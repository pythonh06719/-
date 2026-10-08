import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt } from 'class-validator';

import type { MealType } from '@qsh/shared-types';

import { IsLocalDateKey } from '../../common/validators/local-date-key.validator';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * `PATCH /api/meals/reorder` 请求体（R3.8 / AC-3.8.3）。
 *
 * ⚠️ **刻意不接受 `sortOrder` 字段**（K14）：排序值只能由服务端按
 * 「本用户·本日·本餐当前最大值 + 1」分配，客户端传了也不生效 ——
 * 从类型层断掉，避免前端又把 `sortOrder: 0` 写回来（AC-3.8.5 的根因）。
 *
 * ⚠️ 也**不接受 `userId`**：一律从 JWT 取（NFR-2 / K7）。
 */
export class ReorderMealsDto {
  /** 记录日期 `YYYY-MM-DD`（本地日粒度） */
  @IsLocalDateKey({ message: '日期格式应为 YYYY-MM-DD' })
  loggedDate!: string;

  /** **目标餐次**：列出的记录会被置为该餐次 */
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType!: MealType;

  /**
   * 目标餐次的**完整期望顺序**（去重后按序赋值 `sortOrder = index`）。
   *
   * - 空数组 → 200 no-op；
   * - 含重复 id → 服务端按首次出现去重；
   * - 含未知 id → 400 并在 `error.fields.orderedIds` 指明是哪些。
   */
  @IsArray({ message: '排序列表需为数组' })
  @ArrayMaxSize(200, { message: '一次最多调整 200 条' })
  @Type(() => Number)
  @IsInt({ each: true, message: '排序列表里需为整数 id' })
  orderedIds!: number[];
}
