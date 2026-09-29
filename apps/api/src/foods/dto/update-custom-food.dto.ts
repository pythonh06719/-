import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { FoodCategory } from '@qsh/core';

import { FOOD_CATEGORIES } from '@qsh/core';

/**
 * `PATCH /api/foods/:id` 请求体（C-4 第二步）—— 修改**本人自建**食物。
 *
 * ## 为什么手写而不是 `PartialType(CreateCustomFoodDto)`
 *
 * 本项目 `apps/api` **没有** `@nestjs/mapped-types` 依赖（`package.json` 已核实，
 * 也没有被传递依赖带进来 —— `node_modules/@nestjs/` 下不存在该包）。
 * 为这一处「把 Create DTO 全字段变可选」而**新增一个运行时依赖**，收益极低、
 * 违背 ponytail 原则（不为架构而架构）。字段定义本就有差异（`name` 从必填变可选），
 * 手写 8 个字段更直白，也**不引入新依赖**。
 *
 * ## 可改字段（与 `CreateCustomFoodDto` 逐字段对齐校验规则）
 *
 * `name` / `category` / `kcalPer100g` / `proteinGPer100g` / `fatGPer100g` /
 * `carbGPer100g` / `servingUnits` / `aliases` / `barcode`。
 *
 * ## 🔴 绝不可改字段（**DTO 里根本不存在**，故 `whitelist` 直接剥离）
 *
 * `source` / `createdByUserId` / `isVerified` / `id` —— 与 `CreateCustomFoodDto` 同款安全边界：
 * - `source`：若能改，用户可把自建条目标成 `'builtin'` 伪装成**全站可见**的内置食物
 *   （`food_items.source` 在 SQLite 里**没有 CHECK 约束**，只能靠这里拦）；
 * - `createdByUserId`：若能改，可把食物迁到他人名下（越权写入他人私有库）；
 * - `isVerified`：核验状态是权威来源的标志，用户条目**永不**可自行升格；
 * - `id`：改 id 等于换一条资源，不在本接口语义内。
 * 客户端即便提交这些字段，也会被全局 `ValidationPipe({ whitelist: true })` **静默剥离**。
 *
 * ## 部分更新语义
 *
 * **所有字段可选**，只更新传入的字段（未传的保持原值）。`name` 若传入则须 trim 后非空
 * （空白串由服务端在 `updateCustom` 里再判一次，与 `createCustom` 同款防御）。
 *
 * ## 上限取值（与 Create DTO 完全一致，均为防御性上界，不误伤正常输入）
 *
 * `name` 40 字 / `kcalPer100g` 1000 / 宏量 100 / `servingUnits`、`aliases` 各 20 条 / `barcode` 32 位。
 */
export class UpdateCustomFoodDto {
  /** 食物名（可选；传入时 `1–40` 字，服务端 `trim` 后落库；仅空白视为未填） */
  @IsOptional()
  @IsString({ message: '名称需为文本' })
  @MinLength(1, { message: '请填写名称' })
  @MaxLength(40, { message: '名称最多 40 个字' })
  name?: string;

  /** 分类（可选；必须是权威 9 类之一，防脏值 —— 同 Create DTO） */
  @IsOptional()
  @IsIn(FOOD_CATEGORIES as unknown as FoodCategory[], { message: '分类不在可选范围内' })
  category?: FoodCategory;

  /** 每 100g 热量 kcal（可选，`0–1000`） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  @Max(1000, { message: '热量看起来填大了，请确认一下' })
  kcalPer100g?: number;

  /** 每 100g 蛋白质 g（可选，`0–100`） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '蛋白质需为数字' })
  @Min(0, { message: '蛋白质不能为负数' })
  @Max(100, { message: '蛋白质看起来填大了，请确认一下' })
  proteinGPer100g?: number;

  /** 每 100g 脂肪 g（可选，`0–100`） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '脂肪需为数字' })
  @Min(0, { message: '脂肪不能为负数' })
  @Max(100, { message: '脂肪看起来填大了，请确认一下' })
  fatGPer100g?: number;

  /** 每 100g 碳水 g（可选，`0–100`） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: '碳水需为数字' })
  @Min(0, { message: '碳水不能为负数' })
  @Max(100, { message: '碳水看起来填大了，请确认一下' })
  carbGPer100g?: number;

  /**
   * 份量单位（可选；契约形状 `ServingUnit[]`）。
   *
   * 与 Create DTO 同款**浅校验**（数组 + 元素上限），真正的归一在
   * `FoodsService.updateCustom` 用读路径同一套 `parseServingUnits` 完成（写读对称）。
   */
  @IsOptional()
  @IsArray({ message: '份量单位需为数组' })
  @ArrayMaxSize(20, { message: '份量单位最多 20 条' })
  servingUnits?: unknown[];

  /** 条码（可选；与既有 `barcode` 唯一约束一致，冲突时服务端返回可读错误） */
  @IsOptional()
  @IsString({ message: '条码需为文本' })
  @MaxLength(32, { message: '条码最多 32 位' })
  barcode?: string;

  /** 别名（可选；用于之后的模糊搜索命中） */
  @IsOptional()
  @IsArray({ message: '别名需为数组' })
  @ArrayMaxSize(20, { message: '别名最多 20 条' })
  @IsString({ each: true, message: '别名需为文本' })
  aliases?: string[];
}
