import { Injectable } from '@nestjs/common';

import {
  CalorieInputError,
  calcCalorieBudget,
  ageFromBirthDate,
  deriveWeeklyLossKg,
} from '@qsh/core';
import type { ActivityLevel, CalorieInput, CalorieResult, Gender, MacroRatio } from '@qsh/core';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';

/** 计算预算所需的资料子集（来自 `user_profiles`）。 */
export interface BudgetProfileInput {
  gender: Gender;
  birthDate: string;
  heightCm: number;
  activityLevel: ActivityLevel;
}

/** 计算预算所需的目标子集（来自 `user_goals`）。 */
export interface BudgetGoalInput {
  startWeightKg: number;
  targetWeightKg: number;
  targetWeeks: number;
  weeklyLossKg: number;
  macroRatio: MacroRatio;
}

/**
 * 热量预算服务（**唯一真源 = `@qsh/core`**，ARCHITECTURE §1.6 / §7 K8）。
 *
 * ⚠️ 本服务**不得重写任何公式**：仅做「组装 `CalorieInput` → 调用引擎 → 异常归一」。
 * 引擎硬错误（`CalorieInputError`）统一转为 400 `E_VALID_CALORIE` + `fields`。
 */
@Injectable()
export class BudgetService {
  /**
   * 调用引擎计算预算；把硬校验错误翻译为统一业务异常（告警不阻断，随结果返回）。
   */
  compute(input: CalorieInput): CalorieResult {
    try {
      return calcCalorieBudget(input);
    } catch (error) {
      if (error instanceof CalorieInputError) {
        const fields: Record<string, string> = {};
        for (const item of error.errors) {
          fields[item.field] = item.message;
        }
        throw new ApiException(
          400,
          ERROR_CODES.VALID_CALORIE,
          '这些信息还差一点点，请检查后重试',
          fields,
        );
      }
      throw error;
    }
  }

  /** 由资料 + 目标组装引擎输入（年龄由 `birthDate` 与注入时间推导，K5/K8）。 */
  buildInput(profile: BudgetProfileInput, goal: BudgetGoalInput, now: Date = new Date()): CalorieInput {
    const age = ageFromBirthDate(profile.birthDate, now);
    const weeklyLossKg = goal.weeklyLossKg > 0 ? goal.weeklyLossKg : undefined;
    return {
      gender: profile.gender,
      age,
      heightCm: profile.heightCm,
      weightKg: goal.startWeightKg,
      targetWeightKg: goal.targetWeightKg,
      targetWeeks: goal.targetWeeks,
      activityLevel: profile.activityLevel,
      macroRatio: goal.macroRatio,
      ...(weeklyLossKg !== undefined ? { weeklyLossKg } : {}),
    };
  }

  /** 由资料 + 目标直接算出预算（TC-12 重算入口）。 */
  computeFromProfileAndGoal(
    profile: BudgetProfileInput,
    goal: BudgetGoalInput,
    now: Date = new Date(),
  ): CalorieResult {
    return this.compute(this.buildInput(profile, goal, now));
  }

  /** 推导每周目标减重（Q5）—— 直接复用引擎公式，不本地实现。 */
  deriveWeeklyLossKg(weightKg: number, targetWeightKg: number, targetWeeks: number): number {
    return deriveWeeklyLossKg(weightKg, targetWeightKg, targetWeeks);
  }
}
