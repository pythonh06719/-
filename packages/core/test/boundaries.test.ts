import { describe, expect, it } from 'vitest';
import { calcCalorieBudget, computeCalorieBudget } from '../src/index';
import type { CalorieInput } from '../src/index';

const BASE: CalorieInput = {
  gender: 'female',
  age: 30,
  heightCm: 165,
  weightKg: 60,
  targetWeightKg: 55,
  targetWeeks: 10,
  activityLevel: 'sedentary',
  weeklyLossKg: 0.5,
};

const make = (patch: Partial<CalorieInput>): CalorieInput => ({ ...BASE, ...patch });

describe('边界-极低体重 / 极低身高（TC-04）', () => {
  it('女 14 岁 80cm 20kg：BMR 为正，触及安全下限', () => {
    const input = make({
      age: 14,
      heightCm: 80,
      weightKg: 20,
      targetWeightKg: 19,
      targetWeeks: 52,
      weeklyLossKg: undefined,
    });
    const r = calcCalorieBudget(input);

    // BMR = 10×20 + 6.25×80 − 5×14 − 161 = 469
    expect(r.bmr).toBe(469);
    expect(r.bmr).toBeGreaterThan(0);
    expect(r.floorApplied).toBe(true);
    expect(r.isDeficitCapped).toBe(false);
    expect(r.intakeRecommended).toBe(1200);
    expect(r.safetyFloor).toBe(1200);
  });
});

describe('边界-大年龄（TC-05）', () => {
  it('女 100 岁：计算不崩、结果为正', () => {
    const input = make({
      age: 100,
      heightCm: 160,
      weightKg: 55,
      targetWeightKg: 50,
      targetWeeks: 20,
      weeklyLossKg: undefined,
    });
    const r = calcCalorieBudget(input);

    // BMR = 550 + 1000 − 500 − 161 = 889
    expect(r.bmr).toBe(889);
    expect(r.bmr).toBeGreaterThan(0);
    expect(r.tdee).toBeGreaterThan(0);
    expect(r.intakeRecommended).toBeGreaterThan(0);
    expect(Number.isFinite(r.macros.proteinG)).toBe(true);
  });
});

describe('边界-30% 缺口上限（TC-07）', () => {
  it('极大每周减重导致有效缺口被截断为 TDEE × 0.3', () => {
    // 体重 100kg → 温和上限 2kg/周，取 2kg/周（恰在上限）
    const input = make({
      gender: 'male',
      age: 30,
      heightCm: 180,
      weightKg: 100,
      targetWeightKg: 90,
      targetWeeks: 5,
      activityLevel: 'sedentary',
      weeklyLossKg: 2,
    });
    const r = calcCalorieBudget(input);
    expect(r.isDeficitCapped).toBe(true);
    expect(r.effectiveDeficit / r.tdee).toBeCloseTo(0.3, 2);
  });
});

describe('边界-同时触发上限与下限（TC-08）', () => {
  it('男 30 岁 165cm 70kg 久坐，每周减 1.4kg（1.4 = 70×2% 上限内）', () => {
    const input = make({
      gender: 'male',
      age: 30,
      heightCm: 165,
      weightKg: 70,
      targetWeightKg: 60,
      targetWeeks: 8,
      activityLevel: 'sedentary',
      weeklyLossKg: 1.4,
    });
    const r = computeCalorieBudget(input);
    expect(r.isDeficitCapped).toBe(true);
    expect(r.floorApplied).toBe(true);
    expect(r.intakeRecommended).toBe(1500);
  });
});
