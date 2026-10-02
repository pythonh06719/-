import { Injectable } from '@nestjs/common';

import { Prisma } from '@prisma/client';

import {
  FOOD_HISTORY_DEFAULTS,
  FOOD_SEARCH_DEFAULT_PAGE_SIZE,
  FREQUENT_FOOD_DEFAULTS,
  foodIdentity,
  pageFoodSearch,
  rankFrequentFoods,
  rankFoodSearch,
  selectFoodHistoryEntries,
} from '@qsh/core';
import type { FoodSearchCandidate, FrequentFoodRow } from '@qsh/core';
import type {
  BarcodeLookupResponse,
  ExternalFoodItem,
  FoodHistoryResponse,
  FoodItem,
  FoodSearchHit,
  LastPortion,
  LastPortionsResponse,
  LiveSearchResponse,
  MealType,
  TopFoodItem,
  TopFoodsResponse,
} from '@qsh/shared-types';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import {
  parseJsonStringArray,
  parseServingUnits,
  toFoodItem,
} from '../common/mappers/entity.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, todayLocalKey } from '../common/utils/date.util';
import { CreateCustomFoodDto } from './dto/create-custom-food.dto';
import { LiveSearchDto } from './dto/live-search.dto';
import { SearchFoodsDto } from './dto/search-foods.dto';
import { UpdateCustomFoodDto } from './dto/update-custom-food.dto';
import {
  BARCODE_PATTERN,
  OFF_LICENSE,
  OFF_SOURCE,
  fetchOpenFoodFactsProduct,
  searchOpenFoodFacts,
} from './external/off.client';
import type { ExternalFoodDraft } from './external/off.client';
import {
  FOOD_HISTORY_SCAN_LIMIT,
  FOOD_IDENTITY_PROJECTION_LIMIT,
  FOOD_SEARCH_RANK_SCAN_LIMIT,
  keywordWhere,
  visibleFoodWhere,
} from './foods.util';
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
 * 相关度优先搜索结果（`GET /api/foods/search`）。
 *
 * 形状与 `FoodSearchResult` 一致（`items/total/page/pageSize`），只是单条多了
 * **区分词标注** `qualifier`（跨来源同物异名靠它区分，**不合并**）。
 */
export interface FoodSearchRankedResult {
  items: FoodSearchHit[];
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
   * **相关度优先**搜索（`GET /api/foods/search`，阶段 2）。
   *
   * 与 `search()` 的区别（为什么另开端点而不是改旧端点）：
   * - 旧 `GET /api/foods` 的排序是 `isVerified desc, id asc`（**退化排序**，实际 = 入库顺序），
   *   改它会动到既有契约与用例，故保持不动；
   * - 新端点明确按**相关度**排序（前缀 > 子串 > 仅别名，同档按 `id` 稳定分页），
   *   并把跨来源同物异名的**区分词**标出来。
   *
   * 🔴 **红线：绝不按热量 / 任何营养字段排序** —— 排序函数 `rankFoodSearch` 只接收身份字段
   * （id / name / namePinyin / aliases），从接口上就不存在按营养排序的可能（PRD §7 无负罪感）。
   *
   * ⚠️ **不使用向量兜底**：相关度排序必须是确定、可解释的顺序（同一关键词每次结果一致，
   * 便于「加载更多」稳定分页）；向量检索的顺序不可解释，故本端点只走关键词候选 + 内存排序。
   */
  async searchRanked(userId: number, dto: SearchFoodsDto): Promise<FoodSearchRankedResult> {
    const keyword = (dto.q ?? dto.keyword ?? '').trim();
    const pageSize = dto.pageSize ?? dto.limit ?? FOOD_SEARCH_DEFAULT_PAGE_SIZE;
    const page = dto.page ?? (dto.offset ? Math.floor(dto.offset / pageSize) + 1 : 1);

    const filters: object[] = [visibleFoodWhere(userId)];
    if (keyword.length > 0) {
      filters.push(keywordWhere(keyword));
    }
    if (dto.category && dto.category.trim().length > 0) {
      filters.push({ category: dto.category.trim() });
    }
    const where = { AND: filters };

    // ① 最小投影取候选（排序只需要身份字段）+ 总数（分页用，`total` 不受扫描上限影响）。
    const [rows, total] = await Promise.all([
      this.prisma.foodItem.findMany({
        where,
        select: { id: true, name: true, namePinyin: true, aliases: true },
        orderBy: { id: 'asc' },
        take: FOOD_SEARCH_RANK_SCAN_LIMIT,
      }),
      this.prisma.foodItem.count({ where }),
    ]);

    // ② 纯函数排序（`packages/core`，前后端同一口径）。
    const candidates: FoodSearchCandidate[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      namePinyin: row.namePinyin,
      aliases: parseJsonStringArray(row.aliases),
    }));
    const ranked = rankFoodSearch(candidates, keyword);
    const hitById = new Map(ranked.map((hit) => [hit.id, hit]));
    const pageIds = pageFoodSearch(ranked, page, pageSize);

    // ③ 只回表当前页（一次 `in` 查询，避免 N+1），再按排序顺序还原。
    const fullRows =
      pageIds.length === 0
        ? []
        : await this.prisma.foodItem.findMany({
            where: { id: { in: pageIds }, ...visibleFoodWhere(userId) },
          });
    const rowById = new Map(fullRows.map((row) => [row.id, row]));

    const items: FoodSearchHit[] = [];
    for (const id of pageIds) {
      const row = rowById.get(id);
      const hit = hitById.get(id);
      if (row === undefined || hit === undefined) {
        continue; // 理论上不会发生（候选来自同一 `where`）
      }
      items.push({ ...toFoodItem(row), qualifier: hit.qualifier, matchRank: hit.rank });
    }

    return { items, total, page, pageSize };
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

  /**
   * **上次份量记忆**（D-1）：批量取若干个食物「**最近一次有有效份量**的记录」。
   *
   * ## 为什么是**批量**端点（而不是单个 `GET /foods/:id/last-portion`）
   *
   * 前端要在**点选前**就把默认份量算好（才能真正「不多点一次」）；若走单点端点，
   * 列表里每一条都要各发一次请求（搜索列表一屏 20 条、每次改关键词都会重拉），
   * 请求数会随列表长度线性放大。批量端点把「一屏食物的上次份量」收敛成**一次请求**，
   * 也让默认值在用户点下去之前就已就绪（不会出现「先显示默认、再跳成上次值」的抖动）。
   *
   * ## 只查本人（NFR-2 / K7）
   *
   * `userId` 一律取自 JWT（控制器传入），**绝不接受客户端传入**。且先按
   * `visibleFoodWhere` 过滤可见 id：对当前用户**不可见**的食物，其键**根本不出现**
   * 在结果里（不泄露「这个食物是否存在」）。
   *
   * ## 「有有效份量」的判定（与 `@qsh/core` 的 `hasUsablePortion` **逐条同口径**）
   *
   * 一条记录算「有有效份量」须满足二者之一：
   * 1. **正克数**（`grams > 0`）；
   * 2. 或 **非空 `servingUnit` 且 `servingQty > 0`**（此时克数需借食物库单位表才能换算）。
   *
   * 快加卡 / 自定义空白记录（三者皆空、`grams` 为 `null`）**不是**「上次份量」，
   * 否则会把用户上次吃的量抹成 0。
   *
   * ⚠️ **本 SQL 过滤与 core 的判定必须同步修改**：任一处改了规则，
   * `test/foods-last-portion.e2e.test.ts` 的边界用例必须先红（本项目反复出现的
   * 「同一件事两处实现口径不一致」正是靠这条镜像约束兜住）。
   * 注：写入路径（`resolveMealAmount` / 更新路径）落库的 `servingUnit` 要么是 `null`，
   * 要么是**已 trim 且命中食物库单位表**的非空串，故不存在「纯空白单位」形态，
   * `非空` 判据用 `not: ''` 即可与 core 的 `trim().length > 0` 等价。
   *
   * ## 取「最近一次」的排序
   *
   * `orderBy: [loggedDate desc, id desc]` —— 先用**本地日粒度**日期倒排，同日再按自增
   * `id` 倒排取最后写入的一条。命中 `ix_meal_user_food`（`@@index([userId, foodItemId])`）。
   *
   * @param userId 当前登录用户 id（来自 JWT）
   * @param ids    已规整的食物 id 列表（去重、正整数、上限见 `parseFoodIdCsv`）
   * @returns `{ portions }`：可见 id → 最近一次份量；可见但无历史 → `null`；不可见 → 无键
   */
  async lastPortions(userId: number, ids: readonly number[]): Promise<LastPortionsResponse> {
    const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
    if (unique.length === 0) {
      return { portions: {} };
    }

    // ① 可见性过滤（K7）：只处理对本人可见的食物，不可见的**不出键**。
    const visible = await this.prisma.foodItem.findMany({
      where: { id: { in: unique }, ...visibleFoodWhere(userId) },
      select: { id: true },
    });

    // ② 逐个取「最近一次有有效份量的本人记录」（命中 ix_meal_user_food）。
    //    用 `Promise.all` 并行：单个请求的 id 数已被 `parseFoodIdCsv` 限制在上限内。
    const portions: Record<string, LastPortion | null> = {};
    await Promise.all(
      visible.map(async (food) => {
        const row = await this.prisma.mealLog.findFirst({
          where: {
            userId,
            foodItemId: food.id,
            // 有效份量（与 @qsh/core 的 `hasUsablePortion` 逐条镜像，见方法注释）：
            // ① 有**正克数**（`gt: 0` 天然排除 null / 0 / 负数）；或
            // ② **非空份量单位 + 正数量**（`servingUnit` 既非 null 又非空串，且 `servingQty > 0`）。
            // 快加卡 / 空白记录（三者皆空）两条分支都不满足 → 被跳过，让更早的有效记录浮上来。
            OR: [
              { grams: { gt: 0 } },
              {
                AND: [
                  { servingUnit: { not: null } },
                  { servingUnit: { not: '' } },
                  { servingQty: { gt: 0 } },
                ],
              },
            ],
          },
          orderBy: [{ loggedDate: 'desc' }, { id: 'desc' }],
          select: { grams: true, servingUnit: true, servingQty: true },
        });
        portions[String(food.id)] =
          row === null
            ? null
            : { grams: row.grams, servingUnit: row.servingUnit, servingQty: row.servingQty };
      }),
    );

    return { portions };
  }

  /**
   * **我什么时候吃过它**（D-5）：`GET /api/foods/:id/history?limit=`。
   *
   * 返回该食物在**本人**记录里的历史日期明细（日期 + 餐次 + 份量），**日期倒序**，
   * 供搜索结果 / 最近 / 收藏里的任意一行展开查看 —— 补上「常吃榜之外无处可查」的缺口。
   *
   * ## ⚠️ 核心难点：快加卡记录查不到（唯一真成本点）
   *
   * `meals.quickAdd` 写入时 `foodItemId: null`，**只有 `customName`**。
   * 故只按 `foodItemId` 查，**一条快加记录都查不到** —— 而快加卡恰恰是「随手记一笔」
   * 的主力来源，漏掉它等于这个功能对相当比例的用户是空的。
   *
   * 解决办法是**按名称归一**匹配，且**必须复用 core 的唯一实现**（K16）：
   * - 目标键：`foodIdentity({ foodItemId, foodName: food.name })`；
   * - 每条候选行：`foodIdentity({ foodItemId, customName })`；
   * - 相等即命中。
   *
   * 🔴 **绝不允许在这里自己写一套「去空格 + 转小写」**：那会让同一道菜在常吃榜里算 1 种、
   * 在这里算 2 种，两个互相打架的数字正是 K16 要防的事。
   *
   * ## 合并口径沿用 D-4
   *
   * 「库内条目与同名快加条目合并为 1 种」是**既定口径、不是 bug**（见
   * `docs/ARCHITECTURE-增量-补完三项.md` D-4，与 `rankFrequentFoods` 一致）。
   *
   * ## 可见性（K7 纵深防御）
   *
   * ① 目标食物本身走 `requireVisibleFood`（含 `visibleFoodWhere`）：他人私有自定义食物
   *    → 404，不暴露存在性；
   * ② `meal_logs` 一律 `where: { userId }`（`userId` 取自 JWT，**绝不接受客户端传入**）：
   *    他人对**同一食物**的记录绝不会混进我的结果。
   *
   * ## 为什么用 `findMany` 而不是 `groupBy`
   *
   * 响应要「日期 + 餐次 + 份量」，而 `meal_logs` 的 `groupBy` 三元组
   * （`foodItemId` / `customName` / `loggedDate`）**不含** `mealType` / `grams` /
   * `servingUnit` —— 用了 `groupBy` 就得再查一次明细把日期补齐，纯属绕路。
   * 故取**最小 `select`** 的 `findMany` + `take` 上限（`FOOD_HISTORY_SCAN_LIMIT`），
   * 排序与截断交给 core 的 `selectFoodHistoryEntries`（零 IO 纯函数，可单测）。
   *
   * @param userId 当前登录用户 id（来自 JWT）
   * @param foodId 被查询的食物 id
   * @param limit 返回条数上限，1–100（越界 400）
   */
  async history(
    userId: number,
    foodId: number,
    limit: number = FOOD_HISTORY_DEFAULTS.limit,
  ): Promise<FoodHistoryResponse> {
    if (!Number.isFinite(limit) || limit < 1 || limit > FOOD_HISTORY_DEFAULTS.maxLimit) {
      throw new ApiException(
        400,
        ERROR_CODES.VALID_INPUT,
        `返回条数应在 1 到 ${FOOD_HISTORY_DEFAULTS.maxLimit} 之间`,
        { limit: `返回条数应在 1 到 ${FOOD_HISTORY_DEFAULTS.maxLimit} 之间` },
      );
    }

    // ① 目标食物必须存在且对本人可见，否则 404（K7：不暴露存在性）。
    const food = await this.requireVisibleFood(userId, foodId);

    // ② 目标身份键 —— 走 core 唯一实现（K16）。
    const targetKey = foodIdentity({ foodItemId: food.id, foodName: food.name });
    if (targetKey === null) {
      return { foodId: food.id, name: food.name, items: [] };
    }

    // ③ 候选行：库内条目命中 **或** 快加卡（`foodItemId IS NULL` 且有 `customName`）。
    //    `where: { userId }` 是数据隔离的**唯一**来源（绝不接受客户端传入 userId）。
    //    `take` 为纵深防御上限（见 `FOOD_HISTORY_SCAN_LIMIT` 注释）。
    const rows = await this.prisma.mealLog.findMany({
      where: {
        userId,
        OR: [{ foodItemId: food.id }, { foodItemId: null, customName: { not: null } }],
      },
      orderBy: [{ loggedDate: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        loggedDate: true,
        mealType: true,
        grams: true,
        servingUnit: true,
        servingQty: true,
        foodItemId: true,
        customName: true,
      },
      take: FOOD_HISTORY_SCAN_LIMIT,
    });

    // ④ 身份归一 + 排序 + 截断，全部交给 core（单一真源，K16）。
    //    ⚠️ `foodName` **必须**按 `top()`（第 446 行）同款规则给：`foodItemId` 非空的行
    //    要反查回显示名，否则 `foodIdentity` 会因「显示名为空」回落到 `food:<id>`，
    //    与目标键（归一后的食物名）比不上 → **库内条目一条都命中不了**。
    //    这里 `requireVisibleFood` 已把目标食物整行取回，名字直接可用，无需额外查询。
    const items = selectFoodHistoryEntries(
      rows.map((row) => ({
        id: row.id,
        loggedDate: row.loggedDate,
        mealType: row.mealType,
        grams: row.grams,
        servingUnit: row.servingUnit,
        servingQty: row.servingQty,
        foodItemId: row.foodItemId,
        customName: row.customName,
        foodName: row.foodItemId === null ? null : food.name,
      })),
      targetKey,
      { limit: Math.floor(limit) },
    );

    return {
      foodId: food.id,
      name: food.name,
      items: items.map((item) => ({ ...item, mealType: item.mealType as MealType })),
    };
  }

  /**
   * 按 id 取单条食物（B3「改份量」：编辑面板要读这条食物的份量单位）。
   *
   * 不可见 / 不存在统一 404（复用 `requireVisibleFood`，与既有口径一致）。
   */
  async byId(userId: number, foodId: number): Promise<FoodItem> {
    const row = await this.requireVisibleFood(userId, foodId);
    return toFoodItem(row);
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

  /**
   * **我的常吃榜**（R11.5 / AC-11.5.1）：近 N 天按**出现天数**（distinct `loggedDate`）降序取前 N。
   *
   * 全部聚合由 SQL `groupBy` 下推（K15）：最小投影为
   * `(foodItemId, customName, loggedDate)` 三元组 —— 「出现天数」在数学上**无法**
   * 用比「（身份候选, 日期）二元组」更小的数据算出，这是最小必要投影，不是妥协（D-5）。
   * 排名与身份归一交给 `@qsh/core` 的 `rankFrequentFoods`，与前端展示同一口径（NFR-11）。
   *
   * ⚠️ 与 `recent()`（时间倒序去重，服务「最近」tab）**语义并列、互不影响**：
   * 改 `recent()` 会造成回归，故本轮另开 `/foods/top`（D-3）。
   *
   * 数据不足（出现天数 < 3）→ `items: []`（**不是 null、不是缺字段**，UI 整块隐藏）。
   *
   * @param days 统计窗口（天，含今天），1–365
   * @param limit 返回条数上限，1–50
   */
  async top(
    userId: number,
    days: number = FREQUENT_FOOD_DEFAULTS.days,
    limit: number = FREQUENT_FOOD_DEFAULTS.limit,
  ): Promise<TopFoodsResponse> {
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '统计天数应在 1 到 365 之间', {
        days: '统计天数应在 1 到 365 之间',
      });
    }
    if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '返回条数应在 1 到 50 之间', {
        limit: '返回条数应在 1 到 50 之间',
      });
    }

    const windowDays = Math.floor(days);
    const to = todayLocalKey();
    const from = addDays(to, -(windowDays - 1));

    // ① 最小投影：(身份候选, 日期) 二元组。`take` 为纵深防御上限（见常量注释）。
    const grouped = await this.prisma.mealLog.groupBy({
      by: ['foodItemId', 'customName', 'loggedDate'],
      where: { userId, loggedDate: { gte: from, lte: to } },
      orderBy: [{ loggedDate: 'asc' }, { foodItemId: 'asc' }, { customName: 'asc' }],
      take: FOOD_IDENTITY_PROJECTION_LIMIT,
    });

    // ② 一次 `in` 查询反查显示名，避免 N+1（D-6）。
    // ⚠️ 必须叠加 `visibleFoodWhere(userId)`（K7 纵深防御）：否则可能反查出**他人私有**自定义食物的名称。
    // 正常数据下不会命中不可见项，叠加后行为不变，仅堵住越权展示的可能。
    const ids = [...new Set(grouped.map((row) => row.foodItemId).filter((id): id is number => id !== null))];
    const nameById = new Map<number, string>();
    if (ids.length > 0) {
      const rows = await this.prisma.foodItem.findMany({
        where: { id: { in: ids }, ...visibleFoodWhere(userId) },
        select: { id: true, name: true },
      });
      for (const row of rows) {
        nameById.set(row.id, row.name);
      }
    }

    // ③ 组装最小投影行，交给 core 排名
    const projection: FrequentFoodRow[] = grouped.map((row) => ({
      foodItemId: row.foodItemId,
      customName: row.customName,
      foodName: row.foodItemId === null ? null : (nameById.get(row.foodItemId) ?? null),
      loggedDate: row.loggedDate,
    }));

    const ranked = rankFrequentFoods(projection, {
      days: windowDays,
      limit: Math.floor(limit),
      minDays: FREQUENT_FOOD_DEFAULTS.minDays,
    });

    if (ranked.length === 0) {
      return { days: windowDays, items: [] };
    }

    // ④ 一次取完整条目，供 Composer 复用既有「份量确认 → 确认记录」路径。
    // ⚠️ 同样叠加 `visibleFoodWhere(userId)`（K7）：详情不高于列表/名称的可见性。
    const resultIds = [...new Set(ranked.map((item) => item.foodItemId).filter((id): id is number => id !== null))];
    const foodById = new Map<number, FoodItem>();
    if (resultIds.length > 0) {
      const rows = await this.prisma.foodItem.findMany({
        where: { id: { in: resultIds }, ...visibleFoodWhere(userId) },
      });
      for (const row of rows) {
        foodById.set(row.id, toFoodItem(row));
      }
    }

    // ⑤ 透传 core 已算好的 `lastLoggedDate`（该身份最近一次出现的日期）。
    //    **零新查询**：它就是上面 `rankFrequentFoods` 的返回值之一，此前只是没往下带。
    const items: TopFoodItem[] = ranked.map((item) => ({
      name: item.name,
      dayCount: item.dayCount,
      foodItemId: item.foodItemId,
      lastLoggedDate: item.lastLoggedDate,
      food: item.foodItemId === null ? null : (foodById.get(item.foodItemId) ?? null),
    }));

    return { days: windowDays, items };
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

  // -------------------------------------------------------------------------
  // 用户自定义食物（C-4 第一步 / R3.6）：把「快加卡」记下的食物存进个人食物库
  // -------------------------------------------------------------------------

  /**
   * 新建**用户自定义食物**（`POST /api/foods`）—— 把用户手填的食物变成可复用条目。
   *
   * ## 为什么需要它
   *
   * 快速加卡（`POST /api/meals/quick-add`）此前只写 `meal_logs`（`foodItemId: null`），
   * 这条食物**下次搜不到、无法复用**，用户只能重填一遍。本方法补上「让它可复用」。
   *
   * ## 归属与来源：一律服务端决定（硬约束，不可协商）
   *
   * - `source` **硬编码 `'user_custom'`**，绝不取自请求体 —— `food_items.source` 在
   *   Prisma 里是普通 `String`（非 enum）、生成的 SQLite 表**没有 CHECK 约束**，
   *   若接受客户端传入，客户端可提交 `'builtin'` 把自己造的食物伪装成内置食物
   *   （污染全站可见口径）。DTO 里根本没有这个字段，这里再显式写死；
   * - `createdByUserId` **取 JWT 里的 `userId`**，绝不取自请求体 —— 否则可把食物
   *   挂到他人名下（越权写入他人私有库）；
   * - `isVerified: false`：用户自建条目**永不**标为已核验（那是内置/权威来源的标志）。
   *
   * ## 可见性（复用既有分支，不改 `visibleFoodWhere`）
   *
   * `visibleFoodWhere` 的第二个分支是 `createdByUserId: userId` 而**不是**
   * `source: 'user_custom'` —— 这是**有意的解耦**（「本人创建的任何条目可见」）。
   * 故无需为本功能改动任何可见性逻辑：写入 `createdByUserId` 后，本条目自然只对
   * 创建者可见，跨用户搜不到。
   *
   * ## 去重策略：**允许同名重复，不报错、不覆盖**
   *
   * 用户自用场景下，同名条目往往是**不同做法 / 不同店家的同一道菜**（「楼下麻辣烫」
   * 换一家店热量就不一样），强行去重会惹人烦；静默覆盖更是会**改掉用户已经记过的
   * 那条的口径**（历史记录与食物库参照物突然变了，属于数据一致性事故）。
   * 前端另有 C1「同名温和提示」在提交前**问一句** —— 提示属于提示，不在这里拦。
   *
   * @param userId 当前登录用户 id（来自 JWT，控制器传入）
   * @param dto 已通过 `CreateCustomFoodDto` 校验的请求体
   * @returns 落库后的 `FoodItem`（可供前端立即选中记录，或刷新搜索命中）
   */
  async createCustom(userId: number, dto: CreateCustomFoodDto): Promise<FoodItem> {
    const name = dto.name.trim();
    // 防御：`@MinLength(1)` 允许纯空白字符串（长度 ≥ 1），这里再判一次「trim 后非空」。
    if (name.length === 0) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请填写名称', {
        name: '请填写名称',
      });
    }

    // 份量单位归一：复用读路径的同一套解析（`parseServingUnits`）—— 保证「写进去的
    // 一定能读出来」（写读对称），并顺带滤掉非法元素（空 unit / 非正 grams）。
    const servingUnits = parseServingUnits(JSON.stringify(dto.servingUnits ?? []));
    // 默认份量克数取**标记为默认的那一条**，否则取第一条 —— 与既有 `resolveDefaultServing`
    // 的前端口径一致（有 defaultServingGrams 就用它，否则回落到基准份量）。
    const defaultServingGrams =
      servingUnits.find((item) => item.isDefault === true)?.grams ?? servingUnits[0]?.grams ?? null;

    // 别名：去空白 + 去空串 + 去重（不做小写归一：中文别名无大小写，英文别名保留原样更利于用户识别）。
    const aliases = [...new Set((dto.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0))];

    const barcode = dto.barcode?.trim();

    try {
      const row = await this.prisma.foodItem.create({
        data: {
          name,
          namePinyin: null, // 用户自建条目不生成拼音（拼音检索面向内置库；别名已可命中）
          aliases: JSON.stringify(aliases),
          category: dto.category ?? 'other',
          kcalPer100g: dto.kcalPer100g,
          proteinGPer100g: dto.proteinGPer100g ?? 0,
          fatGPer100g: dto.fatGPer100g ?? 0,
          carbGPer100g: dto.carbGPer100g ?? 0,
          servingUnits: JSON.stringify(servingUnits),
          defaultServingGrams,
          barcode: barcode !== undefined && barcode.length > 0 ? barcode : null,
          // ⚠️ 以下三行是本方法的**安全核心**：来源 / 归属 / 核验状态一律服务端决定。
          source: 'user_custom',
          createdByUserId: userId,
          isVerified: false,
        },
      });
      return toFoodItem(row);
    } catch (error) {
      // `barcode` 有唯一约束（`ux_food_barcode`）：客户端传了已存在的条码 → 可读的 400
      // （不 500、不吞错）。判据用 Prisma 的 P2002 唯一约束冲突码。
      if (isUniqueConstraintError(error)) {
        throw new ApiException(400, ERROR_CODES.VALID_INPUT, '这个条码已经有一条食物了，可以不填条码', {
          barcode: '这个条码已经有一条食物了，可以不填条码',
        });
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 我的食物库（C-4 第二步 / R3.6）：管理本人自建食物（列 / 改 / 删）
  // -------------------------------------------------------------------------

  /**
   * **列出本人自建的食物**（`GET /api/foods/mine`）。
   *
   * 与 `search()` / `recent()` / `favorites()` 的**区别**：这里刻意**只取自己建的**
   * （`createdByUserId = userId` 且 `source = 'user_custom'`），**不含** builtin /
   * openfoodfacts / usda / cfcd 等公开来源 —— 用户要的是「管理我存的东西」，
   * 不是「浏览全库」。
   *
   * `where` 里**两个条件都写**（虽然后端写入时二者总是同时成立）：语义明确 ——
   * 明确表达「本人创建的**自定义**条目」，不依赖「createdByUserId 非空 ⇒ source=user_custom」这一隐含假设。
   *
   * 排序 `id desc`（最近建的在前）：`id` 单调递增且**索引友好**（主键），
   * 比 `createdAt`（字符串时间，同样存在时可能并列）更稳定。
   *
   * `take: 200` 为纵深防御上限：个人自建库正常远小于此，防止异常账号把整表读进内存。
   *
   * @param userId 当前登录用户 id（来自 JWT）
   * @returns 本人自建食物（最近的在前），最多 200 条
   */
  async listMine(userId: number, limit = 200): Promise<FoodItem[]> {
    const rows = await this.prisma.foodItem.findMany({
      where: { createdByUserId: userId, source: 'user_custom' },
      orderBy: { id: 'desc' },
      take: limit,
    });
    return rows.map(toFoodItem);
  }

  /**
   * **修改本人自建的食物**（`PATCH /api/foods/:id`）—— 部分更新语义，只改传入的字段。
   *
   * ## 越权判定：**绝不能**复用 `requireVisibleFood`（安全核心）
   *
   * `visibleFoodWhere` 是 **OR** 语义 —— builtin / openfoodfacts / usda / cfcd **也「可见」**。
   * 若用 `requireVisibleFood` 做改校验，用户就能**改掉内置食物**（全库共用的 1773 条种子数据）。
   * 故这里用更严格的 `requireOwnedCustomFood`：`id` + `source='user_custom'` + `createdByUserId=userId`
   * **三条件同时满足**，否则一律 404（项目惯例：越权返回 404 而非 403，不泄露存在性）。
   *
   * ## 可改字段与安全边界
   *
   * `name` / `category` / `kcalPer100g` / 三个宏量 / `servingUnits` / `aliases` / `barcode`
   * 走 `UpdateCustomFoodDto`（`source` / `createdByUserId` / `isVerified` / `id` **不在 DTO 里**，
   * 即使提交也被全局 `whitelist` 剥离）。默认份量克数与 Create 同款：取**标记默认**的那一条，否则第一条。
   *
   * @returns 更新后的 `FoodItem`
   */
  async updateCustom(userId: number, foodId: number, dto: UpdateCustomFoodDto): Promise<FoodItem> {
    await this.requireOwnedCustomFood(userId, foodId);

    const data: Prisma.FoodItemUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      // 防御：`@MinLength(1)` 允许纯空白字符串（长度 ≥ 1），这里再判一次「trim 后非空」（同 createCustom）。
      if (name.length === 0) {
        throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请填写名称', { name: '请填写名称' });
      }
      data.name = name;
    }
    if (dto.category !== undefined) {
      data.category = dto.category;
    }
    if (dto.kcalPer100g !== undefined) {
      data.kcalPer100g = dto.kcalPer100g;
    }
    if (dto.proteinGPer100g !== undefined) {
      data.proteinGPer100g = dto.proteinGPer100g;
    }
    if (dto.fatGPer100g !== undefined) {
      data.fatGPer100g = dto.fatGPer100g;
    }
    if (dto.carbGPer100g !== undefined) {
      data.carbGPer100g = dto.carbGPer100g;
    }
    if (dto.servingUnits !== undefined) {
      // 份量单位归一：复用读路径的同一套解析（写读对称，非法元素被静默滤除），
      // 默认份量克数取「标记默认的那一条」，否则第一条（与 createCustom 一致）。
      const servingUnits = parseServingUnits(JSON.stringify(dto.servingUnits ?? []));
      data.servingUnits = JSON.stringify(servingUnits);
      data.defaultServingGrams =
        servingUnits.find((item) => item.isDefault === true)?.grams ?? servingUnits[0]?.grams ?? null;
    }
    if (dto.aliases !== undefined) {
      const aliases = [...new Set(dto.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0))];
      data.aliases = JSON.stringify(aliases);
    }
    if (dto.barcode !== undefined) {
      const barcode = dto.barcode.trim();
      data.barcode = barcode.length > 0 ? barcode : null;
    }

    try {
      const row = await this.prisma.foodItem.update({ where: { id: foodId }, data });
      return toFoodItem(row);
    } catch (error) {
      // `barcode` 唯一约束（`ux_food_barcode`）冲突 → 可读的 400（不 500、不吞错），与 createCustom 同款。
      if (isUniqueConstraintError(error)) {
        throw new ApiException(400, ERROR_CODES.VALID_INPUT, '这个条码已经有一条食物了，可以不填条码', {
          barcode: '这个条码已经有一条食物了，可以不填条码',
        });
      }
      throw error;
    }
  }

  /**
   * **删除本人自建的食物**（`DELETE /api/foods/:id`）。
   *
   * ## 越权判定：同 `updateCustom`，用 `requireOwnedCustomFood`（三条件），否则 404
   *
   * ## 数据完整性：删除前**必须先写名字快照**（本方法最关键的一步）
   *
   * 外键行为（见 `prisma/schema.prisma`）：
   * - `MealLog.foodItem` 是 **`onDelete: SetNull`** → 删食物后，引用它的 `meal_logs` 行
   *   `food_item_id` 变 **null**；
   * - `MealComboItem.foodItem` 同样是 **`onDelete: SetNull`** → 同上。
   *
   * ⚠️ **问题**：普通记录（从食物库选中条目记录的）写入时 `custom_name` **本来就是 null**
   * （见 `meals.service.ts`：`customName: dto.customName ?? null`），而 `MealLog` 契约**没有 name 字段**、
   * `listByDate` 也**不 join 食物表**。于是 `foodItemId` 被 SetNull 后，那条历史记录会**退化成无名条目**。
   *
   * 因此本方法在**同一事务**里先补名字，再删：
   * 1. `meal_logs` 中 `foodItemId = :id 且 custom_name IS NULL` 的行 → `custom_name = <食物名字>`；
   * 2. `meal_combo_items` 同上；
   * 3. 然后才 `delete` 该 `food_items` 行（此时 SetNull 生效，但名字已留存）。
   *
   * 🔴 **只补 `custom_name IS NULL` 的行**，**绝不覆盖**已有 `customName` —— 用户可能在记录时
   * 把显示名改成了「我的减脂餐」之类，覆盖它等于篡改用户输入。
   *
   * ## 收藏：**无需处理**
   *
   * `FoodFavorite.foodItem` 是 **`onDelete: Cascade`** → 收藏关联随食物删除自动清理（合理）。
   *
   * @returns `{ deleted: true }`（对齐 `DELETE /api/exercises/:id`）
   */
  async removeCustom(userId: number, foodId: number): Promise<{ deleted: true }> {
    const food = await this.requireOwnedCustomFood(userId, foodId);

    await this.prisma.$transaction(async (tx) => {
      // ① 删除前：把名字快照写进引用它的历史行（只补 customName 为空的行，绝不覆盖已有值）。
      await tx.mealLog.updateMany({
        where: { foodItemId: foodId, customName: null },
        data: { customName: food.name },
      });
      await tx.mealComboItem.updateMany({
        where: { foodItemId: foodId, customName: null },
        data: { customName: food.name },
      });
      // ② 再删食物：此时 SetNull 会让 foodItemId 变 null，但名字已留存（①）。
      await tx.foodItem.delete({ where: { id: foodId } });
    });

    return { deleted: true };
  }

  /**
   * 校验食物**存在且为当前用户自建**，返回 Prisma 行；否则统一抛 404（不泄露存在性）。
   *
   * ⚠️ **不要用它替换 `requireVisibleFood` 做「可见性」判断** —— 二者语义不同：
   * - `requireVisibleFood`：**OR** 语义（公开来源 **或** 本人创建），用于「读 / 记一餐」等**只读可见**场景；
   * - 本方法：**AND** 语义（必须 `source='user_custom'` **且** `createdByUserId=userId`），
   *   专用于「改 / 删自己的东西」这类**写**操作 —— 只有它才能挡住「用户删/改内置食物」的越权。
   */
  async requireOwnedCustomFood(userId: number, foodId: number) {
    const food = await this.prisma.foodItem.findFirst({
      where: { id: foodId, source: 'user_custom', createdByUserId: userId },
    });
    if (!food) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_FOOD, '没有找到这个食物');
    }
    return food;
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

/**
 * 是否为 Prisma 唯一约束冲突（`P2002`）。
 *
 * 不 import `@prisma/client` 的 `PrismaClientKnownRequestError` 做 `instanceof` 判断：
 * 该错误类在 Prisma 版本间**可能被复制成多份实例**（生成的 client 与运行时各持一份），
 * `instanceof` 会漏判。用**结构化判据**（`code === 'P2002'`）更稳，且不引入额外依赖。
 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
