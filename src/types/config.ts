import type { AgentState, AgentStateType } from './states.ts';

/** 工具调用参数。 */
export interface ToolCall {
  id: string;
  name: string;
  params: Record<string, unknown>;
}

/** 工具执行结果。 */
export interface ToolResult {
  ok: boolean;
  content: unknown;
  error?: string;
}

/** 工具元数据（注册规范见设计文档附录 C）。 */
export interface ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** true 时顺序执行（有副作用），false 时可并行（只读）。 */
  sideEffects?: boolean;
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/** 对话消息。 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCall?: ToolCall;
}

export type LLMIntent = 'think' | 'judge' | 'reflect';

export interface LLMRequest {
  messages: Message[];
  tools?: ToolMetadata[];
  intent: LLMIntent;
  temperature?: number;
}

export interface LLMResponse {
  /** 文本回复（无工具调用时）。 */
  text?: string;
  /** 需要执行的工具调用。 */
  toolCalls?: ToolCall[];
}

/**
 * LLM 提供方抽象。框架不绑定具体厂商，demo 默认使用 MockLLMProvider，
 * 真实场景可替换为 OpenAILLMProvider（见 src/llm/OpenAIProvider.ts）。
 */
export interface LLMProvider {
  complete(req: LLMRequest): Promise<LLMResponse>;
  /** 可选：流式 token 输出，供可观测层 / WebSocket 使用。 */
  stream?: (req: LLMRequest, onChunk: (chunk: string) => void) => Promise<LLMResponse>;
}

/** 预算配置（四维）。 */
export interface Budget {
  maxTurns: number;
  maxTotalTokens: number;
  maxIterations: number;
  maxExecutionTime: number; // 毫秒
}

/** LLM 配置。 */
export interface LLMConfig {
  provider: string;
  model: string;
  temperature?: number;
  apiKey?: string;
  baseURL?: string;
}

/** 检查点配置。 */
export interface CheckpointConfig {
  enabled: boolean;
  dbPath: string;
  interval: number; // 每 N 轮保存一次
  snapshotDir: string;
}

/** Hook 上下文。 */
export interface LLMContext {
  request: LLMRequest;
}
export interface ToolContext {
  call: ToolCall;
}

/** 钩子接口（设计文档 3.5）。 */
export interface AgentHook {
  beforeState?(state: AgentState): Promise<AgentState | 'abort'>;
  afterState?(state: AgentState): Promise<void>;
  beforeLLM?(context: LLMContext): Promise<LLMContext | 'abort'>;
  beforeTool?(context: ToolContext): Promise<ToolContext | 'deny'>;
  afterTool?(result: ToolResult): Promise<ToolResult>;
}

/**
 * Token 估算器接口。
 * 接收文本，返回预估的 Token 数。
 * 可根据模型类型自定义实现（如 cl100k_base、o200k_base 兼容的估算）。
 */
export type TokenEstimator = (text: string) => number;

/** 顶层配置。 */
export interface AgentEventLoopConfig {
  budget: Budget;
  llm: LLMConfig;
  tools: Record<string, ToolMetadata>;
  checkpoint?: CheckpointConfig;
  wsPort?: number;
  verbose?: boolean;
  sessionId?: string;
  llmProvider?: LLMProvider;
  hooks?: AgentHook[];
  /** 可选的自定义 Token 估算器，默认使用字符 / 4 的粗略估算。 */
  tokenEstimator?: TokenEstimator;
  /** LLM 调用超时毫秒数，默认 120000（2 分钟）。 */
  llmTimeoutMs?: number;
}

/** 运行结果。 */
export interface RunResult {
  sessionId: string;
  output: string;
  turns: number;
  iterations: number;
  totalTokens: number;
  terminatedBy: AgentStateType | 'budget' | 'user' | 'stall';
  elapsedMs: number;
  restored: boolean;
}
