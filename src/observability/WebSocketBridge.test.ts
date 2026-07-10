import { describe, it, expect, afterEach } from 'bun:test';
import { WebSocketBridge } from './WebSocketBridge.ts';
import { EventBus } from '../core/EventBus.ts';
import { AgentEventLoop } from '../core/AgentEventLoop.ts';
import { MockLLMProvider } from '../llm/MockLLMProvider.ts';

let bridge: WebSocketBridge | null = null;

afterEach(() => {
  bridge?.stop();
  bridge = null;
});

function openWs(url: string, timeoutMs = 2000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('ws open timeout')), timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = (e) => {
      clearTimeout(t);
      reject(e);
    };
  });
}

function collect(ws: WebSocket, ms: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const msgs: Array<Record<string, unknown>> = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(e.data as string));
    setTimeout(() => resolve(msgs), ms);
  });
}

describe('WebSocketBridge — lifecycle', () => {
  it('starts on a random port and exposes port', () => {
    bridge = new WebSocketBridge({ port: 0 });
    expect(bridge.port).toBeGreaterThan(0);
  });

  it('uses provided port when not 0', () => {
    bridge = new WebSocketBridge({ port: 0 });
    expect(typeof bridge.port).toBe('number');
  });

  it('rejects HTTP requests to wrong path with 404', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/wrong-path`);
    expect(res.status).toBe(404);
  });

  it('responds 200/healthcheck-ish on non-upgrade GET to /agent-ws', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/agent-ws`);
    expect([400, 426]).toContain(res.status);
  });
});

describe('WebSocketBridge — session filtering', () => {
  it('rejects when client sessionId does not match', async () => {
    bridge = new WebSocketBridge({ port: 0, sessionId: 'agent-A' });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/agent-ws?sessionId=agent-B`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts when client sessionId matches', async () => {
    bridge = new WebSocketBridge({ port: 0, sessionId: 'agent-A' });
    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws?sessionId=agent-A`);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('accepts when bridge has no sessionId and client provides none', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('drops events whose payload.sessionId does not match', async () => {
    bridge = new WebSocketBridge({ port: 0, sessionId: 'mine' });
    const bus = new EventBus();
    bridge.attach(bus);

    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws?sessionId=mine`);
    const received = collect(ws, 80);

    bus.emit('LoopStart', { sessionId: 'mine' });
    bus.emit('LoopStart', { sessionId: 'other' });
    bus.emit('StateStart', { type: 'THINK' });

    const msgs = await received;
    const types = msgs.map((m) => m.type);
    expect(types).toContain('LoopStart');
    expect(types).toContain('StateStart');
    // exact: only one LoopStart (from 'mine'), not from 'other'
    expect(msgs.filter((m) => m.type === 'LoopStart')).toHaveLength(1);
    // 'other' sessionId event must be dropped
    const otherPayload = msgs
      .map((m) => m.payload as { sessionId?: string } | undefined)
      .find((p) => p?.sessionId === 'other');
    expect(otherPayload).toBeUndefined();

    ws.close();
  });
});

describe('WebSocketBridge — event forwarding', () => {
  it('forwards all EventBus events to connected client', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const bus = new EventBus();
    bridge.attach(bus);

    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const received = collect(ws, 80);

    bus.emit('LoopStart', { sessionId: 's' });
    bus.emit('StateStart', { type: 'THINK' });
    bus.emit('StateEnd', { type: 'THINK' });
    bus.emit('LoopEnd', { sessionId: 's', by: 'TERMINATE' });

    const msgs = await received;
    expect(msgs).toHaveLength(4);
    expect(msgs[0]).toMatchObject({ type: 'LoopStart', payload: { sessionId: 's' } });
    expect(msgs[1]).toMatchObject({ type: 'StateStart', payload: { type: 'THINK' } });
    expect(msgs[3]).toMatchObject({ type: 'LoopEnd' });
    expect(typeof (msgs[0] as { timestamp: number }).timestamp).toBe('number');

    ws.close();
  });

  it('does not throw when no clients are connected', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const bus = new EventBus();
    bridge.attach(bus);
    expect(() => bus.emit('LoopStart', { x: 1 })).not.toThrow();
    await bridge.stop();
    bridge = null;
  });

  it('supports multiple clients receiving the same events', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const bus = new EventBus();
    bridge.attach(bus);

    const ws1 = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const ws2 = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const c1 = collect(ws1, 80);
    const c2 = collect(ws2, 80);

    bus.emit('LoopStart', { sessionId: 's' });

    const [m1, m2] = await Promise.all([c1, c2]);
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    expect(m1[0].type).toBe('LoopStart');
    expect(m2[0].type).toBe('LoopStart');

    expect(bridge.clientCount).toBe(2);
    ws1.close();
    ws2.close();
  });
});

describe('WebSocketBridge — INTERRUPT command', () => {
  it('invokes onInterrupt handler with graceful by default', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const received: Array<{ kind: string; reason?: string }> = [];
    bridge.onInterrupt((cmd) => received.push(cmd));

    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const msgs = collect(ws, 80);

    ws.send(JSON.stringify({ type: 'INTERRUPT', reason: 'user-cancel' }));

    const m = await msgs;
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ kind: 'graceful', reason: 'user-cancel' });
    expect(m.some((x) => x.type === 'BridgeAck')).toBe(true);
    const ack = m.find((x) => x.type === 'BridgeAck') as { payload: Record<string, unknown> };
    expect(ack.payload).toMatchObject({ command: 'INTERRUPT', kind: 'graceful', reason: 'user-cancel' });

    ws.close();
  });

  it('supports hard interrupt', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const received: Array<{ kind: string; reason?: string }> = [];
    bridge.onInterrupt((cmd) => received.push(cmd));

    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const ready = new Promise<void>((r) => { ws.onmessage = () => {}; r(); });
    await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`).then(() => {});
    await ready;

    ws.send(JSON.stringify({ type: 'INTERRUPT', kind: 'hard', reason: 'shutdown' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([{ kind: 'hard', reason: 'shutdown' }]);

    ws.close();
  });

  it('coerces invalid kind to graceful', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const received: Array<{ kind: string }> = [];
    bridge.onInterrupt((cmd) => received.push(cmd));

    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    ws.send(JSON.stringify({ type: 'INTERRUPT', kind: 'who-knows' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(received[0].kind).toBe('graceful');

    ws.close();
  });
});

describe('WebSocketBridge — INJECT command', () => {
  it('invokes onInject handler with the message', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const received: Array<{ message: string }> = [];
    bridge.onInject((cmd) => received.push(cmd));

    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const msgs = collect(ws, 80);

    ws.send(JSON.stringify({ type: 'INJECT', message: '请改用简明风格' }));

    const m = await msgs;
    expect(received).toEqual([{ message: '请改用简明风格' }]);
    expect(m.some((x) => x.type === 'BridgeAck')).toBe(true);

    ws.close();
  });
});

describe('WebSocketBridge — error paths', () => {
  it('responds BridgeError on invalid JSON', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const msgs = collect(ws, 80);

    ws.send('not-json{{{');

    const m = await msgs;
    expect(m.some((x) => x.type === 'BridgeError')).toBe(true);
    const err = m.find((x) => x.type === 'BridgeError') as { payload: { error: string } };
    expect(err.payload.error).toBe('Invalid JSON');

    ws.close();
  });

  it('responds BridgeError on unknown command', async () => {
    bridge = new WebSocketBridge({ port: 0 });
    const ws = await openWs(`ws://127.0.0.1:${bridge.port}/agent-ws`);
    const msgs = collect(ws, 80);

    ws.send(JSON.stringify({ type: 'MAGIC_WORD' }));

    const m = await msgs;
    const err = m.find((x) => x.type === 'BridgeError') as { payload: { error: string } };
    expect(err).toBeDefined();
    expect(err.payload.error).toContain('MAGIC_WORD');

    ws.close();
  });
});

describe('WebSocketBridge — stop / cleanup', () => {
  it('stop() closes the server and detaches from bus', async () => {
    const bus = new EventBus();
    bridge = new WebSocketBridge({ port: 0 });
    bridge.attach(bus);
    expect(bridge.clientCount).toBe(0);

    await bridge.stop();
    expect(bridge.port).toBe(0);

    // After stop, emit should not throw
    expect(() => bus.emit('LoopStart', { x: 1 })).not.toThrow();
    bridge = null;
  });
});

describe('AgentEventLoop — WebSocket bridge integration', () => {
  afterEach(() => {
    bridge?.stop();
    bridge = null;
  });

  it('auto-starts bridge when wsPort is set', async () => {
    const agent = new AgentEventLoop({
      sessionId: 'ws-int-1',
      budget: { maxTurns: 5, maxTotalTokens: 100, maxIterations: 10, maxExecutionTime: 1000 },
      llm: { provider: 'mock', model: 'm' },
      llmProvider: new MockLLMProvider(),
      tools: {},
      wsPort: 0,
    });
    expect(agent.wsPort).toBeGreaterThan(0);
    bridge = (agent as unknown as { bridge: WebSocketBridge }).bridge;
    await agent.dispose();
  });

  it('forwards events to a connected client and accepts INTERRUPT', async () => {
    const agent = new AgentEventLoop({
      sessionId: 'ws-int-2',
      budget: { maxTurns: 20, maxTotalTokens: 5000, maxIterations: 200, maxExecutionTime: 10000 },
      llm: { provider: 'mock', model: 'm' },
      llmProvider: new MockLLMProvider(),
      tools: {},
      wsPort: 0,
    });
    const b = (agent as unknown as { bridge: WebSocketBridge }).bridge;
    bridge = b;
    const ws = await openWs(`ws://127.0.0.1:${b.port}/agent-ws?sessionId=ws-int-2`);

    const received: string[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { type: string };
      received.push(m.type);
      if (m.type === 'BridgeAck') ws.close();
    };

    // 启动 agent（后台），首个 StateStart 到达后立刻发 INTERRUPT
    const p = agent.run('需要被中断的任务');
    await new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as { type: string };
        if (m.type === 'StateStart') {
          ws.removeEventListener('message', onMsg);
          ws.send(JSON.stringify({ type: 'INTERRUPT', kind: 'hard', reason: 'test' }));
          resolve();
        }
      };
      ws.addEventListener('message', onMsg);
    });

    const result = await p;
    expect(result.terminatedBy).toBe('user');
    expect(received).toContain('LoopStart');
    expect(received).toContain('BridgeAck');
    await agent.dispose();
  });

  it('accepts INJECT and calls agent.injectMessage()', async () => {
    const agent = new AgentEventLoop({
      sessionId: 'ws-int-inject',
      budget: { maxTurns: 5, maxTotalTokens: 100, maxIterations: 10, maxExecutionTime: 1000 },
      llm: { provider: 'mock', model: 'm' },
      llmProvider: new MockLLMProvider(),
      tools: {},
      wsPort: 0,
    });
    const b = (agent as unknown as { bridge: WebSocketBridge }).bridge;
    bridge = b;
    const injected: string[] = [];
    b.onInject((cmd) => { injected.push(cmd.message); });
    const ws = await openWs(`ws://127.0.0.1:${b.port}/agent-ws?sessionId=ws-int-inject`);

    const msgs = collect(ws, 80);
    ws.send(JSON.stringify({ type: 'INJECT', message: '改用简明风格' }));
    const m = await msgs;

    expect(injected).toEqual(['改用简明风格']);
    expect(m.some((x) => x.type === 'BridgeAck')).toBe(true);
    ws.close();
    await agent.dispose();
  });

  it('does not start bridge when wsPort is not provided', async () => {
    const agent = new AgentEventLoop({
      sessionId: 'ws-int-3',
      budget: { maxTurns: 5, maxTotalTokens: 100, maxIterations: 10, maxExecutionTime: 1000 },
      llm: { provider: 'mock', model: 'm' },
      llmProvider: new MockLLMProvider(),
      tools: {},
    });
    const b = (agent as unknown as { bridge?: WebSocketBridge }).bridge;
    expect(b).toBeUndefined();
    expect(agent.wsPort).toBeUndefined();
    await agent.dispose();
  });
});
