/**
 * 实体类型（entities）—— 与 `docs/SCHEMA.sql`（SQLite）/ `docs/schema.pg.sql`（PostgreSQL）逐表对应。
 *
 * 约定（ARCHITECTURE §3.2）：
 * - TS 侧字段一律 **camelCase**；注释中的 `// db: <snake_case>` 标注对应 DB 列名。
 * - JSON 列（`dietary_preference` / `conditions` / `serving_units` / `macro_ratio` / `aliases`）
 *   在 DB 里是 **TEXT（SQLite）/ JSONB（PG）**；实体层给出**已解析后的结构化类型**，
 *   由仓储层负责 `JSON.parse` / `JSON.stringify`。
 * - 日期：日粒度用本地时区 `YYYY-MM-DD` 字符串；时间戳用 **ISO8601 UTC** 字符串（K5）。
 * - 布尔：DB 为 INTEGER(0/1，SQLite) / BOOLEAN(PG)，实体层为 `boolean`（应用层归一）。
 * - 枚举：DB 为 TEXT（+ CHECK），实体层为字符串联合类型（不用原生 enum，便于演进）。
 * - 主键：数据库自增整数；TS 侧统一用 `number`。
 *
 * ⚠️ 本文件**不重复定义**引擎类型（`Gender` / `ActivityLevel` / `MacroRatio`），
 *    一律从 `@qsh/core` 复用（=前后端唯一真源）。
 */

import type { ActivityLevel, Gender, MacroRatio } from '@qsh/core';

// ---------------------------------------------------------------------------
// 共享枚举（字符串联合，与 DB 的 TEXT + CHECK 对齐）
// ---------------------------------------------------------------------------

/** `users.status` */
export type UserStatus = 'active' | 'disabled';

/** `auth_verification_codes.purpose` */
export type VerificationPurpose = 'login' | 'signup' | 'reset';

/** `meal_logs.meal_type` / `meal_combos.meal_type` */
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** `meal_logs.source` —— 四种记录方式的来源标识（PRD R3） */
export type MealLogSource = 'search' | 'quick_add' | 'barcode' | 'ai' | 'combo';

/** `food_items.source` */
export type FoodSource = 'builtin' | 'openfoodfacts' | 'user_custom';

/** `weight_logs.source` */
export type WeightLogSource = 'manual' | 'import';

/** `user_settings.unit` */
export type UnitSystem = 'kcal' | 'kj';

/** `fasting_settings.plan` / `fasting_sessions.plan` */
export type FastingPlan = '16:8' | '18:6' | 'custom';

/** `ai_usage.feature` */
export type AiFeature = 'daily_summary' | 'today_plan' | 'free_ask' | 'food_recognize' | 'agent';

// ---------------------------------------------------------------------------
// 1. users
// ---------------------------------------------------------------------------

/** 表 `users` —— 身份与鉴权（纯鉴权表，敏感资料见 `user_profiles`）。 */
export interface User {
  id: number;
  /** db: email */
  email: string;
  /** db: password_hash —— bcryptjs(cost=12)；纯验证码用户为 `null`（D9） */
  passwordHash: string | null;
  /** db: email_verified_at —— ISO8601 UTC，可空 */
  emailVerifiedAt: string | null;
  /** db: status */
  status: UserStatus;
  /** db: created_at —— ISO8601 UTC */
  createdAt: string;
  /** db: updated_at —— ISO8601 UTC */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 2. auth_verification_codes
// ---------------------------------------------------------------------------

/** 表 `auth_verification_codes` —— 邮箱验证码（存 hash、一次性、5 分钟过期）。 */
export interface AuthVerificationCode {
  id: number;
  /** db: email */
  email: string;
  /** db: code_hash —— 仅存 hash，不存明文 */
  codeHash: string;
  /** db: purpose */
  purpose: VerificationPurpose;
  /** db: expires_at —— ISO8601 UTC */
  expiresAt: string;
  /** db: consumed_at —— 消费即置位（一次性），可空 */
  consumedAt: string | null;
  /** db: created_at —— ISO8601 UTC */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 3. user_profiles
// ---------------------------------------------------------------------------

/** 表 `user_profiles` —— 基础资料（1:1 `users`，`user_id` 即主键）。 */
export interface UserProfile {
  /** db: user_id —— 主键兼外键 */
  userId: number;
  /** db: gender */
  gender: Gender;
  /** db: birth_date —— `YYYY-MM-DD` 本地日期 */
  birthDate: string;
  /** db: height_cm */
  heightCm: number;
  /** db: activity_level */
  activityLevel: ActivityLevel;
  /** db: dietary_preference —— JSON array<string>，实体层已解析 */
  dietaryPreference: string[];
  /** db: conditions —— JSON array<string>，**敏感字段**（D3 / Q12） */
  conditions: string[];
  /** db: disclaimer_accepted_at —— ISO8601 UTC，可空 */
  disclaimerAcceptedAt: string | null;
  /** db: onboarding_completed_at —— ISO8601 UTC，可空 */
  onboardingCompletedAt: string | null;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 4. user_goals
// ---------------------------------------------------------------------------

/** 表 `user_goals` —— **当前生效**目标（1:1 `users`）；修改即重算（R1.4）。 */
export interface UserGoal {
  /** db: user_id —— 主键兼外键 */
  userId: number;
  /** db: start_weight_kg */
  startWeightKg: number;
  /** db: target_weight_kg */
  targetWeightKg: number;
  /** db: target_weeks */
  targetWeeks: number;
  /** db: weekly_loss_kg —— Q5 推导并落库 */
  weeklyLossKg: number;
  /** db: macro_ratio —— JSON，三者和须 = 100 */
  macroRatio: MacroRatio;
  /** db: is_active —— INTEGER(0/1) */
  isActive: boolean;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 5. weight_goal_history
// ---------------------------------------------------------------------------

/** 表 `weight_goal_history` —— 目标变更历史（追加式，支撑预测曲线与审计）。 */
export interface WeightGoalHistory {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: start_weight_kg */
  startWeightKg: number;
  /** db: target_weight_kg */
  targetWeightKg: number;
  /** db: target_weeks */
  targetWeeks: number;
  /** db: weekly_loss_kg */
  weeklyLossKg: number;
  /** db: macro_ratio —— JSON */
  macroRatio: MacroRatio;
  /** db: effective_from —— `YYYY-MM-DD` 本地日期 */
  effectiveFrom: string;
  /** db: created_at */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 6. user_settings
// ---------------------------------------------------------------------------

/** 表 `user_settings` —— 单位/深色/饮水目标/断食开关（1:1 `users`）。 */
export interface UserSettings {
  /** db: user_id —— 主键兼外键 */
  userId: number;
  /** db: unit —— kcal / kJ 切换（R2.11） */
  unit: UnitSystem;
  /** db: dark_mode —— INTEGER(0/1) */
  darkMode: boolean;
  /** db: water_goal_ml */
  waterGoalMl: number;
  /** db: fasting_enabled —— 默认关闭（R8.1） */
  fastingEnabled: boolean;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 7. weight_logs
// ---------------------------------------------------------------------------

/** 表 `weight_logs` —— 每日体重（`(user_id, logged_at)` 同日唯一；CSV 导入 UPSERT 覆盖）。 */
export interface WeightLog {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: logged_at —— `YYYY-MM-DD` 本地日期，当日唯一 */
  loggedAt: string;
  /** db: weight_kg */
  weightKg: number;
  /** db: note —— ≤200 字 */
  note: string | null;
  /** db: source */
  source: WeightLogSource;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 8. food_items
// ---------------------------------------------------------------------------

/**
 * 自然份量单位（`food_items.serving_units` 的元素，ARCHITECTURE §3.3）。
 *
 * 换算规则：`kcal = kcal_per_100g × (选定克数 ÷ 100)`；
 * 选定克数 = `grams`（该单位默认克数）或用户自定义克数（R3.3 / TC-17）。
 */
export interface ServingUnit {
  /** 个/碗/杯/片/袋/份/支…（1–10 字） */
  unit: string;
  /** 该单位对应的克数（> 0） */
  grams: number;
  /** 默认选中单位（每项至多 1 个 true） */
  isDefault?: boolean;
  /** 展示别名，如「一中碗」（可选，≤20 字） */
  label?: string;
}

/** 表 `food_items` —— 中式食物库（每 100g 营养 + 自然份量单位）。 */
export interface FoodItem {
  id: number;
  /** db: name */
  name: string;
  /** db: name_pinyin —— 拼音模糊搜索，可空 */
  namePinyin: string | null;
  /** db: aliases —— JSON array<string>，实体层已解析 */
  aliases: string[];
  /** db: category —— 主食/家常菜/外卖/奶茶/零食/水果/蔬菜/蛋白/other */
  category: string;
  /** db: kcal_per_100g */
  kcalPer100g: number;
  /** db: protein_g_per_100g */
  proteinGPer100g: number;
  /** db: fat_g_per_100g */
  fatGPer100g: number;
  /** db: carb_g_per_100g */
  carbGPer100g: number;
  /** db: fiber_g_per_100g —— 可空 */
  fiberGPer100g: number | null;
  /** db: sodium_mg_per_100g —— 可空 */
  sodiumMgPer100g: number | null;
  /** db: saturated_fat_g_per_100g —— 可空 */
  saturatedFatGPer100g: number | null;
  /** db: sugar_g_per_100g —— 可空 */
  sugarGPer100g: number | null;
  /** db: calcium_mg_per_100g —— 可空 */
  calciumMgPer100g: number | null;
  /** db: iron_mg_per_100g —— 可空 */
  ironMgPer100g: number | null;
  /** db: potassium_mg_per_100g —— 可空 */
  potassiumMgPer100g: number | null;
  /** db: vitamin_d_ug_per_100g —— 可空 */
  vitaminDUgPer100g: number | null;
  /** db: b12_ug_per_100g —— 可空 */
  b12UgPer100g: number | null;
  /** db: magnesium_mg_per_100g —— 可空 */
  magnesiumMgPer100g: number | null;
  /** db: serving_units —— JSON array<ServingUnit>，实体层已解析 */
  servingUnits: ServingUnit[];
  /** db: default_serving_grams —— 冗余一份默认单位克数，便于排序与快捷默认 */
  defaultServingGrams: number | null;
  /** db: barcode —— Open Food Facts（二期，R3.6）；唯一（可空） */
  barcode: string | null;
  /** db: source */
  source: FoodSource;
  /** db: created_by_user_id —— user_custom 归属；builtin 为 `null` */
  createdByUserId: number | null;
  /** db: is_verified —— INTEGER(0/1) */
  isVerified: boolean;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 9. food_favorites
// ---------------------------------------------------------------------------

/** 表 `food_favorites` —— 收藏（R3.4）；复合主键 `(user_id, food_item_id)`。 */
export interface FoodFavorite {
  /** db: user_id */
  userId: number;
  /** db: food_item_id */
  foodItemId: number;
  /** db: created_at */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 10. meal_logs
// ---------------------------------------------------------------------------

/** 表 `meal_logs` —— 饮食记录（search / quick_add / barcode / ai / combo）。 */
export interface MealLog {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: logged_date —— `YYYY-MM-DD` 本地日期（D1） */
  loggedDate: string;
  /** db: meal_type */
  mealType: MealType;
  /** db: food_item_id —— 可为空（快速加卡仅名称+热量，R3.5/TC-19） */
  foodItemId: number | null;
  /** db: custom_name —— 快速加卡 / AI 名称 */
  customName: string | null;
  /** db: grams —— 选定克数（单位 g），可空=按份量估算 */
  grams: number | null;
  /** db: serving_unit —— 个/碗/杯/片/袋 */
  servingUnit: string | null;
  /** db: serving_qty */
  servingQty: number | null;
  /** db: kcal */
  kcal: number;
  /** db: protein_g —— 快速加卡允许为空（TC-19） */
  proteinG: number | null;
  /** db: fat_g */
  fatG: number | null;
  /** db: carb_g */
  carbG: number | null;
  /** db: fiber_g —— 二期微量 */
  fiberG: number | null;
  /** db: sodium_mg */
  sodiumMg: number | null;
  /** db: source */
  source: MealLogSource;
  /** db: combo_id —— 由套餐模板记录时回填，可空 */
  comboId: number | null;
  /** db: note */
  note: string | null;
  /** db: sort_order —— 餐间拖拽排序（TC-27） */
  sortOrder: number;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 11. meal_combos
// ---------------------------------------------------------------------------

/** 表 `meal_combos` —— 套餐模板头（模板修改不影响历史，US-10）。 */
export interface MealCombo {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: name */
  name: string;
  /** db: meal_type */
  mealType: MealType;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 12. meal_combo_items
// ---------------------------------------------------------------------------

/** 表 `meal_combo_items` —— 套餐模板明细。 */
export interface MealComboItem {
  id: number;
  /** db: combo_id */
  comboId: number;
  /** db: food_item_id —— 可为空（自定义条目） */
  foodItemId: number | null;
  /** db: custom_name */
  customName: string | null;
  /** db: grams —— 单位 g */
  grams: number | null;
  /** db: serving_unit */
  servingUnit: string | null;
  /** db: serving_qty */
  servingQty: number | null;
  /** db: kcal */
  kcal: number;
  /** db: protein_g */
  proteinG: number | null;
  /** db: fat_g */
  fatG: number | null;
  /** db: carb_g */
  carbG: number | null;
  /** db: sort_order */
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// 13. met_activities
// ---------------------------------------------------------------------------

/** 表 `met_activities` —— 运动 MET 表（R6.1，二期）；主键为文本 `code`。 */
export interface MetActivity {
  /** db: code —— 主键 */
  code: string;
  /** db: name */
  name: string;
  /** db: category */
  category: string;
  /** db: intensity —— 强度档位（如 慢走/快走），可空（Q11） */
  intensity: string | null;
  /** db: met */
  met: number;
  /** db: is_builtin —— INTEGER(0/1) */
  isBuiltin: boolean;
  /** db: source —— 数据来源标注，可空 */
  source: string | null;
  /** db: created_at */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 14. exercise_logs
// ---------------------------------------------------------------------------

/** 表 `exercise_logs` —— 运动记录（消耗 = MET × kg × h，TC-32，二期）。 */
export interface ExerciseLog {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: logged_date —— `YYYY-MM-DD` 本地日期 */
  loggedDate: string;
  /** db: activity_code —— 外键 met_activities.code（ON DELETE RESTRICT） */
  activityCode: string;
  /** db: activity_name —— 冗余快照 */
  activityName: string;
  /** db: met */
  met: number;
  /** db: minutes */
  minutes: number;
  /** db: weight_kg_at_log */
  weightKgAtLog: number;
  /** db: kcal_burned */
  kcalBurned: number;
  /** db: note */
  note: string | null;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 15. water_logs
// ---------------------------------------------------------------------------

/** 表 `water_logs` —— 饮水（一键 +250ml；撤销 = 删除最新一条，TC-33，二期）。 */
export interface WaterLog {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: logged_date —— `YYYY-MM-DD` 本地日期 */
  loggedDate: string;
  /** db: logged_at —— ISO8601 UTC 精确时间，用于撤销 */
  loggedAt: string;
  /** db: amount_ml */
  amountMl: number;
  /** db: created_at */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 16. habit_definitions
// ---------------------------------------------------------------------------

/** 表 `habit_definitions` —— 习惯项（`userId === null` 为系统内置模板，R7.3，二期）。 */
export interface HabitDefinition {
  id: number;
  /** db: user_id —— `null` = 内置模板 */
  userId: number | null;
  /** db: code —— water / early_sleep / steps / no_takeout … */
  code: string;
  /** db: name */
  name: string;
  /** db: icon —— 可空 */
  icon: string | null;
  /** db: target_per_day */
  targetPerDay: number;
  /** db: is_active —— INTEGER(0/1) */
  isActive: boolean;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 17. habit_checkins
// ---------------------------------------------------------------------------

/** 表 `habit_checkins` —— 习惯打卡（幂等；断签不惩罚，TC-35，二期）。 */
export interface HabitCheckin {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: habit_id */
  habitId: number;
  /** db: logged_date —— `YYYY-MM-DD` 本地日期 */
  loggedDate: string;
  /** db: done —— INTEGER(0/1) */
  done: boolean;
  /** db: value —— 可选数值（步数等） */
  value: number | null;
  /** db: created_at */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 18. fasting_settings
// ---------------------------------------------------------------------------

/** 表 `fasting_settings` —— 断食设置（默认关闭；开启需内容警告确认，R8.1/R8.2）。 */
export interface FastingSettings {
  /** db: user_id —— 主键兼外键 */
  userId: number;
  /** db: plan */
  plan: FastingPlan;
  /** db: target_fast_hours */
  targetFastHours: number;
  /** db: eat_window_start —— `HH:mm`，可空 */
  eatWindowStart: string | null;
  /** db: enabled —— INTEGER(0/1) */
  enabled: boolean;
  /** db: disclaimer_ack_at —— ISO8601 UTC，可空 */
  disclaimerAckAt: string | null;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 19. fasting_sessions
// ---------------------------------------------------------------------------

/** 表 `fasting_sessions` —— 断食会话（不做主动推送，R8.3，二期）。 */
export interface FastingSession {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: plan */
  plan: FastingPlan;
  /** db: target_hours */
  targetHours: number;
  /** db: started_at —— ISO8601 UTC */
  startedAt: string;
  /** db: ended_at —— ISO8601 UTC，可空 */
  endedAt: string | null;
  /** db: completed —— INTEGER(0/1) */
  completed: boolean;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 20. ai_usage
// ---------------------------------------------------------------------------

/** 表 `ai_usage` —— AI 每日限额（每账号每日每功能计数，上限 50，R9.4，三期）。 */
export interface AiUsage {
  id: number;
  /** db: user_id */
  userId: number;
  /** db: usage_date —— `YYYY-MM-DD` 本地日期 */
  usageDate: string;
  /** db: feature */
  feature: AiFeature;
  /** db: request_count */
  requestCount: number;
  /** db: token_in */
  tokenIn: number;
  /** db: token_out */
  tokenOut: number;
  /** db: created_at */
  createdAt: string;
  /** db: updated_at */
  updatedAt: string;
}
