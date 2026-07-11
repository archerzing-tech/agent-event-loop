/**
 * 复杂验证 demo —— 离线、确定性、覆盖设计文档的关键高级能力：
 *
 *  A. 多工具编排：search → calculator → 总结（连续 ACT/OBSERVE/THINK）
 *  B. VERIFY → REFINE → VERIFY：验证未通过后精炼重试，最终通过
 *  C. REFLECT 自愈：工具执行失败 → OBSERVE → REFLECT → 修正重试 → 成功
 *  D. 预算耗尽：maxTurns 触发，主循环强制注入 TERMINATE
 *  E. 钩子拦截：beforeTool 限流拒绝 → 工具失败 → REFLECT 自愈
 *
 * 运行：bun run demo:complex
 */
import { Glob } from 'bun';
import {
  AgentHarness,
  type AgentEventLoopConfig,
  type AgentHook,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ToolCall,
  type ToolResult,
} from '../src/index.ts';

// ---------- 脚本化 LLM（确定性驱动高级状态路径） ----------
type ScriptStep = (req: LLMRequest) => LLMResponse;

class ScriptedLLMProvider implements LLMProvider {
  private idx = 0;
  constructor(private steps: ScriptStep[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (this.idx < this.steps.length) return this.steps[this.idx++](req);
    return { text: '（兜底）结论：任务已完成。' };
  }
}

const tc = (name: string, params: Record<string, unknown>): ToolCall => ({
  id: `call-${Math.random().toString(36).slice(2, 8)}`,
  name,
  params,
});

// ---------- 工具 ----------
const calculator = {
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

const search = {
  name: 'search',
  description: '模拟网络搜索',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  sideEffects: false,
  handler: async (p: Record<string, unknown>): Promise<ToolResult> => ({
    ok: true,
    content: { query: String(p.query), results: [`资料A(${String(p.query)})`, `资料B(${String(p.query)})`] },
  }),
};

const weather = {
  name: 'weather',
  description: '查询天气（有副作用，顺序执行）',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  sideEffects: true,
  handler: async (p: Record<string, unknown>): Promise<ToolResult> => ({
    ok: true,
    content: { city: String(p.city), temp: 22, condition: '晴' },
  }),
};

// ---------- 场景配置 ----------
function config(
  id: string,
  provider: LLMProvider,
  opts: { maxTurns?: number; hooks?: AgentHook[]; checkpoint?: boolean } = {}
): AgentEventLoopConfig {
  return {
    sessionId: id,
    budget: {
      maxTurns: opts.maxTurns ?? 20,
      maxTotalTokens: 5000,
      maxIterations: 100,
      maxExecutionTime: 30000,
    },
    llm: { provider: 'script', model: 'script-1' },
    llmProvider: provider,
    tools: { calculator, search, weather },
    hooks: opts.hooks,
    checkpoint: opts.checkpoint
      ? { enabled: true, dbPath: `./data/${id}.sqlite`, interval: 2, snapshotDir: `./data/${id}-snaps` }
      : { enabled: false, dbPath: '', interval: 2, snapshotDir: '' },
    verbose: false,
  };
}

function runScenario(label: string, agent: AgentHarness, prompt: string) {
  const seen = new Set<string>();
  agent.onAny((e) => {
    const icon: Record<string, string> = {
      StateStart: '▶️', ToolExecStart: '🔧', ToolExecEnd: '✅',
      ReflectionResult: '🪞', Terminate: '🏁',
    };
    if (icon[e.type]) {
      const p = e.payload as any;
      if (e.type === 'ToolExecEnd') console.log(`      ${icon[e.type]} ${p.name} ok=${p.ok}`);
      else if (e.type === 'StateStart') console.log(`      ${icon[e.type]} ${p.type}${p.urgent ? '(紧急)' : ''}`);
      else if (e.type === 'ReflectionResult') console.log(`      ${icon[e.type]} ${JSON.stringify(p)}`);
      else if (e.type === 'Terminate') console.log(`      ${icon[e.type]} reason=${JSON.stringify(p)}`);
    }
  });
  return agent.run(prompt).then((r) => {
    console.log(`\n  --- ${label} 结果 ---`);
    console.log(`  terminatedBy=${r.terminatedBy} turns=${r.turns} iterations=${r.iterations} tokens=${r.totalTokens}`);
    console.log(`  output=${r.output}`);
    return r;
  });
}

async function main() {
  // A. 多工具编排
  console.log('\n########## A. 多工具编排 search→calculator→总结 ##########');
  {
    const llm = new ScriptedLLMProvider([
      () => ({ toolCalls: [tc('search', { query: 'Agent Event Loop' })] }),
      () => ({ toolCalls: [tc('calculator', { expression: '100 * 3 / 2' })] }),
      (req) => {
        const tool = req.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('；');
        return { text: `基于资料与计算（${tool}），结论是：该架构可显著提升调度确定性。` };
      },
      () => ({ text: JSON.stringify({ pass: true, reason: '含明确结论' }) }),
    ]);
    await runScenario('A', new AgentHarness(config('A', llm)), '调研 Agent Event Loop 并核算 100*3/2');
  }

  // B. VERIFY→REFINE→VERIFY
  console.log('\n########## B. 验证未通过→精炼重试→通过 ##########');
  {
    const llm = new ScriptedLLMProvider([
      () => ({ text: '初稿：今天天气不错。' }),
      () => ({ text: JSON.stringify({ pass: false, reason: '缺乏结构与要点' }) }),
      () => ({ text: '修订稿：1) 天气晴 22℃；2) 适合户外活动；3) 建议带防晒。' }),
      () => ({ text: JSON.stringify({ pass: true, reason: '结构化且完整' }) }),
    ]);
    await runScenario('B', new AgentHarness(config('B', llm)), '写一段关于今天天气的总结');
  }

  // C. REFLECT 自愈：工具失败
  console.log('\n########## C. 工具失败→REFLECT→修正重试 ##########');
  {
    const llm = new ScriptedLLMProvider([
      () => ({ toolCalls: [tc('calculator', { expression: '1 + abc' })] }), // 非法表达式 -> 失败
      () => ({ text: JSON.stringify({ action: 'think', reason: '修正表达式为合法算式' }) }),
      () => ({ toolCalls: [tc('calculator', { expression: '6 * 7' })] }), // 修正后成功
      (req) => {
        const tool = req.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('；');
        return { text: `修正后计算结果为：${tool}。` };
      },
      () => ({ text: JSON.stringify({ pass: true, reason: '完成' }) }),
    ]);
    await runScenario('C', new AgentHarness(config('C', llm)), '计算 1+abc 然后修正');
  }

  // D. 预算耗尽
  console.log('\n########## D. 预算耗尽（maxTurns=2）强制终止 ##########');
  {
    const llm = new ScriptedLLMProvider([
      () => ({ toolCalls: [tc('search', { query: '无限主题' })] }),
      () => ({ toolCalls: [tc('search', { query: '第二跳' })] }),
      () => ({ toolCalls: [tc('search', { query: '第三跳' })] }),
    ]);
    await runScenario('D', new AgentHarness(config('D', llm, { maxTurns: 2 })), '不断检索直到预算耗尽');
  }

  // E. 钩子拦截：限流拒绝 search
  console.log('\n########## E. 钩子 beforeTool 拒绝→REFLECT 自愈 ##########');
  {
    const rateLimitHook: AgentHook = {
      beforeTool: async (ctx) => {
        if (ctx.call.name === 'search') {
          console.log(`      🚫 hook 拒绝 search（限流）`);
          return 'deny';
        }
        return ctx;
      },
    };
    const llm = new ScriptedLLMProvider([
      () => ({ toolCalls: [tc('search', { query: '被限流的主题' })] }),
      () => ({ text: JSON.stringify({ action: 'think', reason: 'search 被拒，改用本地知识回答' }) }),
      () => ({ text: '基于本地知识：该主题要点为 X、Y、Z。' }),
      () => ({ text: JSON.stringify({ pass: true, reason: '完成' }) }),
    ]);
    await runScenario('E', new AgentHarness(config('E', llm, { hooks: [rateLimitHook] })), '检索被限流的主题');
  }

  // F. 持久化 + 恢复（检查点/快照）
  console.log('\n########## F. 持久化与崩溃恢复 ##########');
  {
    const llm = new ScriptedLLMProvider([
      () => ({ toolCalls: [tc('calculator', { expression: '9 * 9' })] }),
      (req) => ({ text: `结果：${req.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('；')}` }),
      () => ({ text: JSON.stringify({ pass: true, reason: '完成' }) }),
    ]);
    const id = 'F';
    const first = new AgentHarness(config(id, llm, { checkpoint: true }));
    const r1 = await runScenario('F-第一轮', first, '计算 9*9（保留检查点）');
    // 用同一 sessionId 重新构造，应从最新快照恢复
    const llm2 = new ScriptedLLMProvider([
      () => ({ text: '恢复后的补充结论。' }),
      () => ({ text: JSON.stringify({ pass: true, reason: '完成' }) }),
    ]);
    const resumed = new AgentHarness(config(id, llm2, { checkpoint: true }));
    const r2 = await runScenario('F-恢复', resumed, '继续');
    console.log(`      restored=${r2.restored}`);
    const snaps = Array.from(new Glob('snapshot_*.json').scanSync({ cwd: `./data/${id}-snaps`, absolute: true }));
    console.log(`      持久化快照数=${snaps.length}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
