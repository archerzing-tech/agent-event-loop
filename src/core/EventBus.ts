import { Events, type AgentEvent, type EventHandler, type IEventBus } from '../types/events.ts';

export type { AgentEvent, EventHandler, IEventBus };

/**
 * 内存事件总线（设计文档 6.1）。
 * 所有内部状态变更、LLM 块、工具结果均以事件发布，便于监控与调试。
 * 真实部署中可将 WebSocket 桥接作为 onAny 订阅者接入。
 */
export class EventBus implements IEventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private anyListeners = new Set<EventHandler>();

  emit(type: string, payload?: unknown): void {
    const event: AgentEvent = { type, payload, timestamp: Date.now() };
    const set = this.listeners.get(type);
    if (set) for (const h of set) h(event);
    for (const h of this.anyListeners) h(event);
  }

  on(type: string, handler: EventHandler): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  off(type: string, handler: EventHandler): void {
    this.listeners.get(type)?.delete(handler);
  }

  onAny(handler: EventHandler): void {
    this.anyListeners.add(handler);
  }

  offAny(handler: EventHandler): void {
    this.anyListeners.delete(handler);
  }
}

export { Events };
