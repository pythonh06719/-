#!/usr/bin/env node
/**
 * 将 food_embeddings.json 同步进 Postgres food_embeddings 表（pgvector 路径）。
 * 前置：已执行 infra/db/migrations/pg/001_pgvector.sql（扩展 + 表就绪）。
 *
 * 环境变量：
 *   DATABASE_URL_PG  Postgres 连接串（Neon / Render / 本地均可）
 *   PG_SEED_SQL      可选：先插入食物行的 SQL 来源（若 food_items 已灌种子可忽略）
 *
 * 运行：node apps/api/scripts/sync-embeddings-pg.mjs
 * 依赖：pg（apps/api devDependency，若无则 npm i -D pg -w @qsh/api）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMB_PATH = join(__dirname, '../../../infra/db/seed/food_embeddings.json');

const url = process.env.DATABASE_URL_PG;
if (!url) {
  console.error('缺少 DATABASE_URL_PG 环境变量');
  process.exit(1);
}

const { dim, vectors } = JSON.parse(readFileSync(EMB_PATH, 'utf-8'));
const client = new pg.Client({ connectionString: url });
await client.connect();

// 建立 name → id 映射（种子按 name 唯一）
const { rows: foods } = await client.query('SELECT id, name FROM food_items');
const idByName = new Map(foods.map((f) => [f.name, f.id]));

let inserted = 0;
let skipped = 0;
for (const { key, vec } of vectors) {
  const foodId = idByName.get(key);
  if (!foodId) {
    skipped++;
    continue;
  }
  const literal = `[${vec.join(',')}]`;
  await client.query(
    `INSERT INTO food_embeddings (food_item_id, embedding, model)
     VALUES ($1, $2::vector, 'hashed-bigram-v1')
     ON CONFLICT (food_item_id) DO UPDATE
       SET embedding = EXCLUDED.embedding, updated_at = now()`,
    [foodId, literal],
  );
  inserted++;
}

console.log(`synced ${inserted} embeddings (dim=${dim}), skipped ${skipped} (no matching food_item)`);
await client.end();
