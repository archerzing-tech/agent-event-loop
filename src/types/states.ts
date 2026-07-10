/**
 * Agent 状态类型枚举。
 * 每个状态是一个原子认知单元，由对应执行器处理。
 */
export type AgentStateType =
  | 'GATHER'
  | 'THINK'
  | 'ACT'
  | 'OBSERVE'
  | 'VERIFY'
  | 'REFINE'
  | 'REFLECT'
  | 'TERMINATE';

export type Priority = 'normal' | 'high' | 'urgent';

/**
 * 一个原子认知单元。所有具体状态共享该结构，
 * 业务数据挂在 `data` 上，保持类型简单且可序列化（便于持久化）。
 */
export interface AgentState {
  type: AgentStateType;
  id: string;
  timestamp: number;
  priority: Priority;
  data: {
    /** 原始用户输入 / 上一轮输出等任意携带数据 */
    [key: string]: unknown;
  };
}

export function makeState(
  type: AgentStateType,
  data: Record<string, unknown> = {},
  priority: Priority = 'normal'
): AgentState {
  return {
    type,
    id: `${type}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    priority,
    data,
  };
}
