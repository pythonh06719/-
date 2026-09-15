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

import type { MealType, UnitSystem } from './entities';

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
  settings: ExportSettings;
}

/** 当前导出结构版本（写入 `meta.schemaVersion`）。 */
export const EXPORT_SCHEMA_VERSION = 1;

/** 固定应用标识。 */
export const EXPORT_APP_ID = 'qingshenghuo' as const;

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
