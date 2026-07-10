import { makeState, type AgentState, type AgentStateType } from '../types/states.ts';
import type {
  AgentEventLoopConfig,
  AgentHook,
  LLMProvider,
  Message,
  RunResult,
  ToolMetadata,
} from '../types/config.ts';
import { StateQueue } from './StateQueue.ts';
import { BudgetManager } from './BudgetManager.ts';
import { EventBus, Events } from './EventBus.ts';
import { HookManager, LoggerHook } from '../hooks/HookManager.ts';
import { Executors, type ExecContext } from './executors.ts';
import { MockLLMProvider } from '../llm/MockLLMProvider.ts';
import { SqlitePersistence, type IPersistence, defaultCheckpointConfig } from '../persistence/Persistence.ts';
import { WebSocketBridge } from '../observability/WebSocketBridge.ts';
import { randomUUID } from 'node:crypto';

/**
 * Agent-Event-Loop 主调度器（设计文档 3.1）。
 *
 * 借鉴 JavaScript Event Loop 的消息队列 + 微任务优先级思想，
 * 改造为面向 Agent 认知流程的状态调度：队列驱动、双优先级、
 * 预算终止、检查点持久化、事件可观测、钩子可扩展。
 */
export class AgentEventLoop {
  readonly sessionId: string;
  private queue = new StateQueue();
  private budget: BudgetManager;
  private events = new EventBus();
  private hooks: HookManager;
  private llm: LLMProvider;
  private tools: Record<string, ToolMetadata>;
  private cfg: AgentEventLoopConfig;
  private persistence?: IPersistence;
  private bridge?: WebSocketBridge;

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

  constructor(cfg: AgentEventLoopConfig, sessionId?: string) {
    this.cfg = cfg;
    this.sessionId = sessionId ?? cfg.sessionId ?? `sess-${randomUUID().slice(0, 8)}`;
    this.budget = new BudgetManager(cfg.budget, cfg.tokenEstimator);
    this.llm = cfg.llmProvider ?? new MockLLMProvider();
    this.tools = cfg.tools;

    const hooks: AgentHook[] = [...(cfg.hooks ?? [])];
    if (cfg.verbose) hooks.push(LoggerHook);
    this.hooks = new HookManager(hooks);

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

  /** 关闭 WebSocket 桥接（仅在不需要继续推送事件时调用）。
   *  注意：本方法不关闭持久化（SQLite / 快照文件句柄），需要
   *  在进程退出前显式调用 `process.exit` 或对 SqlitePersistence
   *  另起 close() 方法（见后续路线图）。 */
  async dispose(): Promise<void> {
    await this.bridge?.stop();
    this.bridge = undefined;
  }

  /** 已绑定桥接的实际端口（未启用时为 undefined）。 */
  get wsPort(): number | undefined {
    return this.bridge?.port;
  }

  /** 订阅事件（可观测层 / WebSocket 桥接）。 */
  on(type: string, handler: (e: { type: string; payload: unknown; timestamp: number }) => void): void {
    this.events.on(type, handler);
  }
  onAny(handler: (e: { type: string; payload: unknown; timestamp: number }) => void): void {
    this.events.onAny(handler);
  }

  /** 外部中断：graceful 注入 steering 消息；hard 立即清空队列并终止。 */
  interrupt(kind: 'graceful' | 'hard', message?: string): void {
    this.interruptFlag = { kind, message };
    this.events.emit(Events.ExternalInterrupt, { kind, message });
    if (kind === 'hard') {
      this.queue.clear();
      this.queue.enqueue(makeState('TERMINATE', { reason: 'hard-interrupt' }, 'urgent'));
    }
  }

  /** 注入人类反馈 / 外部指令（优雅注入普通队列）。 */
  injectMessage(message: string): void {
    this.messages.push({ role: 'user', content: message });
    this.queue.enqueue(makeState('THINK', { reason: 'injected' }));
  }

  /** 运行主循环（设计文档 3.1 伪代码）。 */
  async run(initialPrompt: string): Promise<RunResult> {
    this.events.emit(Events.LoopStart, { sessionId: this.sessionId });
    this.startedAt = Date.now();
    this.budget.begin();

    // 崩溃恢复：先试快照，再试检查点（设计文档 7.2）
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

      // 3. 处理所有紧急状态
      while (this.queue.hasUrgent()) {
        const state = this.queue.dequeue()!;
        await this.execute(state, true);
        if (this.terminated) return this.finish(this.terminatedBy());
      }

      // 4. 取普通状态
      const state = this.queue.dequeue();
      if (!state) {
        // 空队列处理
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
      await this.execute(state, false);

      // 5. 让出控制权（设计文档：queueMicrotask）
      await this.yieldControl();

      // 6. 终止条件
      if (this.terminated) return this.finish(this.terminatedBy());
      if (this.queue.totalSize === 0 && this.output.value) {
        return this.finish('budget');
      }
    }
  }

  private async execute(state: AgentState, urgent: boolean): Promise<void> {
    this.events.emit(Events.StateStart, { type: state.type, urgent });
    this.budget.bumpIteration();
    if (state.type === 'THINK') {
      this.turnCounter++;
      this.budget.bumpTurn();
    }

    const checked = await this.hooks.beforeState(state);
    if (checked === 'abort') {
      this.events.emit(Events.StateEnd, { type: state.type, aborted: true });
      return;
    }

    // 所有执行器均不抛异常，错误转换为 REFLECT 紧急状态（设计文档 3.4）
    try {
      const ctx: ExecContext = {
        state: checked,
        queue: this.queue,
        budget: this.budget,
        llm: this.llm,
        tools: this.tools,
        hooks: this.hooks,
        events: this.events,
        messages: this.messages,
        refineAttempts: this.refineAttempts,
        output: this.output,
        interruptFlag: this.interruptFlag,
      };
      await Executors[checked.type](ctx);
    } catch (err) {
      this.queue.enqueue(makeState('REFLECT', { error: String(err) }, 'urgent'));
    }

    await this.hooks.afterState(checked);
    this.events.emit(Events.StateEnd, { type: state.type, urgent });

    if (state.type === 'TERMINATE') {
      this.terminated = true;
      this.terminateReason = (state.data.reason as string) ?? 'done';
    }

    // 检查点保存（每 N 轮 或 关键状态 ACT 后）
    if (this.persistence) {
      const interval = this.cfg.checkpoint?.interval ?? 5;
      const onAct = state.type === 'ACT';
      if (onAct || this.turnCounter % interval === 0) {
        await this.saveCheckpoint();
      }
    }
  }

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

    // 过滤掉 TERMINATE 状态，避免恢复后立即终止
    const normal = data.queueNormal.filter((s) => s.type !== 'TERMINATE');
    const urgent = data.queueUrgent.filter((s) => s.type !== 'TERMINATE');

    // 如果过滤后队列为空且已有输出（会话之前已完成），注入 THINK 以真正续跑
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

  private yieldControl(): Promise<void> {
    return new Promise((resolve) => queueMicrotask(resolve));
  }
}
