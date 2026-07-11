/**
 * AgentLoop 模糊测试（Fuzz Testing）。
 *
 * 核心不变式：AgentLoop.transition() 永远不抛异常——始终返回合法的 LoopOutput。
 * 无论输入多么畸形、LLM 多么不可靠、工具多么疯狂，纯状态机引擎必须保持稳定。
 *
 * 测试策略：
 *  - 为 LoopInput 每个字段生成随机值（合法 + 边界 + 畸形）
 *  - 为所有 8 种状态类型生成随机 data.payload
 *  - 随机化 LLM 行为（返回 null、抛异常、返回垃圾数据）
 *  - 随机化工具集（空、多工具、抛异常的工具）
 *  - 大量迭代（默认 500 轮）以覆盖组合空间
 */

import { describe, it, expect } from 'bun:test';
import { AgentLoop, type LoopInput, type LoopOutput } from './AgentLoop.ts';
import { makeState, type AgentState, type AgentStateType } from '../types/states.ts';
import type {
  LLMProvider,
  LLMResponse,
  LLMRequest,
  ToolMetadata,
  ToolResult,
  ToolCall,
  Message,
} from '../types/config.ts';

// ========== 随机生成器 ==========

/** 生成随机字符串（含边界情况）。 */
function randomString(maxLen = 100): string {
  const pool = [
    '',
    'a',
    '正常中文文本',
    'hello world',
    '{"json": "string"}',
    '<script>alert("xss")</script>',
    '\0null\0bytes',
    'a'.repeat(1000),
    '🔥'.repeat(50),
    '   ',
    '\n\t\r',
    undefined as any,
    null as any,
    NaN as any,
  ];
  const choice = pool[Math.floor(Math.random() * pool.length)];
  if (choice !== undefined && choice !== null && !Number.isNaN(choice)) {
    if (Math.random() < 0.3) return choice;
  }
  const len = Math.floor(Math.random() * maxLen);
  return Array.from({ length: len }, () =>
    String.fromCharCode(32 + Math.floor(Math.random() * 95)),
  ).join('');
}

/** 随机布尔值（有时返回非布尔值）。 */
function randomBool(): boolean {
  return Math.random() < 0.5;
}

/** 随机选取数组中的一项。 */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 随机状态类型（含非法值！）。 */
function randomStateType(): string {
  const valid: AgentStateType[] = ['GATHER', 'THINK', 'ACT', 'OBSERVE', 'VERIFY', 'REFINE', 'REFLECT', 'TERMINATE'];
  const invalid = ['', 'UNKNOWN', 'FLY', 'DANCE', '   ', 'gather_lowercase', '🦀', 'undefined', 'null'];
  return Math.random() < 0.85 ? pick(valid) : pick(invalid);
}

/** 随机优先级。 */
function randomPriority(): 'normal' | 'high' | 'urgent' {
  return pick(['normal', 'high', 'urgent', 'normal', 'normal', 'urgent' as any]);
}

/** 随机状态。 */
function randomState(): AgentState {
  return {
    type: randomStateType() as AgentStateType,
    id: `fuzz-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Math.random() < 0.9 ? Date.now() : (pick([0, -1, NaN, Infinity] as any)),
    priority: randomPriority(),
    data: randomData(),
  };
}

/** 随机状态 data 负载。 */
function randomData(): Record<string, unknown> {
  if (Math.random() < 0.1) return pick([{}, null, undefined] as any) ?? {};
  const data: Record<string, unknown> = {};
  const keys = ['prompt', 'toolCalls', 'results', 'answer', 'feedback', 'error', 'analysis', 'reason'];
  const count = Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i++) {
    const k = pick(keys);
    data[k] = randomDataValue();
  }
  // 偶尔添加随机键
  if (Math.random() < 0.3) {
    data[randomString(20)] = randomDataValue();
  }
  return data;
}

/** 随机 data 值。 */
function randomDataValue(): unknown {
  const choices: unknown[] = [
    randomString(),
    Math.random(),
    randomBool(),
    null,
    undefined,
    [],
    { nested: randomString() },
    [randomString(), 42, true, null],
    NaN,
    Infinity,
    -Infinity,
    BigInt ? BigInt(42) : 42,
  ];
  return pick(choices);
}

/** 随机工具调用。 */
function randomToolCall(): ToolCall {
  return {
    id: `call-fuzz-${Math.random().toString(36).slice(2, 8)}`,
    name: pick(['search', 'calculator', 'weather', 'file_read', '', '   ', 'unknown_tool_🔥', undefined as any]),
    params: randomData(),
  };
}

/** 随机消息。 */
function randomMessage(): Message {
  return {
    role: pick(['system', 'user', 'assistant', 'tool']),
    content: randomString(200),
    toolCall: Math.random() < 0.3 ? randomToolCall() : undefined,
  };
}

/** 随机消息列表（有时含畸形数据）。 */
function randomMessages(): Message[] {
  const count = Math.floor(Math.random() * 10);
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) msgs.push(randomMessage());
  // 偶尔插入非法 role
  if (Math.random() < 0.1) {
    (msgs as any).push({ role: 'alien', content: 'hack' });
  }
  // 偶尔返回 null/undefined
  if (Math.random() < 0.05) return null as any;
  return msgs;
}

/** 随机 LLM。 */
function randomLLM(): LLMProvider {
  const behaviors = [
    // 正常响应
    () => ({
      complete: async (_req: LLMRequest): Promise<LLMResponse> => ({
        text: randomString(500),
        toolCalls: Math.random() < 0.5 ? [randomToolCall(), randomToolCall()] : undefined,
      }),
    }),
    // 只返回 text
    () => ({
      complete: async (): Promise<LLMResponse> => ({ text: randomString(200) }),
    }),
    // 只返回 toolCalls
    () => ({
      complete: async (): Promise<LLMResponse> => ({ toolCalls: [randomToolCall()] }),
    }),
    // 返回空对象
    () => ({
      complete: async (): Promise<LLMResponse> => ({}),
    }),
    // 返回 null/undefined
    () => ({
      complete: async (): Promise<LLMResponse> => pick([null, undefined] as any),
    }),
    // 抛异常
    () => ({
      complete: async (): Promise<LLMResponse> => {
        throw new Error(randomString(50));
      },
    }),
    // 抛非 Error 对象
    () => ({
      complete: async (): Promise<LLMResponse> => {
        throw pick(['string error', 42, null, undefined, { code: 500 }, new Error('err')]);
      },
    }),
    // 极慢响应
    () => ({
      complete: async (): Promise<LLMResponse> => {
        await new Promise((r) => setTimeout(r, 1));
        return { text: 'slow' };
      },
    }),
    // 带流式
    () => ({
      complete: async (): Promise<LLMResponse> => ({ text: 'with stream' }),
      stream: async (_req: LLMRequest, onChunk: (chunk: string) => void): Promise<LLMResponse> => {
        for (const c of ['a', 'b', 'c']) {
          if (Math.random() < 0.2) throw new Error('stream error');
          onChunk(c);
        }
        return { text: 'streamed' };
      },
    }),
    // 流式始终抛异常
    () => ({
      complete: async (): Promise<LLMResponse> => ({ text: 'stream fail' }),
      stream: async (): Promise<LLMResponse> => { throw new Error('stream crashed'); },
    }),
  ];
  return pick(behaviors)();
}

/** 随机工具。 */
function randomTool(): ToolMetadata {
  const behaviors: Array<() => ToolMetadata> = [
    () => ({
      name: randomString(10),
      description: randomString(50),
      parameters: {},
      sideEffects: randomBool(),
      handler: async (p: Record<string, unknown>): Promise<ToolResult> => ({
        ok: randomBool(),
        content: pick([randomString(), { data: p }, null, [1, 2, 3]]),
        error: Math.random() < 0.3 ? randomString(50) : undefined,
      }),
    }),
    () => ({
      name: randomString(10),
      description: randomString(50),
      parameters: {},
      sideEffects: randomBool(),
      handler: async (): Promise<ToolResult> => { throw new Error(randomString(30)); },
    }),
    () => ({
      name: randomString(10),
      description: randomString(50),
      parameters: {},
      sideEffects: randomBool(),
      handler: async (): Promise<ToolResult> => { throw pick(['err', 0, null, undefined, { catastrophic: true }]); },
    }),
    () => ({
      name: randomString(10),
      description: randomString(50),
      parameters: {},
      sideEffects: randomBool(),
      handler: async (): Promise<ToolResult> => ({ ok: false, content: null, error: undefined }),
    }),
    () => ({
      name: randomString(10),
      description: randomString(50),
      parameters: {},
      sideEffects: randomBool(),
      handler: async (): Promise<ToolResult> => {
        // 极慢工具
        await new Promise((r) => setTimeout(r, 1));
        return { ok: true, content: 'slow tool' };
      },
    }),
  ];
  return pick(behaviors)();
}

/** 随机工具字典。 */
function randomTools(): Record<string, ToolMetadata> {
  const tools: Record<string, ToolMetadata> = {};
  const count = Math.floor(Math.random() * 5);
  for (let i = 0; i < count; i++) {
    const t = randomTool();
    tools[t.name] = t;
  }
  // 偶尔返回 null/undefined
  if (Math.random() < 0.05) return null as any;
  return tools;
}

/** 随机 emit 函数。 */
function randomEmit(): (type: string, payload?: unknown) => void {
  const behaviors = [
    () => ({} as any),                 // 空函数
    () => (_type: string, _payload?: unknown) => {}, // 静默
    () => (_type: string, _payload?: unknown) => { throw new Error('emit crashed'); }, // 抛异常
    () => (_type: string, _payload?: unknown) => { throw 'string throw'; }, // 抛字符串
    () => {
      let count = 0;
      return (_type: string, _payload?: unknown) => {
        if (count++ > 5) throw new Error('emit rate limit');
      };
    }, // 限流
    () => {
      // 递归发射
      const fn = (type: string, payload?: unknown) => {
        if (Math.random() < 0.1) fn('recursive', payload);
      };
      return fn;
    },
  ];
  return pick(behaviors)();
}

// ========== 模糊测试 ==========

const loop = new AgentLoop();
const ITERATIONS = 500;

describe('AgentLoop fuzz: transition() never throws', () => {
  it(`在 ${ITERATIONS} 轮随机输入下不抛异常`, async () => {
    const errors: Array<{ iteration: number; stateType: string; error: string }> = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const state = randomState();
      const input: LoopInput = {
        state,
        messages: randomMessages() ?? [],
        tools: randomTools() ?? {},
        llm: randomLLM(),
        refineAttempts: Math.random() < 0.5
          ? {}
          : { verify: Math.floor(Math.random() * 10) },
        currentOutput: Math.random() < 0.8 ? randomString(200) : null,
        emit: randomEmit(),
      };

      try {
        const result = await loop.transition(input);

        // 基本结构验证
        expect(result).toBeDefined();
        expect(Array.isArray(result.nextStates)).toBe(true);
        expect(Array.isArray(result.messages)).toBe(true);
        expect(typeof result.terminate).toBe('boolean');

        // 每个 nextState 必须是合法对象
        for (const ns of result.nextStates) {
          expect(ns.state).toBeDefined();
          expect(ns.state.type).toBeDefined();
          expect(typeof ns.state.type).toBe('string');
        }
      } catch (err) {
        errors.push({
          iteration: i,
          stateType: state.type,
          error: String(err),
        });
      }
    }

    // 断言：零异常
    if (errors.length > 0) {
      const sample = errors.slice(0, 5);
      console.error(`AgentLoop fuzz: ${errors.length}/${ITERATIONS} 轮抛出异常`);
      for (const e of sample) {
        console.error(`  #${e.iteration} state=${e.stateType}: ${e.error}`);
      }
    }
    expect(errors).toHaveLength(0);
  });

  it('未知状态类型返回 REFLECT 而非崩溃', async () => {
    const unknownTypes = ['', '  ', 'UNKNOWN', 'fly', '🦀', 'DANCE', 'undefined' as any, null as any];
    for (const type of unknownTypes) {
      const state = { ...makeState('GATHER'), type: type as AgentStateType };
      const result = await loop.transition({
        state,
        messages: [],
        tools: {},
        llm: { complete: async () => ({ text: '' }) },
        refineAttempts: {},
        currentOutput: null,
        emit: () => {},
      });
      expect(result.nextStates[0].state.type).toBe('REFLECT');
      expect(result.terminate).toBe(false);
    }
  });

  it('在所有状态类型 + 各种 LLM 行为下稳定', async () => {
    const stateTypes: AgentStateType[] = ['GATHER', 'THINK', 'ACT', 'OBSERVE', 'VERIFY', 'REFINE', 'REFLECT', 'TERMINATE'];
    const llmBehaviors: LLMProvider[] = [
      { complete: async () => ({}) },
      { complete: async () => ({ text: null as any }) },
      { complete: async () => ({ toolCalls: null as any }) },
      { complete: async () => { throw '💥'; } },
      { complete: async () => ({ text: 'ok' }) },
    ];

    for (const st of stateTypes) {
      for (const llm of llmBehaviors) {
        const state = makeState(st, {
          prompt: 'fuzz',
          toolCalls: [randomToolCall()],
          results: [{ result: { ok: true, content: 'fuzz' } }],
          answer: 'fuzz answer',
          feedback: 'fuzz feedback',
          error: 'fuzz error',
          reason: 'fuzz done',
        });
        const result = await loop.transition({
          state,
          messages: [{ role: 'user', content: 'fuzz' }],
          tools: {},
          llm,
          refineAttempts: {},
          currentOutput: 'fuzz',
          emit: () => {},
        });
        expect(result).toBeDefined();
        expect(typeof result.terminate).toBe('boolean');
      }
    }
  });

  it('极长消息历史不导致崩溃', async () => {
    const longMessages: Message[] = [];
    for (let i = 0; i < 100; i++) {
      longMessages.push({
        role: 'assistant',
        content: 'x'.repeat(1000),
        toolCall: { id: `c${i}`, name: 'tool', params: { idx: i } },
      });
    }
    const result = await loop.transition({
      state: makeState('THINK'),
      messages: longMessages,
      tools: {},
      llm: { complete: async () => ({ text: 'done' }) },
      refineAttempts: {},
      currentOutput: 'x'.repeat(10000),
      emit: () => {},
    });
    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('大量工具调用并发执行不崩溃', async () => {
    const manyTools: Record<string, ToolMetadata> = {};
    const manyCalls: ToolCall[] = [];
    for (let i = 0; i < 50; i++) {
      const name = `tool-${i}`;
      manyTools[name] = {
        name,
        description: '',
        parameters: {},
        sideEffects: i % 3 === 0, // 每三个工具一个有副作用
        handler: async () => ({ ok: true, content: { idx: i } }),
      };
      manyCalls.push({ id: `c${i}`, name, params: { idx: i } });
    }
    const result = await loop.transition({
      state: makeState('ACT', { toolCalls: manyCalls }),
      messages: [],
      tools: manyTools,
      llm: { complete: async () => ({ text: '' }) },
      refineAttempts: {},
      currentOutput: null,
      emit: () => {},
    });
    expect(result).toBeDefined();
    expect(result.nextStates[0].state.type).toBe('OBSERVE');
    expect(result.messages.length).toBe(50); // 每个工具一条消息
  });

  it('纯文本路径 LLM 返回超长字符串', async () => {
    const hugeText = 'A'.repeat(100000);
    const result = await loop.transition({
      state: makeState('THINK'),
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      llm: { complete: async () => ({ text: hugeText }) },
      refineAttempts: {},
      currentOutput: null,
      emit: () => {},
    });
    expect(result).toBeDefined();
    expect(result.output).toBe(hugeText);
    expect(result.tokenText).toBe(hugeText);
  });

  it('emit 抛异常不影响 transition 返回值', async () => {
    let emitThrowCount = 0;
    const throwingEmit = (type: string, payload?: unknown) => {
      emitThrowCount++;
      throw new Error(`emit error #${emitThrowCount}`);
    };
    const result = await loop.transition({
      state: makeState('THINK'),
      messages: [{ role: 'user', content: 'test' }],
      tools: {},
      llm: { complete: async () => ({ text: 'response' }) },
      refineAttempts: {},
      currentOutput: null,
      emit: throwingEmit,
    });
    // emit 抛异常应被 AgentLoop 的 catch 块捕获并转换为 REFLECT
    expect(result).toBeDefined();
    expect(result.nextStates[0].state.type).toBe('REFLECT');
    expect((result.nextStates[0].state.data.error as string)).toContain('emit error');
  });

  it('所有状态类型的 output 字段始终为 string | null', async () => {
    const types: AgentStateType[] = ['GATHER', 'THINK', 'ACT', 'OBSERVE', 'VERIFY', 'REFINE', 'REFLECT', 'TERMINATE'];
    for (const type of types) {
      for (let i = 0; i < 10; i++) {
        const result = await loop.transition({
          state: makeState(type, randomData()),
          messages: randomMessages() ?? [],
          tools: randomTools() ?? {},
          llm: randomLLM(),
          refineAttempts: {},
          currentOutput: Math.random() < 0.5 ? randomString(100) : null,
          emit: () => {},
        });
        // output must be string or null
        expect(result.output === null || typeof result.output === 'string').toBe(true);
        // nextStates must be array
        expect(Array.isArray(result.nextStates)).toBe(true);
        // messages must be array
        expect(Array.isArray(result.messages)).toBe(true);
        // tokenText must be string
        expect(typeof result.tokenText).toBe('string');
        // terminate must be boolean
        expect(typeof result.terminate).toBe('boolean');
      }
    }
  });
});
