import type {
  ExportBundle,
  ExportFileDescriptor,
  ExportJsonPayload,
  ExportWeightRow,
} from '@qsh/shared-types';
import {
  CSV_FILE_NAMES,
  CSV_ENCODING,
  EXPORT_CSV_COLUMNS,
  EXPORT_SCHEMA_VERSION,
  EXPORT_APP_ID,
} from '@qsh/shared-types';
// CSV 序列化/解析的**唯一真源**在 `@qsh/core`（前后端共用，K11）——本模块只保留
// 面向 UI 的便捷封装（文件描述符、导出打包、空骨架），不再重复实现转义与解析。
import {
  escapeCsvField,
  parseWeightCsv as parseWeightCsvCore,
  serializeCsv,
  withBom,
  type ParsedWeightCsv as ParsedWeightCsvCore,
} from '@qsh/core';
import { isDateKey } from './format';

export { escapeCsvField, serializeCsv, withBom };

/**
 * 数据主权序列化（lib/csv.ts）—— **纯函数**，便于单元测试（T04 DoD / K11 / §9）。
 *
 * 约定（PRD §9.1 / §9.2 / §9.3）：
 * - JSON：`meta` + `profile` + `goals` + 各实体数组 + `settings`，字段名逐字一致；
 * - CSV：**UTF-8 with BOM**、首行表头、日期 `YYYY-MM-DD`、逗号/引号/换行按 RFC 4180 转义；
 * - 导入：仅历史体重，同日期覆盖，非法行跳过并汇总（返回 `errors`）。
 *
 * 序列化/解析实现已下沉至 `@qsh/core`（见文件顶部 import），此处仅做类型适配。
 */

/** CSV MIME 类型（带 BOM 的 UTF-8 文本）。 */
export const CSV_MIME = 'text/csv;charset=utf-8';
/** JSON MIME 类型。 */
export const JSON_MIME = 'application/json;charset=utf-8';

/** CSV 导入校验结果（透传 core 类型，保持既有导出面不变）。 */
export type ParsedWeightCsv = ParsedWeightCsvCore;

/** 构造一个可下载文件的描述（CSV 一律含 BOM）。 */
export function buildCsvFile<T extends object>(
  fileName: string,
  columns: readonly string[],
  rows: readonly T[],
): ExportFileDescriptor {
  return {
    fileName,
    mimeType: CSV_MIME,
    content: withBom(serializeCsv(columns, rows)),
    withBom: true,
  };
}

/** 构造 JSON 文件描述。 */
export function buildJsonFile(payload: ExportJsonPayload): ExportFileDescriptor {
  return {
    fileName: 'data.json',
    mimeType: JSON_MIME,
    content: `${JSON.stringify(payload, null, 2)}\n`,
    withBom: false,
  };
}

/** 把导出 JSON 的 `meals` 段展开为 CSV 行（每 item 一行）。 */
export function flattenMealRows(payload: ExportJsonPayload): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const meal of payload.meals) {
    for (const item of meal.items) {
      rows.push({
        date: meal.date,
        mealType: meal.mealType,
        name: item.name,
        grams: item.grams,
        kcal: item.kcal,
        proteinG: item.proteinG,
        fatG: item.fatG,
        carbG: item.carbG,
      });
    }
  }
  return rows;
}

/** 由导出结构打包 JSON + 各 CSV 文件（§9.2 文件清单）。 */
export function serializeExportBundle(payload: ExportJsonPayload): ExportBundle {
  return {
    json: payload,
    files: [
      buildJsonFile(payload),
      buildCsvFile(CSV_FILE_NAMES.weights, EXPORT_CSV_COLUMNS.weights, payload.weights),
      buildCsvFile(CSV_FILE_NAMES.meals, EXPORT_CSV_COLUMNS.meals, flattenMealRows(payload)),
      buildCsvFile(CSV_FILE_NAMES.exercises, EXPORT_CSV_COLUMNS.exercises, payload.exercises),
      buildCsvFile(CSV_FILE_NAMES.habits, EXPORT_CSV_COLUMNS.habits, payload.habits),
      buildCsvFile(CSV_FILE_NAMES.water, EXPORT_CSV_COLUMNS.water, payload.water),
    ],
  };
}

/** 构造导出 JSON 的 `meta` 段。 */
export function buildExportMeta(exportedAtIso: string): ExportJsonPayload['meta'] {
  return {
    app: EXPORT_APP_ID,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: exportedAtIso,
  };
}

/** 创建一个「空骨架」导出结构（后端不可用时用本地缓存填充，保证导出按钮可用）。 */
export function createEmptyExportPayload(exportedAtIso: string): ExportJsonPayload {
  return {
    meta: buildExportMeta(exportedAtIso),
    profile: {
      gender: 'female',
      birthDate: '1990-01-01',
      heightCm: 165,
      activityLevel: 'sedentary',
      dietaryPreference: [],
      conditions: [],
    },
    goals: {
      targetWeightKg: 55,
      targetWeeks: 12,
      macroRatio: { protein: 25, fat: 25, carb: 50 },
    },
    weights: [],
    meals: [],
    exercises: [],
    habits: [],
    water: [],
    settings: { unit: 'kcal', darkMode: false, fastingEnabled: false },
  };
}

// ---------------------------------------------------------------------------
// CSV 导入（§9.3 历史体重）—— 解析已下沉至 `@qsh/core`，此处仅委托导出
// ---------------------------------------------------------------------------

export const parseWeightCsv = parseWeightCsvCore;

/** 把趋势点转成导出用的 `weights[]` 行（升序）。 */
export function toExportWeightRows(
  logs: ReadonlyArray<{ loggedAt?: string; date?: string; weightKg: number; note?: string | null }>,
): ExportWeightRow[] {
  const rows: ExportWeightRow[] = [];
  for (const log of logs) {
    const date = log.date ?? log.loggedAt;
    if (typeof date !== 'string') {
      continue;
    }
    rows.push({ date, weightKg: log.weightKg, note: log.note ?? '' });
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export { CSV_ENCODING };
