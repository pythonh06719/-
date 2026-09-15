import {
  ACTIVITY_FACTORS,
  AGE_MAX,
  AGE_MIN,
  HEIGHT_MAX,
  HEIGHT_MIN,
  TARGET_BMI_LOW_THRESHOLD,
  TARGET_WEEKS_MAX,
  TARGET_WEEKS_MIN,
  WARNING_CODES,
  WEEKLY_LOSS_MAX_RATIO,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from './constants';
import type {
  ActivityLevel,
  CalorieInput,
  Gender,
  ValidationError,
  ValidationReport,
  ValidationWarning,
} from './types';

/**
 * 输入存在**硬错误**（不可计算）时抛出的错误（供服务端 / 单测尽早暴露契约破坏，ARCHITECTURE §4.5）。
 *
 * 仅当 `validateCalorieInput(input).errors` 非空时抛出；`warnings`（非阻断告警）**从不**触发本错误。
 */
export class CalorieInputError extends Error {
  /** 全部校验错误条目 */
  public readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(
      `热量引擎输入校验未通过（${errors.length} 项）：${errors
        .map((e) => e.code)
        .join(', ')}`,
    );
    this.name = 'CalorieInputError';
    this.errors = errors;
    // 保证跨编译目标（ES5/ES2022） instanceof 行为一致
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const VALID_GENDERS: readonly Gender[] = ['male', 'female'];

const VALID_ACTIVITY_LEVELS = Object.keys(ACTIVITY_FACTORS) as ActivityLevel[];

/** 判断是否为有限数值。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 判断是否为有限整数。 */
function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

/**
 * 纯校验函数：返回**两级校验报告** `{ errors, warnings }`，**不抛错**（ARCHITECTURE §4.5）。
 *
 * - `errors`（硬错误，阻断）：仅「不可计算」的输入（枚举非法 / 越界 / 宏量和 ≠ 100 /
 *   `weeklyLossKg` 非有限值或 ≤ 0）。
 * - `warnings`（告警，不阻断）：「可计算但不理想」的输入 ——
 *   `weeklyLossKg > weightKg × 2%`、目标体重对应 `BMI < 18.5`。
 *
 * 校验规则严格对齐 ARCHITECTURE §4.5（错误码表 + 告警码表）。
 */
export function validateCalorieInput(input: CalorieInput): ValidationReport {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!VALID_GENDERS.includes(input.gender)) {
    errors.push({ code: 'E_GENDER', field: 'gender', message: '请选择性别（男 / 女）' });
  }

  if (!isInteger(input.age) || input.age < AGE_MIN || input.age > AGE_MAX) {
    errors.push({
      code: 'E_AGE',
      field: 'age',
      message: `年龄需为 ${AGE_MIN}–${AGE_MAX} 之间的整数周岁`,
    });
  }

  if (!isFiniteNumber(input.heightCm) || input.heightCm < HEIGHT_MIN || input.heightCm > HEIGHT_MAX) {
    errors.push({
      code: 'E_HEIGHT',
      field: 'heightCm',
      message: `身高需在 ${HEIGHT_MIN}–${HEIGHT_MAX} cm 之间`,
    });
  }

  if (!isFiniteNumber(input.weightKg) || input.weightKg < WEIGHT_MIN || input.weightKg > WEIGHT_MAX) {
    errors.push({
      code: 'E_WEIGHT',
      field: 'weightKg',
      message: `体重需在 ${WEIGHT_MIN}–${WEIGHT_MAX} kg 之间`,
    });
  }

  if (
    !isFiniteNumber(input.targetWeightKg) ||
    input.targetWeightKg <= 0 ||
    (isFiniteNumber(input.weightKg) && input.targetWeightKg > input.weightKg)
  ) {
    errors.push({
      code: 'E_TARGET_WEIGHT',
      field: 'targetWeightKg',
      message: '目标体重需大于 0 且不超过当前体重',
    });
  }

  if (
    !isInteger(input.targetWeeks) ||
    input.targetWeeks < TARGET_WEEKS_MIN ||
    input.targetWeeks > TARGET_WEEKS_MAX
  ) {
    errors.push({
      code: 'E_TARGET_WEEKS',
      field: 'targetWeeks',
      message: `目标期限需为 ${TARGET_WEEKS_MIN}–${TARGET_WEEKS_MAX} 之间的整数周`,
    });
  }

  if (!VALID_ACTIVITY_LEVELS.includes(input.activityLevel)) {
    errors.push({ code: 'E_ACTIVITY', field: 'activityLevel', message: '请选择有效的活动量档位' });
  }

  if (input.macroRatio !== undefined) {
    const { protein, fat, carb } = input.macroRatio;
    const allFinite = isFiniteNumber(protein) && isFiniteNumber(fat) && isFiniteNumber(carb);
    const allNonNegative = allFinite && protein >= 0 && fat >= 0 && carb >= 0;
    const sum = allFinite ? protein + fat + carb : Number.NaN;
    // 容差为 0（严格等于 100）
    if (!allNonNegative || sum !== 100) {
      errors.push({
        code: 'E_MACRO_SUM',
        field: 'macroRatio',
        message: '蛋白质 / 脂肪 / 碳水百分比需均不小于 0，且三者之和等于 100',
      });
    }
  }

  if (input.weeklyLossKg !== undefined) {
    if (!isFiniteNumber(input.weeklyLossKg) || input.weeklyLossKg <= 0) {
      // 硬错误：非有限值（NaN / Infinity）或 ≤ 0 → 无法计算缺口
      errors.push({
        code: 'E_WEEKLY_LOSS',
        field: 'weeklyLossKg',
        message: '每周减重需为大于 0 的有限数值',
      });
    } else if (
      isFiniteNumber(input.weightKg) &&
      input.weeklyLossKg > input.weightKg * WEEKLY_LOSS_MAX_RATIO
    ) {
      // 告警（非阻断）：超过体重 × 2% 的温和上限，照常计算 + 温和提示（ARCHITECTURE §4.5 / D13）
      warnings.push({
        code: WARNING_CODES.WEEKLY_LOSS_AGGRESSIVE,
        field: 'weeklyLossKg',
        message: '每周减重建议更温和一些（不超过当前体重的 2%）',
      });
    }
  }

  // 告警（非阻断）：目标体重对应 BMI 偏低
  if (
    isFiniteNumber(input.targetWeightKg) &&
    input.targetWeightKg > 0 &&
    isFiniteNumber(input.heightCm) &&
    input.heightCm > 0
  ) {
    const heightM = input.heightCm / 100;
    const targetBmi = input.targetWeightKg / (heightM * heightM);
    if (targetBmi < TARGET_BMI_LOW_THRESHOLD) {
      warnings.push({
        code: WARNING_CODES.TARGET_BMI_LOW,
        field: 'targetWeightKg',
        message: '目标体重偏轻，建议和营养师聊聊更稳妥的区间',
      });
    }
  }

  return { errors, warnings };
}
