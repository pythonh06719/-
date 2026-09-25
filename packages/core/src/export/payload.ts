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
