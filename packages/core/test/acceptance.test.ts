import { describe, expect, it } from 'vitest';
import acceptanceRaw from './fixtures/acceptance.json';
import {
  calcCalorieBudget,
  computeCalorieBudget,
  DEFAULT_MACRO_RATIO,
  deriveWeeklyLossKg,
  WARNING_CODES,
} from '../src/index';
import type { CalorieInput, CalorieResult } from '../src/index';

interface Expected {
  bmr?: number;
  tdee?: number;
  targetDeficitRaw?: number;
  deficitCap?: number;
  effectiveDeficit?: number;
  isDeficitCapped?: boolean;
  intakeRecommended?: number;
  floorApplied?: boolean;
  safetyFloor?: number;
}

interface AcceptanceCase {
  description: string;
  input: CalorieInput;
  expected: Expected;
}

const fixtures = acceptanceRaw as unknown as { 'TC-01': AcceptanceCase; 'TC-02': AcceptanceCase };

/** 断言 result 与 fixture.expected 中的每个给定字段精确相等。 */
function assertExpected(result: CalorieResult, expected: Expected): void {
  if (expected.bmr !== undefined) expect(result.bmr).toBe(expected.bmr);
  if (expected.tdee !== undefined) expect(result.tdee).toBe(expected.tdee);
  if (expected.targetDeficitRaw !== undefined) {
    expect(result.targetDeficitRaw).toBe(expected.targetDeficitRaw);
  }
  if (expected.deficitCap !== undefined) expect(result.deficitCap).toBe(expected.deficitCap);
  if (expected.effectiveDeficit !== undefined) {
    expect(result.effectiveDeficit).toBe(expected.effectiveDeficit);
  }
  if (expected.isDeficitCapped !== undefined) {
    expect(result.isDeficitCapped).toBe(expected.isDeficitCapped);
  }
  if (expected.intakeRecommended !== undefined) {
    expect(result.intakeRecommended).toBe(expected.intakeRecommended);
  }
  if (expected.floorApplied !== undefined) expect(result.floorApplied).toBe(expected.floorApplied);
  if (expected.safetyFloor !== undefined) expect(result.safetyFloor).toBe(expected.safetyFloor);
}

describe('验收用例（PRD §8.1 / ARCHITECTURE §4.4）', () => {
  it('TC-01：女 30 岁 165cm 60kg 久坐，每周减 0.5kg', () => {
    const tc = fixtures['TC-01'];
    const result = calcCalorieBudget(tc.input);

    assertExpected(result, tc.expected);

    // 两个标志位可同时为 true
    expect(result.isDeficitCapped).toBe(true);
    expect(result.floorApplied).toBe(true);

    // 安全文案：含「接近安全下限」语义（鼓励式，禁止负罪感文案）
    expect(result.safetyMessages.join('')).toContain('接近安全下限');
    expect(result.safetyMessages).toHaveLength(2);

    // 结果侧告警：0.5kg（< 60×2%）且目标 55kg（BMI 20.2）→ 仅触下限一条告警
    expect(result.warnings.map((w) => w.code)).toEqual([WARNING_CODES.FLOOR_APPLIED]);

    // 宏量营养素默认 25/25/50：1200 → 75 / 33.3 / 150
    expect(result.macros.proteinG).toBeCloseTo(75.0, 5);
    expect(result.macros.fatG).toBeCloseTo(33.3, 5);
    expect(result.macros.carbG).toBeCloseTo(150.0, 5);

    // 反推每周实际减重与预计周数
    expect(result.weeklyLossEffectiveKg).toBeCloseTo(0.35, 2);
    expect(result.etaWeeks).not.toBeNull();
    expect(result.etaWeeks as number).toBeCloseTo(14.31, 2);
  });

  it('TC-02（修订）：显式 weeklyLossKg=2 被接受（不抛错），逐字段 = 2200.0 / 475.3 / 1200 + 恰好 2 条告警', () => {
    const tc = fixtures['TC-02'];

    // 前置：输入确实显式携带 weeklyLossKg = 2
    expect(tc.input.weeklyLossKg).toBe(2);

    // 关键行为：不再是硬错误，绝不抛错
    let result: CalorieResult;
    expect(() => {
      result = calcCalorieBudget(tc.input);
    }).not.toThrow();
    result = calcCalorieBudget(tc.input);

    // 逐字段预期
    assertExpected(result, tc.expected);
    expect(result.bmr).toBe(1320);
    expect(result.tdee).toBe(1584);
    expect(result.targetDeficitRaw).toBe(2200.0);
    expect(result.deficitCap).toBe(475.3);
    expect(result.effectiveDeficit).toBe(475.3);
    expect(result.isDeficitCapped).toBe(true);
    expect(result.intakeRecommended).toBe(1200);
    expect(result.floorApplied).toBe(true);
    expect(result.safetyFloor).toBe(1200);

    // warnings：恰好 2 条（输入侧 W_WEEKLY_LOSS_AGGRESSIVE + 结果侧 W_FLOOR_APPLIED，按发生顺序）
    expect(result.warnings.map((w) => w.code)).toEqual([
      WARNING_CODES.WEEKLY_LOSS_AGGRESSIVE,
      WARNING_CODES.FLOOR_APPLIED,
    ]);
    expect(result.warnings).toHaveLength(2);

    // safetyMessages：保持 2 条（floor 文案 + capped 文案，顺序：先下限后上限），语义不变
    expect(result.safetyMessages).toHaveLength(2);
    expect(result.safetyMessages[0]).toContain('接近安全下限');
    expect(result.safetyMessages[1]).toContain('更可持续');
  });

  it('TC-02 一致性：推导链路（目标 52kg / 4 周 → 2.0kg）与显式链路（weeklyLossKg=2）引擎结果完全一致', () => {
    // 推导出 2.0kg/周：(60 − 52) / 4 = 2.0；D13 —— 不再硬校验后两条链路行为统一
    expect(deriveWeeklyLossKg(60, 52, 4)).toBeCloseTo(2.0, 10);

    const shared: Omit<CalorieInput, 'weeklyLossKg'> = {
      gender: 'female',
      age: 30,
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: 52,
      targetWeeks: 4,
      activityLevel: 'sedentary',
    };

    const derived = calcCalorieBudget({ ...shared });
    const explicit = calcCalorieBudget({ ...shared, weeklyLossKg: 2 });

    // 数值 / 标志位 / safetyMessages / 宏量 / etaWeeks 全部一致（warnings 因输入差异而不同，见下）
    const withoutWarnings = (r: CalorieResult): Partial<CalorieResult> => {
      const clone: Partial<CalorieResult> = { ...r };
      delete clone.warnings;
      return clone;
    };
    expect(withoutWarnings(derived)).toEqual(withoutWarnings(explicit));

    // 两条链路都被 30% 上限 + 安全下限钳制
    expect(derived.isDeficitCapped).toBe(true);
    expect(derived.floorApplied).toBe(true);
    expect(explicit.isDeficitCapped).toBe(true);
    expect(explicit.floorApplied).toBe(true);

    // 显式链路携带输入侧激进告警；推导链路无 weeklyLossKg 输入故不产生该告警
    expect(explicit.warnings.map((w) => w.code)).toEqual([
      WARNING_CODES.WEEKLY_LOSS_AGGRESSIVE,
      WARNING_CODES.FLOOR_APPLIED,
    ]);
    expect(derived.warnings.map((w) => w.code)).toEqual([WARNING_CODES.FLOOR_APPLIED]);
  });
});

describe('30% 缺口上限：截断但未触下限（TC-07）', () => {
  it('男 30 岁 180cm 85kg 中度活动，每周减 1.5kg', () => {
    const input: CalorieInput = {
      gender: 'male',
      age: 30,
      heightCm: 180,
      weightKg: 85,
      targetWeightKg: 75,
      targetWeeks: 8,
      activityLevel: 'moderate',
      weeklyLossKg: 1.5,
    };

    const result = calcCalorieBudget(input);
    const bmrFloat = 10 * 85 + 6.25 * 180 - 5 * 30 + 5; // BMR 浮点

    // BMR = 1830，TDEE = 1830 × 1.55 = 2836.5
    expect(result.bmr).toBe(1830);
    expect(result.tdee).toBe(2837);

    // 原始缺口 = 1.5 × 7700 / 7 = 1650，超过 cap
    expect(result.targetDeficitRaw).toBeCloseTo(1650, 1);
    expect(result.isDeficitCapped).toBe(true);
    expect(result.floorApplied).toBe(false);

    // 有效缺口 ≈ TDEE × 0.3（TDEE = 1830 × 1.55 = 2836.5，cap = 2836.5 × 0.3 ≈ 850.95 → 输出取整 851.0）
    const capFloat = bmrFloat * 1.55 * 0.3;
    expect(result.deficitCap).toBeCloseTo(capFloat, 0);
    expect(result.effectiveDeficit).toBe(result.deficitCap);
    expect(Math.abs(result.effectiveDeficit - capFloat)).toBeLessThan(0.1);

    // 建议摄入 = TDEE − cap（未触下限）
    expect(result.intakeRecommended).toBe(Math.round(bmrFloat * 1.55 - capFloat));
    expect(result.safetyMessages.join('')).toContain('更可持续');
    expect(result.safetyMessages.join('')).not.toContain('接近安全下限');

    // 未触发下限、周减重 1.5kg（< 85×2%=1.7）、目标 75kg（BMI 23.1）→ 无任何告警
    expect(result.warnings).toEqual([]);
  });
});

describe('达成周数无法预测时返回 null', () => {
  it('目标体重等于当前体重（有效缺口为 0）', () => {
    const input: CalorieInput = {
      gender: 'female',
      age: 30,
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: 60,
      targetWeeks: 10,
      activityLevel: 'sedentary',
    };
    const result = computeCalorieBudget(input);
    expect(result.targetDeficitRaw).toBe(0);
    expect(result.effectiveDeficit).toBe(0);
    expect(result.etaWeeks).toBeNull();
  });

  it('安全下限高于 TDEE 时（反推周减重 ≤ 0）返回 null', () => {
    const input: CalorieInput = {
      gender: 'female',
      age: 100,
      heightCm: 140,
      weightKg: 40,
      targetWeightKg: 38,
      targetWeeks: 52,
      activityLevel: 'sedentary',
    };
    const result = computeCalorieBudget(input);
    expect(result.intakeRecommended).toBe(1200);
    expect(result.floorApplied).toBe(true);
    expect(result.weeklyLossEffectiveKg).toBeLessThan(0);
    expect(result.etaWeeks).toBeNull();
  });

  it('默认宏量比例与显式传入一致', () => {
    const base: CalorieInput = {
      gender: 'female',
      age: 30,
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: 55,
      targetWeeks: 10,
      activityLevel: 'sedentary',
      weeklyLossKg: 0.5,
    };
    const withDefault = computeCalorieBudget(base);
    const withExplicit = computeCalorieBudget({ ...base, macroRatio: { ...DEFAULT_MACRO_RATIO } });
    expect(withExplicit.macros).toEqual(withDefault.macros);
  });
});
