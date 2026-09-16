import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toFoodItem } from '../../common/mappers/entity.mapper';
import { PrismaService } from '../../prisma/prisma.service';
import { cosineSimilarity, embedText, FOOD_EMBED_DIM } from './embedding';

/** 引用溯源条目：每条检索结果必须携带数据来源与许可（DATA-LICENSE.md）。 */
export interface Citation {
  source: string;
  license: string;
  attribution: string;
}

export interface RagFoodHit {
  id: number;
  name: string;
  namePinyin: string | null;
  aliases: string[];
  category: string;
  kcalPer100g: number;
  proteinGPer100g: number;
  fatGPer100g: number;
  carbGPer100g: number;
  score: number;
  citation: Citation;
}

interface StoredEmbedding {
  key: string; // name（种子内唯一）
  vec: number[];
}

const SOURCE_LICENSE: Record<string, Citation> = {
  builtin: {
    source: 'builtin',
    license: 'CC BY 4.0',
    attribution: '轻生活自建常识样例集',
  },
  openfoodfacts: {
    source: 'openfoodfacts',
    license: 'ODbL 1.0',
    attribution: '© Open Food Facts contributors (world.openfoodfacts.org)',
  },
  usda: {
    source: 'usda',
    license: 'Public Domain',
    attribution: 'USDA FoodData Central — SR Legacy (fdc.nal.usda.gov)',
  },
  manual: {
    source: 'manual',
    license: '用户自建',
    attribution: '用户本人录入',
  },
};

/**
 * 食物库 RAG 向量检索服务（RAG-1/RAG-2）：
 *
 * - **SQLite 路径（本地/CI）**：启动时加载 `infra/db/seed/food_embeddings.json` 到内存，
 *   余弦相似度 top-K 检索，再用 Prisma 按 id 回表取完整行。
 * - **Postgres 路径（生产 / Neon）**：当 `DATABASE_URL_PG` 存在且 `food_embeddings` 表可用
 *   （见 `infra/db/migrations/pg/001_pgvector.sql`），走 pgvector `<=>` 余弦距离原生 SQL。
 *   pgvector 不可用时自动降级回内存路径，保证服务不因缺扩展而崩溃。
 */
@Injectable()
export class VectorSearchService implements OnModuleInit {
  private readonly logger = new Logger(VectorSearchService.name);
  private readonly memVectors: StoredEmbedding[] = [];
  private memReady = false;
  private pgReady = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    this.loadMemoryVectors();
    await this.probePgVector();
  }

  /** 内存向量：来自种子侧预计算的 `food_embeddings.json`（构建脚本 `scripts/build-embeddings.mjs`）。 */
  private loadMemoryVectors(): void {
    try {
      const path = join(process.cwd(), 'infra/db/seed/food_embeddings.json');
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
        dim: number;
        vectors: StoredEmbedding[];
      };
      if (raw.dim !== FOOD_EMBED_DIM) {
        this.logger.warn(`embedding dim mismatch: file=${raw.dim} code=${FOOD_EMBED_DIM}`);
        return;
      }
      this.memVectors.push(...raw.vectors);
      this.memReady = true;
      this.logger.log(`loaded ${raw.vectors.length} food embeddings (dim=${raw.dim})`);
    } catch (err) {
      this.logger.warn(`food_embeddings.json not loaded (${(err as Error).message}); RAG falls back to LIKE search`);
    }
  }

  /** 探测 pgvector 可用性：扩展存在 + 表存在 才走 PG 路径。 */
  private async probePgVector(): Promise<void> {
    if (!process.env.DATABASE_URL_PG) return;
    try {
      await this.prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
      await this.prisma.$queryRaw`SELECT 1 FROM information_schema.tables WHERE table_name = 'food_embeddings'`;
      this.pgReady = true;
      this.logger.log('pgvector ready: using Postgres vector path');
    } catch {
      this.logger.warn('pgvector not available; using in-memory path');
    }
  }

  /**
   * 向量检索 top-K。`visibleIds` 由调用方传入（数据隔离：内置库 + 用户自建），
   * 内存路径在此过滤；PG 路径在 SQL 中过滤。
   */
  async search(
    userId: number,
    query: string,
    topK = 8,
  ): Promise<RagFoodHit[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const queryVec = embedText(q);

    // ---- Postgres + pgvector 路径 ----
    if (this.pgReady) {
      const vecLiteral = `[${queryVec.map((v) => v.toFixed(6)).join(',')}]`;
      try {
        const rows = await this.prisma.$queryRaw<
          Array<{
            id: bigint;
            name: string;
            name_pinyin: string | null;
            aliases: string;
            category: string;
            kcal_per_100g: number;
            protein_g_per_100g: number;
            fat_g_per_100g: number;
            carb_g_per_100g: number;
            source: string;
            distance: number;
          }>
        >`
          SELECT f.id, f.name, f.name_pinyin, f.aliases::text AS aliases,
                 f.category, f.kcal_per_100g, f.protein_g_per_100g,
                 f.fat_g_per_100g, f.carb_g_per_100g, f.source,
                 e.embedding <=> ${vecLiteral}::vector AS distance
          FROM food_items f
          JOIN food_embeddings e ON e.food_item_id = f.id
          WHERE (f.source IN ('builtin','openfoodfacts','usda') OR f.created_by_user_id = ${userId})
            AND f.name NOT LIKE ${'%【隐藏】%'}
          ORDER BY e.embedding <=> ${vecLiteral}::vector
          LIMIT ${topK}
        `;
        return rows.map((r) => this.toHit(r, 1 - Number(r.distance)));
      } catch (err) {
        this.logger.warn(`pgvector query failed (${(err as Error).message}); falling back to memory`);
      }
    }

    // ---- 内存余弦路径 ----
    if (!this.memReady) return [];

    const scored = this.memVectors
      .map((s) => ({ key: s.key, score: cosineSimilarity(queryVec, s.vec) }))
      .filter((s) => s.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK * 3); // 先多取一些，回表 + 可见性过滤后可能变少

    if (scored.length === 0) return [];

    const names = scored.map((s) => s.key);
    const rows = await this.prisma.foodItem.findMany({
      where: {
        name: { in: names },
        OR: [
          { source: { in: ['builtin', 'openfoodfacts', 'usda'] } },
          { createdByUserId: userId },
        ],
      },
    });
    const scoreByName = new Map(scored.map((s) => [s.key, s.score]));
    return rows
      .map((r) => this.toHit(r as never, scoreByName.get(r.name) ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private toHit(
    row: {
      id: number | bigint;
      name: string;
      name_pinyin?: string | null;
      namePinyin?: string | null;
      aliases: string | string[];
      category: string;
      kcal_per_100g?: number;
      kcalPer100g?: number;
      protein_g_per_100g?: number;
      proteinGPer100g?: number;
      fat_g_per_100g?: number;
      fatGPer100g?: number;
      carb_g_per_100g?: number;
      carbGPer100g?: number;
      source: string;
    },
    score: number,
  ): RagFoodHit {
    let aliases: string[] = [];
    try {
      const parsed = typeof row.aliases === 'string' ? JSON.parse(row.aliases) : row.aliases;
      if (Array.isArray(parsed)) aliases = parsed.map(String);
    } catch {
      aliases = [];
    }
    return {
      id: Number(row.id),
      name: row.name,
      namePinyin: row.namePinyin ?? row.name_pinyin ?? null,
      aliases,
      category: row.category,
      kcalPer100g: row.kcalPer100g ?? row.kcal_per_100g ?? 0,
      proteinGPer100g: row.proteinGPer100g ?? row.protein_g_per_100g ?? 0,
      fatGPer100g: row.fatGPer100g ?? row.fat_g_per_100g ?? 0,
      carbGPer100g: row.carbGPer100g ?? row.carb_g_per_100g ?? 0,
      score: Number(score.toFixed(4)),
      citation: SOURCE_LICENSE[row.source] ?? {
        source: row.source,
        license: 'unknown',
        attribution: 'unknown',
      },
    };
  }
}

// 保留引用：toFoodItem 仍被 foods.service 主搜索使用，此处不做重复映射
export { toFoodItem };
