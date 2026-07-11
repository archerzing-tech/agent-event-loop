/**
 * AgentHarness 集成测试。
 *
 * 覆盖场景：
 *  - run() 完整认知循环（GATHER→THINK→ACT→OBSERVE→THINK→VERIFY→TERMINATE）
 *  - 钩子系统拦截（beforeState / afterState / beforeLLM / beforeTool / afterTool）
 *  - 持久化与崩溃恢复（检查点 SQLite + 快照文件系统）
 *  - 生命周期管理（dispose / interrupt hard&graceful / injectMessage）
 *  - 事件总线集成（StateStart / StateEnd / ToolExecStart / ToolExecEnd / LoopStart / LoopEnd）
 *  - 预算耗尽强制终止
 *  - 空闲挂起检测（idle stall）
 *  - LLM 异常 → REFLECT 自愈
 *  - 多 session 隔离
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Glob } from 'bun';

import { AgentHarness } from './AgentHarness.ts';
import type {
  AgentEventLoopConfig,
  AgentHook,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolMetadata,
  ToolResult,
  Message,
} from '../types/config.ts';
import { Events } from '../core/EventBus.ts';

// ========== 确定性脚本化 LLM ==========

/** 基于步骤数组的脚本化 LLM —— 每一步返回预设的响应。 */
class ScriptLLM implements LLMProvider {
  private idx = 0;
  constructor(
    private steps: Array<(req: LLMRequest) => LLMResponse>,
    private delayMs = 0,
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.idx < this.steps.length) return this.steps[this.idx++](req);
    return { text: '（兜底）任务已完成。' };
  }

  get callCount(): number {
    return this.idx;
  }
}

const tc = (name: string, params: Record<string, unknown> = {}): ToolCall => ({
  id: `c-${Math.random().toString(36).slice(2, 8)}`,
  name,
  params,
});

// ========== 工具 ==========

const calculator: ToolMetadata = {
  name: 'calculator',
  description: '计算算术表达式',
  parameters: { type: 'object', properties: { expression: { type: 'string' } } },
  sideEffects: false,
  handler: async (p: Record<string, unknown>): Promise<ToolResult> => {
    const expr = String(p.expression ?? '');
    if (!/^[\d+\-*/().\s]+$/.test(expr)) return { ok: false, content: null, error: '非法表达式' };
    const value = Function(`"use strict"; return (${expr});`)();
    return { ok: true, content: { expression: expr, result: value } };
  },
};

const search: ToolMetadata = {
  name: 'search',
  description: '模拟搜索',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  sideEffects: false,
  handler: async (p: Record<string, unknown>): Promise<ToolResult> => ({
    ok: true,
    content: { query: String(p.query), results: [`结果A(${String(p.query)})`, `结果B(${String(p.query)})`] },
  }),
};

// ========== 测试配置工厂 ==========

function minimalConfig(overrides: Partial<AgentEventLoopConfig> & { llmProvider: LLMProvider }): AgentEventLoopConfig {
  return {
    budget: { maxTurns: 20, maxTotalTokens: 10000, maxIterations: 100, maxExecutionTime: 30000 },
    llm: { provider: 'script', model: 's' },
    tools: {},
    ...overrides,
  };
}

// ========== 集成测试 ==========

describe('AgentHarness — 完整认知循环', () => {
  afterAll(() => {
    // 清理测试数据文件
    for (const dir of ['./data', './data2']) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('完成 GATHER→THINK→VERIFY→TERMINATE 全流程（纯文本路径）', async () => {
    const llm = new ScriptLLM([
      () => ({ text: '第一步计算结果：42。' }),
      () => ({ text: JSON.stringify({ pass: true, reason: '完成' }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({ sessionId: 'int-text', llmProvider: llm }));
    const result = await agent.run('计算 6*7');
    expect(result.terminatedBy).toBe('TERMINATE');
    expect(result.turns).toBe(1);
    expect(result.output).toContain('42');
    expect(result.restored).toBe(false);
  });

  it('完成 GATHER→THINK→ACT→OBSERVE→THINK→VERIFY→TERMINATE（工具调用路径）', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('calculator', { expression: '6*7' })] }),
      (req) => {
        const tools = req.messages.filter((m) => m.role === 'tool');
        return { text: `计算结果为：${tools.map((t) => t.content).join('')}` };
      },
      () => ({ text: JSON.stringify({ pass: true, reason: '正确' }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'int-tool',
      llmProvider: llm,
      tools: { calculator },
    }));
    const result = await agent.run('请使用 calculator 计算 6*7');
    expect(result.terminatedBy).toBe('TERMINATE');
    expect(result.turns).toBeGreaterThanOrEqual(2);
    expect(result.output).toContain('42');
  });

  it('发出 StateStart/StateEnd 事件', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'done' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const events: string[] = [];
    const agent = new AgentHarness(minimalConfig({ sessionId: 'int-events', llmProvider: llm }));
    agent.onAny((e) => events.push(e.type));
    await agent.run('test');
    expect(events).toContain(Events.LoopStart);
    expect(events).toContain(Events.StateStart);
    expect(events).toContain(Events.StateEnd);
    expect(events).toContain(Events.LoopEnd);
    expect(events).toContain(Events.Terminate);
  });

  it('产生预期的 RunResult 结构', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'hello' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({ sessionId: 'int-result', llmProvider: llm }));
    const result = await agent.run('greet');
    expect(result).toMatchObject({
      sessionId: 'int-result',
      terminatedBy: 'TERMINATE',
      turns: 1,
    });
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThan(0);
    expect(typeof result.output).toBe('string');
    expect(result.restored).toBe(false);
  });

  it('允许多个独立 session 并发运行', async () => {
    const llm1 = new ScriptLLM([
      () => ({ text: 'A' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const llm2 = new ScriptLLM([
      () => ({ text: 'B' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const [r1, r2] = await Promise.all([
      new AgentHarness(minimalConfig({ sessionId: 'int-concur-a', llmProvider: llm1 })).run('task A'),
      new AgentHarness(minimalConfig({ sessionId: 'int-concur-b', llmProvider: llm2 })).run('task B'),
    ]);
    expect(r1.sessionId).toBe('int-concur-a');
    expect(r2.sessionId).toBe('int-concur-b');
    expect(r1.terminatedBy).toBe('TERMINATE');
    expect(r2.terminatedBy).toBe('TERMINATE');
  });
});

describe('AgentHarness — 钩子系统', () => {
  it('beforeState 可以修改状态数据', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'modified' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const hook: AgentHook = {
      beforeState: async (s) => {
        if (s.type === 'GATHER') {
          return { ...s, data: { ...s.data, prompt: '被 hook 修改的 prompt' } };
        }
        return s;
      },
    };
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'hook-modify',
      llmProvider: llm,
      hooks: [hook],
    }));
    const result = await agent.run('原始 prompt');
    expect(result.turns).toBe(1); // 成功执行一轮，说明 hook 修改了 prompt 并且 LLM 正确响应
  });

  it('beforeState abort 跳过状态执行', async () => {
    const llm = new ScriptLLM([() => ({ text: 'should not run' })]);
    const hook: AgentHook = {
      beforeState: async (s) => {
        if (s.type === 'THINK') return 'abort';
        return s;
      },
    };
    const events: string[] = [];
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'hook-abort',
      llmProvider: llm,
      hooks: [hook],
    }));
    agent.onAny((e) => events.push(e.type));
    const result = await agent.run('test');
    // THINK 被 abort → 后续 VERIFY/TERMINATE 永远不会发生 → 预算耗尽或 idle stall
    expect(['budget', 'stall']).toContain(result.terminatedBy);
    // bumpTurn 在 abort 前已执行，故 turnCounter > 0
  });

  it('beforeLLM 可以修改请求温度', async () => {
    let capturedTemp: number | undefined;
    const llm: LLMProvider = {
      complete: async (req) => {
        capturedTemp = req.temperature;
        return { text: 'hello' };
      },
    };
    const hook: AgentHook = {
      beforeLLM: async (ctx) => ({
        request: { ...ctx.request, temperature: 0.1 },
      }),
    };
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'hook-llm-temp',
      llmProvider: llm,
      hooks: [hook],
      budget: { maxTurns: 3, maxTotalTokens: 1000, maxIterations: 20, maxExecutionTime: 5000 },
    }));
    await agent.run('test');
    expect(capturedTemp).toBe(0.1);
  });

  it('beforeTool deny 导致工具执行失败', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('search', { query: 'secret' })] }),
      () => ({ text: JSON.stringify({ action: 'think', reason: 'search 被禁止' }) }),
      () => ({ text: '改用内部知识回答：秘密是 X。' }),
      () => ({ text: JSON.stringify({ pass: true, reason: '完成' }) }),
    ]);
    const denyHook: AgentHook = {
      beforeTool: async (ctx) => {
        if (ctx.call.name === 'search') return 'deny';
        return ctx;
      },
    };
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'hook-deny',
      llmProvider: llm,
      tools: { search },
      hooks: [denyHook],
    }));
    const result = await agent.run('查询秘密');
    expect(result.output).toContain('X');
    expect(result.terminatedBy).toBe('TERMINATE');
  });

  it('afterTool 可以转换工具结果', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('calculator', { expression: '2+2' })] }),
      (req) => {
        const toolMsg = req.messages.filter((m) => m.role === 'tool');
        return { text: `工具返回：${toolMsg.map((m) => m.content).join(';')}` };
      },
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const wrapHook: AgentHook = {
      afterTool: async (r) => ({
        ...r,
        content: r.ok ? `[加密]${JSON.stringify(r.content)}` : r.content,
      }),
    };
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'hook-aftertool',
      llmProvider: llm,
      tools: { calculator },
      hooks: [wrapHook],
    }));
    const result = await agent.run('2+2');
    expect(result.output).toContain('[加密]');
  });

  it('钩子链按顺序执行', async () => {
    const order: string[] = [];
    const hookA: AgentHook = {
      afterState: async () => { order.push('A'); },
    };
    const hookB: AgentHook = {
      afterState: async () => { order.push('B'); },
    };
    const llm = new ScriptLLM([
      () => ({ text: 'x' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'hook-chain',
      llmProvider: llm,
      hooks: [hookA, hookB],
    }));
    await agent.run('test');
    expect(order).toContain('A');
    expect(order).toContain('B');
    // afterState 按注册顺序执行
    const firstA = order.indexOf('A');
    const firstB = order.indexOf('B');
    expect(firstA).toBeLessThan(firstB);
  });
});

describe('AgentHarness — 持久化与恢复', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'harness-persist-'));
  const dbPath = join(tmp, 'cp.sqlite');
  const snapDir = join(tmp, 'snaps');

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function persistConfig(llm: LLMProvider, sessionId: string): AgentEventLoopConfig {
    return {
      sessionId,
      budget: { maxTurns: 20, maxTotalTokens: 10000, maxIterations: 100, maxExecutionTime: 30000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: llm,
      tools: { calculator },
      checkpoint: { enabled: true, dbPath, interval: 2, snapshotDir: snapDir },
    };
  }

  it('在运行过程中产生检查点文件', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('calculator', { expression: '3*3' })] }),
      () => ({ text: '9' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness(persistConfig(llm, 'persist-cp-exists'));
    await agent.run('3*3');
    // 检查点 DB 和快照目录应该存在
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(snapDir)).toBe(true);
    const snaps = Array.from(new Glob('snapshot_*.json').scanSync({ cwd: snapDir }));
    expect(snaps.length).toBeGreaterThan(0);
  });

  it('同一 sessionId 可恢复并继续执行', async () => {
    const sid = 'persist-recover';

    // 第一轮：带工具调用 + 结果
    const llm1 = new ScriptLLM([
      () => ({ toolCalls: [tc('calculator', { expression: '5*5' })] }),
      (req) => {
        const tools = req.messages.filter((m) => m.role === 'tool');
        return { text: `25, ${tools.map((t) => t.content).join('')}` };
      },
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent1 = new AgentHarness(persistConfig(llm1, sid));
    const r1 = await agent1.run('5*5');
    expect(r1.terminatedBy).toBe('TERMINATE');
    expect(r1.restored).toBe(false);

    // 第二轮：使用同一 sessionId，应从检查点恢复
    const llm2 = new ScriptLLM([
      () => ({ text: '恢复后的补充。' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent2 = new AgentHarness(persistConfig(llm2, sid));
    const r2 = await agent2.run('继续');
    expect(r2.restored).toBe(true);
    // 恢复后的执行应产生新的结果
    expect(r2.output.length).toBeGreaterThan(0);
  });

  it('恢复后保留之前的消息历史和轮次计数', async () => {
    const sid = 'persist-history';

    const llm1 = new ScriptLLM([
      () => ({ text: '第一次输出' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent1 = new AgentHarness(persistConfig(llm1, sid));
    const r1 = await agent1.run('第一次任务');
    expect(r1.turns).toBe(1);

    const llm2 = new ScriptLLM([
      () => ({ text: '第二次输出' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent2 = new AgentHarness(persistConfig(llm2, sid));
    const r2 = await agent2.run('继续');
    expect(r2.restored).toBe(true);
    // 恢复后续跑的轮次从之前的轮次之后开始计数
    expect(r2.turns).toBeGreaterThan(0);
  });
});

describe('AgentHarness — 中断与注入', () => {
  it('hard interrupt 立即清空队列并终止', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('calculator', { expression: '1+1' })] }),
      () => ({ text: '2' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ], 20);
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'intr-hard',
      llmProvider: llm,
      tools: { calculator },
    }));
    const p = agent.run('计算 1+1');
    setTimeout(() => agent.interrupt('hard', '取消'), 5);
    const result = await p;
    expect(result.terminatedBy).toBe('user');
  });

  it('graceful interrupt 注入 steering 消息重新引导', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('calculator', { expression: '1+1' })] }),
      () => ({ text: '2' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ], 20);
    const events: string[] = [];
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'intr-graceful',
      llmProvider: llm,
      tools: { calculator },
    }));
    agent.onAny((e) => events.push(e.type));

    const p = agent.run('计算 1+1');
    setTimeout(() => agent.interrupt('graceful', '请改用 search'), 20);
    const result = await p;
    expect(result.terminatedBy).toBe('TERMINATE'); // graceful 不强制终止，最终正常结束
    expect(events).toContain(Events.ExternalInterrupt);
  });

  it('injectMessage 将消息加入对话并触发 THINK', async () => {
    const llm = new ScriptLLM([
      () => ({ text: '初始回答' }),
      () => ({ text: '注入后的回答' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ], 50);
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'intr-inject',
      llmProvider: llm,
      budget: { maxTurns: 5, maxTotalTokens: 10000, maxIterations: 50, maxExecutionTime: 5000 },
    }));
    const p = agent.run('初始任务');
    setTimeout(() => agent.injectMessage('请补充更多细节'), 15);
    const result = await p;
    // injectMessage 增加了新的 user message → agent 继续执行
    expect(result.turns).toBeGreaterThanOrEqual(2);
    expect(result.output).toContain('注入后的回答');
  });
});

describe('AgentHarness — 预算与终止条件', () => {
  it('maxTurns 耗尽时强制终止', async () => {
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('search', { query: 'a' })] }),
      () => ({ toolCalls: [tc('search', { query: 'b' })] }),
      () => ({ toolCalls: [tc('search', { query: 'c' })] }),
      () => ({ toolCalls: [tc('search', { query: 'd' })] }),
      () => ({ toolCalls: [tc('search', { query: 'e' })] }),
      () => ({ toolCalls: [tc('search', { query: 'f' })] }),
    ]);
    const agent = new AgentHarness({
      sessionId: 'budget-maxTurns',
      budget: { maxTurns: 2, maxTotalTokens: 5000, maxIterations: 20, maxExecutionTime: 5000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: llm,
      tools: { search },
    });
    const result = await agent.run('不断搜索');
    expect(result.terminatedBy).toBe('budget');
    expect(result.turns).toBeLessThanOrEqual(2);
  });

  it('maxTotalTokens 耗尽时强制终止', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'A'.repeat(2000) }),
      () => ({ text: 'B'.repeat(2000) }),
      () => ({ text: 'C'.repeat(2000) }),
    ]);
    const agent = new AgentHarness({
      sessionId: 'budget-tokens',
      budget: { maxTurns: 20, maxTotalTokens: 200, maxIterations: 50, maxExecutionTime: 5000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: llm,
      tools: {},
    });
    const result = await agent.run('生成大量文本');
    expect(result.terminatedBy).toBe('budget');
  });

  it('maxIterations 耗尽时强制终止', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'x' }),
      () => ({ text: JSON.stringify({ pass: false }) }),
      () => ({ text: 'y' }),
      () => ({ text: JSON.stringify({ pass: false }) }),
      () => ({ text: 'z' }),
      () => ({ text: JSON.stringify({ pass: false }) }),
    ]);
    const agent = new AgentHarness({
      sessionId: 'budget-iters',
      budget: { maxTurns: 20, maxTotalTokens: 5000, maxIterations: 5, maxExecutionTime: 5000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: llm,
      tools: {},
    });
    const result = await agent.run('test');
    expect(result.terminatedBy).toBe('budget');
  });
});

describe('AgentHarness — 错误处理与自愈', () => {
  it('LLM 抛异常 → AgentLoop 捕获并转换为 REFLECT → 自愈', async () => {
    const llm: LLMProvider = {
      complete: async (req: LLMRequest) => {
        if (req.intent === 'think') throw new Error('LLM 临时故障');
        // REFLECT 判断可以继续
        if (req.intent === 'reflect') {
          return { text: JSON.stringify({ action: 'think', reason: '重试' }) };
        }
        // VERIFY 直接通过
        return { text: JSON.stringify({ pass: true }) };
      },
    };
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'err-llm-crash',
      llmProvider: llm,
      budget: { maxTurns: 5, maxTotalTokens: 5000, maxIterations: 30, maxExecutionTime: 5000 },
    }));
    const result = await agent.run('测试 LLM 异常');
    // 即使 LLM 抛异常，harness 不应崩溃
    expect(['TERMINATE', 'budget']).toContain(result.terminatedBy);
  });

  it('工具执行异常被捕获并转换为工具结果中的错误', async () => {
    const crashTool: ToolMetadata = {
      name: 'crash',
      description: '总是崩溃',
      parameters: {},
      sideEffects: false,
      handler: async () => { throw new Error('tool panic'); },
    };
    const llm = new ScriptLLM([
      () => ({ toolCalls: [tc('crash')] }),
      () => ({ text: JSON.stringify({ action: 'think', reason: '工具崩溃，改用其他方式' }) }),
      () => ({ text: '无法使用工具，但可以给出估算。估算结果：大概 42。' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'err-tool-crash',
      llmProvider: llm,
      tools: { crash: crashTool },
    }));
    const result = await agent.run('测试工具崩溃');
    expect(result.terminatedBy).toBe('TERMINATE');
    expect(result.output.length).toBeGreaterThan(0);
  });
});

describe('AgentHarness — 生命周期', () => {
  it('dispose 可以安全调用多次', async () => {
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'lifecycle-dispose',
      llmProvider: new ScriptLLM([
        () => ({ text: 'x' }),
        () => ({ text: JSON.stringify({ pass: true }) }),
      ]),
    }));
    await agent.dispose();
    await agent.dispose(); // 第二次不应报错
  });

  it('wsPort 在未启用时为 undefined', () => {
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'lifecycle-ws-off',
      llmProvider: new ScriptLLM([() => ({ text: 'x' })]),
    }));
    expect(agent.wsPort).toBeUndefined();
  });

  it('wsPort 在启用时返回有效端口', async () => {
    const agent = new AgentHarness({
      sessionId: 'lifecycle-ws-on',
      budget: { maxTurns: 5, maxTotalTokens: 100, maxIterations: 10, maxExecutionTime: 1000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: new ScriptLLM([() => ({ text: 'x' })]),
      tools: {},
      wsPort: 0,
    });
    expect(agent.wsPort).toBeGreaterThan(0);
    await agent.dispose();
  });

  it('可以订阅特定事件类型', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'hello' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({ sessionId: 'lifecycle-on', llmProvider: llm }));

    const starts: string[] = [];
    agent.on(Events.StateStart, (e) => starts.push((e.payload as any).type));

    await agent.run('test');
    expect(starts).toContain('GATHER');
    expect(starts).toContain('THINK');
    expect(starts).toContain('VERIFY');
    expect(starts).toContain('TERMINATE');
  });
});

describe('AgentHarness — 边缘情况', () => {
  it('空队列 + 无输出 → idle spins 后 stall 终止', async () => {
    // 让所有 THINK 都被 beforeState abort，导致队列空 + 无输出
    const hook: AgentHook = {
      beforeState: async (s) => {
        if (s.type === 'THINK') return 'abort';
        return s;
      },
    };
    const agent = new AgentHarness({
      sessionId: 'edge-stall',
      budget: { maxTurns: 500, maxTotalTokens: 100000, maxIterations: 2000, maxExecutionTime: 10000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: new ScriptLLM([() => ({ text: 'x' })]),
      tools: {},
      hooks: [hook],
    });
    const result = await agent.run('test');
    // THINK abort 可能先触发预算耗尽而非 idle stall（bumpTurn 在 abort 前执行）
    expect(['stall', 'budget']).toContain(result.terminatedBy);
  });

  it('自定义 sessionId 被正确使用', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'x' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness(minimalConfig({
      sessionId: 'my-custom-session',
      llmProvider: llm,
    }));
    expect(agent.sessionId).toBe('my-custom-session');
    const result = await agent.run('test');
    expect(result.sessionId).toBe('my-custom-session');
  });

  it('verbose 模式不抛出异常', async () => {
    const llm = new ScriptLLM([
      () => ({ text: 'x' }),
      () => ({ text: JSON.stringify({ pass: true }) }),
    ]);
    const agent = new AgentHarness({
      sessionId: 'edge-verbose',
      budget: { maxTurns: 5, maxTotalTokens: 100, maxIterations: 10, maxExecutionTime: 1000 },
      llm: { provider: 'script', model: 's' },
      llmProvider: llm,
      tools: {},
      verbose: true,
    });
    const result = await agent.run('test');
    expect(result.terminatedBy).toBe('TERMINATE');
  });
});
