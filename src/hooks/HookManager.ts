import type { AgentHook, LLMContext, ToolContext, ToolResult } from '../types/config.ts';
import type { AgentState } from '../types/states.ts';

/**
 * 钩子管理器（设计文档 3.5）。
 * 在状态执行前后、LLM 调用前后、工具调用前后触发拦截器。
 * 内置示例：日志钩子（结构化 JSON Lines）。
 */
export class HookManager {
  private hooks: AgentHook[] = [];

  constructor(hooks: AgentHook[] = []) {
    this.hooks = hooks;
  }

  use(hook: AgentHook): void {
    this.hooks.push(hook);
  }

  async beforeState(state: AgentState): Promise<AgentState | 'abort'> {
    let s: AgentState = state;
    for (const h of this.hooks) {
      if (!h.beforeState) continue;
      const r = await h.beforeState(s);
      if (typeof r === 'string' && r === 'abort') return 'abort';
      s = r;
    }
    return s;
  }

  async afterState(state: AgentState): Promise<void> {
    for (const h of this.hooks) await h.afterState?.(state);
  }

  async beforeLLM(ctx: LLMContext): Promise<LLMContext | 'abort'> {
    let c = ctx;
    for (const h of this.hooks) {
      if (!h.beforeLLM) continue;
      const r = await h.beforeLLM(c);
      if (typeof r === 'string' && r === 'abort') return 'abort';
      c = r;
    }
    return c;
  }

  async beforeTool(ctx: ToolContext): Promise<ToolContext | 'deny'> {
    let c = ctx;
    for (const h of this.hooks) {
      if (!h.beforeTool) continue;
      const r = await h.beforeTool(c);
      if (typeof r === 'string' && r === 'deny') return 'deny';
      c = r;
    }
    return c;
  }

  async afterTool(result: ToolResult): Promise<ToolResult> {
    let r = result;
    for (const h of this.hooks) {
      if (!h.afterTool) continue;
      r = await h.afterTool(r);
    }
    return r;
  }
}

/**
 * 日志钩子：输出结构化日志（设计文档 6.3），便于接入 ELK / Loki。
 */
export const LoggerHook: AgentHook = {
  afterState(state: AgentState) {
    const line = JSON.stringify({
      level: 'info',
      hook: 'logger',
      state: state.type,
      ts: state.timestamp,
    });
    console.log(line);
    return Promise.resolve();
  },
};
