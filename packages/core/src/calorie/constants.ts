import type { ActivityLevel, Gender, MacroRatio } from './types';

/**
 * 活动系数表（PRD R2.2 / ARCHITECTURE §4.2）。
 * TDEE = BMR × activityFactor。
 */
export const ACTIVITY_FACTORS: Readonly<Record<ActivityLevel, number>> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  high: 1.725,
  athlete: 1.9,
};

/**
 * 安全下限（kcal，PRD R2.5）：女性 1200 / 男性 1500。
 * 建议摄入 final = max(rawIntake, floor)，**下限优先级高于缺口上限**。
 */
export const SAFETY_FLOOR: Readonly<Record<Gender, number>> = {
  female: 1200,
  male: 1500,
};

/** 每公斤脂肪对应的热量（kcal）。 */
export const KCAL_PER_KG_FAT = 7700;

/** 每日缺口上限比例（TDEE × 30%，PRD R2.4）。 */
export const DEFICIT_CAP_RATIO = 0.3;

/**
 * taper 触发阈值（kg，PRD R2.7）：**剩余需减重量**低于此值时，缺口按剩余量线性收窄。
 *
 * 为什么要有 taper：最后几公斤若仍维持大缺口，一旦达标骤然恢复饮食极易反弹 ——
 * 这正是需求里「防反弹」的用意。在阈值内把速度线性降到 0，给身体一个过渡。
 *
 * 为什么取 2kg：约相当于温和节奏下的 2~4 周量，足够平缓又不至于拖太久；
 * 而且此时体重的日常波动（±0.5~1.5kg）已与目标差同量级，再维持大缺口没有意义。
 *
 * 注意：**已达成（remaining <= 0）不属于 taper**，那时由维持模式（R11.2）接管 ——
 * 缺口归零、摄入回到 TDEE。
 */
export const TAPER_REMAINING_KG = 2;

/** 默认宏量营养素比例（蛋白 25% / 脂肪 25% / 碳水 50%，PRD R2.8）。 */
export const DEFAULT_MACRO_RATIO: MacroRatio = { protein: 25, fat: 25, carb: 50 };

/** 宏量营养素能量密度（kcal/g）：蛋白 4 / 脂肪 9 / 碳水 4。 */
export const KCAL_PER_G_PROTEIN = 4;
export const KCAL_PER_G_FAT = 9;
export const KCAL_PER_G_CARB = 4;

/** 年龄边界（周岁，整数）。 */
export const AGE_MIN = 14;
export const AGE_MAX = 100;

/** 身高边界（cm）。 */
export const HEIGHT_MIN = 80;
export const HEIGHT_MAX = 250;

/** 体重边界（kg）。 */
export const WEIGHT_MIN = 20;
export const WEIGHT_MAX = 400;

/** 目标期限边界（整数周）。 */
export const TARGET_WEEKS_MIN = 1;
export const TARGET_WEEKS_MAX = 260;

/**
 * 每周减重的温和上限比例（体重 × 2%）。
 *
 * 超过该比例时**不截断、不阻断计算**，仅产出非阻断告警 `W_WEEKLY_LOSS_AGGRESSIVE`
 * （ARCHITECTURE §4.5 / D13）。真正的缺口防线是 `min(rawDeficit, TDEE × 30%)`。
 */
export const WEEKLY_LOSS_MAX_RATIO = 0.02;

/**
 * 目标体重对应的健康 BMI 下限（WHO 标准）。
 * 目标体重对应 BMI 低于该值时产出非阻断告警 `W_TARGET_BMI_LOW`（ARCHITECTURE §4.5）。
 */
export const TARGET_BMI_LOW_THRESHOLD = 18.5;

/**
 * 非阻断告警码（前缀 `W_`，ARCHITECTURE §4.5 / §7 K3）。
 * 仅供 `warnings` 通道使用，**绝不抛错、绝不阻断计算**。
 */
export const WARNING_CODES = {
  /** 每周减重超过体重 2%（输入侧告警） */
  WEEKLY_LOSS_AGGRESSIVE: 'W_WEEKLY_LOSS_AGGRESSIVE',
  /** 目标体重对应 BMI 偏低（输入侧告警） */
  TARGET_BMI_LOW: 'W_TARGET_BMI_LOW',
  /** 已触发安全下限（结果侧告警） */
  FLOOR_APPLIED: 'W_FLOOR_APPLIED',
} as const;

/** 告警码取值联合类型。 */
export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];
