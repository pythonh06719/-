/**
 * 目标达成进度（R2.7）—— **纯函数、唯一真源**。
 *
 * 回答体重页的两个问题：「走到哪儿了」和「还要多久」，并在**已达成目标**时
 * 自动切换为**维持模式**（不再制造缺口，摄入 = TDEE），避免出现「目标已达成
 * 却还显示一个 0 周 / 空档」的尴尬状态。
 *
 * ⚠️ 语气约束（PRD §7）：本模块**只产出中性事实**，不含任何面向用户的措辞；
 * 文案一律由 `apps/web/src/lib/copy.ts` 负责，便于统一审校。
 *
 * 设计约束：
 * - 零 IO、零运行时依赖（`@qsh/core` 铁律）；不读取 `Date.now()`（K8）；
 * - 输入无法构成有意义的进度时返回 `null`，调用方据此**隐藏整张卡片**
 *   （不显示 0% 的空档、不显示「还需 0 周」）；
 * - 达成比一律钳制到 `[0, 1]`：增重不会变成负进度，超额达成不会变成 >100%。
 */

import { round2 } from '../calorie/rounding';

/** `buildGoalProgress` 的输入。 */
export interface GoalProgressInput {
  /**
   * 进度基准体重 kg —— **设定目标时**的体重。
   *
   * ⚠️ 不要用 `user_goals.start_weight_kg` 充当基准：该字段会被
   * 「记录最新一天体重 → 同步起始体重」逻辑持续改写为**当前体重**，
   * 直接相减会恒等于 0（进度永远是 0%）。基准应取目标历史里最早的一条。
   */
  baselineKg: number;
  /** 目标体重 kg */
  targetWeightKg: number;
  /** 最新体重 kg（尚未记录过体重时为 `null`） */
  latestKg: number | null;
  /** 引擎 `CalorieResult.etaWeeks`：按当前节奏预计还需周数；无法预测时 `null` */
  etaWeeks: number | null;
  /** 引擎 `CalorieResult.tdee`：维持模式下的建议摄入（每日总消耗，不制造缺口） */
  maintenanceKcal: number | null;
}

/** 目标达成进度（前端据此渲染进度环与文案）。 */
export interface GoalProgress {
  /** 进度基准体重 kg（设定目标时的体重） */
  baselineKg: number;
  /** 目标体重 kg */
  targetWeightKg: number;
  /** 最新体重 kg（无记录时 `null`） */
  latestKg: number | null;
  /** 达成比（0~1，钳制） */
  progressRatio: number;
  /** 已达成目标（最新体重 ≤ 目标体重） */
  reached: boolean;
  /** 距目标还差 kg（已达成时为 0；无记录时 `null`） */
  remainingKg: number | null;
  /** 按当前节奏还需周数（维持模式 / 无法预测时为 `null`） */
  etaWeeks: number | null;
  /** 维持模式：已达成目标，**不再制造缺口** */
  maintenance: boolean;
  /** 维持热量 kcal/日（= TDEE）；非维持模式为 `null` */
  maintenanceKcal: number | null;
}

/** 把 `number | null` 归一为「有限数或 null」（`NaN` / `±Infinity` 视为缺失）。 */
function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 计算目标达成进度（R2.7）。
 *
 * 达成比 = `(基准 − 最新) ÷ (基准 − 目标)`，钳制到 `[0, 1]`。
 * 基准 ≤ 目标（本身不是减重目标）时：没高于目标即视为已走到终点（1），否则为 0。
 *
 * 返回 `null` 的情形（调用方应隐藏卡片，而非渲染 0%）：
 * - `baselineKg` / `targetWeightKg` 非有限，或 ≤ 0；
 *
 * @param input 见 {@link GoalProgressInput}
 * @returns 进度对象；无法构成有意义的进度时为 `null`
 */
export function buildGoalProgress(input: GoalProgressInput): GoalProgress | null {
  const { baselineKg, targetWeightKg } = input;
  if (!Number.isFinite(baselineKg) || !Number.isFinite(targetWeightKg)) {
    return null;
  }
  if (baselineKg <= 0 || targetWeightKg <= 0) {
    return null;
  }

  const latestKg = finiteOrNull(input.latestKg);
  const reached = latestKg !== null && latestKg <= targetWeightKg;
  const remainingKg =
    latestKg === null ? null : round2(Math.max(0, latestKg - targetWeightKg));

  const totalDrop = baselineKg - targetWeightKg;
  let progressRatio = 0;
  if (latestKg !== null) {
    if (totalDrop <= 0) {
      // 基准本就不高于目标（不是减重目标）：只要没高于目标，就算走到终点
      progressRatio = reached ? 1 : 0;
    } else {
      progressRatio = Math.min(Math.max((baselineKg - latestKg) / totalDrop, 0), 1);
    }
  }

  const etaWeeks = finiteOrNull(input.etaWeeks);
  const maintenanceKcal = finiteOrNull(input.maintenanceKcal);

  return {
    baselineKg,
    targetWeightKg,
    latestKg,
    progressRatio: round2(progressRatio),
    reached,
    remainingKg,
    // 维持模式下**不再给出「还需几周」**（引擎此时 etaWeeks 本就是 null，这里二次兜底）
    etaWeeks: reached || etaWeeks === null || etaWeeks <= 0 ? null : round2(etaWeeks),
    maintenance: reached,
    maintenanceKcal: reached && maintenanceKcal !== null ? Math.round(maintenanceKcal) : null,
  };
}
