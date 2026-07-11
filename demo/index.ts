/**
 * 最小验证 demo —— 离线可跑（无需 API Key）。
 *
 * 演示能力：
 *  1. 双队列状态调度（GATHER→THINK→ACT→OBSERVE→THINK→VERIFY→TERMINATE）
 *  2. 真实工具执行（calculator / search）
 *  3. 事件总线可观测（实时打印状态流转）
 *  4. 四维预算控制
 *  5. SQLite 检查点 + 文件系统快照持久化
 *  6. 外部中断（graceful / hard）
 *
 * 运行：bun run demo
 */
import { Glob } from 'bun';
import {
  AgentHarness,
  MockLLMProvider,
  type AgentEventLoopConfig,
  type ToolResult,
} from '../src/index.ts';

// ---- 真实工具（本地即可执行，用于验证工具调用闭环） ----
const calculator = {
  name: 'calculator',
  description: '计算算术表达式',
  parameters: { type: 'object', properties: { expression: { type: 'string' } } },
  sideEffects: false,
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const expr = String(params.expression ?? '');
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      return { ok: false, content: null, error: '非法表达式' };
    }
    const value = Function(`"use strict"; return (${expr});`)();
    return { ok: true, content: { expression: expr, result: value } };
  },
};

const search = {
  name: 'search',
  description: '模拟网络搜索',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  sideEffects: false,
  handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const query = String(params.query ?? '');
    return {
      ok: true,
      content: {
        query,
        results: [
          `关于“${query}”的权威资料 A`,
          `关于“${query}”的社区讨论 B`,
        ],
      },
    };
  },
};

function buildConfig(sessionId: string): AgentEventLoopConfig {
  return {
    sessionId,
    budget: {
      maxTurns: 12,
      maxTotalTokens: 5000,
      maxIterations: 60,
      maxExecutionTime: 30000,
    },
    llm: { provider: 'mock', model: 'mock-1' },
    llmProvider: new MockLLMProvider(),
    tools: { calculator, search },
    checkpoint: {
      enabled: true,
      dbPath: './data/checkpoints.sqlite',
      interval: 3,
      snapshotDir: './data/snapshots',
    },
    verbose: false,
  };
}

/** 漂亮的终端事件追踪。 */
function attachTrace(agent: AgentHarness) {
  const icons: Record<string, string> = {
    LoopStart: '🚀',
    StateStart: '▶️ ',
    ToolExecStart: '🔧',
    ToolExecEnd: '✅',
    ReflectionResult: '🪞',
    Terminate: '🏁',
    LoopEnd: '⏹ ',
  };
  agent.onAny((e) => {
    const icon = icons[e.type] ?? '·';
    if (e.type === 'StateStart') {
      const p = e.payload as any;
      console.log(`  ${icon} StateStart  ${p.type}${p.urgent ? ' (urgent)' : ''}`);
    } else if (e.type === 'ToolExecEnd') {
      const p = e.payload as any;
      console.log(`  ${icon} ${p.name} -> ok=${p.ok}`);
    } else if (e.type === 'Terminate') {
      console.log(`  ${icon} Terminate (${JSON.stringify(e.payload)})`);
    }
  });
}

async function main() {
  console.log('===== Demo 1: 完整认知循环 + 工具调用 =====');
  const agent = new AgentHarness(buildConfig('demo-1'));
  attachTrace(agent);

  const result = await agent.run('请使用 calculator 计算 (3 + 4) * 2 并给出结论');
  printResult(result);

  console.log('\n===== Demo 2: 外部硬中断 =====');
  const agent2 = new AgentHarness(buildConfig('demo-2'));
  attachTrace(agent2);
  // 启动后立刻硬中断，验证队列清空 + 立即终止
  const p = agent2.run('请规划一次长途旅行（被中断）');
  setTimeout(() => agent2.interrupt('hard', '用户取消'), 5);
  const r2 = await p;
  printResult(r2);

  console.log('\n===== Demo 3: 持久化文件检查 =====');
  const glob = new Glob('snapshot_*.json');
  const snaps = Array.from(glob.scanSync({ cwd: './data/snapshots', absolute: true }));
  console.log(`  快照文件数: ${snaps.length}`);
  console.log(`  检查点 DB: ./data/checkpoints.sqlite`);

  console.log('\n===== Demo 4: 崩溃恢复（同 sessionId 续跑） =====');
  const resumed = new AgentHarness(buildConfig('demo-1'));
  attachTrace(resumed);
  const r4 = await resumed.run('继续');
  console.log(`  restored=${r4.restored} turns=${r4.turns}`);
  printResult(r4);
}

function printResult(r: Awaited<ReturnType<AgentHarness['run']>>) {
  console.log('\n----- RunResult -----');
  console.log(JSON.stringify(
    {
      sessionId: r.sessionId,
      terminatedBy: r.terminatedBy,
      turns: r.turns,
      iterations: r.iterations,
      totalTokens: r.totalTokens,
      elapsedMs: r.elapsedMs,
      output: r.output,
    },
    null,
    2
  ));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
