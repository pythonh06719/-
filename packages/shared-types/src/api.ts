/**
 * API 契约（api）—— 前后端共享的请求 DTO 与响应类型。
 *
 * 统一响应包装见 ARCHITECTURE §7 K2：
 *   成功 `{ data, error: null }`；失败 `{ data: null, error: { code, message, fields? } }`
 * 错误码规范见 §7 K3：`E_` 前缀 = 阻断性错误；`W_` 前缀 = 非阻断告警（仅出现在
 * `CalorieResult.warnings`，绝不出现在 `ApiError.code`）。
 */

import type {
  ActivityLevel,
  CalorieResult,
  Gender,
  GoalForecastPoint,
  GoalProgress,
  MacroRatio,
  ValidationError,
  ValidationWarning,
} from '@qsh/core';

import type {
  FoodItem,
  MealCombo,
  MealComboItem,
  MealLog,
  MealLogSource,
  MealType,
  ServingUnit,
  User,
  UserGoal,
  UserProfile,
  UserSettings,
  VerificationPurpose,
  WeightLog,
  WeightLogSource,
} from './entities';

// ---------------------------------------------------------------------------
// 统一响应包装（ARCHITECTURE §7 K2）
// ---------------------------------------------------------------------------

/** 统一错误对象。 */
export interface ApiError {
  /** 错误码（`E_` 前缀，见 §7 K3） */
  code: string;
  /** 面向用户的中文提示（鼓励式，§7 K4） */
  message: string;
  /** 字段级错误明细（可选，`字段名 -> 提示`） */
  fields?: Record<string, string>;
}

/**
 * 统一响应包装（判别联合）。
 * - 成功：`{ data: T; error: null }`
 * - 失败：`{ data: null; error: ApiError }`
 */
export type ApiResponse<T> =
  | { data: T; error: null }
  | { data: null; error: ApiError };

/** 分页响应（列表类接口通用）。 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// 鉴权（auth）：邮箱 + 验证码（R1.1/R1.6/R1.7）
// ---------------------------------------------------------------------------

/** `POST /api/auth/send-code` 请求。 */
export interface SendCodeRequest {
  email: string;
  /** 用途，缺省 `login` */
  purpose?: VerificationPurpose;
}

/** `POST /api/auth/send-code` 响应（默认不返回验证码本身，仅返回有效期）。 */
export interface SendCodeResponse {
  email: string;
  /** 验证码剩余有效秒数（默认 300s） */
  expiresInSeconds: number;
  /**
   * 真实验证码：**仅自用 / 开发模式**回显（服务端 `AUTH_LOG_CODE=true`）。
   *
   * ⚠️ 安全边界：该开关默认 `false`，生产环境本字段恒为 `undefined`（不会出现在响应里）。
   * 前端拿到它只做「预填输入框」，不得据此认为服务端总是会返回验证码。
   */
  code?: string;
}

/** `POST /api/auth/verify-code` 请求。 */
export interface VerifyCodeRequest {
  email: string;
  /** 6 位数字验证码 */
  code: string;
  /** 用途，缺省 `login` */
  purpose?: VerificationPurpose;
}

/** 密码登录请求（与验证码登录共存；`password_hash IS NULL` 时禁用，D9）。 */
export interface PasswordLoginRequest {
  email: string;
  password: string;
}

/** 鉴权成功响应（`accessToken` 仅内存保存；`refreshToken` 走 HttpOnly Cookie，不下发到前端）。 */
export interface AuthResponse {
  /** 访问令牌（ACCESS，2h） */
  accessToken: string;
  /** 访问令牌剩余有效秒数 */
  expiresInSeconds: number;
  user: User;
  /** 是否已完成引导问卷（决定前端跳 `/onboarding` 或 `/dashboard`） */
  onboardingCompleted: boolean;
}

// ---------------------------------------------------------------------------
// 引导问卷 / 资料（users）：R1.3/R1.4
// ---------------------------------------------------------------------------

/**
 * `POST /api/onboarding` 请求 —— 引导问卷（US-03）。
 *
 * ⚠️ 不含 `userId`：服务端一律从 JWT 取 `sub`（TC-42/K7）。
 */
export interface OnboardingRequest {
  /** 性别 */
  gender: Gender;
  /** 出生日期 `YYYY-MM-DD`（用于算 age） */
  birthDate: string;
  /** 身高 cm */
  heightCm: number;
  /** 当前体重 kg */
  currentWeightKg: number;
  /** 目标体重 kg */
  targetWeightKg: number;
  /** 目标期限（整数周） */
  targetWeeks: number;
  /** 活动量档位 */
  activityLevel: ActivityLevel;
  /** 饮食偏好（如 少油/素食/清真），可空 */
  dietaryPreference?: string[];
  /** 常见疾病（**敏感**，D3/Q12），可空 */
  conditions?: string[];
  /** 自定义宏量比例（三者和须 = 100），可空则用默认 {25,25,50} */
  macroRatio?: MacroRatio;
  /** 是否已确认免责声明（US-04/R1.5） */
  disclaimerAccepted?: boolean;
}

/** `POST /api/onboarding` / `GET /api/profile` 响应。 */
export interface OnboardingResponse {
  profile: UserProfile;
  goal: UserGoal;
  /** 服务端用 `@qsh/core` 重算的热量预算（唯一可信来源） */
  budget: CalorieResult;
}

/** `PATCH /api/profile` 请求（基础数据修改 → 服务端重算落库，R1.4/TC-12）。 */
export interface UpdateProfileRequest {
  gender?: Gender;
  birthDate?: string;
  heightCm?: number;
  activityLevel?: ActivityLevel;
  dietaryPreference?: string[];
  conditions?: string[];
}

/** `PATCH /api/goals` 请求（目标修改 → 追加历史 + 重算落库）。 */
export interface UpdateGoalRequest {
  currentWeightKg?: number;
  targetWeightKg?: number;
  targetWeeks?: number;
  macroRatio?: MacroRatio;
  weeklyLossKg?: number;
}

/** `GET /api/settings` / `PATCH /api/settings` 请求与响应。 */
export type UpdateSettingsRequest = Partial<
  Pick<UserSettings, 'unit' | 'darkMode' | 'waterGoalMl' | 'fastingEnabled'>
>;

// ---------------------------------------------------------------------------
// 食物库（foods）：R3.1~R3.4
// ---------------------------------------------------------------------------

/** `GET /api/foods` 查询参数。 */
export interface SearchFoodsQuery {
  /** 关键词（名称 / 拼音 / 别名） */
  keyword?: string;
  /** 分类 */
  category?: string;
  /** 页码（从 1 开始） */
  page?: number;
  /** 每页条数 */
  pageSize?: number;
}

/** `GET /api/foods` 响应。 */
export type SearchFoodsResponse = Paginated<FoodItem>;

/** `POST /api/foods` 请求 —— 新建用户自定义食物（R3.6）。 */
export interface CreateCustomFoodRequest {
  name: string;
  category?: string;
  kcalPer100g: number;
  proteinGPer100g?: number;
  fatGPer100g?: number;
  carbGPer100g?: number;
  servingUnits?: ServingUnit[];
  barcode?: string;
  aliases?: string[];
}

// ---------------------------------------------------------------------------
// 在线食物库兜底（Phase C-1）：Open Food Facts 只读代理 + 幂等导入
// ---------------------------------------------------------------------------

/**
 * 外部（在线）食物条目 —— 来自 Open Food Facts，**尚未入库**故无 DB `id`。
 *
 * 字段命名与 `FoodItem` 对齐，前端可复用同一套份量 / 热量换算逻辑。
 * 数据许可为 **ODbL 1.0**，须署名「© Open Food Facts contributors」。
 */
export interface ExternalFoodItem {
  /** 外部唯一标识（OFF 的 `code`，即条码） */
  externalId: string;
  name: string;
  /** 映射到本项目的分类 */
  category: string;
  kcalPer100g: number;
  proteinGPer100g: number;
  fatGPer100g: number;
  carbGPer100g: number;
  servingUnits: ServingUnit[];
  defaultServingGrams: number | null;
  /** 条码（与 `externalId` 相同） */
  barcode: string;
  /** 品牌（可空） */
  brand: string | null;
  /** 上游商品页 URL（供用户核验 / ODbL 署名） */
  sourceUrl: string;
  source: 'openfoodfacts';
  /** 数据许可标识（如 `ODbL 1.0`） */
  license: string;
}

/**
 * `GET /api/foods/live-search` 响应（R3.6 / Phase C-1）。
 *
 * `degraded: true` 表示上游不可用（网络异常 / 超时）—— 前端应给出「先用本地结果」的友好提示，
 * **不是错误**，故仍返回 200。
 */
export interface LiveSearchResponse {
  items: ExternalFoodItem[];
  /** 归一化通过的条数（= `items.length`） */
  found: number;
  /** 因脏数据（缺名称 / 缺条码 / 热量非法）被过滤掉的条数 */
  skipped: number;
  /** 是否降级（上游不可用） */
  degraded: boolean;
  source: 'openfoodfacts';
  license: string;
}

/** `POST /api/foods/import-external` 请求 —— 仅提供外部条码，营养数据由服务端重取。 */
export interface ImportExternalFoodRequest {
  /** OFF 条码（8–14 位数字） */
  externalId: string;
}

/**
 * `GET /api/foods/barcode/:code` 响应（Phase C-2）。
 *
 * - 命中 → `{ item, degraded: false }`；
 * - 上游不可用 → `{ item: null, degraded: true }`（HTTP 200，非错误）；
 * - 确认不存在 → HTTP 404 `E_NOTFOUND_FOOD`。
 */
export interface BarcodeLookupResponse {
  item: FoodItem | null;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// 饮食记录（meals）：R3.5/R3.8 —— 四种记录方式
// ---------------------------------------------------------------------------

/**
 * `POST /api/meals` 请求 —— 新增一条饮食记录。
 *
 * 四种来源（`source`）所需字段：
 * - `search`   ：`foodId` +（`grams` 或 `servingUnit`/`servingQty`）
 * - `quick_add`：`customName` + `customKcal`（快速加卡，TC-19）
 * - `barcode`  ：`foodId`（扫码命中食物库）
 * - `ai`       ：`customName` + `foodId`（AI 匹配食物库后确认，TC-22/23）
 * - `combo`    ：`comboId`（由套餐模板展开，服务端拆分写入）
 *
 * 金额/质量单位统一为 **g**（K6）。
 */
export interface CreateMealLogRequest {
  /** 记录日期 `YYYY-MM-DD`（缺省=客户端本地今天，D1） */
  loggedDate?: string;
  mealType: MealType;
  source?: MealLogSource;
  /** 食物库条目 id（search/barcode/ai 来源） */
  foodId?: number;
  /** 快速加卡 / AI 自定义名称（无 foodId 时必填） */
  customName?: string;
  /** 自定义热量 kcal（快速加卡必填，TC-19） */
  customKcal?: number;
  /** 选定克数（g） */
  grams?: number;
  /** 选定份量单位（个/碗/杯/片/袋） */
  servingUnit?: string;
  /** 份量数量 */
  servingQty?: number;
  /** 备注 */
  note?: string;
}

/** `POST /api/meals/quick-add` 请求 —— 快速加卡（R3.5/TC-19）。 */
export interface QuickAddRequest {
  loggedDate?: string;
  mealType: MealType;
  customName: string;
  /** 自定义热量 kcal（单位 kcal，整数展示） */
  customKcal: number;
  /** 可选：自定义宏量（快速加卡允许为空） */
  proteinG?: number;
  fatG?: number;
  carbG?: number;
  note?: string;
}

/** `GET /api/meals` 查询参数（按日/按餐聚合）。 */
export interface ListMealsQuery {
  /** 起始日期 `YYYY-MM-DD` */
  from?: string;
  /** 结束日期 `YYYY-MM-DD` */
  to?: string;
  /** 指定日期 */
  date?: string;
  mealType?: MealType;
}

/** 按餐分组的当日饮食结构。 */
export interface MealGroup {
  mealType: MealType;
  logs: MealLog[];
  /** 该餐合计热量 kcal */
  totalKcal: number;
}

/** `GET /api/meals` 响应。 */
export interface ListMealsResponse {
  date?: string;
  groups: MealGroup[];
  /** 当日合计热量 kcal */
  totalKcal: number;
}

/** `PATCH /api/meals/:id` 请求。 */
export interface UpdateMealLogRequest {
  grams?: number;
  servingUnit?: string;
  servingQty?: number;
  mealType?: MealType;
  note?: string;
  sortOrder?: number;
}

// ---------------------------------------------------------------------------
// 套餐模板（combos）：R3.9 —— 模板修改不影响历史（US-10）
// ---------------------------------------------------------------------------

/** 套餐模板明细输入项。 */
export interface MealComboItemInput {
  foodId?: number;
  customName?: string;
  grams?: number;
  servingUnit?: string;
  servingQty?: number;
  kcal?: number;
  proteinG?: number;
  fatG?: number;
  carbG?: number;
  sortOrder?: number;
}

/** `POST /api/combos` / `PATCH /api/combos/:id` 请求。 */
export interface MealComboRequest {
  name: string;
  mealType: MealType;
  items: MealComboItemInput[];
}

/** 套餐模板（含明细）。 */
export interface MealComboWithItems extends MealCombo {
  items: MealComboItem[];
}
export type MealComboItemType = MealComboItem;

/** `POST /api/combos/:id/log` 请求 —— 一键用套餐记一餐。 */
export interface LogComboRequest {
  loggedDate?: string;
  /** 覆盖套餐默认餐次（可选） */
  mealType?: MealType;
}

// ---------------------------------------------------------------------------
// 体重（weights）：R7.1/R7.2 —— 7 日移动平均
// ---------------------------------------------------------------------------

/** `POST /api/weights` 请求（同日重复 = UPSERT 覆盖，TC-34/9.3）。 */
export interface CreateWeightLogRequest {
  /** 记录日期 `YYYY-MM-DD`（缺省=客户端本地今天） */
  loggedAt?: string;
  weightKg: number;
  /** 备注 ≤200 字 */
  note?: string;
  source?: WeightLogSource;
}

/** 体重趋势数据点。 */
export interface WeightTrendPoint {
  /** `YYYY-MM-DD` */
  date: string;
  weightKg: number;
}

/** 7 日移动平均数据点。 */
export interface MovingAveragePoint {
  /** `YYYY-MM-DD` */
  date: string;
  /** 7 日移动平均体重 kg（不足 7 天时为已有点的均值或 `null`） */
  value: number | null;
}

/** `GET /api/weights/trend` 响应。 */
export interface WeightTrendResponse {
  /** 原始体重点（升序） */
  points: WeightTrendPoint[];
  /** 7 日移动平均线（升序，与 `points` 日期对齐） */
  movingAverage7: MovingAveragePoint[];
  /** 期间最小/最大/最新体重 kg */
  stats: {
    minKg: number | null;
    maxKg: number | null;
    latestKg: number | null;
    /** 相对首个点位的净变化 kg（可正可负） */
    changeKg: number | null;
  };
  /**
   * 目标达成预测曲线（R2.6，升序、每周一个点）。
   * 无生效目标（或无法预测）时为空数组 `[]`，**必填不回退 `null`**，
   * 前端据此判断是否需要画「目标预测」虚线。
   */
  forecast: GoalForecastPoint[];
  /**
   * 目标达成进度（R2.7，含「维持模式」）。
   *
   * - 有生效目标 → 进度对象（可能处于维持模式）；
   * - 无生效目标 / 无法构成有意义的进度 → `null`，前端据此**隐藏整张卡片**
   *   （与 `forecast: []` 同理，必填、不回退缺省值）。
   */
  goalProgress: GoalProgress | null;
}

/** `GET /api/weights` 响应。 */
export type ListWeightsResponse = Paginated<WeightLog>;

// ---------------------------------------------------------------------------
// 看板（dashboard）：US-05 —— 今日剩余热量聚合
// ---------------------------------------------------------------------------

/** 迷你体重趋势点（看板用，最近 N 天）。 */
export interface MiniTrendPoint {
  /** `YYYY-MM-DD` */
  date: string;
  weightKg: number | null;
}

/** `GET /api/dashboard` 响应。 */
export interface DashboardResponse {
  /** 看板日期 `YYYY-MM-DD`（客户端本地今天） */
  date: string;
  /** 当前生效目标（无则 `null`，前端引导去 `/onboarding`） */
  goal: UserGoal | null;
  /** 服务端重算的预算摘要 */
  budget: {
    /** 建议摄入 kcal */
    intakeRecommended: number;
    /** 基础代谢 kcal */
    bmr: number;
    /** 每日总消耗 kcal */
    tdee: number;
  } | null;
  /** 今日已摄入 kcal */
  intakeKcal: number;
  /** 今日已消耗 kcal（运动，二期） */
  burnedKcal: number;
  /** 今日剩余热量 kcal = intakeRecommended − intakeKcal（可为负） */
  remainingKcal: number;
  /** 进度比 = intakeKcal / intakeRecommended（0~1+） */
  progressRatio: number;
  /** 今日饮水 ml */
  waterMl: number;
  /** 饮水目标 ml */
  waterGoalMl: number;
  /** 迷你体重趋势（最近 7 天） */
  miniTrend: MiniTrendPoint[];
  /** 鼓励式文案（无负罪感，§7 K4） */
  encouragement: string;
  /** 非阻断提醒（来自引擎 warnings / 结果侧，§4.5） */
  warnings: ValidationWarning[];
}

// ---------------------------------------------------------------------------
// 通用：健康检查
// ---------------------------------------------------------------------------

/** `GET /api/health` 响应。 */
export interface HealthResponse {
  status: 'ok';
  /** 服务端时间 ISO8601 UTC */
  time: string;
}

// ---------------------------------------------------------------------------
// 引擎错误入参（供 API 层抛出/映射用）
// ---------------------------------------------------------------------------

/** 校验失败时用于构造 `ApiError.fields` 的映射。 */
export type ValidationFieldMap = Record<string, string>;

/** 便捷类型：把引擎 `ValidationError[]` 映射为 `ApiError` 所需字段。 */
export type EngineErrors = ValidationError[];
