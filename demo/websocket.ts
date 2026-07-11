/**
 * WebSocket 桥接 demo（设计文档 §6.2）。
 *
 * 启动 AgentEventLoop，启用 wsPort=0（OS 随机分配），
 * 进程内连接一个 WebSocket 客户端验证：
 *   1. 客户端能收到事件流（LoopStart / StateStart / ...）
 *   2. 客户端发送 INTERRUPT → agent 立即停止 → 收到 BridgeAck
 *
 * 真实场景下，浏览器或 wscat 等客户端连接同一 URL 即可观察。
 */
import {
  AgentHarness,
  type AgentEventLoopConfig,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ToolCall,
} from '../src/index.ts';

// 脚本化 LLM：连续 6 轮 THINK→ACT（tool call）才到最终文本，
// 演示期间能保证 INTERRUPT(hard) 来得及在 agent 终止前抵达。
class DemoScriptedLLM implements LLMProvider {
  private step = 0;
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    await new Promise((r) => setTimeout(r, 60));
    this.step++;
    if (this.step <= 6) {
      const call: ToolCall = {
        id: `c${this.step}`,
        name: 'search',
        params: { query: `第 ${this.step} 跳搜索` },
      };
      return { toolCalls: [call] };
    }
    return { text: `经过 ${this.step} 轮检索，结论：旅行规划完成。` };
  }
}

const config: AgentEventLoopConfig = {
  sessionId: 'ws-demo',
  budget: {
    maxTurns: 20,
    maxTotalTokens: 5000,
    maxIterations: 200,
    maxExecutionTime: 30000,
  },
  llm: { provider: 'script', model: 'script-1' },
  llmProvider: new DemoScriptedLLM(),
  tools: {},
  checkpoint: { enabled: false, dbPath: '', interval: 5, snapshotDir: '' },
  wsPort: 0,
  verbose: false,
};

const agent = new AgentHarness(config);
const url = `ws://127.0.0.1:${agent.wsPort}/agent-ws?sessionId=ws-demo`;

console.log(`🔌 WebSocket bridge listening on ${url}\n`);

const ws = new WebSocket(url);
const wsReady = new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = (e) => reject(e);
});

let eventCount = 0;
let interrupted = false;
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data as string) as { type: string; payload: unknown; timestamp: number };
  eventCount++;
  if (msg.type === 'LoopStart') console.log(`  ▶ LoopStart  sessionId=${(msg.payload as { sessionId: string }).sessionId}`);
  else if (msg.type === 'StateStart') console.log(`  · StateStart ${(msg.payload as { type: string }).type}`);
  else if (msg.type === 'Terminate') console.log(`  ⏹ Terminate ${JSON.stringify(msg.payload)}`);
  else if (msg.type === 'LoopEnd') console.log(`  ⏹ LoopEnd ${JSON.stringify(msg.payload)}`);
  else if (msg.type === 'BridgeAck') {
    console.log(`  ✓ BridgeAck ${JSON.stringify(msg.payload)}`);
    interrupted = true;
  }
  // 收到第一个 StateStart 立刻发 INTERRUPT（确保在 agent 终止前抵达）
  if (msg.type === 'StateStart' && !interrupted) {
    console.log('\n🛑 客户端发送 INTERRUPT(hard) ...');
    ws.send(JSON.stringify({ type: 'INTERRUPT', kind: 'hard', reason: 'demo-stop' }));
  }
};

await wsReady;

const result = await agent.run('请使用 search 检索旅行规划');
console.log('\n--- Result ---');
console.log(JSON.stringify({
  sessionId: result.sessionId,
  terminatedBy: result.terminatedBy,
  turns: result.turns,
  elapsedMs: result.elapsedMs,
}, null, 2));

ws.close();
await agent.dispose();

if (!interrupted) {
  console.error('\n❌ Demo 失败：未收到 BridgeAck');
  process.exit(1);
}
console.log(`\n✅ Demo 通过：共收到 ${eventCount} 条事件`);
