/**
 * `@qsh/core` 统一导出面（ARCHITECTURE §2 / §4）。
 *
 * 本包为**零 IO、零运行时依赖**的纯函数包，是热量引擎的前后端唯一真源。
 * 任何一侧都不得复制公式；公式改动必须同时通过 `packages/core/test` 门禁。
 */

// 类型契约
export type {
  ActivityLevel,
  CalorieInput,
  CalorieResult,
  Gender,
  MacroRatio,
  MacroResult,
  SafeCalorieResult,
  SafetyFlags,
  ValidationError,
  ValidationReport,
  ValidationWarning,
} from './calorie/types';

// 常量
export {
  ACTIVITY_FACTORS,
  AGE_MAX,
  AGE_MIN,
  DEFAULT_MACRO_RATIO,
  DEFICIT_CAP_RATIO,
  HEIGHT_MAX,
  HEIGHT_MIN,
  KCAL_PER_G_CARB,
  KCAL_PER_G_FAT,
  KCAL_PER_G_PROTEIN,
  KCAL_PER_KG_FAT,
  SAFETY_FLOOR,
  TARGET_BMI_LOW_THRESHOLD,
  TARGET_WEEKS_MAX,
  TARGET_WEEKS_MIN,
  WARNING_CODES,
  WEEKLY_LOSS_MAX_RATIO,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type WarningCode,
} from './calorie/constants';

// 取整工具
export { round1, round2 } from './calorie/rounding';

// 公式（含抛错式入口 calcCalorieBudget）
export {
  calcBMR,
  calcCalorieBudget,
  calcETaWeeks,
  computeCalorieBudget,
  calcTDEE,
  deriveWeeklyLossKg,
  type BmrInput,
} from './calorie/formulas';

// 校验（含错误类）
export { CalorieInputError, validateCalorieInput } from './calorie/validate';

// 安全入口（联合式，不抛错）
export { safeCalcCalorieBudget } from './calorie/engine';

// 宏量营养素
export { calcMacros } from './calorie/macros';

// 安全提示文案
export { buildSafetyMessages } from './calorie/messages';

// 单位换算
export { gToKg, kcalToKj, kgToG, KJ_PER_KCAL, kjToKcal, lToMl, mlToL } from './units/convert';

// 本地日期工具
export { ageFromBirthDate, isLocalDateKey, toLocalDateKey } from './date/daykey';

// ---------------------------------------------------------------------------
// 二期模块（T05）
// ---------------------------------------------------------------------------

// 运动与 MET（R6.1 / R6.2）
export {
  MET_ACTIVITY_LIBRARY,
  calcExerciseKcal,
  exerciseMinutesForKcal,
  findMetActivity,
  type MetActivity,
} from './exercise/met';

// 生活化工具（R5.1~R5.4）
export {
  DRINK_LIBRARY,
  FEAST_LIBRARY,
  TAKEOUT_LIBRARY,
  estimateDrink,
  estimateFeast,
  estimateTakeout,
  snackRedemption,
  type DrinkEstimate,
  type DrinkItem,
  type FeastEstimate,
  type KcalRange,
  type SnackRedemption,
  type SugarLevel,
  type TakeoutItem,
} from './tools/estimates';

// 数据主权序列化（§9 / K11）
export {
  CSV_BOM,
  escapeCsvField,
  parseWeightCsv,
  serializeCsv,
  withBom,
  type ParsedWeightCsv,
} from './export/serialize';
