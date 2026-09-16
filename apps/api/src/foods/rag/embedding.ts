/**
 * 确定性本地文本向量（RAG-1）：
 * - 零外部依赖、零网络请求：不依赖任何 embedding API，离线可复现（same text → same vector）。
 * - 256 维 hashed bag-of-bigrams：对中文按字符 bigram、ASCII 按词，哈希到固定维度后 L2 归一化。
 * - 若业务后续切换到真实 embedding 服务（OpenAI / BGE 等），仅需替换本文件的 embedText 实现，
 *   向量维度需同步更新 pgvector 列定义与 FOOD_EMBED_DIM。
 */

export const FOOD_EMBED_DIM = 256;

/** FNV-1a 32 位哈希：确定性、分布均匀、实现零依赖。 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 分词：中文按字符 bigram，ASCII 连续段按小写词，两路都保留单字。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const segments = normalized.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) ?? [];
  for (const seg of segments) {
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      for (let i = 0; i < seg.length; i++) {
        tokens.push(seg[i] ?? '');
        if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
      }
    } else {
      tokens.push(seg);
    }
  }
  return tokens;
}

/**
 * 文本 → 256 维 L2 归一化向量。
 * 输入建议格式：`名称 拼音 别名1 别名2 分类`。
 */
export function embedText(text: string, dim = FOOD_EMBED_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    // 双哈希签名：h 与 h*2654435761 撒到两个槽位，降低碰撞造成的语义混叠
    const h1 = fnv1a(token) % dim;
    const h2 = fnv1a(`#${token}`) % dim;
    vec[h1] = (vec[h1] ?? 0) + 1;
    if (h2 !== h1) vec[h2] = (vec[h2] ?? 0) + 0.5;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** 余弦相似度（输入应已归一化，退化为点积；保留完整公式以防外部向量未归一化）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
