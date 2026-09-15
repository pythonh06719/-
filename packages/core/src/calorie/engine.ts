import { computeCalorieBudget } from './formulas';
import { validateCalorieInput } from './validate';
import type { CalorieInput, SafeCalorieResult } from './types';

/**
 * 联合式安全入口：**不抛错**，返回判别联合（ARCHITECTURE §4.5）。
 * 供前端表单直接消费（UI 好处理）。
 *
 * - 校验通过：`{ ok: true, result }`（告警位于 `result.warnings` 内）
 * - 校验未通过（存在硬错误）：`{ ok: false, errors }`
 *
 * > 说明：本函数与 `calcCalorieBudget`（位于 `formulas.ts`，抛错式）语义不同，
 * > 单独放在 `engine.ts` 以避免 `validate.ts` ↔ `formulas.ts` 循环依赖。
 */
export function safeCalcCalorieBudget(input: CalorieInput): SafeCalorieResult {
  const { errors } = validateCalorieInput(input);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, result: computeCalorieBudget(input) };
}
