import { makeState, type AgentState } from '../types/states.ts';
import type {
  LLMProvider,
  Message,
  ToolMetadata,
  ToolResult,
} from '../types/config.ts';
import { BudgetManager } from '../core/BudgetManager.ts';
import { StateQueue } from '../core/StateQueue.ts';
import { HookManager } from '../hooks/HookManager.ts';
import { EventBus, Events } from '../core/EventBus.ts';

/** 执行器共享上下文。 */
export interface ExecContext {
  state: AgentState;
  queue: StateQueue;
  budget: BudgetManager;
  llm: LLMProvider;
  tools: Record<string, ToolMetadata>;
  hooks: HookManager;
  events: EventBus;
  messages: Message[];
  refineAttempts: Map<string, number>;
  output: { value: string | null };
  interruptFlag: { kind: 'none' | 'graceful' | 'hard'; message?: string };
}

/** GATHER：压缩/规整上下文，然后入队 THINK。 */
export async function handleGather(ctx: ExecContext): Promise<void> {
  const prompt = (ctx.state.data.prompt as string) ?? ctx.messages.at(-1)?.content ?? '';
  ctx.messages.push({ role: 'user', content: prompt });
  ctx.queue.enqueue(makeState('THINK', { reason: 'gathered' }));
}

/** THINK：调用 LLM 推理；有工具调用 -> ACT，否则 -> VERIFY。 */
export async function handleThink(ctx: ExecContext): Promise<void> {
  const llmCtx = await ctx.hooks.beforeLLM({ request: { messages: ctx.messages, tools: Object.values(ctx.tools), intent: 'think' } });
  if (llmCtx === 'abort') {
    ctx.queue.enqueue(makeState('REFLECT', { error: 'LLM aborted by hook' }, 'urgent'));
    return;
  }
  ctx.events.emit(Events.LLMRequest, { intent: 'think' });
  const res = await ctx.llm.complete(llmCtx.request);
  if (res.text) ctx.budget.addTokens(res.text);

  // 流式输出（若提供）
  if (ctx.llm.stream) {
    await ctx.llm.stream(llmCtx.request, (chunk) => ctx.events.emit(Events.LLMChunk, { chunk }));
  }

  if (res.toolCalls && res.toolCalls.length) {
    for (const tc of res.toolCalls) {
      ctx.messages.push({ role: 'assistant', content: '', toolCall: tc });
    }
    ctx.queue.enqueue(makeState('ACT', { toolCalls: res.toolCalls }));
  } else {
    const text = res.text ?? '（无输出）';
    ctx.messages.push({ role: 'assistant', content: text });
    ctx.output.value = text;
    ctx.queue.enqueue(makeState('VERIFY', { answer: text }));
  }
}

/** ACT：执行工具（智能分组：只读并行，写入串行），入队 OBSERVE。 */
export async function handleAct(ctx: ExecContext): Promise<void> {
  const calls = (ctx.state.data.toolCalls as any[]) ?? [];
  const results: { call: any; result: ToolResult }[] = [];

  // 分组：有副作用的顺序执行，无副作用的并行
  const readOnly = calls.filter((c) => !ctx.tools[c.name]?.sideEffects);
  const writes = calls.filter((c) => ctx.tools[c.name]?.sideEffects);

  const runOne = async (call: any) => {
    const tool = ctx.tools[call.name];
    if (!tool) {
      results.push({ call, result: { ok: false, content: null, error: `unknown tool: ${call.name}` } });
      return;
    }
    const tc = await ctx.hooks.beforeTool({ call });
    if (tc === 'deny') {
      results.push({ call, result: { ok: false, content: null, error: 'denied by hook' } });
      return;
    }
    ctx.events.emit(Events.ToolExecStart, { name: call.name, params: call.params });
    let r: ToolResult;
    try {
      r = await tool.handler(call.params);
    } catch (e) {
      r = { ok: false, content: null, error: String(e) };
    }
    r = await ctx.hooks.afterTool(r);
    ctx.events.emit(Events.ToolExecEnd, { name: call.name, ok: r.ok });
    results.push({ call, result: r });
  };

  await Promise.all(readOnly.map(runOne));
  for (const c of writes) await runOne(c);

  for (const { call, result } of results) {
    ctx.messages.push({
      role: 'tool',
      content: result.ok ? JSON.stringify(result.content) : `ERROR: ${result.error}`,
    });
  }
  ctx.queue.enqueue(makeState('OBSERVE', { results }));
}

/** OBSERVE：检查工具结果；出错 -> REFLECT，否则 -> THINK。 */
export async function handleObserve(ctx: ExecContext): Promise<void> {
  const results = (ctx.state.data.results as { result: ToolResult }[]) ?? [];
  const hasError = results.some((r) => !r.result.ok);
  if (hasError) {
    ctx.queue.enqueue(makeState('REFLECT', { error: 'tool execution error' }, 'urgent'));
  } else {
    ctx.queue.enqueue(makeState('THINK', { reason: 'observed' }));
  }
}

/** VERIFY：LLM-as-Judge 评估输出；通过 -> TERMINATE，否则 REFINE（最多 3 次）。 */
export async function handleVerify(ctx: ExecContext): Promise<void> {
  const answer = (ctx.state.data.answer as string) ?? ctx.output.value ?? '';
  const llmCtx = await ctx.hooks.beforeLLM({ request: { messages: [...ctx.messages, { role: 'user', content: `请评估以下结论是否达成目标：${answer}` }], intent: 'judge' } });
  if (llmCtx === 'abort') {
    ctx.queue.enqueue(makeState('TERMINATE', { reason: 'verify aborted' }, 'urgent'));
    return;
  }
  const res = await ctx.llm.complete(llmCtx.request);
  const verdict = safeParse(res.text ?? '{}') as { pass?: boolean; reason?: string };
  ctx.budget.addTokens(res.text ?? '');

  // 确保 pass 是布尔值，否则视为格式异常直接终止（不浪费 REFINE 轮次）
  if (typeof verdict.pass !== 'boolean') {
    ctx.queue.enqueue(makeState('TERMINATE', { reason: 'verify-malformed' }, 'urgent'));
    return;
  }

  const attempts = (ctx.refineAttempts.get('verify') ?? 0) + 1;
  ctx.refineAttempts.set('verify', attempts);

  if (verdict.pass) {
    ctx.queue.enqueue(makeState('TERMINATE', { reason: 'verified' }, 'urgent'));
  } else if (attempts < 3) {
    ctx.queue.enqueue(makeState('REFINE', { feedback: verdict.reason ?? '需改进' }));
  } else {
    ctx.queue.enqueue(makeState('TERMINATE', { reason: 'refine-limit' }, 'urgent'));
  }
}

/** REFINE：基于反馈重组提示，入队 THINK。 */
export async function handleRefine(ctx: ExecContext): Promise<void> {
  const feedback = (ctx.state.data.feedback as string) ?? '请改进';
  ctx.messages.push({ role: 'user', content: `反馈：${feedback}。请基于以上结果修正。` });
  ctx.queue.enqueue(makeState('THINK', { reason: 'refine' }));
}

/** REFLECT：自我分析；修正 -> THINK，否则 -> TERMINATE。 */
export async function handleReflect(ctx: ExecContext): Promise<void> {
  const analysis = (ctx.state.data.error as string) ?? (ctx.state.data.analysis as string) ?? '';
  const llmCtx = await ctx.hooks.beforeLLM({ request: { messages: [...ctx.messages, { role: 'user', content: `自我反思：当前遇到「${analysis}」，应修正后继续还是终止？` }], intent: 'reflect' } });
  if (llmCtx === 'abort') {
    ctx.queue.enqueue(makeState('TERMINATE', { reason: 'reflect aborted' }, 'urgent'));
    return;
  }
  const res = await ctx.llm.complete(llmCtx.request);
  const decision = safeParse(res.text ?? '{}') as { action?: string; reason?: string };
  ctx.budget.addTokens(res.text ?? '');
  ctx.events.emit(Events.ReflectionResult, decision);

  if (decision.action === 'terminate') {
    ctx.queue.enqueue(makeState('TERMINATE', { reason: decision.reason ?? 'reflected' }, 'urgent'));
  } else {
    ctx.queue.enqueue(makeState('THINK', { reason: 'reflect' }));
  }
}

/** TERMINATE：设置终止标志，记录最终输出。 */
export async function handleTerminate(ctx: ExecContext): Promise<void> {
  const reason = (ctx.state.data.reason as string) ?? 'done';
  if (!ctx.output.value) {
    ctx.output.value = ctx.messages.filter((m) => m.role === 'assistant').at(-1)?.content ?? '';
  }
  ctx.events.emit(Events.Terminate, { reason });
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    // 容忍模型返回非严格 JSON
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
    return {};
  }
}

export const Executors: Record<AgentState['type'], (ctx: ExecContext) => Promise<void>> = {
  GATHER: handleGather,
  THINK: handleThink,
  ACT: handleAct,
  OBSERVE: handleObserve,
  VERIFY: handleVerify,
  REFINE: handleRefine,
  REFLECT: handleReflect,
  TERMINATE: handleTerminate,
};
