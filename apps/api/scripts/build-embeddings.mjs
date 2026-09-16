#!/usr/bin/env node
/**
 * 构建 food_embeddings.json（RAG-1 种子侧预计算）：
 * 读取 infra/db/seed/food_items.seed.json，对每条食物用 @qsh/api 的确定性
 * hashed-bigram embedding（256 维）生成向量，输出到同目录。
 *
 * 运行：node apps/api/scripts/build-embeddings.mjs
 * 说明：embedding 逻辑与 src/foods/rag/embedding.ts 保持一致（复制内联，
 * 避免 node 脚本依赖 TS 构建）；修改 embedding 实现时必须同步两处并重建本文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '../../../infra/db/seed/food_items.seed.json');
const OUT_PATH = join(__dirname, '../../../infra/db/seed/food_embeddings.json');
const DIM = 256;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text) {
  const tokens = [];
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const segments = normalized.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) ?? [];
  for (const seg of segments) {
    if (/^[\u4e00-\u9fff]+$/.test(seg)) {
      for (let i = 0; i < seg.length; i++) {
        tokens.push(seg[i]);
        if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
      }
    } else {
      tokens.push(seg);
    }
  }
  return tokens;
}

function embedText(text) {
  const vec = new Array(DIM).fill(0);
  for (const token of tokenize(text)) {
    const h1 = fnv1a(token) % DIM;
    const h2 = fnv1a(`#${token}`) % DIM;
    vec[h1] += 1;
    if (h2 !== h1) vec[h2] += 0.5;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

const seed = JSON.parse(readFileSync(SEED_PATH, 'utf-8'));
const items = seed.items ?? [];
const vectors = items.map((item) => {
  const text = [item.name, item.namePinyin ?? '', ...(item.aliases ?? []), item.category ?? '']
    .join(' ');
  return { key: item.name, vec: embedText(text).map((v) => Number(v.toFixed(6))) };
});

writeFileSync(
  OUT_PATH,
  JSON.stringify({ dim: DIM, count: vectors.length, generatedBy: 'apps/api/scripts/build-embeddings.mjs', vectors }, null, 1),
);
console.log(`wrote ${vectors.length} embeddings (dim=${DIM}) -> ${OUT_PATH}`);
