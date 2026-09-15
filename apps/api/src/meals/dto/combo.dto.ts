import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

import type { MealType } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * 套餐模板明细输入（R3.9）。
 *
 * 兼容固定契约 `{ foodId?, name, amountG, kcal }` 与 `shared-types` `MealComboItemInput`
 * （`customName` / `grams` / `servingUnit` / `servingQty`）。
 */
export class ComboItemDto {
  /** 食物库条目 id（可选） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '食物 id 需为整数' })
  foodId?: number;

  /** 名称（契约写法） */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  name?: string;

  /** 名称（`shared-types` 写法） */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  customName?: string;

  /** 克数（`shared-types` 写法） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '克数需为数字' })
  @Min(0, { message: '克数不能为负数' })
  grams?: number;

  /** 克数（契约写法） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '克数需为数字' })
  @Min(0, { message: '克数不能为负数' })
  amountG?: number;

  /** 份量单位 */
  @IsOptional()
  @IsString({ message: '份量单位需为文本' })
  servingUnit?: string;

  /** 份量数量 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '份量数量需为数字' })
  @Min(0, { message: '份量数量不能为负数' })
  servingQty?: number;

  /** 热量 kcal（自定义条目必填） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  kcal?: number;

  /** 蛋白 g */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '蛋白质需为数字' })
  proteinG?: number;

  /** 脂肪 g */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '脂肪需为数字' })
  fatG?: number;

  /** 碳水 g */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '碳水需为数字' })
  carbG?: number;

  /** 排序 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '排序需为整数' })
  sortOrder?: number;
}

/** `POST /api/meal-combos` 请求体。 */
export class CreateComboDto {
  /** 套餐名称 */
  @IsString({ message: '请填写套餐名称' })
  name!: string;

  /** 默认餐次（缺省 `breakfast`） */
  @IsOptional()
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType?: MealType;

  /** 明细条目 */
  @IsArray({ message: '明细需为数组' })
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  items!: ComboItemDto[];
}

/** `POST /api/meal-combos/:id/apply` 请求体（一键用套餐记一餐）。 */
export class ApplyComboDto {
  /** 餐次 */
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType!: MealType;

  /** 记录日期 `YYYY-MM-DD` */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;
}
