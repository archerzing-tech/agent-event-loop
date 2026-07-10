import type { AgentState, AgentStateType } from '../types/states.ts';

/**
 * 双队列状态容器（设计文档 3.2）。
 * - 普通队列：常规状态（GATHER/THINK/ACT/OBSERVE/VERIFY/REFINE/TERMINATE）。
 * - 紧急队列：高优先级状态（REFLECT/TERMINATE），总是优先处理。
 *
 * 出队顺序：先排空紧急队列，再取普通队列（FIFO）。
 */
export class StateQueue {
  private normalQueue: AgentState[] = [];
  private urgentQueue: AgentState[] = [];

  /** 入队。force=true 时无论优先级都进入紧急队列。 */
  enqueue(state: AgentState, force = false): void {
    if (force || state.priority === 'urgent') {
      this.urgentQueue.push(state);
    } else {
      this.normalQueue.push(state);
    }
  }

  /** 出队：优先紧急队列。 */
  dequeue(): AgentState | undefined {
    const urgent = this.urgentQueue.shift();
    if (urgent) return urgent;
    return this.normalQueue.shift();
  }

  hasUrgent(): boolean {
    return this.urgentQueue.length > 0;
  }

  /** 是否存在 TERMINATE 状态（紧急或普通）。 */
  hasTerminateState(): boolean {
    return [...this.urgentQueue, ...this.normalQueue].some(
      (s) => s.type === 'TERMINATE'
    );
  }

  get totalSize(): number {
    return this.normalQueue.length + this.urgentQueue.length;
  }

  clear(): void {
    this.normalQueue = [];
    this.urgentQueue = [];
  }

  toJSON(): { normal: AgentState[]; urgent: AgentState[] } {
    return {
      normal: structuredClone(this.normalQueue),
      urgent: structuredClone(this.urgentQueue),
    };
  }

  fromJSON(data: { normal: AgentState[]; urgent: AgentState[] }): void {
    this.normalQueue = structuredClone(data.normal ?? []);
    this.urgentQueue = structuredClone(data.urgent ?? []);
  }
}

export type { AgentStateType };
