/**
 * 导出 payload 的**兼容读法**（core/export/payload.ts）—— R11.4 / QR-6。
 *
 * **为什么放 core 而不是 shared-types**：shared-types 是「纯类型包、不含可执行逻辑」；
 * 且 core 不许 import shared-types（K12），故返回形状用本模块自己的结构性类型承载。
 *
 * **版本语义（K25）**：`EXPORT_SCHEMA_VERSION` 只增不减。v1 备份文件没有 `wins` 顶层键，
 * 读取侧必须视为「没有这类记录」而不是「文件坏了」—— 导入/回看不因版本差而报错。
 */

/** `wins` 顶层键自 schemaVersion 2 起存在。 */
export const EXPORT_SCHEMA_VERSION_MIN_WINS = 2;

/** `wins[]` 元素的最小形状（与 shared-types 的 `ExportWinRow` 同构）。 */
export interface ExportWinRowLike {
  /** `YYYY-MM-DD` */
  date: string;
  text: string;
}

/**
 * 读取导出 JSON 的 `wins` 顶层键（QR-6）：
 * - v1（无该键）/ `raw` 非对象 / `wins` 非数组 → **一律返回 `[]`，绝不抛错**；
 * - 元素 `date` / `text` 非字符串的**逐条过滤**，不因单条脏数据丢整批；
 * - `raw` 为 `null` / 数组 / 字符串等非对象输入同样返回 `[]`。
 *
 * @param raw 解析后的导出 JSON（任意形状，调用方无需预判）
 */
export function readExportWins(raw: unknown): ExportWinRowLike[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }
  const candidate = (raw as { wins?: unknown }).wins;
  if (!Array.isArray(candidate)) {
    return [];
  }
  const rows: ExportWinRowLike[] = [];
  for (const item of candidate) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const record = item as { date?: unknown; text?: unknown };
    if (typeof record.date !== 'string' || typeof record.text !== 'string') {
      continue;
    }
    rows.push({ date: record.date, text: record.text });
  }
  return rows;
}

/** 单份备份允许的最大 UTF-8 字节数。 */
export const MAX_EXPORT_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** 单个实体数组允许的最大记录数，避免非预期文件占用过多内存。 */
export const MAX_EXPORT_ROWS_PER_ENTITY = 50_000;

/** 恢复解析后使用的导出结构；与 shared-types 同构，但 core 不反向依赖 shared-types。 */
export interface ParsedExportPayload {
  meta: { app: 'qingshenghuo'; schemaVersion: 1 | 2; exportedAt: string };
  profile: {
    gender: 'male' | 'female';
    birthDate: string;
    heightCm: number;
    activityLevel: 'sedentary' | 'light' | 'moderate' | 'high' | 'athlete';
    dietaryPreference: string[];
    conditions: string[];
  };
  goals: {
    targetWeightKg: number;
    targetWeeks: number;
    macroRatio: { protein: number; fat: number; carb: number };
  };
  weights: Array<{ date: string; weightKg: number; note: string }>;
  meals: Array<{
    date: string;
    mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack';
    items: Array<{ name: string; grams: number; kcal: number; proteinG: number; fatG: number; carbG: number }>;
  }>;
  exercises: Array<{ date: string; type: string; met: number; minutes: number; kcalBurned: number }>;
  habits: Array<{ date: string; habitId: string; done: boolean }>;
  water: Array<{ date: string; ml: number }>;
  wins: ExportWinRowLike[];
  settings: { unit: 'kcal' | 'kj'; darkMode: boolean; fastingEnabled: boolean };
}

/** 恢复预览的事实统计。`meals` 按最终落库的餐次条目数计数。 */
export interface ExportPayloadSummary {
  counts: {
    weights: number;
    meals: number;
    exercises: number;
    habits: number;
    water: number;
    wins: number;
  };
  dateRange: { from: string; to: string } | null;
}

/** 解析未通过时的稳定原因码。 */
export type ExportPayloadParseErrorCode =
  | 'EXPORT_TOO_LARGE'
  | 'EXPORT_JSON_UNREADABLE'
  | 'EXPORT_SHAPE_MISMATCH'
  | 'EXPORT_VERSION_UNSUPPORTED';

/** 导出备份的解析结果：调用方必须先判断 `ok`，不会因用户文件内容而抛异常。 */
export type ParseExportPayloadResult =
  | { ok: true; payload: ParsedExportPayload; summary: ExportPayloadSummary }
  | { ok: false; error: { code: ExportPayloadParseErrorCode; message: string } };

class PayloadShapeError extends Error {}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PayloadShapeError(`${path} 需要是对象`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0) || Array.from(value).length > maxLength) {
    throw new PayloadShapeError(`${path} 不是可读取的文本`);
  }
  return value;
}

function readFiniteNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PayloadShapeError(`${path} 不是可读取的数字`);
  }
  return value;
}

function readInteger(value: unknown, path: string, min: number, max: number): number {
  const number = readFiniteNumber(value, path, min, max);
  if (!Number.isInteger(number)) {
    throw new PayloadShapeError(`${path} 需要是整数`);
  }
  return number;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PayloadShapeError(`${path} 需要是布尔值`);
  }
  return value;
}

function readArray<T>(
  value: unknown,
  path: string,
  mapper: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length > MAX_EXPORT_ROWS_PER_ENTITY) {
    throw new PayloadShapeError(`${path} 不是可读取的记录列表`);
  }
  return value.map(mapper);
}

function readStringArray(value: unknown, path: string): string[] {
  return readArray(value, path, (item, index) => readString(item, `${path}[${index}]`, 200, true));
}

function assertUniqueRows<T>(rows: readonly T[], path: string, keyOf: (row: T) => string): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (keys.has(key)) {
      throw new PayloadShapeError(`${path} 含重复记录`);
    }
    keys.add(key);
  }
}

/** 判断字符串是否为真实存在的 `YYYY-MM-DD` 公历日期。 */
function readDateKey(value: unknown, path: string): string {
  const text = readString(value, path, 10);
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (matched === null) {
    throw new PayloadShapeError(`${path} 不是日期`);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new PayloadShapeError(`${path} 不是日期`);
  }
  return text;
}

function parsePayloadObject(root: Record<string, unknown>): ParsedExportPayload {
  const meta = assertRecord(root.meta, 'meta');
  if (meta.app !== 'qingshenghuo') {
    throw new PayloadShapeError('meta.app 与轻生活备份不一致');
  }
  const schemaVersion = readInteger(meta.schemaVersion, 'meta.schemaVersion', 1, Number.MAX_SAFE_INTEGER);
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    const error = new PayloadShapeError('当前版本暂时不能读取这份备份');
    error.name = 'ExportPayloadVersionError';
    throw error;
  }
  const exportedAt = readString(meta.exportedAt, 'meta.exportedAt', 100);
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw new PayloadShapeError('meta.exportedAt 不是时间戳');
  }

  const profileRaw = assertRecord(root.profile, 'profile');
  const gender = readString(profileRaw.gender, 'profile.gender', 20);
  if (gender !== 'male' && gender !== 'female') {
    throw new PayloadShapeError('profile.gender 不在支持范围内');
  }
  const activityLevel = readString(profileRaw.activityLevel, 'profile.activityLevel', 20);
  if (!['sedentary', 'light', 'moderate', 'high', 'athlete'].includes(activityLevel)) {
    throw new PayloadShapeError('profile.activityLevel 不在支持范围内');
  }
  const profile: ParsedExportPayload['profile'] = {
    gender,
    birthDate: readDateKey(profileRaw.birthDate, 'profile.birthDate'),
    heightCm: readFiniteNumber(profileRaw.heightCm, 'profile.heightCm', 50, 300),
    activityLevel: activityLevel as ParsedExportPayload['profile']['activityLevel'],
    dietaryPreference: readStringArray(profileRaw.dietaryPreference, 'profile.dietaryPreference'),
    conditions: readStringArray(profileRaw.conditions, 'profile.conditions'),
  };

  const goalsRaw = assertRecord(root.goals, 'goals');
  const macroRaw = assertRecord(goalsRaw.macroRatio, 'goals.macroRatio');
  const macroRatio = {
    protein: readFiniteNumber(macroRaw.protein, 'goals.macroRatio.protein', 0, 100),
    fat: readFiniteNumber(macroRaw.fat, 'goals.macroRatio.fat', 0, 100),
    carb: readFiniteNumber(macroRaw.carb, 'goals.macroRatio.carb', 0, 100),
  };
  if (Math.abs(macroRatio.protein + macroRatio.fat + macroRatio.carb - 100) > 0.01) {
    throw new PayloadShapeError('goals.macroRatio 合计需要是 100');
  }
  const goals: ParsedExportPayload['goals'] = {
    targetWeightKg: readFiniteNumber(goalsRaw.targetWeightKg, 'goals.targetWeightKg', 1, 499),
    targetWeeks: readInteger(goalsRaw.targetWeeks, 'goals.targetWeeks', 1, 520),
    macroRatio,
  };

  const weights = readArray(root.weights, 'weights', (item, index) => {
    const row = assertRecord(item, `weights[${index}]`);
    return {
      date: readDateKey(row.date, `weights[${index}].date`),
      weightKg: readFiniteNumber(row.weightKg, `weights[${index}].weightKg`, 0.1, 499.9),
      note: readString(row.note, `weights[${index}].note`, 200, true),
    };
  });
  assertUniqueRows(weights, 'weights', (row) => row.date);

  const meals = readArray(root.meals, 'meals', (item, index) => {
    const row = assertRecord(item, `meals[${index}]`);
    const mealType = readString(row.mealType, `meals[${index}].mealType`, 20);
    if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(mealType)) {
      throw new PayloadShapeError(`meals[${index}].mealType 不在支持范围内`);
    }
    const items = readArray(row.items, `meals[${index}].items`, (mealItem, itemIndex) => {
      const entry = assertRecord(mealItem, `meals[${index}].items[${itemIndex}]`);
      return {
        name: readString(entry.name, `meals[${index}].items[${itemIndex}].name`, 200),
        grams: readFiniteNumber(entry.grams, `meals[${index}].items[${itemIndex}].grams`, 0, 1_000_000),
        kcal: readFiniteNumber(entry.kcal, `meals[${index}].items[${itemIndex}].kcal`, 0, 1_000_000),
        proteinG: readFiniteNumber(entry.proteinG, `meals[${index}].items[${itemIndex}].proteinG`, 0, 1_000_000),
        fatG: readFiniteNumber(entry.fatG, `meals[${index}].items[${itemIndex}].fatG`, 0, 1_000_000),
        carbG: readFiniteNumber(entry.carbG, `meals[${index}].items[${itemIndex}].carbG`, 0, 1_000_000),
      };
    });
    return {
      date: readDateKey(row.date, `meals[${index}].date`),
      mealType: mealType as ParsedExportPayload['meals'][number]['mealType'],
      items,
    };
  });

  const exercises = readArray(root.exercises, 'exercises', (item, index) => {
    const row = assertRecord(item, `exercises[${index}]`);
    return {
      date: readDateKey(row.date, `exercises[${index}].date`),
      type: readString(row.type, `exercises[${index}].type`, 100),
      met: readFiniteNumber(row.met, `exercises[${index}].met`, 0.1, 100),
      minutes: readFiniteNumber(row.minutes, `exercises[${index}].minutes`, 0.1, 10_000),
      kcalBurned: readFiniteNumber(row.kcalBurned, `exercises[${index}].kcalBurned`, 0, 1_000_000),
    };
  });

  const habits = readArray(root.habits, 'habits', (item, index) => {
    const row = assertRecord(item, `habits[${index}]`);
    return {
      date: readDateKey(row.date, `habits[${index}].date`),
      habitId: readString(row.habitId, `habits[${index}].habitId`, 100),
      done: readBoolean(row.done, `habits[${index}].done`),
    };
  });
  assertUniqueRows(habits, 'habits', (row) => `${row.date}|${row.habitId}`);

  const water = readArray(root.water, 'water', (item, index) => {
    const row = assertRecord(item, `water[${index}]`);
    return {
      date: readDateKey(row.date, `water[${index}].date`),
      ml: readInteger(row.ml, `water[${index}].ml`, 1, 1_000_000),
    };
  });

  const wins = readExportWins(root).map((row, index) => ({
    date: readDateKey(row.date, `wins[${index}].date`),
    text: readString(row.text, `wins[${index}].text`, 60),
  }));

  const settingsRaw = assertRecord(root.settings, 'settings');
  const unit = readString(settingsRaw.unit, 'settings.unit', 10);
  if (unit !== 'kcal' && unit !== 'kj') {
    throw new PayloadShapeError('settings.unit 不在支持范围内');
  }

  return {
    meta: { app: 'qingshenghuo', schemaVersion, exportedAt },
    profile,
    goals,
    weights,
    meals,
    exercises,
    habits,
    water,
    wins,
    settings: {
      unit,
      darkMode: readBoolean(settingsRaw.darkMode, 'settings.darkMode'),
      fastingEnabled: readBoolean(settingsRaw.fastingEnabled, 'settings.fastingEnabled'),
    },
  };
}

/** 统计恢复预览所需的 6 类记录条数与整体日期跨度。 */
export function summarizeExportPayload(payload: ParsedExportPayload): ExportPayloadSummary {
  const dates = [
    ...payload.weights.map((row) => row.date),
    ...payload.meals.map((row) => row.date),
    ...payload.exercises.map((row) => row.date),
    ...payload.habits.map((row) => row.date),
    ...payload.water.map((row) => row.date),
    ...payload.wins.map((row) => row.date),
  ].sort();
  return {
    counts: {
      weights: payload.weights.length,
      meals: payload.meals.reduce((count, meal) => count + meal.items.length, 0),
      exercises: payload.exercises.length,
      habits: payload.habits.length,
      water: payload.water.length,
      wins: payload.wins.length,
    },
    dateRange: dates.length === 0 ? null : { from: dates[0] as string, to: dates[dates.length - 1] as string },
  };
}

/**
 * 解析并校验轻生活 JSON 备份。
 *
 * 支持 schemaVersion 1/2；v1 没有 `wins` 时按空数组读取。函数无 IO、不会因用户输入抛异常，
 * API 与 Web 可复用同一口径。未知字段会被忽略，已知字段必须满足导出契约。
 */
export function parseExportPayload(
  raw: unknown,
  options: { maxBytes?: number } = {},
): ParseExportPayloadResult {
  const maxBytes = options.maxBytes ?? MAX_EXPORT_PAYLOAD_BYTES;
  let candidate: unknown = raw;
  try {
    if (typeof raw === 'string') {
      const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      if (new TextEncoder().encode(normalized).byteLength > maxBytes) {
        return { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: '这个文件内容太多，这次先不读取' } };
      }
      candidate = JSON.parse(normalized) as unknown;
    } else {
      const serialized = JSON.stringify(raw);
      if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > maxBytes) {
        return { ok: false, error: { code: 'EXPORT_TOO_LARGE', message: '这个文件内容太多，这次先不读取' } };
      }
    }
  } catch {
    return {
      ok: false,
      error: { code: 'EXPORT_JSON_UNREADABLE', message: '这次没能读出备份内容，请选择轻生活导出的 JSON 文件' },
    };
  }

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      ok: false,
      error: { code: 'EXPORT_SHAPE_MISMATCH', message: '这份内容与轻生活备份的格式不一致' },
    };
  }

  try {
    const payload = parsePayloadObject(candidate as Record<string, unknown>);
    return { ok: true, payload, summary: summarizeExportPayload(payload) };
  } catch (error) {
    if (error instanceof PayloadShapeError && error.name === 'ExportPayloadVersionError') {
      return {
        ok: false,
        error: { code: 'EXPORT_VERSION_UNSUPPORTED', message: '这份备份来自较新的版本，当前暂时不能读取' },
      };
    }
    return {
      ok: false,
      error: { code: 'EXPORT_SHAPE_MISMATCH', message: '这份内容与轻生活备份的格式不一致' },
    };
  }
}
