/**
 * AgentLoop — 纯状态机引擎（无任何可变状态）。
 *
 * 职责：接收 LoopInput，执行对应状态的纯逻辑，返回 LoopOutput。
 *
 * 关键设计原则：
 *  - 无可变字段：AgentLoop 类的任何方法都不持有或修改实例状态
 *  - 副作用通过回调表达：emit() 用于事件，llm/tools 作为入参注入
 *  - 不抛异常：所有错误转换为 REFLECT 状态返回
 *  - 不感知基础设施：不知道 hooks/persistence/WebSocket 的存在
 *
 * @see DESIGN.md §3.1 — AgentLoop (Stateless State Machine Engine)
 */

import { makeState, type AgentState, type Priority } from '../types/states.ts';
import type {
  LLMProvider,
  Message,
  ToolMetadata,
  ToolResult,
  ToolCall,
  LLMIntent,
} from '../types/config.ts';
import { Events } from '../core/EventBus.ts';

// ---- Types ----

/** 单次状态转换的输入。所有数据均为只读快照，loop 不会修改。 */
export interface LoopInput {
  state: AgentState;
  messages: readonly Message[];
  tools: Record<string, ToolMetadata>;
  llm: LLMProvider;
  refineAttempts: Record<string, number>;
  currentOutput: string | null;
  emit: (type: string, payload?: unknown) => void;
}

/** 单次状态转换的输出。包含所有需要 harness 应用的变更。 */
export interface LoopOutput {
  /** 需要入队的后续状态列表 */
  nextStates: Array<{ state: AgentState; priority?: Priority }>;
  /** 更新后的消息历史（全新数组，不修改原引用） */
  messages: Message[];
  /** 更新后的 final output */
  output: string | null;
  /** LLM 生成的文本（供 harness 做 token 估算） */
  tokenText: string;
  /** 更新后的 refine 重试计数（只包含有变更的键） */
  refineAttempts?: Record<string, number>;
  /** 是否应终止执行 */
  terminate: boolean;
  /** 终止原因 */
  terminateReason?: string;
}

// ---- 纯执行器函数 ----

function handleGather(input: LoopInput): LoopOutput {
  const prompt =
    (input.state.data.prompt as string) ??
    input.messages.at(-1)?.content ??
    '';
  const newMessages = [...input.messages, { role: 'user' as const, content: prompt }];
  return {
    nextStates: [{ state: makeState('THINK', { reason: 'gathered' }) }],
    messages: newMessages,
    output: input.currentOutput,
    tokenText: '',
    terminate: false,
  };
}

async function handleThink(input: LoopInput): Promise<LoopOutput> {
  input.emit(Events.LLMRequest, { intent: 'think' });

  const req = { messages: [...input.messages] as Message[], tools: Object.values(input.tools), intent: 'think' as const };

  // 优先流式，回退 complete —— 两者互斥，不重复调用
  const res = input.llm.stream
    ? await input.llm.stream(req, (chunk) => input.emit(Events.LLMChunk, { chunk }))
    : await input.llm.complete(req);

  const newMessages = [...input.messages];
  const tokenText = res.text ?? '';

  if (res.toolCalls && res.toolCalls.length > 0) {
    for (const tc of res.toolCalls) {
      newMessages.push({ role: 'assistant', content: '', toolCall: tc });
    }
    return {
      nextStates: [{ state: makeState('ACT', { toolCalls: res.toolCalls }) }],
      messages: newMessages,
      output: input.currentOutput,
      tokenText,
      terminate: false,
    };
  }

  const text = res.text ?? '（无输出）';
  newMessages.push({ role: 'assistant', content: text });
  return {
    nextStates: [{ state: makeState('VERIFY', { answer: text }) }],
    messages: newMessages,
    output: text,
    tokenText,
    terminate: false,
  };
}

async function handleAct(input: LoopInput): Promise<LoopOutput> {
  const calls: ToolCall[] = (input.state.data.toolCalls as ToolCall[]) ?? [];
  const results: { call: ToolCall; result: ToolResult }[] = [];
  const newMessages = [...input.messages];

  // 分组：有副作用的顺序执行，无副作用的并行
  const readOnly = calls.filter((c) => !input.tools[c.name]?.sideEffects);
  const writes = calls.filter((c) => input.tools[c.name]?.sideEffects);

  const runOne = async (call: ToolCall) => {
    const tool = input.tools[call.name];
    if (!tool) {
      results.push({ call, result: { ok: false, content: null, error: `unknown tool: ${call.name}` } });
      return;
    }
    input.emit(Events.ToolExecStart, { name: call.name, params: call.params });
    let r: ToolResult;
    try {
      r = await tool.handler(call.params);
    } catch (e) {
      r = { ok: false, content: null, error: String(e) };
    }
    input.emit(Events.ToolExecEnd, { name: call.name, ok: r.ok });
    results.push({ call, result: r });
  };

  await Promise.all(readOnly.map(runOne));
  for (const c of writes) await runOne(c);

  for (const { call, result } of results) {
    newMessages.push({
      role: 'tool',
      content: result.ok ? JSON.stringify(result.content) : `ERROR: ${result.error}`,
    });
  }

  return {
    nextStates: [{ state: makeState('OBSERVE', { results }) }],
    messages: newMessages,
    output: input.currentOutput,
    tokenText: '',
    terminate: false,
  };
}

function handleObserve(input: LoopInput): LoopOutput {
  const results = (input.state.data.results as { result: ToolResult }[]) ?? [];
  const hasError = results.some((r) => !r.result.ok);

  return {
    nextStates: [
      hasError
        ? { state: makeState('REFLECT', { error: 'tool execution error' }), priority: 'urgent' }
        : { state: makeState('THINK', { reason: 'observed' }) },
    ],
    messages: [...input.messages],
    output: input.currentOutput,
    tokenText: '',
    terminate: false,
  };
}

async function handleVerify(input: LoopInput): Promise<LoopOutput> {
  const answer = (input.state.data.answer as string) ?? input.currentOutput ?? '';
  const newMessages = [...input.messages];

  const res = await input.llm.complete({
    messages: [
      ...input.messages,
      { role: 'user', content: `请评估以下结论是否达成目标：${answer}` },
    ],
    intent: 'judge',
  });

  const tokenText = res.text ?? '';
  const verdict = safeParse(res.text ?? '{}') as { pass?: boolean; reason?: string };

  // 确保 pass 是布尔值，否则视为格式异常直接终止
  if (typeof verdict.pass !== 'boolean') {
    return {
      nextStates: [{ state: makeState('TERMINATE', { reason: 'verify-malformed' }), priority: 'urgent' }],
      messages: newMessages,
      output: input.currentOutput,
      tokenText,
      terminate: false,
    };
  }

  const attempts = (input.refineAttempts['verify'] ?? 0) + 1;
  const updatedRefineAttempts = { verify: attempts };

  if (verdict.pass) {
    return {
      nextStates: [{ state: makeState('TERMINATE', { reason: 'verified' }), priority: 'urgent' }],
      messages: newMessages,
      output: input.currentOutput,
      tokenText,
      refineAttempts: updatedRefineAttempts,
      terminate: false,
    };
  }

  if (attempts < 3) {
    return {
      nextStates: [{ state: makeState('REFINE', { feedback: verdict.reason ?? '需改进' }) }],
      messages: newMessages,
      output: input.currentOutput,
      tokenText,
      refineAttempts: updatedRefineAttempts,
      terminate: false,
    };
  }

  return {
    nextStates: [{ state: makeState('TERMINATE', { reason: 'refine-limit' }), priority: 'urgent' }],
    messages: newMessages,
    output: input.currentOutput,
    tokenText,
    refineAttempts: updatedRefineAttempts,
    terminate: false,
  };
}

function handleRefine(input: LoopInput): LoopOutput {
  const feedback = (input.state.data.feedback as string) ?? '请改进';
  const newMessages = [
    ...input.messages,
    { role: 'user' as const, content: `反馈：${feedback}。请基于以上结果修正。` },
  ];
  return {
    nextStates: [{ state: makeState('THINK', { reason: 'refine' }) }],
    messages: newMessages,
    output: input.currentOutput,
    tokenText: '',
    terminate: false,
  };
}

async function handleReflect(input: LoopInput): Promise<LoopOutput> {
  const analysis =
    (input.state.data.error as string) ??
    (input.state.data.analysis as string) ??
    '';
  const newMessages = [...input.messages];

  const res = await input.llm.complete({
    messages: [
      ...input.messages,
      { role: 'user', content: `自我反思：当前遇到「${analysis}」，应修正后继续还是终止？` },
    ],
    intent: 'reflect',
  });

  const tokenText = res.text ?? '';
  const decision = safeParse(res.text ?? '{}') as { action?: string; reason?: string };
  input.emit(Events.ReflectionResult, decision);

  if (decision.action === 'terminate') {
    return {
      nextStates: [{ state: makeState('TERMINATE', { reason: decision.reason ?? 'reflected' }), priority: 'urgent' }],
      messages: newMessages,
      output: input.currentOutput,
      tokenText,
      terminate: false,
    };
  }

  return {
    nextStates: [{ state: makeState('THINK', { reason: 'reflect' }) }],
    messages: newMessages,
    output: input.currentOutput,
    tokenText,
    terminate: false,
  };
}

function handleTerminate(input: LoopInput): LoopOutput {
  const reason = (input.state.data.reason as string) ?? 'done';
  const output = input.currentOutput ?? input.messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? '';
  input.emit(Events.Terminate, { reason });
  return {
    nextStates: [],
    messages: [...input.messages],
    output,
    tokenText: '',
    terminate: true,
    terminateReason: reason,
  };
}

// ---- 执行器路由表 ----

type Executor = (input: LoopInput) => Promise<LoopOutput>;

const executorMap: Record<string, Executor> = {
  GATHER: (i) => Promise.resolve(handleGather(i)),
  THINK: handleThink,
  ACT: handleAct,
  OBSERVE: (i) => Promise.resolve(handleObserve(i)),
  VERIFY: handleVerify,
  REFINE: (i) => Promise.resolve(handleRefine(i)),
  REFLECT: handleReflect,
  TERMINATE: (i) => Promise.resolve(handleTerminate(i)),
};

// ---- Stateless Engine ----

/**
 * AgentLoop — 纯状态机引擎。
 *
 * 不持有任何可变字段，所有数据通过 LoopInput 传入、LoopOutput 传出。
 * 不感知 hooks / persistence / WebSocket 等基础设施的存在。
 */
export class AgentLoop {
  /**
   * 执行一次状态转换。
   * @param input 当前状态 + 上下文快照
   * @returns 转换结果（新状态、消息变更、终止标志等）
   */
  async transition(input: LoopInput): Promise<LoopOutput> {
    const executor = executorMap[input.state.type];
    if (!executor) {
      return {
        nextStates: [{ state: makeState('REFLECT', { error: `unknown state: ${input.state.type}` }, 'urgent') }],
        messages: [...input.messages],
        output: input.currentOutput,
        tokenText: '',
        terminate: false,
      };
    }
    try {
      return await executor(input);
    } catch (err) {
      // 执行器不抛异常——错误转换为 REFLECT
      return {
        nextStates: [{ state: makeState('REFLECT', { error: String(err) }, 'urgent') }],
        messages: [...input.messages],
        output: input.currentOutput,
        tokenText: '',
        terminate: false,
      };
    }
  }
}

// ---- 工具函数 ----

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Extract the first balanced JSON object from the string
    const idx = s.indexOf('{');
    if (idx === -1) return {};
    let depth = 0;
    for (let i = idx; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(idx, i + 1));
          } catch {
            return {};
          }
        }
      }
    }
    return {};
  }
}
