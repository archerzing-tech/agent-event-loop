import type { ServerWebSocket } from 'bun';
import { type AgentEvent, type EventBus, type EventHandler } from '../core/EventBus.ts';

/**
 * WebSocket 桥接（设计文档 §6.2）。
 *
 * 把 AgentEventLoop 内部的 EventBus 事件实时推送到前端，
 * 并支持前端反向发送 INTERRUPT / INJECT 控制消息。
 *
 * 端点：`ws://host:port/agent-ws?sessionId=xxx`
 * 消息格式（双向一致）：`{ type, payload, timestamp }`
 *
 * 用法：
 *   const bridge = new WebSocketBridge({ port: 8080, sessionId: 'demo' });
 *   bridge.attach(agent.events);          // 转发事件
 *   bridge.onInterrupt(cmd => agent.interrupt(cmd.kind, cmd.reason));
 *   // ...
 *   await bridge.stop();
 *
 * 注意：每个端口同时只允许一个 WebSocketBridge 实例；
 * 多 Agent 复用同一端口需借助自定义注册表（设计文档 v2.1 路线图）。
 */

export interface WebSocketBridgeOptions {
  port: number;
  sessionId?: string;
  path?: string;
  host?: string;
}

export interface InterruptCommand {
  kind: 'graceful' | 'hard';
  reason?: string;
}

export interface InjectCommand {
  message: string;
}

type WsData = { sessionId: string | null };

export class WebSocketBridge {
  private server?: Bun.Server<WsData>;
  private clients = new Set<ServerWebSocket<WsData>>();
  private interruptHandler?: (cmd: InterruptCommand) => void;
  private injectHandler?: (cmd: InjectCommand) => void;
  private busUnsub?: () => void;
  private readonly opts: Required<Omit<WebSocketBridgeOptions, 'sessionId'>> & { sessionId: string };

  constructor(opts: WebSocketBridgeOptions) {
    this.opts = {
      port: opts.port,
      sessionId: opts.sessionId ?? '',
      path: opts.path ?? '/agent-ws',
      host: opts.host ?? '127.0.0.1',
    };
    this.start();
  }

  start(): void {
    if (this.server) return;
    this.server = Bun.serve({
      port: this.opts.port,
      hostname: this.opts.host,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname !== this.opts.path) {
          return new Response('Not Found', { status: 404 });
        }
        const sid = url.searchParams.get('sessionId');
        if (this.opts.sessionId && sid && sid !== this.opts.sessionId) {
          return new Response('Session mismatch', { status: 403 });
        }
        const data: WsData = { sessionId: sid || this.opts.sessionId || null };
        const upgraded = server.upgrade(req, { data });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      },
      websocket: {
        data: {} as WsData,
        open: (ws) => {
          this.clients.add(ws);
        },
        close: (ws) => {
          this.clients.delete(ws);
        },
        message: (ws, message) => {
          this.handleMessage(ws, message);
        },
      },
    });
  }

  async stop(): Promise<void> {
    this.busUnsub?.();
    this.busUnsub = undefined;
    await this.server?.stop(true);
    this.server = undefined;
    this.clients.clear();
  }

  get port(): number {
    return this.server?.port ?? this.opts.port;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  attach(bus: EventBus): void {
    this.busUnsub?.();
    const handler: EventHandler = (e: AgentEvent) => this.broadcast(e);
    bus.onAny(handler);
    this.busUnsub = () => bus.offAny(handler);
  }

  onInterrupt(handler: (cmd: InterruptCommand) => void): void {
    this.interruptHandler = handler;
  }

  onInject(handler: (cmd: InjectCommand) => void): void {
    this.injectHandler = handler;
  }

  private broadcast(e: AgentEvent): void {
    if (this.clients.size === 0) return;
    const payload = e.payload as { sessionId?: string } | undefined;
    if (this.opts.sessionId && payload?.sessionId && payload.sessionId !== this.opts.sessionId) {
      return;
    }
    const data = JSON.stringify({ type: e.type, payload: e.payload, timestamp: e.timestamp });
    for (const ws of this.clients) {
      // ws.send 返回 0 表示被丢弃（连接已不可写），主动移除避免后续无限重试
      if (ws.send(data) === 0) this.clients.delete(ws);
    }
  }

  private handleMessage(ws: ServerWebSocket<WsData>, message: string | Buffer<ArrayBuffer>): void {
    const parsed = this.tryParse(message);
    if (!parsed) {
      this.ack(ws, 'BridgeError', { error: 'Invalid JSON' });
      return;
    }
    const t = parsed.type;
    if (t === 'INTERRUPT') {
      const kind: 'graceful' | 'hard' = parsed.kind === 'hard' ? 'hard' : 'graceful';
      const cmd: InterruptCommand = {
        kind,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
      this.interruptHandler?.(cmd);
      this.ack(ws, 'BridgeAck', { command: 'INTERRUPT', ...cmd });
    } else if (t === 'INJECT') {
      const cmd: InjectCommand = {
        message: typeof parsed.message === 'string' ? parsed.message : '',
      };
      this.injectHandler?.(cmd);
      this.ack(ws, 'BridgeAck', { command: 'INJECT', ...cmd });
    } else {
      this.ack(ws, 'BridgeError', { error: `Unknown command: ${t ?? '(none)'}` });
    }
  }

  private tryParse(message: string | Buffer<ArrayBuffer>): Record<string, unknown> | null {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private ack(ws: ServerWebSocket<WsData>, type: string, payload: unknown): void {
    ws.send(JSON.stringify({ type, payload, timestamp: Date.now() }));
  }
}
