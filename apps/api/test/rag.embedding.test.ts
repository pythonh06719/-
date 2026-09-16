import { describe, expect, it } from 'vitest';

import { cosineSimilarity, embedText, tokenize } from '../src/foods/rag/embedding';

describe('RAG embedding（确定性本地向量）', () => {
  it('同一文本两次 embedding 结果完全一致（可复现）', () => {
    expect(embedText('米饭 白米饭 主食')).toEqual(embedText('米饭 白米饭 主食'));
  });

  it('向量已 L2 归一化（模长 ≈ 1）', () => {
    const v = embedText('鸡胸肉');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('维度为 FOOD_EMBED_DIM = 256', () => {
    expect(embedText('任意')).toHaveLength(256);
  });

  it('语义相近文本（共享 bigram）相似度高于无关文本', () => {
    const q = embedText('米饭');
    const near = embedText('白米饭 蒸米饭 主食');
    const far = embedText('可乐 碳酸饮料 零食');
    expect(cosineSimilarity(q, near)).toBeGreaterThan(cosineSimilarity(q, far));
  });

  it('tokenize：中文产出单字 + bigram，英文产出小写词', () => {
    const tokens = tokenize('米饭 Rice');
    expect(tokens).toContain('米饭');
    expect(tokens).toContain('饭');
    expect(tokens).toContain('rice');
  });

  it('空文本返回零向量，不抛错', () => {
    const v = embedText('');
    expect(v.every((x) => x === 0)).toBe(true);
    expect(cosineSimilarity(v, embedText('x'))).toBe(0);
  });
});
