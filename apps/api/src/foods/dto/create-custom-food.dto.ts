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
 * `POST /api/foods` 请求体（C-4 第一步 / R3.6）—— 新建用户自定义食物。
 *
 * **契约**：`packages/shared-types` 的 `CreateCustomFoodRequest`（`name/category/kcalPer100g/
 * proteinGPer100g/fatGPer100g/carbGPer100g/servingUnits/barcode/aliases`）。本 DTO 是它的
 * **服务端校验形态**，字段一一对应，不多也不少。
 *
 * ## 安全边界（务必理解：DB 不拦，只能靠这里）
 *
 * `food_items.source` 在 Prisma schema 里是**普通 `String`**（不是 enum），
 * 生成的 SQLite 表**没有 CHECK 约束**（`builtin | openfoodfacts | usda | cfcd | user_custom`
 * 只写在注释里）。因此：
 * - `source` **不由本 DTO 接收**，一律由 `FoodsService.createCustom` 硬编码为 `'user_custom'`
 *   —— 客户端即便提交 `source: 'builtin'` 也只会被 `whitelist` 剥离（无法自造"内置食物"）；
 * - `createdByUserId` 同理**不由 DTO 接收**，由服务端从 JWT 的 userId 取
 *   —— 客户端提交 `createdByUserId: <别人 id>` 无效（无法把食物挂到他人名下）。
 *
 * ## 分类白名单（防脏值）
 *
 * `GET /foods/categories` 只做 `distinct` + 排序、**零白名单过滤**，DB 里有什么脏
 * category 就返回什么（历史脏值 50+ 种）。若允许用户自由填 `category`，自定义食物会
 * **持续产生新的脏值**并进入分类浏览页。故这里用 `@IsIn(FOOD_CATEGORIES)` 严格限定在
 * 权威 9 类（`@qsh/core` 单一真源，与 `schema.prisma:190` 注释一致）。
 *
 * ⚠️ 上限取值说明（均为**防御性**上界，不是业务规则，不会误伤正常输入）：
 * - `name` 40 字：中文食物名极少超 20 字，40 留足余量；
 * - `kcalPer100g` 1000：纯油脂 900 已是天花板，1000 之上必是误填或注入；
 * - 宏量 100：任何单一成分都不可能超过 100g/100g。
 */
export class CreateCustomFoodDto {
  /** 食物名（`1–40` 字，服务端 `trim` 后落库；仅空白视为未填） */
  @IsString({ message: '名称需为文本' })
  @MinLength(1, { message: '请填写名称' })
  @MaxLength(40, { message: '名称最多 40 个字' })
  name!: string;

  /** 分类（必须是权威 9 类之一，防脏值） */
  @IsOptional()
  @IsIn(FOOD_CATEGORIES as unknown as FoodCategory[], { message: '分类不在可选范围内' })
  category?: FoodCategory;

  /** 每 100g 热量 kcal（必填，`0–1000`） */
  @Type(() => Number)
  @IsNumber({}, { message: '热量需为数字' })
  @Min(0, { message: '热量不能为负数' })
  @Max(1000, { message: '热量看起来填大了，请确认一下' })
  kcalPer100g!: number;

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
   * 份量单位（可选；契约形状 `ServingUnit[]` = `{ unit, grams, isDefault?, label? }`）。
   *
   * 只做**浅校验**（数组 + 元素上限），不在此处深挖每个元素的合法性：
   * `@ValidateNested` 需要一个**具体 DTO 类**才有意义，而这里的元素形状在不同
   * 来源（OFF / CFCD / 用户）下略有差异，硬写一个嵌套 DTO 反而会误伤合法输入。
   * 真正的归一在落库前由 `FoodsService.createCustom` 用**读路径的同一套解析口径**
   * （`parseServingUnits`）完成 —— 写读对称，非法元素被静默滤除（不报错、不落脏数据）。
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
