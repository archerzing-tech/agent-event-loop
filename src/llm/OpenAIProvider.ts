import type { LLMConfig, LLMProvider, LLMRequest, LLMResponse, ToolCall } from '../types/config.ts';

/**
 * OpenAI 兼容 LLM 实现（真实可用，需要 API Key）。
 * 通过 fetch 调用 chat/completions，支持工具调用。
 * 用作 MockLLMProvider 的替代品，演示真实场景接入。
 */
export class OpenAILLMProvider implements LLMProvider {
  constructor(private cfg: LLMConfig) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const url = `${this.cfg.baseURL ?? 'https://api.openai.com/v1'}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      temperature: req.temperature ?? this.cfg.temperature ?? 0.7,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCall ? { tool_calls: [m.toolCall] } : {}),
      })),
    };
    if (req.tools && req.tools.length && req.intent === 'think') {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    const msg = json.choices?.[0]?.message;
    const toolCalls: ToolCall[] | undefined = (msg?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      params: JSON.parse(tc.function.arguments || '{}'),
    }));
    return {
      text: msg?.content ?? undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  }
}

export function createLLMProvider(cfg: LLMConfig): LLMProvider {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAILLMProvider(cfg);
    default:
      throw new Error(`Unknown LLM provider: ${cfg.provider}`);
  }
}
