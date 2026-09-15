import {
  ACTIVITY_FACTORS,
  DEFAULT_MACRO_RATIO,
  DEFICIT_CAP_RATIO,
  KCAL_PER_KG_FAT,
  SAFETY_FLOOR,
  WARNING_CODES,
} from './constants';
import { calcMacros } from './macros';
import { buildSafetyMessages } from './messages';
import { round1, round2 } from './rounding';
import { CalorieInputError, validateCalorieInput } from './validate';
import type { ActivityLevel, CalorieInput, CalorieResult, ValidationWarning } from './types';

/** BMR 公式所需的输入子集。 */
export type BmrInput = Pick<CalorieInput, 'gender' | 'weightKg' | 'heightCm' | 'age'>;

/**
 * 计算基础代谢率（Mifflin-St Jeor，PRD R2.1 / §5.2）。
 *
 * - 男：`10 × weightKg + 6.25 × heightCm − 5 × age + 5`
 * - 女：`10 × weightKg + 6.25 × heightCm − 5 × age − 161`
 *
 * 返回浮点值（不取整），取整由输出层负责。
 */
export function calcBMR(input: BmrInput): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  return input.gender === 'male' ? base + 5 : base - 161;
}

/**
 * 计算每日总消耗 TDEE = BMR × 活动系数（PRD R2.2）。
 *
 * @param bmr 基础代谢率（浮点）
 * @param level 活动量档位
 */
export function calcTDEE(bmr: number, level: ActivityLevel): number {
  return bmr * ACTIVITY_FACTORS[level];
}

/**
 * 未显式提供 `weeklyLossKg` 时，按 `(weightKg − targetWeightKg) ÷ targetWeeks` 推导（PRD Q5）。
 */
export function deriveWeeklyLossKg(weightKg: number, targetWeightKg: number, targetWeeks: number): number {
  return (weightKg - targetWeightKg) / targetWeeks;
}

/**
 * 按有效缺口预测达成目标所需周数（ARCHITECTURE §4.2 步骤 13）。
 *
 * 无法预测时返回 `null`（有效缺口 ≤ 0，或按最终摄入反推的实际周减重 ≤ 0）。
 */
export function calcETaWeeks(
  input: Pick<CalorieInput, 'weightKg' | 'targetWeightKg'>,
  effectiveDeficit: number,
  weeklyLossEffectiveKg: number,
): number | null {
  if (effectiveDeficit <= 0 || weeklyLossEffectiveKg <= 0) {
    return null;
  }
  return (input.weightKg - input.targetWeightKg) / weeklyLossEffectiveKg;
}

/**
 * 纯计算核心：**假定输入已通过校验**，按 ARCHITECTURE §4.2 的运算顺序逐步计算。
 *
 * 运算顺序（**不得调换**）：
 * ```
 * 1) bmrFloat  = Mifflin-St Jeor
 * 2) tdeeFloat = bmrFloat × activityFactor
 * 3) weeklyLoss = weeklyLossKg ?? (weightKg − targetWeightKg) ÷ targetWeeks
 * 4) rawDeficit = weeklyLoss × 7700 ÷ 7
 * 5) cap        = tdeeFloat × 0.30
 * 6) effectiveDeficit = MIN(rawDeficit, cap)          // 先截断
 * 7) rawIntake        = tdeeFloat − effectiveDeficit
 * 8) floor            = male ? 1500 : 1200
 * 9) intakeFinal      = MAX(rawIntake, floor)         // 后钳下限（优先级更高）
 * 10) isDeficitCapped = rawDeficit > cap；floorApplied = rawIntake < floor  // 可同时为 true
 * 11) macros / weeklyLossEffective / etaWeeks
 * ```
 *
 * **告警（`warnings`）是纯旁路输出**：输入侧告警来自 `validateCalorieInput`，
 * 结果侧告警在计算完成后追加 —— 不参与、不影响上述 1→13 步运算顺序（ARCHITECTURE §4.5）。
 */
export function computeCalorieBudget(input: CalorieInput): CalorieResult {
  // 0) 输入侧告警基线（纯旁路；不参与下方 1→13 步运算）
  const { warnings: inputWarnings } = validateCalorieInput(input);

  // 1) 基础代谢
  const bmrFloat = calcBMR(input);

  // 2) 每日总消耗
  const tdeeFloat = calcTDEE(bmrFloat, input.activityLevel);

  // 3) 每周目标减重（显式优先，否则由体重差 / 周数推导）
  const weeklyLoss =
    input.weeklyLossKg ?? deriveWeeklyLossKg(input.weightKg, input.targetWeightKg, input.targetWeeks);

  // 4) 原始每日缺口
  const rawDeficit = (weeklyLoss * KCAL_PER_KG_FAT) / 7;

  // 5) 缺口上限（TDEE 的 30%）
  const cap = tdeeFloat * DEFICIT_CAP_RATIO;

  // 6) 先截断：有效缺口
  const effectiveDeficit = Math.min(rawDeficit, cap);

  // 7) 原始建议摄入
  const rawIntake = tdeeFloat - effectiveDeficit;

  // 8) 安全下限
  const floor = SAFETY_FLOOR[input.gender];

  // 9) 后钳下限（下限优先级高于上限）
  const intakeFinal = Math.max(rawIntake, floor);

  // 10) 两个标志位（可同时为 true）
  const isDeficitCapped = rawDeficit > cap;
  const floorApplied = rawIntake < floor;

  // 11) 宏量营养素（默认 25/25/50）
  const macroRatio = input.macroRatio ?? DEFAULT_MACRO_RATIO;
  const macros = calcMacros(intakeFinal, macroRatio);

  // 12) 按最终摄入反推的每周实际减重
  const weeklyLossEffectiveKg = ((tdeeFloat - intakeFinal) * 7) / KCAL_PER_KG_FAT;

  // 13) 预计达成周数
  const etaWeeksRaw = calcETaWeeks(input, effectiveDeficit, weeklyLossEffectiveKg);

  // 告警（旁路）：输入侧告警 + 结果侧告警，按发生顺序拼接
  const warnings: ValidationWarning[] = [...inputWarnings];
  if (floorApplied) {
    warnings.push({
      code: WARNING_CODES.FLOOR_APPLIED,
      message: '这已接近安全下限，建议把目标调得更温和一些',
    });
  }

  return {
    bmr: Math.round(bmrFloat),
    tdee: Math.round(tdeeFloat),
    targetDeficitRaw: round1(rawDeficit),
    deficitCap: round1(cap),
    effectiveDeficit: round1(effectiveDeficit),
    isDeficitCapped,
    intakeRecommended: Math.round(intakeFinal),
    floorApplied,
    safetyFloor: floor,
    safetyMessages: buildSafetyMessages({ floorApplied, isDeficitCapped }),
    warnings,
    macros,
    weeklyLossEffectiveKg: round2(weeklyLossEffectiveKg),
    etaWeeks: etaWeeksRaw === null ? null : round2(etaWeeksRaw),
  };
}

/**
 * 抛错式计算入口：先校验，**仅当硬错误 `errors` 非空时** `throw CalorieInputError`。
 * 告警（`warnings`）不阻断，随结果返回（ARCHITECTURE §4.5）。
 * 供服务端（唯一可信来源）与单测使用，尽早暴露契约破坏。
 */
export function calcCalorieBudget(input: CalorieInput): CalorieResult {
  const { errors } = validateCalorieInput(input);
  if (errors.length > 0) {
    throw new CalorieInputError(errors);
  }
  return computeCalorieBudget(input);
}
