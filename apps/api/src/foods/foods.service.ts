import { Injectable } from '@nestjs/common';

import type {
  BarcodeLookupResponse,
  ExternalFoodItem,
  FoodItem,
  LiveSearchResponse,
} from '@qsh/shared-types';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { toFoodItem } from '../common/mappers/entity.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { LiveSearchDto } from './dto/live-search.dto';
import { SearchFoodsDto } from './dto/search-foods.dto';
import {
  BARCODE_PATTERN,
  OFF_LICENSE,
  OFF_SOURCE,
  fetchOpenFoodFactsProduct,
  searchOpenFoodFacts,
} from './external/off.client';
import type { ExternalFoodDraft } from './external/off.client';
import { keywordWhere, visibleFoodWhere } from './foods.util';
import { VectorSearchService } from './rag/vector-search.service';
import type { RagFoodHit } from './rag/vector-search.service';

/**
 * 食物库分页结果。
 * 形状对齐契约 `Paginated<FoodItem>`（`items/total/page/pageSize`，QA BUG-03）：
 * `limit/offset` 仅作为**入参别名**继续接受，响应体一律用契约字段名。
 */
export interface FoodSearchResult {
  items: FoodItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 食物库服务（R3.1~R3.4）：搜索 / 分类 / 最近吃过 / 收藏。
 *
 * ⚠️ SQLite 下 Prisma **不支持** `mode: 'insensitive'`，故统一使用普通 `contains`：
 * SQLite 的 `LIKE` 对 ASCII 天然大小写不敏感，中文按子串匹配即可满足需求。
 *
 * 检索来源（RAG 接线）：优先走 `VectorSearchService` 向量检索；以下情况静默回退到
 * 原有关键词检索（`keywordWhere`），保证 API 响应形状不变、SQLite 开发环境零负担：
 * - `DATABASE_URL` 为 SQLite（`file:` 前缀）→ 直接走关键词，不尝试向量；
 * - 向量检索抛错（pgvector 缺失 / 查询失败 / 种子向量未加载）→ catch 后降级。
 */
@Injectable()
export class FoodsService {
  /** 在线搜索结果缓存 TTL（10 分钟，Phase C-1）。 */
  private static readonly LIVE_CACHE_TTL_MS = 10 * 60_000;

  /** 在线搜索结果缓存最大条数（超出按最旧淘汰）。 */
  private static readonly LIVE_CACHE_MAX = 200;

  /** 进程内在线搜索缓存（`key = q|limit`）。仅缓存**成功**结果，降级不缓存。 */
  private readonly liveCache = new Map<string, { at: number; value: LiveSearchResponse }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly vectorSearch: VectorSearchService,
  ) {}

  /** 关键词 + 分类搜索（模糊匹配名称 / 拼音 / 别名）。 */
  async search(userId: number, dto: SearchFoodsDto): Promise<FoodSearchResult> {
    const keyword = (dto.q ?? dto.keyword ?? '').trim();
    const pageSize = dto.pageSize ?? dto.limit ?? 20;
    const page = dto.page ?? (dto.offset ? Math.floor(dto.offset / pageSize) + 1 : 1);
    const offset = (page - 1) * pageSize;

    const vectorHits = await this.tryVectorSearch(userId, keyword, pageSize);

    if (vectorHits !== null) {
      // 向量命中：沿用分页契约做内存分页；category 过滤在命中结果上追加（语义同关键词路径）。
      const filtered =
        dto.category && dto.category.trim().length > 0
          ? vectorHits.filter((hit) => hit.category === dto.category?.trim())
          : vectorHits;
      // 回表：按向量 id 取完整行，复用 `toFoodItem` 映射 —— 响应形状与关键词路径完全一致。
      const ids = filtered.slice(offset, offset + pageSize).map((hit) => hit.id);
      const rows = await this.prisma.foodItem.findMany({
        where: { id: { in: ids }, ...visibleFoodWhere(userId) },
      });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      const items = ids
        .map((id) => rowById.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .map(toFoodItem);
      return { items, total: filtered.length, page, pageSize };
    }

    const filters: object[] = [visibleFoodWhere(userId)];
    if (keyword.length > 0) {
      filters.push(keywordWhere(keyword));
    }
    if (dto.category && dto.category.trim().length > 0) {
      filters.push({ category: dto.category.trim() });
    }

    const where = { AND: filters };
    const [rows, total] = await Promise.all([
      this.prisma.foodItem.findMany({
        where,
        orderBy: [{ isVerified: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: pageSize,
      }),
      this.prisma.foodItem.count({ where }),
    ]);

    return { items: rows.map(toFoodItem), total, page, pageSize };
  }

  /**
   * 尝试向量检索；任何不可用场景返回 `null`（调用方回退关键词），绝不抛错。
   * SQLite（`DATABASE_URL` 以 `file:` 开头）直接短路为 `null`。
   */
  private async tryVectorSearch(
    userId: number,
    keyword: string,
    topK: number,
  ): Promise<RagFoodHit[] | null> {
    if (keyword.length === 0) return null;
    if ((process.env.DATABASE_URL ?? '').startsWith('file:')) return null; // SQLite → 关键词
    try {
      const hits = await this.vectorSearch.search(userId, keyword, topK);
      return hits.length > 0 ? hits : null; // 空命中也回退，保证搜索体验
    } catch {
      return null; // 静默降级：pgvector 缺失 / 查询失败 / 种子未加载
    }
  }

  /** 全部分类（去重、升序）。 */
  async categories(userId: number): Promise<string[]> {
    const rows = await this.prisma.foodItem.findMany({
      where: visibleFoodWhere(userId),
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    return rows.map((row) => row.category);
  }

  /** 「最近吃过」：从 `meal_logs` 关联食物库，去重后按最近时间倒序。 */
  async recent(userId: number, limit = 20): Promise<FoodItem[]> {
    const logs = await this.prisma.mealLog.findMany({
      where: { userId, foodItemId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { foodItem: true },
      take: 200,
    });

    const seen = new Set<number>();
    const items: FoodItem[] = [];
    for (const log of logs) {
      if (log.foodItem && log.foodItemId !== null && !seen.has(log.foodItemId)) {
        seen.add(log.foodItemId);
        items.push(toFoodItem(log.foodItem));
        if (items.length >= limit) {
          break;
        }
      }
    }
    return items;
  }

  /** 收藏列表。 */
  async favorites(userId: number): Promise<FoodItem[]> {
    const rows = await this.prisma.foodFavorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { foodItem: true },
    });
    return rows.map((row) => toFoodItem(row.foodItem));
  }

  /** 加入收藏（幂等）。 */
  async addFavorite(userId: number, foodId: number): Promise<{ favorited: true }> {
    await this.requireVisibleFood(userId, foodId);
    await this.prisma.foodFavorite.upsert({
      where: { userId_foodItemId: { userId, foodItemId: foodId } },
      create: { userId, foodItemId: foodId },
      update: {},
    });
    return { favorited: true };
  }

  /** 取消收藏（幂等）。 */
  async removeFavorite(userId: number, foodId: number): Promise<{ favorited: false }> {
    await this.prisma.foodFavorite.deleteMany({ where: { userId, foodItemId: foodId } });
    return { favorited: false };
  }

  // -------------------------------------------------------------------------
  // 在线食物库兜底（R3.6 / Phase C-1）：Open Food Facts 只读代理 + 幂等导入
  // -------------------------------------------------------------------------

  /**
   * 在线搜索（Open Food Facts 只读代理）。
   *
   * 与本地检索互补：前端仅当本地命中为空（或用户主动点「搜索在线食物库」）时才调用。
   * - 结果映射为 `FoodItem` 形状（无 DB `id`，带 `source: 'openfoodfacts'` / `license` / `sourceUrl`）；
   * - 命中进程内缓存（TTL 10 分钟 / 上限 200 条，**仅缓存成功结果**，降级不缓存）；
   * - 上游不可用 → `degraded: true` + 空数组（HTTP 200，绝不 500）；
   * - **只转发搜索词**，不携带任何用户数据。
   */
  async liveSearch(userId: number, dto: LiveSearchDto): Promise<LiveSearchResponse> {
    void userId; // 鉴权在控制器层完成；代理查询不涉及用户数据
    const query = (dto.q ?? '').trim();
    const limit = dto.limit ?? 10;

    if (query.length === 0) {
      return this.liveResponse([], 0, false);
    }

    const cacheKey = `${query}|${limit}`;
    const cached = this.liveCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < FoodsService.LIVE_CACHE_TTL_MS) {
      return cached.value;
    }

    const outcome = await searchOpenFoodFacts(query, limit);
    const items = outcome.drafts.map((draft) => this.toExternalItem(draft));
    const value = this.liveResponse(items, outcome.skipped, outcome.degraded);

    if (!outcome.degraded) {
      this.rememberLive(cacheKey, value);
    }
    return value;
  }

  /**
   * 把一条在线食物**导入**本地食物库（幂等）。
   *
   * **安全**：营养数据一律**重新从 OFF 拉取**，绝不采信客户端传入的任何热量 / 宏量字段。
   * - 命中已有 `barcode` → 直接返回（离线可用，不重复插）；
   * - 上游不可用 → 503 `E_EXTERNAL_UNAVAILABLE`（可读，不 500）；
   * - 上游确认不存在 → 404 `E_NOTFOUND_FOOD`。
   */
  async importExternal(userId: number, externalId: string): Promise<FoodItem> {
    void userId; // 开放数据库全局可见；入库归属 NULL（source=openfoodfacts）
    const code = externalId.trim();
    if (!BARCODE_PATTERN.test(code)) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '条码应为 8–14 位数字', {
        externalId: '条码应为 8–14 位数字',
      });
    }

    const existing = await this.prisma.foodItem.findFirst({ where: { barcode: code } });
    if (existing !== null) {
      return toFoodItem(existing);
    }

    const { draft, degraded } = await fetchOpenFoodFactsProduct(code);
    if (degraded) {
      throw new ApiException(503, ERROR_CODES.EXTERNAL_UNAVAILABLE, '在线食物库暂时连不上，稍后再试或手动添加');
    }
    if (draft === null) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_FOOD, '在线食物库里没有这条');
    }
    return this.persistDraft(draft);
  }

  /**
   * 条码查询（R3.6 / Phase C-2）：先查本地库，未命中再查 OFF，命中即**幂等入库**返回。
   * - 非法格式 → 400；上游不可用 → `{ item: null, degraded: true }`（HTTP 200，非错误）；
   * - 确认不存在 → 404 `E_NOTFOUND_FOOD`。
   */
  async findByBarcode(userId: number, rawCode: string): Promise<BarcodeLookupResponse> {
    void userId; // 同上：仅按条码查询，不涉及用户数据
    const code = (rawCode ?? '').trim();
    if (!BARCODE_PATTERN.test(code)) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '条码应为 8–14 位数字', {
        code: '条码应为 8–14 位数字',
      });
    }

    const local = await this.prisma.foodItem.findFirst({ where: { barcode: code } });
    if (local !== null) {
      return { item: toFoodItem(local), degraded: false };
    }

    const { draft, degraded } = await fetchOpenFoodFactsProduct(code);
    if (degraded) {
      return { item: null, degraded: true };
    }
    if (draft === null) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_FOOD, '没有找到这个条码');
    }
    return { item: await this.persistDraft(draft), degraded: false };
  }

  /** 组装在线搜索响应（统一带来源与许可）。 */
  private liveResponse(
    items: ExternalFoodItem[],
    skipped: number,
    degraded: boolean,
  ): LiveSearchResponse {
    return { items, found: items.length, skipped, degraded, source: OFF_SOURCE, license: OFF_LICENSE };
  }

  /** 草稿 → 契约 `ExternalFoodItem`。 */
  private toExternalItem(draft: ExternalFoodDraft): ExternalFoodItem {
    return {
      externalId: draft.externalId,
      name: draft.name,
      category: draft.category,
      kcalPer100g: draft.kcalPer100g,
      proteinGPer100g: draft.proteinGPer100g,
      fatGPer100g: draft.fatGPer100g,
      carbGPer100g: draft.carbGPer100g,
      servingUnits: draft.servingUnits,
      defaultServingGrams: draft.defaultServingGrams,
      barcode: draft.barcode,
      brand: draft.brand,
      sourceUrl: draft.sourceUrl,
      source: OFF_SOURCE,
      license: OFF_LICENSE,
    };
  }

  /** 写入内存缓存（超出上限时淘汰最旧一条）。 */
  private rememberLive(key: string, value: LiveSearchResponse): void {
    if (this.liveCache.size >= FoodsService.LIVE_CACHE_MAX) {
      const oldestKey = this.liveCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.liveCache.delete(oldestKey);
      }
    }
    this.liveCache.set(key, { at: Date.now(), value });
  }

  /**
   * 把 OFF 草稿幂等写入 `food_items`：
   * `source=openfoodfacts`（`visibleFoodWhere` 视为全局可见）、归属 `NULL`、`barcode` 唯一键 upsert。
   */
  private async persistDraft(draft: ExternalFoodDraft): Promise<FoodItem> {
    const row = await this.prisma.foodItem.upsert({
      where: { barcode: draft.barcode },
      create: {
        name: draft.name,
        aliases: JSON.stringify([]),
        category: draft.category,
        kcalPer100g: draft.kcalPer100g,
        proteinGPer100g: draft.proteinGPer100g,
        fatGPer100g: draft.fatGPer100g,
        carbGPer100g: draft.carbGPer100g,
        servingUnits: JSON.stringify(draft.servingUnits),
        defaultServingGrams: draft.defaultServingGrams,
        barcode: draft.barcode,
        source: OFF_SOURCE,
        createdByUserId: null,
        isVerified: false,
      },
      update: {},
    });
    return toFoodItem(row);
  }

  /**
   * 校验食物存在且对该用户可见，返回 Prisma 行。
   * 不可见 / 不存在统一抛 404（不泄露存在性）。
   */
  async requireVisibleFood(userId: number, foodId: number) {
    const food = await this.prisma.foodItem.findFirst({
      where: { id: foodId, ...visibleFoodWhere(userId) },
    });
    if (!food) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_FOOD, '没有找到这个食物');
    }
    return food;
  }
}
