/**
 * AgentHarness — 有状态的 Agent 运行时底盘（Stateful Chassis）。
 *
 * 职责：管理 session 状态、生命周期、持久化、可观测性、钩子。
 * 状态转换委托给 AgentLoop（无状态引擎）完成。
 *
 * 关键设计原则：
 *  - 所有可变状态（messages / queue / budget / counters）集中在此
 *  - AgentLoop 是纯引擎，不接触基础设施
 *  - 钩子由 Harness 编排：beforeState 在委托前调用，LLM/Tool 被包装后传入 Loop
 *  - 检查点 / WebSocket / 事件总线均为 Harness 层基础设施
 *
 * @see DESIGN.md §3.2 — AgentHarness (Stateful Runtime Chassis)
 */

import { makeState, type AgentState, type AgentStateType, type Priority } from '../types/states.ts';
import type {
  AgentEventLoopConfig,
  AgentHook,
  LLMContext,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  Message,
  RunResult,
  ToolContext,
  ToolMetadata,
  ToolResult,
} from '../types/config.ts';
import { StateQueue } from '../core/StateQueue.ts';
import { BudgetManager } from '../core/BudgetManager.ts';
import { EventBus, Events } from '../core/EventBus.ts';
import { HookManager, LoggerHook } from '../hooks/HookManager.ts';
import { AgentLoop, type LoopInput } from '../agentLoop/AgentLoop.ts';
import { SqlitePersistence, type IPersistence, defaultCheckpointConfig } from '../persistence/Persistence.ts';
import { WebSocketBridge, type InterruptCommand } from '../observability/WebSocketBridge.ts';
import { randomUUID } from 'node:crypto';

export class AgentHarness {
  readonly sessionId: string;

  // ---- 基础设施 ----
  private loop = new AgentLoop();       // 🔄 无状态引擎
  private events = new EventBus();
  private hooks: HookManager;
  private persistence?: IPersistence;
  private bridge?: WebSocketBridge;

  // ---- Session 状态（所有可变数据） ----
  private queue = new StateQueue();
  private budget: BudgetManager;
  private messages: Message[] = [];
  private refineAttempts = new Map<string, number>();
  private output: { value: string | null } = { value: null };
  private interruptFlag: { kind: 'none' | 'graceful' | 'hard'; message?: string } = { kind: 'none' };
  private terminated = false;
  private terminateReason: string | null = null;
  private idleSpins = 0;
  private turnCounter = 0;
  private startedAt = 0;
  private restored = false;
  private pendingInjects: string[] = [];
  private llm: LLMProvider;
  private tools: Record<string, ToolMetadata>;
  private cfg: AgentEventLoopConfig;

  // 缓存的钩子包装（构造时创建，避免每次 execute 重建）
  private wrappedLLM: LLMProvider;
  private wrappedTools: Record<string, ToolMetadata>;

  constructor(cfg: AgentEventLoopConfig, sessionId?: string) {
    this.cfg = cfg;
    this.sessionId = sessionId ?? cfg.sessionId ?? `sess-${randomUUID().slice(0, 8)}`;
    this.budget = new BudgetManager(cfg.budget, cfg.tokenEstimator);
    this.llm = cfg.llmProvider ?? cfg.llm as unknown as LLMProvider;
    this.tools = cfg.tools;

    const hooks: AgentHook[] = [...(cfg.hooks ?? [])];
    if (cfg.verbose) hooks.push(LoggerHook);
    this.hooks = new HookManager(hooks);

    // 构造时一次性创建钩子包装
    this.wrappedLLM = this.wrapLLMWithHooks();
    this.wrappedTools = this.wrapToolsWithHooks();

    if (cfg.checkpoint?.enabled) {
      const cp = { ...defaultCheckpointConfig(), ...cfg.checkpoint };
      this.persistence = new SqlitePersistence(cp.dbPath, cp.snapshotDir);
    }

    if (cfg.wsPort !== undefined) {
      this.bridge = new WebSocketBridge({ port: cfg.wsPort, sessionId: this.sessionId });
      this.bridge.attach(this.events);
      this.bridge.onInterrupt((cmd) => this.interrupt(cmd.kind, cmd.reason));
    }
  }

  // ---- 公开接口 ----

  /** 关闭 WebSocket 桥接。 */
  async dispose(): Promise<void> {
    await this.bridge?.stop();
    this.bridge = undefined;
  }

  /** 已绑定桥接的实际端口（未启用时为 undefined）。 */
  get wsPort(): number | undefined {
    return this.bridge?.port;
  }

  /** 订阅事件。 */
  on(type: string, handler: (e: { type: string; payload: unknown; timestamp: number }) => void): void {
    this.events.on(type, handler);
  }
  onAny(handler: (e: { type: string; payload: unknown; timestamp: number }) => void): void {
    this.events.onAny(handler);
  }

  /** 外部中断。 */
  interrupt(kind: 'graceful' | 'hard', message?: string): void {
    this.interruptFlag = { kind, message };
    this.events.emit(Events.ExternalInterrupt, { kind, message });
    if (kind === 'hard') {
      this.queue.clear();
      this.queue.enqueue(makeState('TERMINATE', { reason: 'hard-interrupt' }, 'urgent'));
    }
  }

  /** 注入人类反馈。不直接修改 messages，而是延迟到主循环安全时机合并。 */
  injectMessage(message: string): void {
    this.pendingInjects.push(message);
    this.queue.enqueue(makeState('THINK', { reason: 'injected' }));
  }

  /** 运行主循环。 */
  async run(initialPrompt: string): Promise<RunResult> {
    this.events.emit(Events.LoopStart, { sessionId: this.sessionId });
    this.startedAt = Date.now();
    this.budget.begin();

    // 崩溃恢复：先试快照，再试检查点（DESIGN.md §7.2）
    await this.tryRestore();

    if (!this.restored) {
      this.queue.enqueue(makeState('GATHER', { prompt: initialPrompt }));
    }

    while (true) {
      // 1. 预算检查
      const budgetCheck = this.budget.checkExhausted();
      if (budgetCheck.exhausted && !this.queue.hasTerminateState()) {
        this.queue.clear();
        this.queue.enqueue(makeState('TERMINATE', { reason: `budget:${budgetCheck.reason}` }, 'urgent'));
      }

      // 2. 优雅中断：注入 steering 消息
      if (this.interruptFlag.kind === 'graceful') {
        const msg = this.interruptFlag.message ?? '请重新考虑当前方向。';
        this.messages.push({ role: 'user', content: msg });
        this.queue.enqueue(makeState('THINK', { reason: 'steering' }));
        this.interruptFlag = { kind: 'none' };
      }

      // 2.5 合并注入消息（安全时机：在 transition 之间）
      this.mergePendingInjects();

      // 3. 处理所有紧急状态
      while (this.queue.hasUrgent()) {
        const state = this.queue.dequeue()!;
        await this.execute(state);
        if (this.terminated) return this.finish(this.terminatedBy());
      }

      // 4. 取普通状态
      const state = this.queue.dequeue();
      if (!state) {
        if (this.output.value) {
          this.queue.enqueue(makeState('TERMINATE', { reason: 'done' }, 'urgent'));
          continue;
        } else if (this.idleSpins > 3) {
          this.queue.enqueue(makeState('TERMINATE', { reason: 'stall' }, 'urgent'));
          continue;
        } else {
          this.idleSpins++;
          this.queue.enqueue(makeState('THINK', { reason: 'idle-advance' }));
          continue;
        }
      }

      this.idleSpins = 0;
      await this.execute(state);

      // 5. 让出控制权
      await this.yieldControl();

      // 6. 终止条件
      if (this.terminated) return this.finish(this.terminatedBy());
      if (this.queue.totalSize === 0 && this.output.value) {
        return this.finish('budget');
      }
    }
  }

  // ---- 核心执行（委托给无状态 AgentLoop） ----

  private async execute(state: AgentState): Promise<void> {
    this.events.emit(Events.StateStart, { type: state.type, urgent: false });
    this.budget.bumpIteration();
    if (state.type === 'THINK') {
      this.turnCounter++;
      this.budget.bumpTurn();
    }

    // 1. Harness 编排：beforeState 钩子
    const checked = await this.hooks.beforeState(state);
    if (checked === 'abort') {
      this.events.emit(Events.StateEnd, { type: state.type, aborted: true });
      return;
    }

    // 2. 构建 LoopInput —— 使用缓存的钩子包装
    const loopInput: LoopInput = {
      state: checked,
      messages: this.messages,
      tools: this.wrappedTools,
      llm: this.wrappedLLM,
      refineAttempts: Object.fromEntries(this.refineAttempts),
      currentOutput: this.output.value,
      emit: (type, payload) => this.events.emit(type, payload),
    };

    // 3. 委托给无状态 AgentLoop
    const result = await this.loop.transition(loopInput);

    // 4. Harness 应用结果
    this.messages = result.messages;
    this.output.value = result.output;
    // Token 预算：LLM 输出 + 新增消息 + 工具调用 JSON
    this.budget.addTokens(result.tokenText);
    const msgDelta = result.messages.length - loopInput.messages.length;
    if (msgDelta > 0) {
      for (let i = loopInput.messages.length; i < result.messages.length; i++) {
        const m = result.messages[i];
        this.budget.addTokens(m.content);
        if (m.toolCall) this.budget.addTokens(JSON.stringify(m.toolCall));
      }
    }
    if (result.refineAttempts) {
      for (const [key, val] of Object.entries(result.refineAttempts)) {
        this.refineAttempts.set(key, val);
      }
    }
    for (const ns of result.nextStates) {
      this.queue.enqueue(ns.state, ns.priority === 'urgent');
    }
    if (result.terminate) {
      this.terminated = true;
      this.terminateReason = result.terminateReason ?? 'done';
    }

    // 5. Harness 编排：afterState 钩子
    await this.hooks.afterState(checked);
    this.events.emit(Events.StateEnd, { type: state.type });

    // 6. 检查点保存
    if (this.persistence) {
      const interval = this.cfg.checkpoint?.interval ?? 5;
      const onAct = state.type === 'ACT';
      if (onAct || this.turnCounter % interval === 0) {
        await this.saveCheckpoint();
      }
    }
  }

  // ---- 钩子包装 ----

  /** 创建带钩子的 LLM 包装（beforeLLM 拦截 + 修改请求 + 超时保护）。 */
  private wrapLLMWithHooks(): LLMProvider {
    const original = this.llm;
    const hooks = this.hooks;
    const timeoutMs = this.cfg.llmTimeoutMs ?? 120_000;

    const withTimeout = <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        p.finally(() => clearTimeout(timer)),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`LLM timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    };

    return {
      complete: async (req: LLMRequest): Promise<LLMResponse> => {
        const ctx = await hooks.beforeLLM({ request: req });
        if (ctx === 'abort') throw new Error('LLM aborted by hook');
        return withTimeout(original.complete(ctx.request));
      },
      stream: original.stream
        ? async (req: LLMRequest, onChunk: (chunk: string) => void): Promise<LLMResponse> => {
            const ctx = await hooks.beforeLLM({ request: req });
            if (ctx === 'abort') throw new Error('LLM aborted by hook');
            return withTimeout(original.stream!(ctx.request, onChunk));
          }
        : undefined,
    };
  }

  /** 创建带钩子的工具包装（beforeTool 拦截 + afterTool 增强）。 */
  private wrapToolsWithHooks(): Record<string, ToolMetadata> {
    const hooks = this.hooks;
    const wrapped: Record<string, ToolMetadata> = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      wrapped[name] = {
        ...tool,
        handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
          const tc: ToolContext = { call: { id: `call-${Math.random().toString(36).slice(2, 8)}`, name, params } };
          const checked = await hooks.beforeTool(tc);
          if (checked === 'deny') {
            return { ok: false, content: null, error: 'denied by hook' };
          }
          let result: ToolResult;
          try {
            result = await tool.handler(params);
          } catch (e) {
            result = { ok: false, content: null, error: String(e) };
          }
          return hooks.afterTool(result);
        },
      };
    }
    return wrapped;
  }

  // ---- 检查点持久化 ----

  private async saveCheckpoint(): Promise<void> {
    if (!this.persistence) return;
    const q = this.queue.toJSON();
    const data = {
      id: `cp-${this.sessionId}-${Date.now()}`,
      sessionId: this.sessionId,
      turnCount: this.turnCounter,
      queueNormal: q.normal,
      queueUrgent: q.urgent,
      messages: this.messages,
      budget: this.budget.snapshot(),
      refineAttempts: Object.fromEntries(this.refineAttempts),
      finalOutput: this.output.value,
      createdAt: Date.now(),
    };
    await this.persistence.saveCheckpoint(data);
  }

  private async tryRestore(): Promise<void> {
    if (!this.persistence) return;
    const snap = await this.persistence.loadLatestSnapshot(this.sessionId);
    const data = snap ?? (await this.persistence.loadLatestCheckpoint(this.sessionId));
    if (!data) return;

    const normal = data.queueNormal.filter((s) => s.type !== 'TERMINATE');
    const urgent = data.queueUrgent.filter((s) => s.type !== 'TERMINATE');

    if (normal.length === 0 && urgent.length === 0 && data.finalOutput) {
      normal.push(makeState('THINK', { reason: 'restored-continue' }));
    }

    this.queue.fromJSON({ normal, urgent });
    this.messages = data.messages;
    this.budget.restore(data.budget);
    this.turnCounter = data.turnCount;
    this.refineAttempts = new Map(Object.entries(data.refineAttempts ?? {}));
    this.output.value = data.finalOutput;
    this.restored = true;
    this.events.emit('Restore', { sessionId: this.sessionId, turnCount: data.turnCount });
  }

  // ---- 终止与清理 ----

  private terminatedBy(): AgentStateType | 'budget' | 'user' | 'stall' {
    const reason = this.terminateReason;
    if (reason === 'hard-interrupt') return 'user';
    if (reason === 'stall') return 'stall';
    if (reason?.startsWith('budget')) return 'budget';
    return 'TERMINATE';
  }

  private async finish(by: AgentStateType | 'budget' | 'user' | 'stall'): Promise<RunResult> {
    this.events.emit(Events.LoopEnd, { sessionId: this.sessionId, by });
    if (this.persistence) {
      await this.saveCheckpoint();
      await this.persistence.cleanup(this.sessionId, 5);
    }
    return {
      sessionId: this.sessionId,
      output: this.output.value ?? '',
      turns: this.turnCounter,
      iterations: this.budget.iterations,
      totalTokens: this.budget.totalTokens,
      terminatedBy: by,
      elapsedMs: Date.now() - this.startedAt,
      restored: this.restored,
    };
  }

  private mergePendingInjects(): void {
    if (this.pendingInjects.length > 0) {
      for (const msg of this.pendingInjects) {
        this.messages.push({ role: 'user', content: msg });
      }
      this.pendingInjects = [];
    }
  }

  private yieldControl(): Promise<void> {
    return new Promise((resolve) => queueMicrotask(resolve));
  }
}
