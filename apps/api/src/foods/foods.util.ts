import { Prisma } from '@prisma/client';

/**
 * 食物可见性过滤（R3.1 / 数据隔离）：
 * 内置 / 开放数据库（OFF/USDA）对所有人可见；`user_custom` 仅创建者本人可见。
 */
export function visibleFoodWhere(userId: number): Prisma.FoodItemWhereInput {
  return {
    OR: [{ source: { in: ['builtin', 'openfoodfacts', 'usda'] } }, { createdByUserId: userId }],
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
