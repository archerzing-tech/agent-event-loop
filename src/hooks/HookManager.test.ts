import { describe, it, expect } from 'bun:test';
import { HookManager, LoggerHook } from './HookManager.ts';
import { makeState, type AgentState } from '../types/states.ts';
import type { AgentHook, LLMContext, ToolContext, ToolResult } from '../types/config.ts';

const dummyState = () => makeState('THINK', { task: 'test' });
const dummyLLMCtx = (): LLMContext => ({
  request: { messages: [{ role: 'user', content: 'hi' }], intent: 'think' },
});
const dummyToolCtx = (): ToolContext => ({
  call: { id: 'call-1', name: 'search', params: { query: 'test' } },
});
const dummyResult = (ok = true): ToolResult => ({
  ok,
  content: ok ? 'result' : null,
  ...(ok ? {} : { error: 'failed' }),
});

describe('HookManager — empty / no hooks', () => {
  it('passes through with empty constructor', async () => {
    const hm = new HookManager();
    const s = dummyState();
    expect(await hm.beforeState(s)).toBe(s);
    expect(await hm.beforeLLM(dummyLLMCtx())).toEqual(dummyLLMCtx());
    expect(await hm.beforeTool(dummyToolCtx())).toEqual(dummyToolCtx());
    expect(await hm.afterTool(dummyResult())).toEqual(dummyResult());
    // afterState should not throw
    await expect(hm.afterState(s)).resolves.toBeUndefined();
  });
});

describe('HookManager — beforeState', () => {
  it('passes state through a modifying hook', async () => {
    const hook: AgentHook = {
      beforeState: async (s) => ({ ...s, data: { ...s.data, modified: true } }),
    };
    const hm = new HookManager([hook]);
    const result = await hm.beforeState(dummyState());
    expect(result).not.toBe('abort');
    expect((result as AgentState).data.modified).toBe(true);
  });

  it('aborts when hook returns "abort"', async () => {
    const hook: AgentHook = {
      beforeState: async () => 'abort' as const,
    };
    const hm = new HookManager([hook]);
    expect(await hm.beforeState(dummyState())).toBe('abort');
  });

  it('chains multiple beforeState hooks in order', async () => {
    const log: string[] = [];
    const hookA: AgentHook = {
      beforeState: async (s) => {
        log.push('a');
        return { ...s, data: { ...s.data, step: 'a' } };
      },
    };
    const hookB: AgentHook = {
      beforeState: async (s) => {
        log.push('b');
        return { ...s, data: { ...s.data, step: 'b' } };
      },
    };
    const hm = new HookManager([hookA, hookB]);
    const result = await hm.beforeState(dummyState());
    expect(log).toEqual(['a', 'b']);
    expect(result).not.toBe('abort');
    expect((result as AgentState).data.step).toBe('b'); // last wins
  });

  it('stops chaining on abort', async () => {
    const log: string[] = [];
    const hookA: AgentHook = {
      beforeState: async () => 'abort' as const,
    };
    const hookB: AgentHook = {
      beforeState: async (s) => {
        log.push('b');
        return s;
      },
    };
    const hm = new HookManager([hookA, hookB]);
    expect(await hm.beforeState(dummyState())).toBe('abort');
    expect(log).toEqual([]); // hookB never called
  });
});

describe('HookManager — afterState', () => {
  it('calls afterState on all hooks', async () => {
    const log: string[] = [];
    const hookA: AgentHook = { afterState: async () => { log.push('a'); } };
    const hookB: AgentHook = { afterState: async () => { log.push('b'); } };
    const hm = new HookManager([hookA, hookB]);
    await hm.afterState(dummyState());
    expect(log).toEqual(['a', 'b']);
  });

  it('does not throw when no afterState hooks defined', async () => {
    const hm = new HookManager([{ beforeState: async (s) => s }]);
    await expect(hm.afterState(dummyState())).resolves.toBeUndefined();
  });
});

describe('HookManager — beforeLLM', () => {
  it('passes context through', async () => {
    const hook: AgentHook = {
      beforeLLM: async (ctx) => ({
        request: { ...ctx.request, temperature: 0.5 },
      }),
    };
    const hm = new HookManager([hook]);
    const result = await hm.beforeLLM(dummyLLMCtx());
    expect(result).not.toBe('abort');
    expect((result as LLMContext).request.temperature).toBe(0.5);
  });

  it('returns "abort" to cancel LLM call', async () => {
    const hook: AgentHook = {
      beforeLLM: async () => 'abort' as const,
    };
    const hm = new HookManager([hook]);
    expect(await hm.beforeLLM(dummyLLMCtx())).toBe('abort');
  });

  it('chains multiple beforeLLM hooks', async () => {
    const log: string[] = [];
    const hookA: AgentHook = {
      beforeLLM: async (ctx) => {
        log.push('a');
        const req = { ...ctx.request, messages: [...ctx.request.messages, { role: 'user' as const, content: 'extra' }] };
        return { request: req };
      },
    };
    const hookB: AgentHook = {
      beforeLLM: async (ctx) => {
        log.push('b');
        return { request: { ...ctx.request, temperature: 0.1 } };
      },
    };
    const hm = new HookManager([hookA, hookB]);
    const result = await hm.beforeLLM(dummyLLMCtx());
    expect(log).toEqual(['a', 'b']);
    expect(result).not.toBe('abort');
    const llmCtx = result as LLMContext;
    expect(llmCtx.request.temperature).toBe(0.1);
    expect(llmCtx.request.messages).toHaveLength(2);
  });
});

describe('HookManager — beforeTool', () => {
  it('passes context through', async () => {
    const hook: AgentHook = {
      beforeTool: async (ctx) => ctx,
    };
    const hm = new HookManager([hook]);
    const result = await hm.beforeTool(dummyToolCtx());
    expect(result).not.toBe('deny');
    expect((result as ToolContext).call.name).toBe('search');
  });

  it('denies tool execution', async () => {
    const hook: AgentHook = {
      beforeTool: async () => 'deny' as const,
    };
    const hm = new HookManager([hook]);
    expect(await hm.beforeTool(dummyToolCtx())).toBe('deny');
  });

  it('denies specific tool by name', async () => {
    const rateLimit: AgentHook = {
      beforeTool: async (ctx) => {
        if (ctx.call.name === 'search') return 'deny';
        return ctx;
      },
    };
    const hm = new HookManager([rateLimit]);

    const searchCall: ToolContext = { call: { id: 'c1', name: 'search', params: {} } };
    const calcCall: ToolContext = { call: { id: 'c2', name: 'calculator', params: {} } };

    expect(await hm.beforeTool(searchCall)).toBe('deny');
    expect(await hm.beforeTool(calcCall)).toEqual(calcCall);
  });

  it('chains hooks with deny in middle', async () => {
    const log: string[] = [];
    const hookA: AgentHook = {
      beforeTool: async (ctx) => {
        log.push('a');
        return ctx;
      },
    };
    const hookB: AgentHook = {
      beforeTool: async () => {
        log.push('b');
        return 'deny' as const;
      },
    };
    const hookC: AgentHook = {
      beforeTool: async (ctx) => {
        log.push('c');
        return ctx;
      },
    };
    const hm = new HookManager([hookA, hookB, hookC]);
    expect(await hm.beforeTool(dummyToolCtx())).toBe('deny');
    expect(log).toEqual(['a', 'b']); // hookC never called
  });
});

describe('HookManager — afterTool', () => {
  it('passes result through unchanged', async () => {
    const hook: AgentHook = {
      afterTool: async (r) => r,
    };
    const hm = new HookManager([hook]);
    expect(await hm.afterTool(dummyResult(true))).toEqual({ ok: true, content: 'result' });
  });

  it('transforms result in hook', async () => {
    const hook: AgentHook = {
      afterTool: async (r) => ({ ...r, content: `wrapped: ${r.content}` }),
    };
    const hm = new HookManager([hook]);
    const result = await hm.afterTool(dummyResult(true));
    expect(result.content).toBe('wrapped: result');
  });

  it('chains multiple afterTool hooks', async () => {
    const hookA: AgentHook = {
      afterTool: async (r) => ({ ...r, content: `[${r.content}]` }),
    };
    const hookB: AgentHook = {
      afterTool: async (r) => ({ ...r, content: `${r.content}!` }),
    };
    const hm = new HookManager([hookA, hookB]);
    const result = await hm.afterTool(dummyResult(true));
    expect(result.content).toBe('[result]!');
  });

  it('handles error result in afterTool', async () => {
    const hook: AgentHook = {
      afterTool: async (r) => ({ ...r, error: r.error ? `enhanced: ${r.error}` : undefined }),
    };
    const hm = new HookManager([hook]);
    const errResult = dummyResult(false);
    const result = await hm.afterTool(errResult);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('enhanced: failed');
  });
});

describe('HookManager — use() dynamic registration', () => {
  it('adds hook after construction', async () => {
    const hm = new HookManager();
    const log: string[] = [];
    const hook: AgentHook = {
      afterState: async () => { log.push('dynamic'); },
    };

    hm.use(hook);
    await hm.afterState(dummyState());
    expect(log).toEqual(['dynamic']);
  });

  it('dynamically added hooks are invoked in order', async () => {
    const hm = new HookManager();
    const log: string[] = [];

    hm.use({ afterState: async () => { log.push('first'); } });
    hm.use({ afterState: async () => { log.push('second'); } });

    await hm.afterState(dummyState());
    expect(log).toEqual(['first', 'second']);
  });
});

describe('HookManager — mixed hooks (realistic scenarios)', () => {
  it('rate-limit + audit hook work together', async () => {
    const auditLog: string[] = [];

    const rateLimit: AgentHook = {
      beforeTool: async (ctx) => {
        if (ctx.call.name === 'search') return 'deny';
        return ctx;
      },
    };

    const audit: AgentHook = {
      beforeTool: async (ctx) => {
        auditLog.push(`tool:${ctx.call.name}`);
        return ctx;
      },
    };

    const hm = new HookManager([audit, rateLimit]);

    // search is denied, audit ran first
    const searchCall: ToolContext = { call: { id: 'c1', name: 'search', params: {} } };
    expect(await hm.beforeTool(searchCall)).toBe('deny');
    expect(auditLog).toEqual(['tool:search']);

    // calculator passes through
    const calcCall: ToolContext = { call: { id: 'c2', name: 'calculator', params: {} } };
    const calcResult = await hm.beforeTool(calcCall);
    expect(calcResult).toEqual(calcCall);
    expect(auditLog).toEqual(['tool:search', 'tool:calculator']);
  });

  it('LLM modifier + state modifier compose correctly', async () => {
    const llmModifier: AgentHook = {
      beforeLLM: async (ctx) => ({
        request: { ...ctx.request, temperature: 0.3 },
      }),
    };

    const stateModifier: AgentHook = {
      beforeState: async (s) => ({ ...s, data: { ...s.data, enriched: true } }),
    };

    const hm = new HookManager([stateModifier, llmModifier]);

    const stateResult = await hm.beforeState(dummyState());
    expect(stateResult).not.toBe('abort');
    expect((stateResult as AgentState).data.enriched).toBe(true);

    const llmResult = await hm.beforeLLM(dummyLLMCtx());
    expect(llmResult).not.toBe('abort');
    expect((llmResult as LLMContext).request.temperature).toBe(0.3);
  });
});

describe('LoggerHook', () => {
  it('exists and has afterState handler', () => {
    expect(LoggerHook).toBeDefined();
    expect(typeof LoggerHook.afterState).toBe('function');
  });
});
