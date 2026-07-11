/**
 * AgentLoop 单元测试——覆盖所有 8 个纯执行器 + transition() 调度器。
 *
 * 测试策略：
 *  - 每个 executor 作为纯函数测试：给定 LoopInput → 期望 LoopOutput
 *  - LLM 用内联 Mock 注入，避免依赖 MockLLMProvider 的脚本化行为
 *  - emit 用 spy 函数捕获，验证事件发射
 *  - AgentLoop.transition() 测试路由、未知状态、异常捕获
 */

import { describe, it, expect } from 'bun:test';
import { AgentLoop, type LoopInput, type LoopOutput } from './AgentLoop.ts';
import { makeState, type AgentState } from '../types/states.ts';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ToolMetadata,
  ToolResult,
  Message,
} from '../types/config.ts';
import { Events } from '../core/EventBus.ts';

// ========== 辅助工具 ==========

/** 创建确定性 LLM 存根。 */
function stubLLM(response: Partial<LLMResponse>, options?: { stream?: boolean }): LLMProvider {
  return {
    complete: async (_req: LLMRequest): Promise<LLMResponse> => ({
      text: undefined,
      toolCalls: undefined,
      ...response,
    }),
    stream: options?.stream
      ? async (_req: LLMRequest, onChunk: (chunk: string) => void): Promise<LLMResponse> => {
          for (const chunk of ['chunk1', 'chunk2']) onChunk(chunk);
          return { text: undefined, toolCalls: undefined, ...response };
        }
      : undefined,
  };
}

/** 空 emit spy。 */
function noopEmit() {}
const emitSpy = (): { calls: Array<[string, unknown?]>; fn: LoopInput['emit'] } => {
  const calls: Array<[string, unknown?]> = [];
  return {
    calls,
    fn: (type: string, payload?: unknown) => {
      calls.push([type, payload]);
    },
  };
};

/** 构建最小 LoopInput。 */
function input(overrides: Partial<LoopInput> & { state: AgentState }): LoopInput {
  return {
    messages: [],
    tools: {},
    llm: stubLLM({}),
    refineAttempts: {},
    currentOutput: null,
    emit: noopEmit,
    ...overrides,
  };
}

/** 工具工厂。 */
function makeTool(name: string, overrides?: Partial<ToolMetadata>): ToolMetadata {
  return {
    name,
    description: `tool ${name}`,
    parameters: {},
    sideEffects: false,
    handler: async (p: Record<string, unknown>): Promise<ToolResult> => ({
      ok: true,
      content: `result:${JSON.stringify(p)}`,
    }),
    ...overrides,
  };
}

const loop = new AgentLoop(); // 无状态引擎，全局可复用

// ========== AgentLoop.transition() 调度器 ==========

describe('AgentLoop.transition()', () => {
  it('routes GATHER to handleGather', async () => {
    const out = await loop.transition(input({ state: makeState('GATHER', { prompt: 'hi' }) }));
    expect(out.nextStates[0].state.type).toBe('THINK');
  });

  it('routes THINK to handleThink', async () => {
    const out = await loop.transition(
      input({ state: makeState('THINK'), llm: stubLLM({ text: 'hello' }) }),
    );
    expect(out.nextStates[0].state.type).toBe('VERIFY');
  });

  it('routes ACT to handleAct', async () => {
    const out = await loop.transition(
      input({ state: makeState('ACT', { toolCalls: [] }) }),
    );
    expect(out.nextStates[0].state.type).toBe('OBSERVE');
  });

  it('routes OBSERVE to handleObserve', async () => {
    const out = await loop.transition(input({ state: makeState('OBSERVE', { results: [] }) }));
    expect(out.nextStates[0].state.type).toBe('THINK');
  });

  it('routes VERIFY to handleVerify', async () => {
    const out = await loop.transition(
      input({ state: makeState('VERIFY', { answer: 'x' }), llm: stubLLM({ text: '{"pass":true}' }) }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
  });

  it('routes REFINE to handleRefine', async () => {
    const out = await loop.transition(
      input({ state: makeState('REFINE', { feedback: 'improve' }) }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
  });

  it('routes REFLECT to handleReflect', async () => {
    const out = await loop.transition(
      input({ state: makeState('REFLECT', { error: 'err' }), llm: stubLLM({ text: '{"action":"think"}' }) }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
  });

  it('routes TERMINATE to handleTerminate', async () => {
    const out = await loop.transition(input({ state: makeState('TERMINATE', { reason: 'done' }) }));
    expect(out.terminate).toBe(true);
  });

  it('returns REFLECT for unknown state type', async () => {
    const fakeState = { ...makeState('THINK'), type: 'UNKNOWN' as any };
    const out = await loop.transition(input({ state: fakeState }));
    expect(out.nextStates[0].state.type).toBe('REFLECT');
    expect(out.nextStates[0].state.data.error).toContain('UNKNOWN');
  });

  it('catches executor errors and returns REFLECT', async () => {
    // 让 LLM 抛异常
    const throwingLLM: LLMProvider = {
      complete: async () => { throw new Error('LLM crashed'); },
    };
    const out = await loop.transition(
      input({ state: makeState('THINK'), llm: throwingLLM }),
    );
    expect(out.nextStates[0].state.type).toBe('REFLECT');
    expect(out.nextStates[0].state.data.error).toContain('LLM crashed');
  });

  it('does not mutate the input messages array', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    const originalLen = msgs.length;
    await loop.transition(
      input({ state: makeState('THINK'), messages: msgs, llm: stubLLM({ text: 'hi' }) }),
    );
    expect(msgs).toHaveLength(originalLen);
  });
});

// ========== GATHER ==========

describe('GATHER', () => {
  it('uses prompt from state.data', async () => {
    const out = await loop.transition(
      input({ state: makeState('GATHER', { prompt: 'test prompt' }) }),
    );
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ role: 'user', content: 'test prompt' });
  });

  it('falls back to last message content when prompt is absent', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'fallback msg' }];
    const out = await loop.transition(
      input({ state: makeState('GATHER'), messages: msgs }),
    );
    expect(out.messages[1]).toMatchObject({ role: 'user', content: 'fallback msg' });
  });

  it('falls back to empty string when nothing available', async () => {
    const out = await loop.transition(
      input({ state: makeState('GATHER', {}) }),
    );
    expect(out.messages[0].content).toBe('');
  });

  it('preserves existing messages', async () => {
    const msgs: Message[] = [{ role: 'system', content: 'be helpful' }];
    const out = await loop.transition(
      input({ state: makeState('GATHER', { prompt: 'hi' }), messages: msgs }),
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual(msgs[0]);
    expect(out.messages[1].content).toBe('hi');
  });

  it('enqueues a single THINK state', async () => {
    const out = await loop.transition(
      input({ state: makeState('GATHER', { prompt: 'x' }) }),
    );
    expect(out.nextStates).toHaveLength(1);
    expect(out.nextStates[0].state.type).toBe('THINK');
    expect(out.nextStates[0].state.data.reason).toBe('gathered');
  });

  it('output is unchanged', async () => {
    const out = await loop.transition(
      input({ state: makeState('GATHER', { prompt: 'x' }), currentOutput: 'existing' }),
    );
    expect(out.output).toBe('existing');
  });
});

// ========== THINK ==========

describe('THINK', () => {
  it('emits LLMRequest event before calling LLM', async () => {
    const spy = emitSpy();
    await loop.transition(
      input({ state: makeState('THINK'), llm: stubLLM({ text: 'hello' }), emit: spy.fn }),
    );
    expect(spy.calls[0][0]).toBe(Events.LLMRequest);
    expect((spy.calls[0][1] as any)?.intent).toBe('think');
  });

  it('streams chunks when LLM provider supports it', async () => {
    const spy = emitSpy();
    const spyLLM = stubLLM({ text: 'final' }, { stream: true });
    await loop.transition(
      input({ state: makeState('THINK'), llm: spyLLM, emit: spy.fn }),
    );
    const chunkCalls = spy.calls.filter(([t]) => t === Events.LLMChunk);
    expect(chunkCalls.length).toBeGreaterThanOrEqual(1);
    expect(chunkCalls[0]).toEqual([Events.LLMChunk, { chunk: 'chunk1' }]);
  });

  it('returns VERIFY when LLM returns text', async () => {
    const out = await loop.transition(
      input({ state: makeState('THINK'), llm: stubLLM({ text: 'some answer' }) }),
    );
    expect(out.nextStates[0].state.type).toBe('VERIFY');
    expect(out.nextStates[0].state.data.answer).toBe('some answer');
  });

  it('sets output to LLM text when no tool calls', async () => {
    const out = await loop.transition(
      input({ state: makeState('THINK'), llm: stubLLM({ text: 'the output' }) }),
    );
    expect(out.output).toBe('the output');
  });

  it('appends assistant message with text when no tool calls', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'question' }];
    const out = await loop.transition(
      input({ state: makeState('THINK'), messages: msgs, llm: stubLLM({ text: 'answer' }) }),
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toMatchObject({ role: 'assistant', content: 'answer' });
  });

  it('uses default text when LLM returns empty', async () => {
    const out = await loop.transition(
      input({ state: makeState('THINK'), llm: stubLLM({}) }),
    );
    expect(out.output).toBe('（无输出）');
  });

  it('returns ACT when LLM returns tool calls', async () => {
    const out = await loop.transition(
      input({
        state: makeState('THINK'),
        llm: stubLLM({
          toolCalls: [{ id: 'call-1', name: 'search', params: { q: 'test' } }],
        }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('ACT');
    expect((out.nextStates[0].state.data.toolCalls as any[])).toHaveLength(1);
  });

  it('appends assistant messages with tool calls', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'search' }];
    const out = await loop.transition(
      input({
        state: makeState('THINK'),
        messages: msgs,
        llm: stubLLM({
          toolCalls: [{ id: 'call-1', name: 'search', params: { q: 'x' } }],
        }),
      }),
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].role).toBe('assistant');
    expect(out.messages[1].toolCall).toBeDefined();
    expect(out.messages[1].toolCall!.name).toBe('search');
  });

  it('does not change output when returning tool calls', async () => {
    const out = await loop.transition(
      input({
        state: makeState('THINK'),
        currentOutput: 'existing',
        llm: stubLLM({
          toolCalls: [{ id: 'c1', name: 'calc', params: { expr: '1+1' } }],
        }),
      }),
    );
    expect(out.output).toBe('existing');
  });

  it('returns tokenText from LLM response', async () => {
    const out = await loop.transition(
      input({ state: makeState('THINK'), llm: stubLLM({ text: 'some token text' }) }),
    );
    expect(out.tokenText).toBe('some token text');
  });
});

// ========== ACT ==========

describe('ACT', () => {
  it('executes read-only tools in parallel', async () => {
    const toolA = makeTool('a', {
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, content: 'A' };
      },
    });
    const toolB = makeTool('b', {
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, content: 'B' };
      },
    });
    const start = Date.now();
    const out = await loop.transition(
      input({
        state: makeState('ACT', { toolCalls: [{ id: 'c1', name: 'a', params: {} }, { id: 'c2', name: 'b', params: {} }] }),
        tools: { a: toolA, b: toolB },
      }),
    );
    // 如果串行执行需要 ~10ms+，并行只需 ~5ms+
    expect(Date.now() - start).toBeLessThan(50);
    expect(out.nextStates[0].state.type).toBe('OBSERVE');
  });

  it('executes side-effect tools sequentially', async () => {
    const order: string[] = [];
    const toolW = makeTool('w', {
      sideEffects: true,
      handler: async () => {
        order.push('w');
        return { ok: true, content: 'W' };
      },
    });
    const toolR = makeTool('r', {
      handler: async () => {
        order.push('r');
        return { ok: true, content: 'R' };
      },
    });
    await loop.transition(
      input({
        state: makeState('ACT', {
          toolCalls: [
            { id: 'c1', name: 'r', params: {} },
            { id: 'c2', name: 'w', params: {} },
          ],
        }),
        tools: { r: toolR, w: toolW },
      }),
    );
    expect(order[0]).toBe('r'); // read-only runs in parallel, starts first
    expect(order[1]).toBe('w'); // write runs after all reads
  });

  it('handles unknown tools gracefully', async () => {
    const out = await loop.transition(
      input({
        state: makeState('ACT', { toolCalls: [{ id: 'c1', name: 'unknown', params: {} }] }),
        tools: {},
      }),
    );
    expect(out.messages[0].content).toContain('ERROR');
    expect(out.messages[0].content).toContain('unknown');
  });

  it('captures tool handler exceptions', async () => {
    const broken = makeTool('broken', {
      handler: async () => { throw new Error('boom'); },
    });
    const out = await loop.transition(
      input({
        state: makeState('ACT', { toolCalls: [{ id: 'c1', name: 'broken', params: {} }] }),
        tools: { broken },
      }),
    );
    expect(out.messages[0].content).toContain('ERROR');
    expect(out.messages[0].content).toContain('boom');
  });

  it('emits ToolExecStart and ToolExecEnd', async () => {
    const spy = emitSpy();
    const tool = makeTool('greeter', {
      handler: async () => ({ ok: true, content: 'hello' }),
    });
    await loop.transition(
      input({
        state: makeState('ACT', { toolCalls: [{ id: 'c1', name: 'greeter', params: { name: 'world' } }] }),
        tools: { greeter: tool },
        emit: spy.fn,
      }),
    );
    const start = spy.calls.find(([t]) => t === Events.ToolExecStart);
    const end = spy.calls.find(([t]) => t === Events.ToolExecEnd);
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect((start![1] as any).name).toBe('greeter');
    expect((end![1] as any).ok).toBe(true);
  });

  it('appends tool result messages', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'calc' }];
    const calc = makeTool('calc', {
      handler: async () => ({ ok: true, content: { value: 42 } }),
    });
    const out = await loop.transition(
      input({
        state: makeState('ACT', { toolCalls: [{ id: 'c1', name: 'calc', params: { expr: '6*7' } }] }),
        messages: msgs,
        tools: { calc },
      }),
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toMatchObject({ role: 'tool' });
    expect(out.messages[1].content).toContain('42');
  });

  it('output is unchanged', async () => {
    const out = await loop.transition(
      input({
        state: makeState('ACT', { toolCalls: [] }),
        currentOutput: 'prev',
      }),
    );
    expect(out.output).toBe('prev');
  });
});

// ========== OBSERVE ==========

describe('OBSERVE', () => {
  it('enqueues THINK when all tools succeed', async () => {
    const out = await loop.transition(
      input({
        state: makeState('OBSERVE', {
          results: [{ result: { ok: true, content: 'data' } }],
        }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
    expect(out.nextStates[0].priority).toBeUndefined();
  });

  it('enqueues REFLECT urgently when any tool fails', async () => {
    const out = await loop.transition(
      input({
        state: makeState('OBSERVE', {
          results: [
            { result: { ok: true, content: 'data' } },
            { result: { ok: false, content: null, error: 'fail' } },
          ],
        }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('REFLECT');
    expect(out.nextStates[0].priority).toBe('urgent');
  });

  it('preserves messages and output', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'test' }];
    const out = await loop.transition(
      input({
        state: makeState('OBSERVE', { results: [{ result: { ok: true, content: 'd' } }] }),
        messages: msgs,
        currentOutput: 'out',
      }),
    );
    expect(out.messages).toEqual(msgs);
    expect(out.output).toBe('out');
  });
});

// ========== VERIFY ==========

describe('VERIFY', () => {
  it('emits TERMINATE with verified reason when LLM judge passes', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'good answer' }),
        llm: stubLLM({ text: JSON.stringify({ pass: true, reason: 'clear' }) }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
    expect(out.nextStates[0].state.data.reason).toBe('verified');
  });

  it('enqueues REFINE when judge fails and attempts < 3', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'bad answer' }),
        llm: stubLLM({ text: JSON.stringify({ pass: false, reason: 'unclear' }) }),
        refineAttempts: {},
      }),
    );
    expect(out.nextStates[0].state.type).toBe('REFINE');
    expect(out.nextStates[0].state.data.feedback).toBe('unclear');
  });

  it('enqueues REFINE with default feedback when reason is missing', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'bad' }),
        llm: stubLLM({ text: JSON.stringify({ pass: false }) }),
        refineAttempts: {},
      }),
    );
    expect(out.nextStates[0].state.type).toBe('REFINE');
    expect(out.nextStates[0].state.data.feedback).toBe('需改进');
  });

  it('emits TERMINATE with refine-limit when attempts >= 3', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'still bad' }),
        llm: stubLLM({ text: JSON.stringify({ pass: false }) }),
        refineAttempts: { verify: 2 }, // 2 + 1 = 3 → 达到上限
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
    expect(out.nextStates[0].state.data.reason).toBe('refine-limit');
  });

  it('emits TERMINATE with verify-malformed when pass is not boolean', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'x' }),
        llm: stubLLM({ text: JSON.stringify({ pass: 'yes' }) }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
    expect(out.nextStates[0].state.data.reason).toBe('verify-malformed');
  });

  it('handles non-JSON LLM response by extracting JSON from text', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'x' }),
        llm: stubLLM({ text: 'Some text {"pass":true} and more' }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
  });

  it('handles completely malformed LLM response as verify-malformed', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'x' }),
        llm: stubLLM({ text: 'just plain text no json at all!' }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
    expect(out.nextStates[0].state.data.reason).toBe('verify-malformed');
  });

  it('falls back to currentOutput when answer is empty', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: '' }),
        llm: stubLLM({ text: JSON.stringify({ pass: true, reason: 'ok' }) }),
        currentOutput: 'fallback output',
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
  });

  it('returns refineAttempts in the output', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'test' }),
        llm: stubLLM({ text: JSON.stringify({ pass: true }) }),
        refineAttempts: {},
      }),
    );
    expect(out.refineAttempts).toEqual({ verify: 1 });
  });

  it('increments refineAttempts across calls', async () => {
    const out = await loop.transition(
      input({
        state: makeState('VERIFY', { answer: 'test' }),
        llm: stubLLM({ text: JSON.stringify({ pass: false }) }),
        refineAttempts: { verify: 1 },
      }),
    );
    expect(out.refineAttempts).toEqual({ verify: 2 });
  });
});

// ========== REFINE ==========

describe('REFINE', () => {
  it('appends feedback message to conversation', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'original' }];
    const out = await loop.transition(
      input({
        state: makeState('REFINE', { feedback: 'too vague' }),
        messages: msgs,
      }),
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1].content).toContain('too vague');
  });

  it('enqueues THINK state', async () => {
    const out = await loop.transition(
      input({ state: makeState('REFINE', { feedback: 'fix it' }) }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
    expect(out.nextStates[0].state.data.reason).toBe('refine');
  });

  it('uses default feedback when not provided', async () => {
    const out = await loop.transition(
      input({ state: makeState('REFINE', {}) }),
    );
    expect(out.messages[0].content).toContain('请改进');
  });

  it('preserves previous messages', async () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const out = await loop.transition(
      input({ state: makeState('REFINE', { feedback: 'redo' }), messages: msgs }),
    );
    expect(out.messages[0]).toEqual(msgs[0]);
    expect(out.messages[1]).toEqual(msgs[1]);
  });
});

// ========== REFLECT ==========

describe('REFLECT', () => {
  it('enqueues TERMINATE when LLM decides to terminate', async () => {
    const out = await loop.transition(
      input({
        state: makeState('REFLECT', { error: 'fatal' }),
        llm: stubLLM({ text: JSON.stringify({ action: 'terminate', reason: 'cannot fix' }) }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('TERMINATE');
    expect(out.nextStates[0].state.data.reason).toBe('cannot fix');
  });

  it('enqueues THINK when LLM decides to continue', async () => {
    const out = await loop.transition(
      input({
        state: makeState('REFLECT', { error: 'minor issue' }),
        llm: stubLLM({ text: JSON.stringify({ action: 'think', reason: 'can fix' }) }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
    expect(out.nextStates[0].state.data.reason).toBe('reflect');
  });

  it('defaults to THINK when action is unrecognized', async () => {
    const out = await loop.transition(
      input({
        state: makeState('REFLECT', { error: 'x' }),
        llm: stubLLM({ text: JSON.stringify({ action: 'dance' }) }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
  });

  it('defaults to terminate with reflected reason when terminate reason is missing', async () => {
    const out = await loop.transition(
      input({
        state: makeState('REFLECT', { error: 'x' }),
        llm: stubLLM({ text: JSON.stringify({ action: 'terminate' }) }),
      }),
    );
    expect(out.nextStates[0].state.data.reason).toBe('reflected');
  });

  it('emits ReflectionResult event', async () => {
    const spy = emitSpy();
    await loop.transition(
      input({
        state: makeState('REFLECT', { error: 'x' }),
        llm: stubLLM({ text: JSON.stringify({ action: 'think' }) }),
        emit: spy.fn,
      }),
    );
    const evt = spy.calls.find(([t]) => t === Events.ReflectionResult);
    expect(evt).toBeDefined();
    expect((evt![1] as any).action).toBe('think');
  });

  it('uses analysis field when error is absent', async () => {
    const spy = emitSpy();
    const out = await loop.transition(
      input({
        state: makeState('REFLECT', { analysis: 'self-diagnosis' }),
        llm: stubLLM({ text: JSON.stringify({ action: 'think' }) }),
        emit: spy.fn,
      }),
    );
    // ReflectionResult should contain the analysis info
    expect(out.nextStates[0].state.type).toBe('THINK');
  });

  it('uses empty string when both error and analysis are absent', async () => {
    const out = await loop.transition(
      input({
        state: makeState('REFLECT', {}),
        llm: stubLLM({ text: JSON.stringify({ action: 'think' }) }),
      }),
    );
    expect(out.nextStates[0].state.type).toBe('THINK');
  });
});

// ========== TERMINATE ==========

describe('TERMINATE', () => {
  it('sets terminate = true', async () => {
    const out = await loop.transition(
      input({ state: makeState('TERMINATE', { reason: 'done' }) }),
    );
    expect(out.terminate).toBe(true);
    expect(out.terminateReason).toBe('done');
  });

  it('uses currentOutput when available', async () => {
    const out = await loop.transition(
      input({
        state: makeState('TERMINATE', { reason: 'done' }),
        currentOutput: 'final answer',
      }),
    );
    expect(out.output).toBe('final answer');
  });

  it('falls back to last assistant message when no currentOutput', async () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'the answer' },
    ];
    const out = await loop.transition(
      input({
        state: makeState('TERMINATE', { reason: 'done' }),
        messages: msgs,
        currentOutput: null,
      }),
    );
    expect(out.output).toBe('the answer');
  });

  it('falls back to empty string when no messages at all', async () => {
    const out = await loop.transition(
      input({ state: makeState('TERMINATE', { reason: 'done' }) }),
    );
    expect(out.output).toBe('');
  });

  it('uses default reason when not provided', async () => {
    const out = await loop.transition(
      input({ state: makeState('TERMINATE', {}) }),
    );
    expect(out.terminateReason).toBe('done');
  });

  it('emits Terminate event', async () => {
    const spy = emitSpy();
    await loop.transition(
      input({
        state: makeState('TERMINATE', { reason: 'finished' }),
        emit: spy.fn,
      }),
    );
    const evt = spy.calls.find(([t]) => t === Events.Terminate);
    expect(evt).toBeDefined();
    expect((evt![1] as any).reason).toBe('finished');
  });

  it('produces no next states', async () => {
    const out = await loop.transition(
      input({ state: makeState('TERMINATE', { reason: 'bye' }) }),
    );
    expect(out.nextStates).toHaveLength(0);
  });
});
