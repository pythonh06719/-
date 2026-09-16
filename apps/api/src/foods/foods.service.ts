import { Injectable } from '@nestjs/common';

import type { FoodItem } from '@qsh/shared-types';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { toFoodItem } from '../common/mappers/entity.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { SearchFoodsDto } from './dto/search-foods.dto';
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
