import { describe, expect, it } from 'vitest';
import { calcCalorieBudget, calcMacros } from '../src/index';
import type { CalorieInput, MacroRatio } from '../src/index';

describe('calcMacros：默认比例 25 / 25 / 50（TC-10）', () => {
  it('建议摄入 1200 → 蛋白 75g / 脂肪 33.3g / 碳水 150g', () => {
    const macros = calcMacros(1200, { protein: 25, fat: 25, carb: 50 });
    expect(macros.proteinG).toBeCloseTo(75.0, 5);
    expect(macros.fatG).toBeCloseTo(33.3, 5);
    expect(macros.carbG).toBeCloseTo(150.0, 5);
  });

  it('经引擎计算 TC-01 的宏量与直接调用一致（±0.5g 容差内）', () => {
    const input: CalorieInput = {
      gender: 'female',
      age: 30,
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: 55,
      targetWeeks: 10,
      activityLevel: 'sedentary',
      weeklyLossKg: 0.5,
    };
    const r = calcCalorieBudget(input);
    const direct = calcMacros(r.intakeRecommended, { protein: 25, fat: 25, carb: 50 });
    expect(Math.abs(r.macros.proteinG - direct.proteinG)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.macros.fatG - direct.fatG)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.macros.carbG - direct.carbG)).toBeLessThanOrEqual(0.5);
  });
});

describe('calcMacros：自定义比例 30 / 30 / 40（TC-11）', () => {
  it('和为 100 时按 4 / 9 / 4 正确换算（克数取整到 1 位小数）', () => {
    const ratio: MacroRatio = { protein: 30, fat: 30, carb: 40 };
    const macros = calcMacros(2000, ratio);
    expect(macros.proteinG).toBeCloseTo(150.0, 5); // 2000×0.3÷4 = 150
    expect(macros.fatG).toBeCloseTo(66.7, 5); // 2000×0.3÷9 = 66.666… → 66.7
    expect(macros.carbG).toBeCloseTo(200.0, 5); // 2000×0.4÷4 = 200
  });

  it('引擎对自定义比例生效', () => {
    const input: CalorieInput = {
      gender: 'female',
      age: 30,
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: 55,
      targetWeeks: 10,
      activityLevel: 'sedentary',
      weeklyLossKg: 0.5,
      macroRatio: { protein: 30, fat: 30, carb: 40 },
    };
    const r = calcCalorieBudget(input);
    expect(r.macros.proteinG).toBeCloseTo((r.intakeRecommended * 0.3) / 4, 5);
    expect(r.macros.fatG).toBeCloseTo((r.intakeRecommended * 0.3) / 9, 5);
    expect(r.macros.carbG).toBeCloseTo((r.intakeRecommended * 0.4) / 4, 5);
  });
});

describe('calcMacros：极端比例（0% 某项）', () => {
  it('允许某项为 0', () => {
    const macros = calcMacros(1000, { protein: 0, fat: 100, carb: 0 });
    expect(macros.proteinG).toBe(0);
    expect(macros.fatG).toBeCloseTo(111.1, 5); // 1000÷9 = 111.11… → 取整到 1 位小数 111.1
    expect(macros.carbG).toBe(0);
  });
});
