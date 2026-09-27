import { Prisma } from '@prisma/client';

/**
 * 食物可见性过滤（R3.1 / 数据隔离）：
 * 内置 / 开放数据库（OFF / USDA / 中国食物成分表 cfcd）对所有人可见；
 * `user_custom` 仅创建者本人可见。
 */
export function visibleFoodWhere(userId: number): Prisma.FoodItemWhereInput {
  return {
    OR: [{ source: { in: ['builtin', 'openfoodfacts', 'usda', 'cfcd'] } }, { createdByUserId: userId }],
  };
}

/**
 * 食物身份投影（`mealLog.groupBy(foodItemId, customName, loggedDate)`）的行数上限 —— 纵深防御。
 *
 * 该投影是「常吃榜 / 多样性计数」的最小必要输入；理论上界 = 天数 × 每天的 distinct 食物数。
 * 正常情况下远达不到，但**没有上限的聚合**在 SQLite 下会把整个结果集收进内存，
 * 一个「365 天 × 上千种食物」的重度账号可能把它撑大。此上限取一个远超真实用量的值：
 * 正常用户不会触及；只有极端数据才会截断（截断只影响极端情形下的计数精度，不崩溃）。
 */
export const FOOD_IDENTITY_PROJECTION_LIMIT = 20_000;

/**
 * 相关度排序的候选扫描上限（纵深防御）。
 *
 * `GET /api/foods/search` 需要先取出关键词命中的候选，在内存里按相关度排序后再分页。
 * 当前食物库 1773 条（远小于此上限），整体进内存没有压力；此上限只用于堵住
 * 「未来库膨胀到十万级 + 极宽泛关键词（如单个『鸡』字）」时把整表读进内存的情况
 * —— 真到那时只会截断最靠后的候选，不会崩溃。
 */
export const FOOD_SEARCH_RANK_SCAN_LIMIT = 5_000;

/** 关键词模糊匹配条件（名称 / 拼音 / 别名）。 */
export function keywordWhere(keyword: string): Prisma.FoodItemWhereInput {
  return {
    OR: [
      { name: { contains: keyword } },
      { namePinyin: { contains: keyword } },
      { aliases: { contains: keyword } },
    ],
  };
}
