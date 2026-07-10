import { describe, it, expect } from 'bun:test';
import { BudgetManager, estimateTokensByChar, estimateTokensForChinese } from './BudgetManager.ts';

const base = { maxTurns: 5, maxTotalTokens: 100, maxIterations: 10, maxExecutionTime: 1000 };

describe('BudgetManager', () => {
  it('reports exhausted when turns exceed limit', () => {
    const b = new BudgetManager(base);
    b.begin();
    for (let i = 0; i < 5; i++) b.bumpTurn();
    expect(b.checkExhausted().exhausted).toBe(true);
    expect(b.checkExhausted().reason).toBe('maxTurns');
  });

  it('reports exhausted when tokens exceed limit', () => {
    const b = new BudgetManager(base);
    b.begin();
    b.addTokens('x'.repeat(400)); // ~100 tokens
    expect(b.checkExhausted().exhausted).toBe(true);
  });

  it('does not report exhausted within limits', () => {
    const b = new BudgetManager(base);
    b.begin();
    b.bumpTurn();
    b.bumpIteration();
    expect(b.checkExhausted().exhausted).toBe(false);
  });

  it('accepts custom TokenEstimator', () => {
    const fixed = () => 42;
    const b = new BudgetManager(base, fixed);
    b.begin();
    b.addTokens('任意文本');
    expect(b.totalTokens).toBe(42);
  });

  it('uses Chinese-aware estimator via constructor', () => {
    const b = new BudgetManager({ ...base, maxTotalTokens: 9999 }, estimateTokensForChinese);
    b.begin();
    // 中文：'中文测试' = 4字 × 2 = 8
    // ASCII：'hello' = 5字 × 0.25 = 1.25 → ceil(9.25) = 10
    b.addTokens('中文测试 hello');
    expect(b.totalTokens).toBe(10);
  });
});

describe('estimateTokensByChar', () => {
  it('returns 1 for empty string', () => {
    expect(estimateTokensByChar('')).toBe(1);
  });

  it('estimates by char / 4', () => {
    expect(estimateTokensByChar('abcd')).toBe(1);   // 4/4 = 1
    expect(estimateTokensByChar('abcdefgh')).toBe(2); // 8/4 = 2
    expect(estimateTokensByChar('a')).toBe(1);       // min 1
  });
});

describe('estimateTokensForChinese', () => {
  it('returns 1 for empty string', () => {
    expect(estimateTokensForChinese('')).toBe(1);
  });

  it('counts CJK chars at 2 tokens each', () => {
    // '中文' = 2 CJK chars × 2 = 4
    expect(estimateTokensForChinese('中文')).toBe(4);
  });

  it('counts ASCII at 0.25 tokens each', () => {
    // 'abcd' = 4 × 0.25 = 1
    expect(estimateTokensForChinese('abcd')).toBe(1);
  });

  it('handles mixed Chinese and ASCII', () => {
    // '中文测试' = 4 CJK × 2 = 8
    // 'hello' = 5 ASCII × 0.25 = 1.25
    // total = 9.25 → ceil = 10
    expect(estimateTokensForChinese('中文测试 hello')).toBe(10);
  });

  it('counts non-ASCII punctuation at 1 token each', () => {
    // '，' (U+FF0C fullwidth comma) and '。' (U+3002 ideographic full stop)
    // are not CJK unified ideographs and not ASCII → 'other' = 1 token each
    expect(estimateTokensForChinese('，。')).toBe(2);
  });
});
