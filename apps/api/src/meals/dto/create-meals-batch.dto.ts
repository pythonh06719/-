import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import type { MealLogSource, MealType } from '@qsh/shared-types';

import { IsLocalDateKey } from '../../common/validators/local-date-key.validator';

/**
 * 单次批量入账的最大条目数（C-3）。
 *
 * 挡的是「一个请求把 SQLite 写锁占死」：服务层对每个条目做一次食物库查询，
 * 并在同一事务内串行 `create` N 次，而请求体上限是 10MB。
 * 取 200 与 `ReorderMealsDto.orderedIds` 的 `@ArrayMaxSize(200)` 对齐（既有先例）。
 */
export const MAX_BATCH_MEAL_ITEMS = 200;

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
  @IsLocalDateKey({ message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;

  /** 餐次（整批共用） */
  @IsIn(MEAL_TYPES, { message: '请选择餐次' })
  mealType!: MealType;

  /**
   * 待记清单（1 ~ {@link MAX_BATCH_MEAL_ITEMS} 条）
   *
   * ⚠️ **上限是必需的，不是可选的**：`MealsService.createBatch` 对每个元素都做
   * 一次 DB 查询（准备阶段 `await prepareBatchItem`），并在**同一个事务内**串行
   * `await tx.mealLog.create` N 次。`main.ts` 的请求体上限是 `express.json({ limit: '10mb' })`，
   * 10MB 的 JSON 数组足以构造几万条 → 单请求长时间占住 SQLite 的**全库级写锁**，
   * 期间其他写请求（记一餐、喝水、打卡）全部阻塞。
   *
   * 取值 200 参照 `ReorderMealsDto.orderedIds` 的 `@ArrayMaxSize(200)`（同一代码库既有先例），
   * 远高于任何真实使用（一餐不会记 200 个条目），不会误伤正常使用。
   */
  @IsArray({ message: '清单需为数组' })
  @ArrayMinSize(1, { message: '清单里至少要有一样' })
  @ArrayMaxSize(MAX_BATCH_MEAL_ITEMS, {
    message: `一次最多记录 ${MAX_BATCH_MEAL_ITEMS} 条，再多请分几次记`,
  })
  @ValidateNested({ each: true })
  @Type(() => BatchMealItemDto)
  items!: BatchMealItemDto[];
}
