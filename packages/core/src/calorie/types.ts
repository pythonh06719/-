/**
 * 热量引擎对外契约类型（严格对齐 PRD §5.1 / §5.3 与 ARCHITECTURE §4.1 类图）。
 */

/** 性别：用于 BMR 公式与安全下限。 */
export type Gender = 'male' | 'female';

/** 活动量档位：对应系数 1.2 / 1.375 / 1.55 / 1.725 / 1.9。 */
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'high' | 'athlete';

/** 宏量营养素比例（百分比，三者之和须等于 100）。 */
export interface MacroRatio {
  /** 蛋白质占比（%） */
  protein: number;
  /** 脂肪占比（%） */
  fat: number;
  /** 碳水化合物占比（%） */
  carb: number;
}

/** 热量引擎输入契约。 */
export interface CalorieInput {
  /** 性别 */
  gender: Gender;
  /** 周岁（14–100） */
  age: number;
  /** 身高（cm，80–250） */
  heightCm: number;
  /** 当前体重（kg，20–400） */
  weightKg: number;
  /** 目标体重（kg，> 0 且 ≤ weightKg） */
  targetWeightKg: number;
  /** 目标期限（整数周，1–260） */
  targetWeeks: number;
  /** 活动量档位 */
  activityLevel: ActivityLevel;
  /** 宏量营养素比例（缺省 {25,25,50}） */
  macroRatio?: MacroRatio;
  /** 每周目标减重（kg）；缺省则由 weightKg / targetWeightKg / targetWeeks 推导 */
  weeklyLossKg?: number;
}

/** 宏量营养素克数结果。 */
export interface MacroResult {
  /** 蛋白质（g，1 位小数） */
  proteinG: number;
  /** 脂肪（g，1 位小数） */
  fatG: number;
  /** 碳水化合物（g，1 位小数） */
  carbG: number;
}

/** 热量引擎输出契约（取整策略见 ARCHITECTURE §4.4）。 */
export interface CalorieResult {
  /** 基础代谢率（整数 kcal） */
  bmr: number;
  /** 每日总消耗（整数 kcal） */
  tdee: number;
  /** 未截断的原始缺口（1 位小数 kcal） */
  targetDeficitRaw: number;
  /** TDEE × 30% 缺口上限（1 位小数 kcal） */
  deficitCap: number;
  /** 实际采用的缺口（1 位小数 kcal） */
  effectiveDeficit: number;
  /** 是否触发 30% 缺口上限截断 */
  isDeficitCapped: boolean;
  /** 最终建议摄入（整数 kcal） */
  intakeRecommended: number;
  /** 是否触发安全下限 */
  floorApplied: boolean;
  /** 安全下限（1200 / 1500 kcal） */
  safetyFloor: number;
  /** 面向用户的安全提示（鼓励式中文，禁止负罪感文案） */
  safetyMessages: string[];
  /**
   * 非阻断告警（输入侧 + 结果侧，按发生顺序拼接，ARCHITECTURE §4.5）。
   * 为结构化通道（含 `code`），仅供 API / UI 决策、埋点与去重；不参与也不影响运算。
   */
  warnings: ValidationWarning[];
  /** 宏量营养素克数目标 */
  macros: MacroResult;
  /** 按最终摄入反推的每周实际减重（2 位小数 kg） */
  weeklyLossEffectiveKg: number;
  /**
   * 是否触发 taper（PRD R2.7）：剩余需减重量已进入收尾区间，目标减重速度按剩余量
   * **线性收窄**，避免最后几公斤还维持大缺口（达标后骤然恢复饮食极易反弹）。
   * 收窄系数 = 剩余量 ÷ `TAPER_REMAINING_KG`；**已达成时为 false**（那时由维持模式接管）。
   */
  taperApplied: boolean;
  /** 按有效缺口预测达成目标所需周数（2 位小数，无法预测时为 null） */
  etaWeeks: number | null;
}

/** 校验错误条目。 */
export interface ValidationError {
  /** 错误码（如 E_AGE） */
  code: string;
  /** 出错字段 */
  field: string;
  /** 中文提示（鼓励式） */
  message: string;
}

/**
 * 校验告警条目（**非阻断**，ARCHITECTURE §4.5 / §7 K3）。
 *
 * 「可计算但不理想」的输入 / 结果才产出告警；告警 **绝不阻断计算、绝不抛错**。
 */
export interface ValidationWarning {
  /** 告警码（前缀 `W_`，如 `W_WEEKLY_LOSS_AGGRESSIVE`） */
  code: string;
  /** 输入侧告警指向字段；结果侧告警可省略 */
  field?: keyof CalorieInput;
  /** 鼓励式、无负罪感的中文提示（PRD §7） */
  message: string;
}

/**
 * `validateCalorieInput` 的两级校验报告（ARCHITECTURE §4.5）。
 *
 * - `errors`：硬错误（**阻断**，`calcCalorieBudget` 抛 `CalorieInputError`）
 * - `warnings`：告警（**不阻断**，照常计算）
 */
export interface ValidationReport {
  /** 硬错误（阻断） */
  errors: ValidationError[];
  /** 告警（不阻断） */
  warnings: ValidationWarning[];
}

/** `safeCalcCalorieBudget` 的判别联合返回类型。 */
export type SafeCalorieResult =
  | { ok: true; result: CalorieResult }
  | { ok: false; errors: ValidationError[] };

/** 安全提示开关，供 `buildSafetyMessages` 消费。 */
export interface SafetyFlags {
  /** 是否触发安全下限 */
  floorApplied: boolean;
  /** 是否触发 30% 缺口上限 */
  isDeficitCapped: boolean;
}
