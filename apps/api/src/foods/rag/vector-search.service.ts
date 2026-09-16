import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

/** 种子向量文件相对仓库根的路径片段。 */
const FOOD_EMBEDDINGS_RELATIVE = join('infra', 'db', 'seed', 'food_embeddings.json');

/**
 * `__dirname` 向上回溯的最大层数。
 * 编译产物位于 `<repo>/apps/api/dist/apps/api/src/foods/rag/`，到仓库根需 8 层；
 * 源码运行时（ts-node/vitest）位于 `<repo>/apps/api/src/foods/rag/`，需 5 层。
 * 取 16 层留足余量，避免因构建布局微调而失效。
 */
const MAX_DIRNAME_ASCENT = 16;

/** `resolveFoodEmbeddingsPath` 的可选覆盖项（仅供测试注入，生产默认从真实环境推导）。 */
export interface ResolveFoodEmbeddingsPathOptions {
  /** 向上回溯的基线目录，默认 `__dirname`（模块自身所在目录）。 */
  startDir?: string;
  /** cwd 候选的基线目录，默认 `process.cwd()`。 */
  cwd?: string;
}

/**
 * 稳健解析种子向量文件 `food_embeddings.json` 的绝对路径。
 *
 * 历史 Bug（已修复）：此前直接 `join(process.cwd(), 'infra/db/seed/...')`，
 * 导致服务从 `apps/api` 目录启动时（cwd=apps/api）解析到不存在的路径而 ENOENT，
 * 内存向量恒为空、向量检索静默退化成 LIKE 关键词——生产因恰好从仓库根启动而掩盖了问题。
 *
 * 解析优先级（命中第一个 `existsSync` 为真的路径即返回）：
 *   ① 环境变量 `FOOD_EMBEDDINGS_PATH`（显式覆盖；绝对或相对 cwd 均可）。
 *   ② 基于 `__dirname` 逐级向上回溯，拼接 `infra/db/seed/food_embeddings.json`
 *      —— 与 cwd 无关，是「无论从哪里启动都能命中」的兜底。
 *   ③ cwd 三级候选：`<cwd>/…`、`<cwd>/../../…`、`<cwd>/../../../…`
 *      —— 兼容从仓库根、`apps/api`、`apps/api/dist` 等各异 cwd 启动的场景。
 *
 * 全部候选均不存在时，返回最贴近源码布局的「推测路径」（不存在的绝对路径），
 * 由调用方 `readFileSync` 抛出 ENOENT 后安全降级为 LIKE 检索。
 * **本函数绝不抛错**（只有 `existsSync` 与纯路径拼接，无 IO 副作用）。
 *
 * @param options 可选覆盖项（测试注入用），默认从 `__dirname` 与 `process.cwd()` 推导。
 * @returns 候选向量文件的绝对路径（优先返回一个真实存在的路径）。
 */
export function resolveFoodEmbeddingsPath(
  options: ResolveFoodEmbeddingsPathOptions = {},
): string {
  // 运行时兜底：CJS 产物中 `__dirname` 恒为字符串；某些 ESM 转换环境可能未定义。
  const startDir =
    options.startDir ?? (typeof __dirname === 'string' ? __dirname : process.cwd());
  const cwd = options.cwd ?? process.cwd();

  // ① 显式覆盖：环境变量优先。
  const override = (process.env.FOOD_EMBEDDINGS_PATH ?? '').trim();
  if (override.length > 0) {
    const overridePath = isAbsolute(override) ? override : resolve(cwd, override);
    if (existsSync(overridePath)) return overridePath;
    // 覆盖路径不存在时继续尝试其余候选，最终统一降级（不在此处抛错）。
  }

  // ② 基于 __dirname 向上回溯到仓库根。
  let dir = startDir;
  for (let i = 0; i < MAX_DIRNAME_ASCENT; i++) {
    const candidate = join(dir, FOOD_EMBEDDINGS_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // 已抵达文件系统根，停止回溯。
    dir = parent;
  }

  // ③ cwd 三级候选（覆盖仓库根 / apps/api / apps/api/dist 等布局）。
  const cwdCandidates = [
    join(cwd, FOOD_EMBEDDINGS_RELATIVE),
    join(cwd, '..', '..', FOOD_EMBEDDINGS_RELATIVE),
    join(cwd, '..', '..', '..', FOOD_EMBEDDINGS_RELATIVE),
  ];
  for (const candidate of cwdCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  // 全部失败：返回推测路径（不存在），由调用方安全降级。
  return join(startDir, FOOD_EMBEDDINGS_RELATIVE);
}

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
    // 路径解析与 cwd 解耦（见 resolveFoodEmbeddingsPath）；解析本身不抛错。
    const path = resolveFoodEmbeddingsPath();
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
        dim: number;
        vectors: StoredEmbedding[];
      };
      if (raw.dim !== FOOD_EMBED_DIM) {
        this.logger.warn(
          `embedding dim mismatch: file=${raw.dim} code=${FOOD_EMBED_DIM} (from=${path})`,
        );
        return;
      }
      this.memVectors.push(...raw.vectors);
      this.memReady = true;
      this.logger.log(
        `loaded ${raw.vectors.length} food embeddings (dim=${raw.dim}, from=${path})`,
      );
    } catch (err) {
      this.logger.warn(
        `food_embeddings.json not loaded (${(err as Error).message}); RAG falls back to LIKE search`,
      );
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
