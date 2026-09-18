#!/usr/bin/env node
/**
 * 将 food_embeddings.json 同步进 Postgres food_embeddings 表（pgvector 路径）。
 *
 * 建表：脚本在写入前会**幂等**执行 infra/db/migrations/pg/001_pgvector.sql
 * （CREATE EXTENSION / TABLE / INDEX 全部 IF NOT EXISTS），因此**无需人工先跑 psql**；
 * 迁移定义只存在那一份 SQL，脚本直接读取它，不会复制出会漂移的第二份定义。
 * 也可以手工执行该 SQL（可选、可重复）。
 *
 * 环境变量：
 *   DATABASE_URL_PG  Postgres 连接串（Neon / Render / 本地均可）
 *
 * 运行：node apps/api/scripts/sync-embeddings-pg.mjs
 * 依赖：pg（apps/api devDependency，若无则 npm i -D pg -w @qsh/api）
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMB_PATH = join(__dirname, '../../../infra/db/seed/food_embeddings.json');
const MIGRATION_PATH = join(__dirname, '../../../infra/db/migrations/pg/001_pgvector.sql');

/**
 * 读取迁移 SQL，按 `;` 拆分为可逐条执行的语句，跳过纯注释行与空行。
 *
 * 为什么必须拆分：`pg` 客户端的 `query()` 一次只接受**单条**语句，
 * 多语句字符串会报错，故逐条执行。
 *
 * @returns {string[]} 已剔除注释/空行、按原顺序排列的 SQL 语句
 */
export function readMigrationStatements() {
  let sql;
  try {
    sql = readFileSync(MIGRATION_PATH, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取向量表迁移脚本 ${MIGRATION_PATH}：${message}`);
  }

  return sql
    .split(';')
    .map((chunk) =>
      chunk
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

/**
 * 幂等确保 pgvector 扩展与 food_embeddings 表/索引就绪。
 *
 * 逐条执行迁移语句（顺序：扩展 → 表 → 索引）。失败时抛出**可读错误**，
 * 绝不静默继续；若疑似 pgvector 扩展不可用，额外给出提示。
 *
 * @param {{ query: (sql: string) => Promise<unknown> }} client 已连接的 pg 客户端（或测试桩）
 * @returns {Promise<number>} 已执行的 DDL 语句条数
 */
export async function ensureVectorSchema(client) {
  const statements = readMigrationStatements();

  for (const statement of statements) {
    try {
      await client.query(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /extension|control file|permission denied|Could not open/i.test(message)
        ? '\n提示：当前 Postgres 可能未预装 pgvector 扩展（Render / Neon 免费档需 Postgres 16+）。'
        : '';
      const oneLine = statement.replace(/\s+/g, ' ');
      throw new Error(`执行向量表 DDL 失败：\n  ${oneLine}\n原因：${message}${hint}`);
    }
  }

  return statements.length;
}

/** 主流程：连接 → 确保表结构 → 读取种子 → 映射 name→id → upsert 向量。 */
async function main() {
  const url = process.env.DATABASE_URL_PG;
  if (!url) {
    console.error('缺少 DATABASE_URL_PG 环境变量');
    process.exit(1);
  }

  // 动态 import：便于测试时在**未安装 pg** 的环境里仅导入本模块的纯函数。
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`缺少依赖 pg：${message}\n请执行 npm i -D pg -w @qsh/api 后重试`);
    process.exit(1);
  }

  const { dim, vectors } = JSON.parse(readFileSync(EMB_PATH, 'utf-8'));
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const statementCount = await ensureVectorSchema(client);
    console.log(
      `已确保 pgvector 扩展与 food_embeddings 表就绪（执行 ${statementCount} 条 DDL，幂等可重复）`,
    );

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
  } finally {
    await client.end();
  }
}

// 仅在被直接执行时跑主流程；作为模块被导入（如测试桩）时不产生副作用。
const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  await main();
}
