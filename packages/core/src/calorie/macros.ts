import { KCAL_PER_G_CARB, KCAL_PER_G_FAT, KCAL_PER_G_PROTEIN } from './constants';
import { round1 } from './rounding';
import type { MacroRatio, MacroResult } from './types';

/**
 * 计算宏量营养素克数目标（PRD §5.2 / R2.8）。
 *
 * - 蛋白克数 = 摄入 × protein% ÷ 4（4 kcal/g）
 * - 脂肪克数 = 摄入 × fat% ÷ 9（9 kcal/g）
 * - 碳水克数 = 摄入 × carb% ÷ 4（4 kcal/g）
 *
 * 克数四舍五入到 1 位小数；比较时容差 ±0.5g（ARCHITECTURE D12）。
 *
 * @param intakeKcal 建议摄入（kcal），通常为 final intake
 * @param ratio 蛋白 / 脂肪 / 碳水百分比（三者之和须为 100，由调用方保证）
 */
export function calcMacros(intakeKcal: number, ratio: MacroRatio): MacroResult {
  return {
    proteinG: round1((intakeKcal * (ratio.protein / 100)) / KCAL_PER_G_PROTEIN),
    fatG: round1((intakeKcal * (ratio.fat / 100)) / KCAL_PER_G_FAT),
    carbG: round1((intakeKcal * (ratio.carb / 100)) / KCAL_PER_G_CARB),
  };
}
