/**
 * 份量换算与营养重算（core/meal/portion.ts）—— **单一真源**（NFR-11 / K13）。
 *
 * ## 为什么要有这个模块
 *
 * 「改份量」与「新建记录」必须算出**同一个数**：若两处各写一份换算，
 * 用户把 100g 改成 200g 得到的热量可能和他重新搜一次、选 200g 记下来不一样 ——
 * 这种「同一件事两个数字」正是可解释性（NFR-11）要消灭的东西。
 *
 * 因此本模块把服务端 `POST /api/meals`（新建）与 `PATCH /api/meals/:id`（改份量）
 * 共用的两段纯计算下沉到这里，两侧**只调用、不复制**：
 *
 * 1. `resolveMealAmount`：把「用户填的份量」解析成克数（显式克数 > 份量单位 > 默认份量 > 100g）；
 * 2. `scaleFoodNutrients`：**每 100g 值 × 克数 ÷ 100**，1 位小数取整（与 `round1` 同口径）。
 *
 * ⚠️ 本模块**零 IO、零依赖**，且绝不 import `@qsh/shared-types`（K12）：
 * 入参只声明真正用到的字段（最小投影），`FoodItem` 等更宽的类型天然可传入。
 *
 * 🔴 无负罪感（PRD §7）：本模块**只做换算**，不产出任何「超标 / 超出预算 / 评价」结论；
 * 调用方也不得拿它的结果去判断好坏。
 */

import { round1 } from '../calorie/rounding';

/** 解析份量所需的最小投影（食物库条目 / 快照都满足）。 */
export interface FoodPortionSource {
  /** 默认份量克数（`food_items.default_serving_grams`） */
  defaultServingGrams?: number | null;
  /** 可选份量单位（个 / 碗 / 杯 / 片 / 袋…） */
  servingUnits?: readonly { unit: string; grams: number }[] | null;
}

/** 营养重算所需的最小投影（**每 100g** 口径）。 */
export interface FoodNutrientSource {
  kcalPer100g: number;
  proteinGPer100g: number;
  fatGPer100g: number;
  carbGPer100g: number;
  /** 膳食纤维（可缺失 → 结果为 `null`，不猜） */
  fiberGPer100g?: number | null;
  /** 钠（可缺失 → 结果为 `null`，不猜） */
  sodiumMgPer100g?: number | null;
}

/** 份量解析结果。 */
export interface ResolvedMealAmount {
  /** 解析出的克数（1 位小数） */
  grams: number;
  /** 命中的份量单位（显式克数时为 `null`） */
  servingUnit: string | null;
  /** 份量数量 */
  servingQty: number | null;
}

/** 重算后的营养值（全部为**绝对值**，不是每 100g）。 */
export interface ScaledNutrients {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG: number | null;
  sodiumMg: number | null;
}

/** 兜底克数：既没有显式克数、也没有份量单位、也没有默认份量时按 100g 计。 */
export const DEFAULT_MEAL_GRAMS = 100;

/** 有效正数（NaN / Infinity / ≤ 0 一律视为「没填」）。 */
function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 解析份量 → 克数（**新建与改份量共用**）。
 *
 * 优先级（与既有行为完全一致，不要在这里"优化"顺序）：
 * 1. **显式克数**（`grams`）—— 用户直接填了克数，最可信；
 * 2. **份量单位 × 数量**（`servingUnit` + `servingQty`）—— 命中该食物的单位表才生效；
 * 3. **默认份量**（`defaultServingGrams`）—— 记为「1 份」；
 * 4. **兜底 100g**。
 *
 * @param food 食物（只需份量相关字段）
 * @param input 用户填的份量（三项都可缺省）
 * @returns 克数 + 命中的单位信息
 */
export function resolveMealAmount(
  food: FoodPortionSource,
  input: { grams?: number; servingUnit?: string; servingQty?: number } = {},
): ResolvedMealAmount {
  if (isPositive(input.grams)) {
    return { grams: round1(input.grams), servingUnit: null, servingQty: null };
  }

  if (typeof input.servingUnit === 'string' && input.servingUnit.trim().length > 0 && isPositive(input.servingQty)) {
    const wanted = input.servingUnit.trim();
    const unit = (food.servingUnits ?? []).find((item) => item.unit === wanted);
    if (unit !== undefined && isPositive(unit.grams)) {
      return { grams: round1(unit.grams * input.servingQty), servingUnit: unit.unit, servingQty: input.servingQty };
    }
  }

  if (isPositive(food.defaultServingGrams)) {
    return { grams: round1(food.defaultServingGrams), servingUnit: null, servingQty: 1 };
  }

  return { grams: DEFAULT_MEAL_GRAMS, servingUnit: null, servingQty: null };
}

/**
 * 按克数重算营养（**每 100g 值 × 克数 ÷ 100**，1 位小数）。
 *
 * 缺失字段一律输出 `null`（膳食纤维 / 钠），**不用别的字段反推** —— 凑出来的数字
 * 看着完整，其实不可信（与 @qsh/core 一贯的「缺就缺，不编」口径一致）。
 *
 * @param food 每 100g 营养值
 * @param grams 克数（≤ 0 / 非数字 → 全部为 0，绝不产生 NaN 落库）
 * @returns 该份量下的绝对营养值
 */
export function scaleFoodNutrients(food: FoodNutrientSource, grams: number): ScaledNutrients {
  const factor = isPositive(grams) ? grams / 100 : 0;
  return {
    kcal: round1(food.kcalPer100g * factor),
    proteinG: round1(food.proteinGPer100g * factor),
    fatG: round1(food.fatGPer100g * factor),
    carbG: round1(food.carbGPer100g * factor),
    fiberG: isPositive(food.fiberGPer100g ?? null) ? round1((food.fiberGPer100g as number) * factor) : null,
    sodiumMg: isPositive(food.sodiumMgPer100g ?? null) ? round1((food.sodiumMgPer100g as number) * factor) : null,
  };
}
