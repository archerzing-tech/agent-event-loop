/**
 * 事件总线携带的事件结构。所有内部状态变更、LLM 块、工具结果
 * 都以事件形式发布，便于监控、调试与 WebSocket 桥接。
 */
export interface AgentEvent {
  type: string;
  payload: unknown;
  timestamp: number;
}

export type EventHandler = (event: AgentEvent) => void;

export interface IEventBus {
  emit(type: string, payload?: unknown): void;
  on(type: string, handler: EventHandler): void;
  onAny(handler: EventHandler): void;
  offAny(handler: EventHandler): void;
}

/** 内置事件类型常量，避免拼写错误。 */
export const Events = Object.freeze({
  LoopStart: 'LoopStart',
  LoopEnd: 'LoopEnd',
  TurnStart: 'TurnStart',
  TurnEnd: 'TurnEnd',
  LLMRequest: 'LLMRequest',
  LLMChunk: 'LLMChunk',
  ToolExecStart: 'ToolExecStart',
  ToolExecEnd: 'ToolExecEnd',
  StateStart: 'StateStart',
  StateEnd: 'StateEnd',
  ReflectionResult: 'ReflectionResult',
  Terminate: 'Terminate',
  ExternalInterrupt: 'ExternalInterrupt',
} as const);
