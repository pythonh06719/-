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

import type { MealType } from '@qsh/shared-types';

import { IsLocalDateKey } from '../../common/validators/local-date-key.validator';

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * 单个套餐模板的最大明细条数。
 *
 * 挡的是「一个请求把 SQLite 写锁占死」：服务层对每条明细做一次食物库查询，
 * 再用嵌套 `create` 逐条写入同一个事务，而请求体上限是 10MB。
 */
export const MAX_COMBO_ITEMS = 50;

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

  /**
   * 明细条目（1 ~ {@link MAX_COMBO_ITEMS} 条）
   *
   * ⚠️ **上限是必需的**：`MealsService.createCombo` 对每个明细都做一次
   * `await this.prepareComboItem(...)`，并用 `items: { create: prepared }` 一次性写入。
   * 缺上限时，一个 10MB 请求体（`express.json` 的上限）能塞进几万条明细，
   * 在**单个事务**里逐条查库 + 逐条写库，长时间占住 SQLite 的**全库级写锁**，
   * 期间其他写请求（记一餐、喝水、打卡）全部阻塞。
   *
   * 取 50：一个「套餐」是用户自己攒的常用组合（对照 C-3 批量入账的 200 条上限），
   * 50 条已远超任何真实套餐，且与既有先例同量级。
   */
  @IsArray({ message: '明细需为数组' })
  @ArrayMinSize(1, { message: '套餐里至少要有一样' })
  @ArrayMaxSize(MAX_COMBO_ITEMS, { message: `一个套餐最多 ${MAX_COMBO_ITEMS} 条明细` })
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
  @IsLocalDateKey({ message: '日期格式应为 YYYY-MM-DD' })
  loggedDate?: string;
}
