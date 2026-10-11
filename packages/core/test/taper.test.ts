import { describe, expect, it } from 'vitest';
import {
  KCAL_PER_KG_FAT,
  TAPER_REMAINING_KG,
  computeCalorieBudget,
  deriveWeeklyLossKg,
} from '../src/index';
import type { CalorieInput, CalorieResult } from '../src/index';

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

/**
 * `weeklyLossKg`：taper **之后**的每周目标减重，是「每周目标减重」这一展示数字的唯一真源。
 *
 * 背景（NFR-11）：此前消费方只能自己调 `deriveWeeklyLossKg()` 重算，而它**不含 taper**，
 * 于是页面「每周目标减重」显示 0.15、紧邻的「原始缺口」显示 123.8，两者乘不出彼此
 * （0.15 × 7700 ÷ 7 = 165 ≠ 123.8）。本节把这个字段钉死，成对覆盖 taper 命中 / 不命中。
 */
describe('weeklyLossKg（taper 后的每周减重，NFR-11 唯一口径真源）', () => {
  /** 不显式给 `weeklyLossKg`，让引擎走 `deriveWeeklyLossKg` 推导分支。 */
  const derived = (patch: Partial<CalorieInput>): CalorieInput => ({
    gender: 'female',
    age: 30,
    heightCm: 165,
    activityLevel: 'sedentary',
    weightKg: 70,
    targetWeightKg: 68.5,
    targetWeeks: 10,
    ...patch,
  });

  /**
   * 自洽性判据：`targetDeficitRaw` 由**未取整**的 weeklyLoss 算出后再 `round1`，
   * 而 `weeklyLossKg` 是**先 `round2`** 的输出值，所以两侧**不能**严格相等，须用容差。
   *
   * 误差上界 = `round2` 半格 0.005 kg/周 折算成每日缺口（0.005 × 7700 ÷ 7 = 5.5 kcal/日）
   *          + `round1` 半格 0.05 kcal/日 = **5.55 kcal/日**，故取 5.6。
   *
   * 该容差足够宽松以容纳双重舍入，又足够紧：若 `weeklyLossKg` 退回未收窄的 0.15，
   * 缺口会变成 165、与 123.7 相差 41.3 ≫ 5.6，断言必红（已由缺陷注入反验确认）。
   */
  const DEFICIT_TOLERANCE_KCAL = 5.6;

  const expectSelfConsistent = (r: CalorieResult): void => {
    expect(Math.abs((r.weeklyLossKg * KCAL_PER_KG_FAT) / 7 - r.targetDeficitRaw)).toBeLessThanOrEqual(
      DEFICIT_TOLERANCE_KCAL,
    );
  };

  it('具名算例 70 → 68.5 / 10 周：weeklyLossKg 是收窄后的 0.11，不是推导值 0.15', () => {
    const r = computeCalorieBudget(derived({}));

    // 推导值（不含 taper）= (70 − 68.5) ÷ 10 = 0.15
    expect(deriveWeeklyLossKg(70, 68.5, 10)).toBeCloseTo(0.15, 10);

    expect(r.taperApplied).toBe(true);
    expect(r.weeklyLossKg).toBe(0.11); // round2(0.15 × (1.5 ÷ 2) = 0.1125)
    expect(r.weeklyLossKg).toBeLessThan(deriveWeeklyLossKg(70, 68.5, 10)); // 严格小于
    // 0.15 × 0.75 在浮点下是 0.1124999…（略低于 0.1125），故 round1 落到 **123.7** 而非 123.8。
    // 关键对比：未收窄会得到 0.15 × 7700 ÷ 7 = 165，与 123.7 相差 41.3 —— 这正是消费方自算造成的矛盾。
    expect(r.targetDeficitRaw).toBe(123.7);
    expect(r.targetDeficitRaw).toBeLessThan(165);
    expectSelfConsistent(r);
  });

  it('taper 命中（剩 0.5 / 1 / 1.5kg）→ weeklyLossKg 严格小于推导值且与缺口自洽', () => {
    for (const remaining of [0.5, 1, 1.5]) {
      const r = computeCalorieBudget(derived({ targetWeightKg: 70 - remaining }));

      expect(r.taperApplied).toBe(true);
      expect(r.weeklyLossKg).toBeLessThan(deriveWeeklyLossKg(70, 70 - remaining, 10));
      expectSelfConsistent(r);
    }
  });

  it('taper 不命中（剩 3 / 5 / 10kg）→ weeklyLossKg 等于推导值，不误伤邻近合法值', () => {
    for (const remaining of [3, 5, 10]) {
      const r = computeCalorieBudget(derived({ targetWeightKg: 70 - remaining }));

      expect(r.taperApplied).toBe(false);
      expect(r.weeklyLossKg).toBe(deriveWeeklyLossKg(70, 70 - remaining, 10));
      expectSelfConsistent(r);
    }
  });

  it(`边界：剩 ${TAPER_REMAINING_KG}kg → taperApplied 为 true，但系数为 1，值仍等于推导值`, () => {
    const r = computeCalorieBudget(derived({ targetWeightKg: 70 - TAPER_REMAINING_KG }));

    expect(r.taperApplied).toBe(true);
    expect(r.weeklyLossKg).toBe(deriveWeeklyLossKg(70, 70 - TAPER_REMAINING_KG, 10)); // 0.2
    expectSelfConsistent(r);
  });

  it('显式 weeklyLossKg 同样被收窄：收窄的是最终采用值，不是推导值', () => {
    const r = computeCalorieBudget(derived({ targetWeightKg: 69, weeklyLossKg: 0.3 }));

    expect(r.taperApplied).toBe(true);
    expect(r.weeklyLossKg).toBe(0.15); // 0.3 × (1 ÷ 2)
    expect(r.weeklyLossKg).toBeLessThan(0.3);
    expectSelfConsistent(r);
  });

  it('weeklyLossKg 与 weeklyLossEffectiveKg 是两个不同字段，不可互相顶替', () => {
    // 触发 30% 缺口上限截断：计划侧（weeklyLossKg）不受影响，结果侧（effective）被压低
    const r = computeCalorieBudget(
      derived({ weightKg: 90, targetWeightKg: 60, targetWeeks: 10, weeklyLossKg: 1.5 }),
    );

    expect(r.isDeficitCapped).toBe(true);
    expect(r.weeklyLossKg).toBe(1.5); // 计划侧：未 taper、未被上限截断
    expect(r.weeklyLossEffectiveKg).toBeLessThan(r.weeklyLossKg); // 结果侧：被上限压低
  });
});
