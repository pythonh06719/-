import { PLATEAU_THRESHOLD_KG } from '@qsh/core';
import type { WeightUnit } from '@qsh/shared-types';
import { toDisplayWeight, weightLabel } from '@/lib/units';

/**
 * 体重相关文案的**单位感知（kg / 斤，D-3）**版本。
 *
 * ## 为什么另立模块，而不是改 `lib/copy.ts`
 *
 * `lib/copy.ts` 此刻正被「上次份量记忆（D-1）」**并发编辑**（尚未提交）。
 * 团队约定：本次提交**不得包含 `copy.ts`** —— 否则会把 D-1 未完成的改动一并卷入。
 * 故把「体重这一组**含数值**、且需要按单位换算」的句子集中在本模块：
 * 与 `copy.ts` 零重叠、可独立提交、口径集中便于统一审校。
 *
 * `copy.ts` 里对应的 kg 版句子（`goalRemainingLine` 等）**原样保留**，
 * 待 D-1 落地后再行收敛；本模块是它们在斤模式下的单位感知替代。
 *
 * ## 口径（与 K6 / R2.11 的 `maintenanceLine(kcal, unit)` 同构）
 *
 * - 一切入参都是**内部统一存储的 kg**（kg 是真源，API 与导出恒为 kg）；
 * - 只在**展示**时按当前体重单位换算（1 kg = 2 市斤，换算走 `lib/units`，不重写公式）；
 * - 措辞沿用 `copy.ts` 的原句，仅把「数字 + 单位」替换为当前单位下的**等价**数值，
 *   **不新增任何判断句**（PRD §7 无负罪感）。
 */

/** 当前单位下的 1 位小数文本（非有限值 → `'—'`）。 */
function oneDecimal(kg: number, unit: WeightUnit): string {
  const value = toDisplayWeight(kg, unit);
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

/** 「距离目标还有 X kg / 斤」。 */
export function goalRemainingLine(remainingKg: number, unit: WeightUnit): string {
  return `距离目标还有 ${oneDecimal(remainingKg, unit)} ${weightLabel(unit)}`;
}

/** 「目标 X kg / 斤，按自己的节奏来」。 */
export function goalTargetLine(targetWeightKg: number, unit: WeightUnit): string {
  return `目标 ${oneDecimal(targetWeightKg, unit)} ${weightLabel(unit)}，按自己的节奏来`;
}

/** 「从 X kg / 斤 出发，目标 Y kg / 斤」。 */
export function goalBaselineLine(
  baselineKg: number,
  targetWeightKg: number,
  unit: WeightUnit,
): string {
  return `从 ${oneDecimal(baselineKg, unit)} ${weightLabel(unit)} 出发，目标 ${oneDecimal(targetWeightKg, unit)} ${weightLabel(unit)}`;
}

/** 「最近 X 天，7 日均线的变化不到 0.3 kg / 0.6 斤」。 */
export function plateauStalledLine(stalledDays: number, unit: WeightUnit): string {
  return `最近 ${Math.round(stalledDays)} 天，7 日均线的变化不到 ${oneDecimal(PLATEAU_THRESHOLD_KG, unit)} ${weightLabel(unit)}`;
}

/** 「把时间拉到 4 周看，平均每周 ±X.XX kg / 斤」。 */
export function plateauSlopeLine(kgPerWeek: number, unit: WeightUnit): string {
  const value = toDisplayWeight(kgPerWeek, unit);
  const sign = value > 0 ? '+' : '';
  const text = Number.isFinite(value) ? value.toFixed(2) : '—';
  return `把时间拉到 4 周看，平均每周 ${sign}${text} ${weightLabel(unit)}`;
}

/** ⑥ 下降：「这段时间体重减少了 X kg / 斤」—— 后面**不接任何判断句**（QR-4）。 */
export function periodWeightDownLine(deltaKg: number, unit: WeightUnit): string {
  const value = Math.abs(Number.isFinite(deltaKg) ? toDisplayWeight(deltaKg, unit) : 0);
  return `这段时间体重减少了 ${value} ${weightLabel(unit)}`;
}

/** ⑥ 上涨：「这段时间体重增加了 X kg / 斤」—— 同样只是陈述，不评价。 */
export function periodWeightUpLine(deltaKg: number, unit: WeightUnit): string {
  const value = Math.abs(Number.isFinite(deltaKg) ? toDisplayWeight(deltaKg, unit) : 0);
  return `这段时间体重增加了 ${value} ${weightLabel(unit)}`;
}

/* ---------------------------------------------------------------------------
 * 目标编辑卡（`/profile`）里需要随单位变化的**字段标签**。
 *
 * `copy.ts` 的 `goalCurrentWeightLabel` / `goalTargetWeightLabel` 把 `（kg）`
 * 写死在标签里，切到斤后标签与输入值不一致会误导。故在此提供单位感知版本。
 * ------------------------------------------------------------------------- */

/** 「当前体重（kg / 斤）」。 */
export function goalCurrentWeightLabel(unit: WeightUnit): string {
  return `当前体重（${weightLabel(unit)}）`;
}

/** 「目标体重（kg / 斤）」。 */
export function goalTargetWeightLabel(unit: WeightUnit): string {
  return `目标体重（${weightLabel(unit)}）`;
}

/** 「体重（kg / 斤）」—— 体重记录输入框标签。 */
export function weightInputLabel(unit: WeightUnit): string {
  return `体重（${weightLabel(unit)}）`;
}
