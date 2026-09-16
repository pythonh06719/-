-- 001_pgvector.sql —— 食物库 RAG 向量检索（Postgres 路径，Neon / Render Postgres 均支持 pgvector）
-- 适用对象：schema.pg.prisma 对应的 food_items 表。
-- 运行方式（任选其一）：
--   psql $DATABASE_URL_PG -f infra/db/migrations/pg/001_pgvector.sql
--   或在 Render / Neon 控制台的 SQL 编辑器中整段执行。
-- 幂等：可重复执行。

CREATE EXTENSION IF NOT EXISTS vector;

-- 向量表独立于 Prisma 管理的 food_items（Prisma v5 原生不支持 vector 列）。
CREATE TABLE IF NOT EXISTS food_embeddings (
  food_item_id BIGINT PRIMARY KEY REFERENCES food_items(id) ON DELETE CASCADE,
  embedding    vector(256) NOT NULL,
  model        TEXT NOT NULL DEFAULT 'hashed-bigram-v1',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 余弦距离索引：443 行规模用精确检索即可；规模上万后可换 ivfflat/hnsw。
CREATE INDEX IF NOT EXISTS ix_food_embeddings_cosine
  ON food_embeddings USING hnsw (embedding vector_cosine_ops);

-- 从种子 JSON 导入（一次性，需在装有 node 的环境执行 apps/api/scripts/sync-embeddings-pg.mjs，
-- 或用下面的占位流程手动导入）。此处仅保证表结构就绪。
