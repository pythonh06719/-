import { describe, expect, it } from 'vitest';
import { CalorieInputError, calcCalorieBudget, validateCalorieInput, WARNING_CODES } from '../src/index';
import type { CalorieInput, ValidationError, ValidationWarning } from '../src/index';

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
const asUnsafe = (patch: Record<string, unknown>): CalorieInput =>
  ({ ...BASE, ...patch }) as unknown as CalorieInput;

/** 断言错误码存在。 */
function expectCode(errors: ValidationError[], code: string): void {
  expect(errors.map((e) => e.code)).toContain(code);
}

/** 断言告警码存在。 */
function expectWarningCode(warnings: ValidationWarning[], code: string): void {
  expect(warnings.map((w) => w.code)).toContain(code);
}

describe('validateCalorieInput：合法输入', () => {
  it('完全合法时 errors 与 warnings 均为空', () => {
    expect(validateCalorieInput(BASE)).toEqual({ errors: [], warnings: [] });
  });

  it('自定义比例为 100 且各非负时通过', () => {
    expect(validateCalorieInput(make({ macroRatio: { protein: 30, fat: 30, carb: 40 } })).errors).toEqual([]);
  });
});

describe('validateCalorieInput：错误码（ARCHITECTURE §4.5）', () => {
  it('E_GENDER：性别枚举非法', () => {
    expectCode(validateCalorieInput(asUnsafe({ gender: 'other' })).errors, 'E_GENDER');
  });

  it('E_AGE：年龄越界（13 / 101）及非整数', () => {
    expectCode(validateCalorieInput(make({ age: 13 })).errors, 'E_AGE');
    expectCode(validateCalorieInput(make({ age: 101 })).errors, 'E_AGE');
    expectCode(validateCalorieInput(make({ age: 30.5 })).errors, 'E_AGE');
  });

  it('E_HEIGHT：身高越界（79 / 251）', () => {
    expectCode(validateCalorieInput(make({ heightCm: 79 })).errors, 'E_HEIGHT');
    expectCode(validateCalorieInput(make({ heightCm: 251 })).errors, 'E_HEIGHT');
  });

  it('E_WEIGHT：体重越界（19 / 401）', () => {
    expectCode(validateCalorieInput(make({ weightKg: 19 })).errors, 'E_WEIGHT');
    expectCode(validateCalorieInput(make({ weightKg: 401 })).errors, 'E_WEIGHT');
  });

  it('E_TARGET_WEIGHT：目标体重 > 当前体重 或 ≤ 0', () => {
    expectCode(validateCalorieInput(make({ targetWeightKg: 61 })).errors, 'E_TARGET_WEIGHT');
    expectCode(validateCalorieInput(make({ targetWeightKg: 0 })).errors, 'E_TARGET_WEIGHT');
  });

  it('E_TARGET_WEEKS：周数为 0 / 261 / 非整数', () => {
    expectCode(validateCalorieInput(make({ targetWeeks: 0 })).errors, 'E_TARGET_WEEKS');
    expectCode(validateCalorieInput(make({ targetWeeks: 261 })).errors, 'E_TARGET_WEEKS');
    expectCode(validateCalorieInput(make({ targetWeeks: 3.5 })).errors, 'E_TARGET_WEEKS');
  });

  it('E_ACTIVITY：活动量枚举非法', () => {
    expectCode(validateCalorieInput(asUnsafe({ activityLevel: 'super' })).errors, 'E_ACTIVITY');
  });

  it('E_MACRO_SUM：比例之和 ≠ 100', () => {
    expectCode(validateCalorieInput(make({ macroRatio: { protein: 30, fat: 30, carb: 30 } })).errors, 'E_MACRO_SUM');
  });

  it('E_MACRO_SUM：比例含负数', () => {
    expectCode(validateCalorieInput(make({ macroRatio: { protein: 120, fat: -10, carb: -10 } })).errors, 'E_MACRO_SUM');
  });

  it('E_MACRO_SUM：比例含非有限值（NaN）', () => {
    const report = validateCalorieInput(
      make({ macroRatio: { protein: Number.NaN, fat: 25, carb: 75 } }),
    );
    expectCode(report.errors, 'E_MACRO_SUM');
  });

  it('E_WEEKLY_LOSS（硬错误）：每周减重为 NaN / Infinity / 0 / -1（无法计算缺口）', () => {
    expectCode(validateCalorieInput(make({ weeklyLossKg: Number.NaN })).errors, 'E_WEEKLY_LOSS');
    expectCode(validateCalorieInput(make({ weeklyLossKg: Number.POSITIVE_INFINITY })).errors, 'E_WEEKLY_LOSS');
    expectCode(validateCalorieInput(make({ weeklyLossKg: 0 })).errors, 'E_WEEKLY_LOSS');
    expectCode(validateCalorieInput(make({ weeklyLossKg: -1 })).errors, 'E_WEEKLY_LOSS');
  });
});

describe('validateCalorieInput：告警码（非阻断，ARCHITECTURE §4.5 / D13）', () => {
  it('W_WEEKLY_LOSS_AGGRESSIVE：超过体重 × 2%（60kg → 上限 1.2kg）时报错为空、产出告警', () => {
    const report = validateCalorieInput(make({ weeklyLossKg: 1.3 }));
    expect(report.errors).toEqual([]);
    expectWarningCode(report.warnings, WARNING_CODES.WEEKLY_LOSS_AGGRESSIVE);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.field).toBe('weeklyLossKg');

    // 远高于上限同样只是告警
    const report5 = validateCalorieInput(make({ weeklyLossKg: 5 }));
    expect(report5.errors).toEqual([]);
    expectWarningCode(report5.warnings, WARNING_CODES.WEEKLY_LOSS_AGGRESSIVE);
  });

  it('W_WEEKLY_LOSS_AGGRESSIVE：恰在体重 × 2% 以内不触发', () => {
    const report = validateCalorieInput(make({ weeklyLossKg: 1.2 }));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('weightKg 非有限值时：报 E_WEIGHT 且不产出激进周减重告警', () => {
    const report = validateCalorieInput(make({ weightKg: Number.NaN, weeklyLossKg: 2 }));
    expectCode(report.errors, 'E_WEIGHT');
    expect(report.warnings).toEqual([]);
  });

  it('W_TARGET_BMI_LOW：165cm 目标 48kg（BMI 17.6）触发', () => {
    const report = validateCalorieInput(make({ targetWeightKg: 48 }));
    expect(report.errors).toEqual([]);
    expectWarningCode(report.warnings, WARNING_CODES.TARGET_BMI_LOW);
    expect(report.warnings.find((w) => w.code === WARNING_CODES.TARGET_BMI_LOW)?.field).toBe('targetWeightKg');
  });

  it('W_TARGET_BMI_LOW：165cm 目标 55kg（BMI 20.2）不触发', () => {
    const report = validateCalorieInput(make({ targetWeightKg: 55 }));
    expect(report.warnings).toEqual([]);
  });
});

describe('calcCalorieBudget：抛错式契约', () => {
  it('硬错误输入抛 CalorieInputError 且携带 errors[]', () => {
    let caught: unknown;
    try {
      calcCalorieBudget(make({ age: 13 }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CalorieInputError);
    expect((caught as CalorieInputError).errors.map((e) => e.code)).toContain('E_AGE');
    expect((caught as CalorieInputError).name).toBe('CalorieInputError');
  });

  it('仅告警输入不抛错并照常返回结果', () => {
    // weeklyLossKg = 2（60kg 的 3.3%/周）只是非阻断告警，应当被接受
    const result = calcCalorieBudget(make({ targetWeightKg: 55, weeklyLossKg: 2 }));
    expectWarningCode(result.warnings, WARNING_CODES.WEEKLY_LOSS_AGGRESSIVE);
    expect(result.intakeRecommended).toBe(1200);
  });

  it('合法输入不抛错并返回结果', () => {
    expect(() => calcCalorieBudget(BASE)).not.toThrow();
  });

  it('多个字段同时非法时聚合多个错误码', () => {
    const report = validateCalorieInput(asUnsafe({ age: 13, gender: 'x', heightCm: 300 }));
    expect(report.errors.length).toBeGreaterThanOrEqual(3);
  });
});
