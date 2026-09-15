import type { FoodItem, MealType } from '@qsh/shared-types';

/**
 * 日记页纯工具（pages/diary/meal-utils.ts）—— 便于测试与复用。
 *
 * 份量换算规则（ARCHITECTURE §3.3 / TC-17）：
 * `kcal = kcalPer100g × 选定克数 ÷ 100`。**与引擎/服务端同一规则**，前端仅做展示预估，
 * 最终入库热量以服务端为准。
 */

/** 餐次中文标签（早 / 午 / 晚 / 加餐）。 */
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

/** 餐次顺序（页面展示顺序）。 */
export const MEAL_TYPE_ORDER: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** 无份量单位时的兜底克数。 */
export const DEFAULT_SERVING_GRAMS = 100;

/** 取食物的默认份量克数：优先 `isDefault` 单位，其次首个单位，最后 100g。 */
export function resolveDefaultServing(food: FoodItem): { unit: string; grams: number } {
  const units = food.servingUnits ?? [];
  const preferred = units.find((item) => item.isDefault === true) ?? units[0];
  if (preferred === undefined) {
    if (typeof food.defaultServingGrams === 'number' && food.defaultServingGrams > 0) {
      return { unit: '份', grams: food.defaultServingGrams };
    }
    return { unit: '克', grams: DEFAULT_SERVING_GRAMS };
  }
  return { unit: preferred.unit, grams: preferred.grams };
}

/** 按克数预估热量（整数 kcal）。 */
export function computeKcalFromFood(food: Pick<FoodItem, 'kcalPer100g'>, grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0) {
    return 0;
  }
  return Math.round((food.kcalPer100g * grams) / 100);
}

/** 按克数预估单项宏量营养素（1 位小数）。 */
export function computeMacrosFromFood(
  food: Pick<FoodItem, 'proteinGPer100g' | 'fatGPer100g' | 'carbGPer100g'>,
  grams: number,
): { proteinG: number; fatG: number; carbG: number } {
  const factor = Number.isFinite(grams) && grams > 0 ? grams / 100 : 0;
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  return {
    proteinG: round1(food.proteinGPer100g * factor),
    fatG: round1(food.fatGPer100g * factor),
    carbG: round1(food.carbGPer100g * factor),
  };
}

/** 合计一餐/一日的热量。 */
export function sumKcal(logs: ReadonlyArray<{ kcal: number }>): number {
  return logs.reduce((total, log) => total + (Number.isFinite(log.kcal) ? log.kcal : 0), 0);
}
