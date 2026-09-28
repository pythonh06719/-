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
  TAPER_REMAINING_KG,
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
export {
  ageFromBirthDate,
  diffLocalDateKeys,
  isLocalDateKey,
  normalizeLocalDateKey,
  shiftLocalDateKey,
  toLocalDateKey,
} from './date/daykey';

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
  SUGAR_LEVELS,
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

// AI 每日用量口径（B6：剩余次数 = 上限 − ai_usage 当日合计，唯一真源）
export {
  AI_DAILY_LIMIT,
  deriveAiUsage,
  type AiUsageInput,
  type AiUsageSummary,
} from './ai/quota';

// 「我的常点」档位记忆（C2）：与常吃榜同一套「天数」频次口径，只记忆、不推荐、不评判
export {
  TOOL_MEMORY_LIMITS,
  TOOL_MEMORY_MIN_DAYS,
  TOOL_MEMORY_VERSION,
  emptyToolChoiceMemory,
  pickRememberedChoice,
  recordToolChoice,
  toolChoiceKey,
  type PickRememberedChoiceInput,
  type RecordToolChoiceInput,
  type ToolChoiceEntry,
  type ToolChoiceMemory,
  type ToolMemoryId,
} from './tools/memory';

// 数据主权序列化（§9 / K11）
export {
  CSV_BOM,
  escapeCsvField,
  parseWeightCsv,
  serializeCsv,
  withBom,
  type ParsedWeightCsv,
} from './export/serialize';

// 目标达成预测曲线（R2.6）
export {
  buildGoalForecast,
  type GoalForecastInput,
  type GoalForecastPoint,
} from './weight/forecast';

// 目标达成进度 + 维持模式（R2.7）
export {
  buildGoalProgress,
  type GoalProgress,
  type GoalProgressInput,
} from './weight/progress';

// 平台期判定（R2.7）
export {
  PLATEAU_MIN_POINTS,
  PLATEAU_STALE_DAYS,
  PLATEAU_THRESHOLD_KG,
  PLATEAU_WINDOW_DAYS,
  SLOPE_WINDOW_DAYS,
  detectWeightPlateau,
  type PlateauInput,
  type PlateauPoint,
  type PlateauResult,
} from './weight/plateau';

// ---------------------------------------------------------------------------
// 四期补完（R3.8 / R11.5）
// ---------------------------------------------------------------------------

// 食物身份归一（R11.5 / R11.7 共用唯一口径，K16）
export {
  DISTINCT_FOOD_LIMIT,
  displayFoodName,
  distinctFoodKeys,
  foodIdentity,
  normalizeFoodName,
  type DistinctFoodsOptions,
  type DistinctFoodsResult,
  type FoodRefRow,
} from './food/identity';

// 常吃榜排名（R11.5，出现天数口径）
export {
  FREQUENT_FOOD_DEFAULTS,
  rankFrequentFoods,
  type FrequentFood,
  type FrequentFoodRow,
  type RankFrequentFoodsOptions,
} from './food/frequency';

// 食物分类唯一口径（「食物库数据质量」T1：off.client / 种子脚本 / 校验共用）
export {
  CFCD_CATEGORY_BY_PATH,
  DEFAULT_FOOD_CATEGORY,
  FOOD_CATEGORIES,
  FOOD_CATEGORY_BY_NAME,
  FOOD_CATEGORY_BY_RAW,
  FOOD_CATEGORY_LABELS,
  classifyCategoryByKeywords,
  foodCategoryLabel,
  isFoodCategory,
  mapFoodCategory,
  resolveCfcdCategory,
  type FoodCategory,
} from './food/category';

// 食物名归一化与「区分词」提取（跨源去重 + 搜索区分，单一真源）
// `foodQualifiers`=去重口径（品牌保留）；`foodDisplayQualifiers`=展示口径（再滤品牌/营养声称/产地）
export {
  foodDedupKey,
  foodDisplayQualifiers,
  foodQualifiers,
  isDisplayNoiseQualifier,
  isMeaninglessQualifier,
} from './food/name';

// 食物搜索排序（相关度优先：前缀 > 子串 > 仅别名；绝不按营养排序，单一真源）
// `findSameNameFood` = 快速加卡「同名温和提示」的判定（C1），只做同名/去空白后同名
export {
  FOOD_SEARCH_DEFAULT_PAGE_SIZE,
  ORDER_RANK,
  findSameNameFood,
  foodNameMatchKey,
  foodQualifierLabel,
  matchFoodRank,
  pageFoodSearch,
  rankFoodSearch,
  type FoodMatchRank,
  type FoodNameCandidate,
  type FoodSearchCandidate,
  type FoodSearchRanked,
} from './food/search';

// 餐次排序 / 跨餐移动（R3.8）
export {
  applyReorder,
  type ApplyReorderOptions,
  type ReorderItem,
  type ReorderUpdate,
} from './meal/reorder';

// 份量换算与营养重算（B3：新建 / 改份量**同一口径**，NFR-11）
export {
  DEFAULT_MEAL_GRAMS,
  resolveMealAmount,
  scaleFoodNutrients,
  type FoodNutrientSource,
  type FoodPortionSource,
  type ResolvedMealAmount,
  type ScaledNutrients,
} from './meal/portion';

// ---------------------------------------------------------------------------
// 四期全新项（R11.3 / R11.4 / R11.7）
// ---------------------------------------------------------------------------

// 阶段回顾聚合（R11.3）：SQL 下推事实 → 白名单 6 类指标（K15 / AC-11.3.2）
export {
  PERIOD_DAY_OPTIONS,
  PERIOD_TOP_HABITS,
  resolvePeriodWindow,
  summarizePeriod,
  type PeriodDaysOption,
  type PeriodFacts,
  type PeriodSummary,
} from './report/period';

// 周报窗口（B2 可回看历史周）：边界 / 翻周 / 「几周前」/ 空周判定（口径唯一实现）
export {
  WEEK_WINDOW_DAYS,
  canShiftWeekForward,
  hasAnyWeeklyRecord,
  resolveWeekWindow,
  shiftWeekEndDate,
  weeksBeforeToday,
  type WeekWindow,
  type WeeklyRecordFacts,
} from './report/week';

// 「体重之外的变化」文本清洗（R11.4）：前端拦截与服务端校验同源（AC-11.4.2 / 11.4.9）
export {
  WIN_TEXT_MAX_LENGTH,
  checkWinText,
  normalizeWinText,
  winTextLength,
  type WinTextCheck,
} from './win/text';

// 导出 payload 兼容读取与恢复校验（R11.4 / R10.2）：v1 数据读 `wins` 不报错，恢复先纯函数解析
export {
  EXPORT_SCHEMA_VERSION_MIN_WINS,
  MAX_EXPORT_PAYLOAD_BYTES,
  MAX_EXPORT_ROWS_PER_ENTITY,
  parseExportPayload,
  readExportWins,
  summarizeExportPayload,
  type ExportPayloadParseErrorCode,
  type ExportPayloadSummary,
  type ExportWinRowLike,
  type ParsedExportPayload,
  type ParseExportPayloadResult,
} from './export/payload';
