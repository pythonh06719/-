import { Type } from 'class-transformer';
import {
  ArrayMinSize,
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

import type { MealLogSource, MealType } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const SOURCES: MealLogSource[] = ['search', 'quick_add', 'barcode', 'ai', 'combo'];

/**
 * `POST /api/meals/batch` 的单条目输入（C-3）。
 *
 * 与 `CreateMealDto` 同口径（只少了 `loggedDate` / `mealType` —— 提到请求体顶层，
 * 一餐里所有条目共用同一个日期与餐次）。兼容两种克数字段：`grams` 与 `amountG`。
 */
export class BatchMealItemDto {
  /** 食物库条目 id（search / barcode 来源） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '食物 id 需为整数' })
  foodId?: number;

  /** 自定义名称（无 foodId 时必填） */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  customName?: string;

  /** 自定义热量（无 foodId 时必填） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  customKcal?: number;

  /** 选定克数（g） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '克数需为数字' })
  @Min(0, { message: '克数不能为负数' })
  grams?: number;

  /** 选定克数（g，契约别名） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '克数需为数字' })
  @Min(0, { message: '克数不能为负数' })
  amountG?: number;

  /** 份量单位（个 / 碗 / 杯 / 片 / 袋） */
  @IsOptional()
  @IsString({ message: '份量单位需为文本' })
  servingUnit?: string;

  /** 份量数量 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '份量数量需为数字' })
  @Min(0, { message: '份量数量不能为负数' })
  servingQty?: number;

  /** 记录来源 */
  @IsOptional()
  @IsIn(SOURCES, { message: '记录来源不正确' })
  source?: MealLogSource;

  /** 备注 */
  @IsOptional()
  @IsString({ message: '备注需为文本' })
  note?: string;
}

/**
 * `POST /api/meals/batch` 请求体（C-3 一餐多品项批量记录）。
 *
 * `items` **至少要有 1 条**（空清单没有可记录的意义，直接 400 `E_VALID_INPUT`）；
 * 整体语义为**单事务、全有或全无** —— 由 `MealsService.createBatch` 保证。
 */
export class CreateMealsBatchDto {
  /** 记录日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;

  /** 餐次（整批共用） */
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType!: MealType;

  /** 待记清单（至少 1 条） */
  @IsArray({ message: '清单需为数组' })
  @ArrayMinSize(1, { message: '清单里至少要有一样' })
  @ValidateNested({ each: true })
  @Type(() => BatchMealItemDto)
  items!: BatchMealItemDto[];
}
