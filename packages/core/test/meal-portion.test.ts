/**
 * 份量换算与营养重算（core/meal/portion.ts）测试 —— B3「改份量」的口径门禁。
 *
 * 钉死四件事：
 * ① **换算公式**：每 100g 值 × 克数 ÷ 100，1 位小数（与 `round1` 同口径）；
 * ② **份量解析优先级**：显式克数 > 份量单位 × 份数 > 默认份量 > 兜底 100g；
 * ③ **缺失字段不猜**：膳食纤维 / 钠缺失 → `null`，不拿别的字段反推；
 * ④ **脏输入不出 NaN**：0 / 负数 / NaN / Infinity 一律按 0 处理，绝不产生 NaN 落库。
 *
 * ⚠️ 「改份量」与「新建记录」共用这两个函数 —— 本文件就是「同一件事只能有一个数字」
 * （NFR-11）的守卫：任何人改了换算规则，这里的用例必须先红。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_MEAL_GRAMS, resolveMealAmount, scaleFoodNutrients } from '../src/meal/portion';

/** 一条每 100g 营养值（纤维 / 钠齐全）。 */
const FULL = {
  kcalPer100g: 200,
  proteinGPer100g: 10,
  fatGPer100g: 5,
  carbGPer100g: 20,
  fiberGPer100g: 3,
  sodiumMgPer100g: 120,
};

/** 一条缺纤维 / 钠的（真实食物库里很常见）。 */
const PARTIAL = {
  kcalPer100g: 54,
  proteinGPer100g: 0.9,
  fatGPer100g: 0.2,
  carbGPer100g: 12,
  fiberGPer100g: null,
  sodiumMgPer100g: null,
};

describe('scaleFoodNutrients：每 100g × 克数 ÷ 100', () => {
  it('200g = 每 100g 值 × 2（全部字段等比放大）', () => {
    const result = scaleFoodNutrients(FULL, 200);
    expect(result.kcal).toBe(400);
    expect(result.proteinG).toBe(20);
    expect(result.fatG).toBe(10);
    expect(result.carbG).toBe(40);
    expect(result.fiberG).toBe(6);
    expect(result.sodiumMg).toBe(240);
  });

  it('改份量与新建同一口径：把 100g 改成 250g 等于「直接记 250g」', () => {
    const asCreated = scaleFoodNutrients(FULL, 250);
    const asUpdated = scaleFoodNutrients(FULL, 250);
    expect(asUpdated).toEqual(asCreated);
    expect(asUpdated.kcal).toBe(500);
  });

  it('保留 1 位小数（与 round1 同口径，不做整数截断）', () => {
    // 123 kcal/100g × 33g ÷ 100 = 40.59 → 40.6（若按整数截断会变成 40，差 0.6）
    const result = scaleFoodNutrients({ ...FULL, kcalPer100g: 123 }, 33);
    expect(result.kcal).toBe(40.6);
  });

  it('缺失的纤维 / 钠保持 null（不拿别的字段反推）', () => {
    const result = scaleFoodNutrients(PARTIAL, 150);
    expect(result.kcal).toBe(81);
    expect(result.fiberG).toBeNull();
    expect(result.sodiumMg).toBeNull();
  });

  it('脏输入不出 NaN：0 / 负数 / NaN / Infinity 一律按 0 处理', () => {
    for (const grams of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = scaleFoodNutrients(FULL, grams);
      expect(Number.isNaN(result.kcal)).toBe(false);
      expect(result.kcal).toBe(0);
      expect(result.proteinG).toBe(0);
    }
  });
});

describe('resolveMealAmount：份量 → 克数的优先级', () => {
  const food = {
    defaultServingGrams: 150,
    servingUnits: [
      { unit: '碗', grams: 200 },
      { unit: '个', grams: 50 },
    ],
  };

  it('显式克数优先（哪怕同时给了份量单位）', () => {
    const result = resolveMealAmount(food, { grams: 175, servingUnit: '碗', servingQty: 1 });
    expect(result.grams).toBe(175);
    expect(result.servingUnit).toBeNull();
    expect(result.servingQty).toBeNull();
  });

  it('份量单位 × 份数换算（2 碗 = 400g）', () => {
    const result = resolveMealAmount(food, { servingUnit: '碗', servingQty: 2 });
    expect(result.grams).toBe(400);
    expect(result.servingUnit).toBe('碗');
    expect(result.servingQty).toBe(2);
  });

  it('份量单位不在该食物的单位表里 → 回落到默认份量，不猜', () => {
    const result = resolveMealAmount(food, { servingUnit: '杯', servingQty: 3 });
    expect(result.grams).toBe(150);
    expect(result.servingUnit).toBeNull();
    expect(result.servingQty).toBe(1);
  });

  it('什么都没填 → 默认份量（记为 1 份）', () => {
    const result = resolveMealAmount(food, {});
    expect(result.grams).toBe(150);
    expect(result.servingQty).toBe(1);
  });

  it('连默认份量都没有 → 兜底 100g', () => {
    const result = resolveMealAmount({ defaultServingGrams: null, servingUnits: [] }, {});
    expect(result.grams).toBe(DEFAULT_MEAL_GRAMS);
    expect(result.servingUnit).toBeNull();
    expect(result.servingQty).toBeNull();
  });

  it('份数 ≤ 0 / 非数字时不生效（回落到默认份量，不产生 0g）', () => {
    expect(resolveMealAmount(food, { servingUnit: '碗', servingQty: 0 }).grams).toBe(150);
    expect(resolveMealAmount(food, { servingUnit: '碗', servingQty: Number.NaN }).grams).toBe(150);
  });
});
