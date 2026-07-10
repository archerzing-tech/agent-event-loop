import type { Budget, TokenEstimator } from '../types/config.ts';

/**
 * 默认 Token 估算：按总字符数 / 4（适用于英文为主场景的粗略估算）。
 */
export function estimateTokensByChar(text: string): number {
  return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
}

/**
 * 中文感知的 Token 估算：
 * - 中文字符（CJK）按 ~2 tokens/字
 * - ASCII/数字/空格按 ~0.25 tokens/字符（即 ~1 token / 4 字符）
 * - 其他字符（如标点）按 ~1 token/个
 *
 * 更接近真实 LLM Tokenizer（如 cl100k_base）的行为。
 */
export function estimateTokensForChinese(text: string): number {
  if (!text) return 1;
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK 统一表意文字（中文）
      tokens += 2;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x20) {
      // ASCII 字母、数字、空格
      tokens += 0.25;
    } else {
      // 其他字符（标点、符号等）
      tokens += 1;
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

/**
 * 预算管理（设计文档 3.3）。
 * 四维预算防止无限循环与资源耗尽：轮次 / Token / 迭代 / 时间。
 * 预算耗尽时主循环会强制注入 TERMINATE。
 *
 * 可传入自定义 TokenEstimator 以获得更精准的 Token 估算。
 */
export class BudgetManager {
  private cfg: Budget;
  private startTime = Date.now();
  private _turns = 0;
  private _iterations = 0;
  private _tokens = 0;
  private estimate: TokenEstimator;

  constructor(cfg: Budget, estimator?: TokenEstimator) {
    this.cfg = cfg;
    this.estimate = estimator ?? estimateTokensByChar;
  }

  begin(): void {
    this.startTime = Date.now();
  }

  get turns(): number {
    return this._turns;
  }
  get iterations(): number {
    return this._iterations;
  }
  get totalTokens(): number {
    return this._tokens;
  }
  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /** 进入新的一轮（THINK 开始时计数）。 */
  bumpTurn(): void {
    this._turns++;
  }

  /** 每个状态执行完成计数。 */
  bumpIteration(): void {
    this._iterations++;
  }

  /** 累加 Token 消耗（使用配置的 TokenEstimator）。 */
  addTokens(text: string): void {
    this._tokens += this.estimate(text);
  }

  private get exhausted(): boolean {
    return (
      this._turns >= this.cfg.maxTurns ||
      this._iterations >= this.cfg.maxIterations ||
      this._tokens >= this.cfg.maxTotalTokens ||
      this.elapsedMs >= this.cfg.maxExecutionTime
    );
  }

  /** 返回是否耗尽以及耗尽原因。 */
  checkExhausted(): { exhausted: boolean; reason?: string } {
    if (this._turns >= this.cfg.maxTurns) return { exhausted: true, reason: 'maxTurns' };
    if (this._iterations >= this.cfg.maxIterations)
      return { exhausted: true, reason: 'maxIterations' };
    if (this._tokens >= this.cfg.maxTotalTokens)
      return { exhausted: true, reason: 'maxTotalTokens' };
    if (this.elapsedMs >= this.cfg.maxExecutionTime)
      return { exhausted: true, reason: 'maxExecutionTime' };
    return { exhausted: false };
  }

  snapshot() {
    return {
      turns: this._turns,
      iterations: this._iterations,
      tokens: this._tokens,
      elapsedMs: this.elapsedMs,
    };
  }

  restore(snap: ReturnType<BudgetManager['snapshot']>): void {
    this._turns = snap.turns;
    this._iterations = snap.iterations;
    this._tokens = snap.tokens;
  }
}
