/**
 * 数据主权契约（export）—— 导出 / 导入 / 硬删除（PRD §9 / R10）。
 *
 * - §9.1 导出 JSON 顶层结构：字段名与 PRD **逐字一致**。
 * - §9.2 导出 CSV：每个实体一个文件，UTF-8 **with BOM**，首行表头，日期 `YYYY-MM-DD`。
 * - §9.3 CSV 导入模板：仅历史体重（同日期 UPSERT 覆盖，非法行跳过并汇总）。
 *
 * ⚠️ `profile.conditions` 为**敏感字段**（D3/Q12）：导出时可选择性排除，不进分享卡片。
 */

import type { ActivityLevel, Gender, MacroRatio } from '@qsh/core';

import type { MealType, UnitSystem, WeightUnit } from './entities';

// ---------------------------------------------------------------------------
// §9.1 导出 JSON 顶层结构
// ---------------------------------------------------------------------------

/** 导出文件元信息。 */
export interface ExportMeta {
  /** 固定应用标识 */
  app: 'qingshenghuo';
  /** 结构版本号，升级时递增，用于兼容解码 */
  schemaVersion: number;
  /** 导出时刻 ISO8601 UTC */
  exportedAt: string;
}

/** `profile` 段（来源 `user_profiles` + `users.email`）。 */
export interface ExportProfile {
  /** 邮箱（`users.email`） */
  email?: string;
  gender: Gender;
  /** `YYYY-MM-DD` */
  birthDate: string;
  heightCm: number;
  activityLevel: ActivityLevel;
  dietaryPreference: string[];
  /** 敏感字段（D3）：按导出选项可排除 */
  conditions: string[];
}

/** `goals` 段（来源 `user_goals`）。 */
export interface ExportGoals {
  targetWeightKg: number;
  targetWeeks: number;
  macroRatio: MacroRatio;
}

/** `weights[]` 元素（来源 `weight_logs`）。 */
export interface ExportWeightRow {
  /** `date ← logged_at`，`YYYY-MM-DD` */
  date: string;
  weightKg: number;
  note: string;
}

/** `meals[].items[]` 元素（来源 `meal_logs` 按 food 展开）。 */
export interface ExportMealItem {
  name: string;
  /** 选定克数（g） */
  grams: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

/** `meals[]` 元素（来源 `meal_logs` 按日 + 餐分组）。 */
export interface ExportMealRow {
  /** `YYYY-MM-DD` */
  date: string;
  mealType: MealType;
  items: ExportMealItem[];
}

/** `exercises[]` 元素（来源 `exercise_logs`）。 */
export interface ExportExerciseRow {
  /** `YYYY-MM-DD` */
  date: string;
  /** `type ← activity_code` */
  type: string;
  met: number;
  minutes: number;
  /** `kcalBurned ← kcal_burned` */
  kcalBurned: number;
}

/** `habits[]` 元素（来源 `habit_checkins` join `habit_definitions`）。 */
export interface ExportHabitRow {
  /** `YYYY-MM-DD` */
  date: string;
  /** `habitId ← code` */
  habitId: string;
  done: boolean;
}

/** `water[]` 元素（来源 `water_logs` 按日聚合）。 */
export interface ExportWaterRow {
  /** `YYYY-MM-DD` */
  date: string;
  /** 当日合计 ml */
  ml: number;
}

/** `settings` 段（来源 `user_settings`）。 */
export interface ExportSettings {
  unit: UnitSystem;
  darkMode: boolean;
  fastingEnabled: boolean;
  /**
   * 体重展示单位（D-3，1 kg = 2 市斤）。
   *
   * ⚠️ 这是**展示偏好**，与 `weights[].weightKg` 的存储口径无关 ——
   * 备份里的体重记录**恒为 kg**，本字段只让「恢复备份后单位偏好不丢」成立
   * （与 `unit` / `darkMode` 同属 GAP-4 承诺的「设置可完整恢复」）。
   */
  weightUnit: WeightUnit;
  /**
   * 每日饮水目标（ml，GAP-3）。
   *
   * ⚠️ 与 `water[].ml` 无关：那是「每天实际喝了多少」的事实，本字段是用户设的**目标**。
   * 它让「恢复备份后饮水目标不丢」成立 —— 否则用户改过的目标一恢复就打回默认 2000，
   * 与「设置可完整恢复」的承诺相反。合法区间 500–8000，默认 2000
   * （与后端 `UpdateSettingsDto` / `water.service.ts` 一致）。
   */
  waterGoalMl: number;
}

/** `wins[]` 元素（来源 `win_logs`）。语义是用户自由文本，与其他业务实体无外键，导出时不联表。 */
export interface ExportWinRow {
  /** `YYYY-MM-DD`（`win_logs.logged_date`） */
  date: string;
  /** 正文（≤60 字，应用层校验） */
  text: string;
}

/** **导出 JSON 顶层结构（PRD §9.1，字段名逐字一致）**。 */
export interface ExportJsonPayload {
  meta: ExportMeta;
  profile: ExportProfile;
  goals: ExportGoals;
  weights: ExportWeightRow[];
  meals: ExportMealRow[];
  exercises: ExportExerciseRow[];
  habits: ExportHabitRow[];
  water: ExportWaterRow[];
  /** R11.4 新增顶层键（schemaVersion 2 起，QR-6） */
  wins: ExportWinRow[];
  settings: ExportSettings;
}

/** 当前导出结构版本（1 → 2：新增 `wins` 顶层键，QR-6）。读取侧见 `@qsh/core` 的 `readExportWins`。 */
export const EXPORT_SCHEMA_VERSION = 2;

/** 固定应用标识。 */
export const EXPORT_APP_ID = 'qingshenghuo' as const;

// ---------------------------------------------------------------------------
// R10.2 JSON 备份恢复
// ---------------------------------------------------------------------------

/** 恢复预览中的各类记录条数；meals 按餐次里的条目数计数。 */
export interface RestoreRecordCounts {
  weights: number;
  meals: number;
  exercises: number;
  habits: number;
  water: number;
  wins: number;
}

/** JSON 备份恢复的预览响应。 */
export interface RestorePreviewResponse {
  /** 一次性预览凭据，只能由创建预览的账号确认使用。 */
  previewToken: string;
  schemaVersion: 1 | 2;
  counts: RestoreRecordCounts;
  dateRange: { from: string; to: string } | null;
  mergeStrategy: 'same-day-replace';
}

/** JSON 备份恢复完成后的事实汇总。 */
export interface RestoreResult {
  restored: RestoreRecordCounts;
  dateRange: { from: string; to: string } | null;
  mergeStrategy: 'same-day-replace';
}

// ---------------------------------------------------------------------------
// §9.3 CSV 导入模板（历史体重）
// ---------------------------------------------------------------------------

/** CSV 导入模板行（历史体重）。 */
export interface WeightCsvRow {
  /** `YYYY-MM-DD`（必填） */
  date: string;
  /** 数字，0 < w < 500（必填） */
  weightKg: number;
  /** 文本 ≤200 字（可选） */
  note?: string;
}

/** 体重 CSV 导入列定义（顺序即表头顺序）。 */
export const WEIGHT_CSV_COLUMNS = ['date', 'weightKg', 'note'] as const;

/** CSV 导入结果汇总。 */
export interface CsvImportResult {
  /** 成功导入（含覆盖）条数 */
  imported: number;
  /** 因同日已存在而覆盖的条数 */
  overwritten: number;
  /** 被跳过的非法行数 */
  skipped: number;
  /** 非法行明细（行号 + 原因） */
  errors: { row: number; reason: string }[];
}

// ---------------------------------------------------------------------------
// §9.2 导出 CSV 列定义（每实体一文件）
// ---------------------------------------------------------------------------

/** 导出 CSV 文件名常量。 */
export const CSV_FILE_NAMES = {
  weights: 'weights.csv',
  meals: 'meals.csv',
  exercises: 'exercises.csv',
  habits: 'habits.csv',
  water: 'water.csv',
  /** B4：与 JSON 的 `wins` 顶层键对齐（QR-6 / schemaVersion 2 起） */
  wins: 'wins.csv',
} as const;

/** 导出 CSV 文件键类型。 */
export type CsvFileKey = keyof typeof CSV_FILE_NAMES;

/** 各导出 CSV 的列定义（顺序即表头顺序）。 */
export const EXPORT_CSV_COLUMNS = {
  weights: ['date', 'weightKg', 'note'] as const,
  meals: ['date', 'mealType', 'name', 'grams', 'kcal', 'proteinG', 'fatG', 'carbG'] as const,
  exercises: ['date', 'type', 'met', 'minutes', 'kcalBurned'] as const,
  habits: ['date', 'habitId', 'done'] as const,
  water: ['date', 'ml'] as const,
  /** B4：记录日期 + 内容；正文是自由文本，导出时按 RFC 4180 转义。 */
  wins: ['date', 'text'] as const,
};

/** CSV 字符集约定：UTF-8 with BOM（K11）。 */
export const CSV_ENCODING = 'utf-8-bom' as const;

/** 各 CSV 表头行（含 BOM 前置）。 */
export const CSV_BOM = '\uFEFF';

/** 记录一个已导出文件的描述（下载清单用）。 */
export interface ExportFileDescriptor {
  /** 文件名（如 `weights.csv`） */
  fileName: string;
  /** MIME 类型 */
  mimeType: string;
  /** 文本内容（JSON / CSV 文本） */
  content: string;
  /** 是否含 BOM（CSV 为 true） */
  withBom: boolean;
}

/** 导出打包结果（JSON + 各 CSV 文件）。 */
export interface ExportBundle {
  /** `data.json` 内容 */
  json: ExportJsonPayload;
  /** 各 CSV 文件 */
  files: ExportFileDescriptor[];
}

/** 体重 CSV 行的字段名联合（供解析器 / UI 表单复用）。 */
export type WeightCsvColumn = (typeof WEIGHT_CSV_COLUMNS)[number];
