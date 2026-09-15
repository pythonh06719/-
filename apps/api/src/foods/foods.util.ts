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
