import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

import type { MealType } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * `POST /api/meals/quick-add` 请求体（R3.5 / TC-19）。
 *
 * 固定契约用 `{ name, kcal }`，`shared-types` 用 `{ customName, customKcal }`；两者均接受。
 * 蛋白 / 脂肪 / 碳水允许为空且不阻塞（TC-19）。
 */
export class QuickAddDto {
  /** 记录日期 `YYYY-MM-DD` */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;

  /** 餐次 */
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType!: MealType;

  /** 名称（`shared-types` 写法） */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  customName?: string;

  /** 名称（契约写法） */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  name?: string;

  /** 热量 kcal（`shared-types` 写法） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  customKcal?: number;

  /** 热量 kcal（契约写法） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  kcal?: number;

  /** 可选：蛋白 g */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '蛋白质需为数字' })
  @Min(0, { message: '蛋白质不能为负数' })
  proteinG?: number;

  /** 可选：脂肪 g */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '脂肪需为数字' })
  @Min(0, { message: '脂肪不能为负数' })
  fatG?: number;

  /** 可选：碳水 g */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '碳水需为数字' })
  @Min(0, { message: '碳水不能为负数' })
  carbG?: number;

  /** 备注 */
  @IsOptional()
  @IsString({ message: '备注需为文本' })
  note?: string;
}
