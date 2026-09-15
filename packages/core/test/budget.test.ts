import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FACTORS,
  calcBMR,
  calcCalorieBudget,
  calcTDEE,
  computeCalorieBudget,
  deriveWeeklyLossKg,
  safeCalcCalorieBudget,
  WARNING_CODES,
} from '../src/index';
import type { ActivityLevel, CalorieInput } from '../src/index';

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

describe('calcBMR（Mifflin-St Jeor）', () => {
  it('女性：10w + 6.25h − 5age − 161', () => {
    expect(calcBMR({ gender: 'female', weightKg: 60, heightCm: 165, age: 30 })).toBeCloseTo(1320.25, 6);
  });

  it('男性：10w + 6.25h − 5age + 5', () => {
    expect(calcBMR({ gender: 'male', weightKg: 70, heightCm: 175, age: 40 })).toBeCloseTo(1598.75, 6);
  });
});

describe('活动系数映射（TC-09）', () => {
  const table: ReadonlyArray<readonly [ActivityLevel, number]> = [
    ['sedentary', 1.2],
    ['light', 1.375],
    ['moderate', 1.55],
    ['high', 1.725],
    ['athlete', 1.9],
  ];

  it.each(table)('%s 的系数为 %s', (level, factor) => {
    expect(ACTIVITY_FACTORS[level]).toBeCloseTo(factor, 10);
    expect(calcTDEE(1000, level)).toBeCloseTo(1000 * factor, 6);
  });
});

describe('deriveWeeklyLossKg（PRD Q5）', () => {
  it('未传 weeklyLossKg 时按 (weightKg − targetWeightKg) / targetWeeks 推导', () => {
    expect(deriveWeeklyLossKg(60, 54, 12)).toBeCloseTo(0.5, 10);
  });

  it('computeCalorieBudget 使用推导值时与手算一致', () => {
    const derived = computeCalorieBudget(make({ targetWeightKg: 54, targetWeeks: 12, weeklyLossKg: undefined }));
    const explicit = computeCalorieBudget(make({ targetWeightKg: 54, targetWeeks: 12, weeklyLossKg: 0.5 }));
    expect(derived.targetDeficitRaw).toBe(explicit.targetDeficitRaw);
    expect(derived.intakeRecommended).toBe(explicit.intakeRecommended);
  });
});

describe('主链路：预算拆分与标志位', () => {
  it('TC-01 主链路数值链路正确', () => {
    const r = calcCalorieBudget(BASE);
    expect(r.bmr).toBe(1320);
    expect(r.tdee).toBe(1584);
    expect(r.targetDeficitRaw).toBe(550.0);
    expect(r.deficitCap).toBe(475.3);
    expect(r.effectiveDeficit).toBe(475.3);
    expect(r.intakeRecommended).toBe(1200);
    expect(r.safetyFloor).toBe(1200);
    expect(r.isDeficitCapped).toBe(true);
    expect(r.floorApplied).toBe(true);
    expect(r.safetyMessages.length).toBe(2);

    // 结果侧告警：触下限 → 含 W_FLOOR_APPLIED（0.5kg < 60×2%，目标 55kg BMI 20.2，无输入侧告警）
    expect(r.warnings.map((w) => w.code)).toEqual([WARNING_CODES.FLOOR_APPLIED]);
  });

  it('未触发任何截断/下限时两个标志位均为 false 且提示为空', () => {
    const r = calcCalorieBudget(
      make({ gender: 'male', age: 30, heightCm: 180, weightKg: 85, targetWeightKg: 80, targetWeeks: 10, activityLevel: 'athlete', weeklyLossKg: 0.3 }),
    );
    expect(r.isDeficitCapped).toBe(false);
    expect(r.floorApplied).toBe(false);
    expect(r.safetyMessages).toEqual([]);
    // 未触发下限 → 无结果侧告警（0.3kg < 85×2%，目标 80kg BMI 24.7，无输入侧告警）
    expect(r.warnings).toEqual([]);
  });
});

describe('safeCalcCalorieBudget（联合式，不抛错）', () => {
  it('合法输入返回 { ok: true, result }', () => {
    const outcome = safeCalcCalorieBudget(BASE);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.intakeRecommended).toBe(1200);
    }
  });

  it('非法输入返回 { ok: false, errors } 且不抛错', () => {
    const bad = { ...BASE, age: 10 } as CalorieInput;
    const outcome = safeCalcCalorieBudget(bad);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errors.some((e) => e.code === 'E_AGE')).toBe(true);
    }
  });
});
