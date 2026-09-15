import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

import type { MealLogSource, MealType } from '@qsh/shared-types';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const SOURCES: MealLogSource[] = ['search', 'quick_add', 'barcode', 'ai', 'combo'];

/**
 * `POST /api/meals` 请求体（R3.4 / R3.5 / R3.8）。
 *
 * 兼容两种克数字段：`grams`（`shared-types`）与 `amountG`（固定接口契约）。
 */
export class CreateMealDto {
  /** 记录日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;

  /** 餐次 */
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType!: MealType;

  /** 记录来源 */
  @IsOptional()
  @IsIn(SOURCES, { message: '记录来源不正确' })
  source?: MealLogSource;

  /** 食物库条目 id（search / barcode / ai 来源） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '食物 id 需为整数' })
  foodId?: number;

  /** 快速加卡 / AI 自定义名称 */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  customName?: string;

  /** 自定义热量（快速加卡必填，TC-19） */
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

  /** 备注 */
  @IsOptional()
  @IsString({ message: '备注需为文本' })
  note?: string;
}
