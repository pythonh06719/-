import { describe, expect, it } from 'vitest';
import { TAPER_REMAINING_KG, computeCalorieBudget } from '../src/index';
import type { CalorieInput } from '../src/index';

/**
 * taper（R2.7）：剩余需减重量进入收尾区间时，把减重速度按剩余量**线性收窄**，防反弹。
 *
 * 这里的输入刻意让显式 `weeklyLossKg` 远离「30% 缺口上限」与「安全下限」，
 * 因此断言里的差额**只来自 taper 本身**，不会被截断/钳下限干扰。
 * （最后一条专门反过来验证：taper 不会让结果跌破安全下限。）
 */
const BASE: CalorieInput = {
  gender: 'female',
  age: 30,
  heightCm: 165,
  weightKg: 70,
  targetWeightKg: 60,
  targetWeeks: 20,
  activityLevel: 'sedentary',
  weeklyLossKg: 0.3,
};

const make = (patch: Partial<CalorieInput>): CalorieInput => ({ ...BASE, ...patch });

/** 换算：每周减重 → 每日缺口（与引擎同一公式）。 */
const deficitOf = (weeklyLossKg: number): number => (weeklyLossKg * 7700) / 7;

describe('taper（R2.7 接近目标逐步收窄缺口，防反弹）', () => {
  it('远离目标（剩 10kg）→ 不收窄', () => {
    const result = computeCalorieBudget(BASE);
    expect(result.taperApplied).toBe(false);
    expect(result.effectiveDeficit).toBeCloseTo(deficitOf(0.3), 1);
  });

  it(`剩 ${TAPER_REMAINING_KG}kg（阈值边界）→ 标记收窄，但系数为 1，速度不变`, () => {
    const result = computeCalorieBudget(make({ targetWeightKg: 70 - TAPER_REMAINING_KG }));
    expect(result.taperApplied).toBe(true);
    expect(result.effectiveDeficit).toBeCloseTo(deficitOf(0.3), 1);
  });

  it('剩 1kg → 速度减半', () => {
    const result = computeCalorieBudget(make({ targetWeightKg: 69 }));
    expect(result.taperApplied).toBe(true);
    expect(result.effectiveDeficit).toBeCloseTo(deficitOf(0.15), 1);
  });

  it('剩 0.5kg → 速度剩四分之一', () => {
    const result = computeCalorieBudget(make({ targetWeightKg: 69.5 }));
    expect(result.taperApplied).toBe(true);
    expect(result.effectiveDeficit).toBeCloseTo(deficitOf(0.075), 1);
  });

  it('刚好达成（剩 0）→ 不收窄（由维持模式 R11.2 接管）', () => {
    const result = computeCalorieBudget(make({ targetWeightKg: 70 }));
    expect(result.taperApplied).toBe(false);
  });

  it('已低于目标（剩 −1kg）→ 不收窄', () => {
    const result = computeCalorieBudget(make({ targetWeightKg: 71 }));
    expect(result.taperApplied).toBe(false);
  });

  it('收窄后缺口更小、摄入更接近 TDEE（但还没到维持）', () => {
    const far = computeCalorieBudget(BASE);
    const near = computeCalorieBudget(make({ targetWeightKg: 69 }));

    expect(near.effectiveDeficit).toBeLessThan(far.effectiveDeficit);
    expect(near.intakeRecommended).toBeGreaterThan(far.intakeRecommended);
    // 收窄不等于维持：摄入仍应低于 TDEE
    expect(near.intakeRecommended).toBeLessThan(near.tdee);
  });

  it('收窄不破坏「安全下限优先级高于缺口上限」', () => {
    // 逼近下限的场景：即便触发 taper，最终摄入也不得跌破 1200（女性下限）
    const result = computeCalorieBudget(
      make({ weightKg: 50, targetWeightKg: 49, activityLevel: 'sedentary', weeklyLossKg: 1.2 }),
    );

    expect(result.taperApplied).toBe(true);
    expect(result.floorApplied).toBe(true);
    expect(result.intakeRecommended).toBeGreaterThanOrEqual(result.safetyFloor);
  });
});
