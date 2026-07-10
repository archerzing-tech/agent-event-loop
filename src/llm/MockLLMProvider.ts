import type { LLMProvider, LLMRequest, LLMResponse, ToolMetadata } from '../types/config.ts';

/**
 * LLM 提供方抽象接口（见 src/types/config.ts -> LLMProvider）。
 *
 * 框架不绑定具体厂商。本文件提供工厂：默认实现 MockLLMProvider（离线可跑），
 * 真实场景使用 createLLMProvider(config) 返回 OpenAI 实现。
 */

export { type LLMProvider, type LLMRequest, type LLMResponse, type ToolMetadata };

/**
 * MockLLMProvider —— 用于最小验证 demo，无需任何 API Key。
 *
 * 行为策略（确定性脚本，保证 demo 必然终止并覆盖状态机关键路径）：
 * - intent='think'   首轮：若任务包含可识别工具需求，则产出对应 toolCall；
 *                    后续轮：产出最终文本答案，驱动进入 VERIFY。
 * - intent='judge'   根据答案是否包含“答案”/“结果”字样判定通过，否则 REFINE。
 * - intent='reflect' 根据携带的错误做自我分析，决定回到 THINK 还是 TERMINATE。
 */
export class MockLLMProvider implements LLMProvider {
  private thinkCount = 0;

  /** 重置内部状态，使下一次 intent='think' 重新从首轮行为开始。 */
  reset(): void {
    this.thinkCount = 0;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // 模拟真实 LLM 网络延迟，使主循环让出 macrotask，
    // 从而外部中断（setTimeout/WebSocket）有机会在运行途中插入。
    await new Promise((r) => setTimeout(r, 15));
    if (req.intent === 'think') return this.handleThink(req);
    if (req.intent === 'judge') return this.handleJudge(req);
    return this.handleReflect(req);
  }

  private handleThink(req: LLMRequest): LLMResponse {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const task = (lastUser?.content ?? '') as string;
    const tools = req.tools ?? [];
    const call = this.pickTool(task, tools);

    if (call && this.thinkCount === 0) {
      this.thinkCount++;
      return { toolCalls: [call] };
    }

    this.thinkCount++;
    // 没有更多工具需求 -> 产出最终答案
    const answer = this.composeAnswer(task, req.messages);
    return { text: answer };
  }

  private pickTool(task: string, tools: ToolMetadata[]) {
    for (const t of tools) {
      const kw = t.name.toLowerCase();
      if (task.toLowerCase().includes(kw)) {
        // 根据工具名构造演示参数
        const params: Record<string, unknown> =
          t.name === 'calculator'
            ? { expression: '(3 + 4) * 2' }
            : t.name === 'search'
              ? { query: task }
              : { input: task };
        return { id: `call-${Math.random().toString(36).slice(2, 8)}`, name: t.name, params };
      }
    }
    return undefined;
  }

  private composeAnswer(task: string, messages: LLMRequest['messages']): string {
    // 从工具结果中汇总
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    const parts = toolMsgs.map((m) => `工具结果：${m.content}`);
    const base = parts.length ? parts.join('；') : `针对“${task}”的推理已完成`;
    return `${base}。结论：任务已完成，最终答案如上。`;
  }

  private handleJudge(req: LLMRequest): LLMResponse {
    const last = req.messages[req.messages.length - 1];
    const text = last?.content ?? '';
    const pass = /答案|结果|完成|结论/.test(text);
    return {
      text: pass
        ? JSON.stringify({ pass: true, reason: '输出包含明确结论' })
        : JSON.stringify({ pass: false, reason: '输出缺乏明确结论，需精炼' }),
    };
  }

  private handleReflect(req: LLMRequest): LLMResponse {
    const last = req.messages[req.messages.length - 1];
    const text = (last?.content ?? '') as string;
    if (/无法继续|无输出/.test(text)) {
      return { text: JSON.stringify({ action: 'terminate', reason: '无可用进展' }) };
    }
    return { text: JSON.stringify({ action: 'think', reason: '修正后重新推理' }) };
  }
}
