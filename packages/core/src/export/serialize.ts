/**
 * 数据主权序列化（PRD §9 / 共享知识 K11）—— **零依赖纯函数**。
 *
 * 这是 CSV 序列化/解析的**前后端唯一真源**：
 * - `apps/api` 的 `data` 模块用它做服务端导出与 CSV 导入；
 * - `apps/web` 的 `lib/csv.ts` 委托到本模块（保留原导出面，行为不变）。
 *
 * 约定：
 * - CSV：**UTF-8 with BOM**（`\uFEFF`，Excel 中文不乱码）、首行表头、日期 `YYYY-MM-DD`、
 *   逗号/引号/换行按 RFC 4180 转义；
 * - 导入：仅历史体重（§9.3），同日期覆盖，非法行**跳过并汇总**，不影响合法行。
 */

import { isLocalDateKey } from '../date/daykey';

/** UTF-8 BOM。 */
export const CSV_BOM = '\uFEFF';

/**
 * 转义单个 CSV 字段（RFC 4180）。
 * 含 `,` / `"` / 换行时用双引号包裹，内部 `"` 翻倍。
 *
 * **公式注入防护**：以 `=` `+` `-` `@` 或制表/回车开头的文本单元格
 * 会被 Excel/WPS 当作公式执行（如 `=HYPERLINK(...)`），统一前置单引号 `'` 中和。
 * 副作用：重新导入该 CSV 时此类字段会带前导 `'`，属可接受的安全取舍。
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  // 公式注入中和必须在引号包裹**之前**：带引号的 `=公式` 单元格在 Excel 里同样会执行
  const neutralized = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/**
 * 序列化 CSV 主体（**不含 BOM**，BOM 由 `withBom` 统一添加）。
 *
 * @param columns 表头列顺序
 * @param rows 行数据（键名 = 列名）
 */
export function serializeCsv<T extends object>(
  columns: readonly string[],
  rows: readonly T[],
): string {
  const header = columns.map(escapeCsvField).join(',');
  const body = rows.map((row) =>
    columns.map((column) => escapeCsvField((row as Record<string, unknown>)[column])).join(','),
  );
  return [header, ...body].join('\r\n');
}

/** 为 CSV 文本添加 UTF-8 BOM（K11）。 */
export function withBom(text: string): string {
  return `${CSV_BOM}${text}`;
}

/** 单行 CSV 解析（支持引号包裹与 `""` 转义）。 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** CSV 导入（§9.3 历史体重）解析结果。 */
export interface ParsedWeightCsv {
  /** 合法行（`note` 为空时省略该键） */
  rows: Array<{ date: string; weightKg: number; note?: string }>;
  /** 非法行明细（行号从 1 开始，含表头行） */
  errors: Array<{ row: number; reason: string }>;
}

/**
 * 解析历史体重 CSV（§9.3）。
 *
 * - 自动跳过 BOM；表头列顺序不限，按列名匹配 `date` / `weightKg` / `note`；
 * - `date` 必须为真实存在的 `YYYY-MM-DD`；`weightKg` 必须为 `0 < w < 500` 的数字；
 * - `note` 可选，超过 200 字截断；
 * - 非法行**跳过并汇总**，不影响合法行。
 */
export function parseWeightCsv(text: string): ParsedWeightCsv {
  const errors: Array<{ row: number; reason: string }> = [];
  const rows: ParsedWeightCsv['rows'] = [];

  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return { rows, errors: [{ row: 1, reason: '文件是空的，没有可导入的内容' }] };
  }

  // `lines` 已过滤空行且非空，`lines[0]` 必然存在（noUncheckedIndexedAccess 下的收窄）
  const headerLine = lines[0] ?? '';
  const header = splitCsvLine(headerLine).map((cell) => cell.trim().replace(/^\uFEFF/, ''));
  const dateIndex = header.indexOf('date');
  const weightIndex = header.indexOf('weightKg');
  const noteIndex = header.indexOf('note');

  if (dateIndex === -1 || weightIndex === -1) {
    return { rows, errors: [{ row: 1, reason: '表头需要包含 date 与 weightKg 两列' }] };
  }

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const cells = splitCsvLine(lines[lineIndex] ?? '');
    const rowNumber = lineIndex + 1;

    const dateValue = (cells[dateIndex] ?? '').trim();
    const weightRaw = (cells[weightIndex] ?? '').trim();
    const noteRaw = noteIndex === -1 ? '' : (cells[noteIndex] ?? '').trim();

    if (!isLocalDateKey(dateValue)) {
      errors.push({ row: rowNumber, reason: `日期「${dateValue || '空'}」需要是 YYYY-MM-DD 格式` });
      continue;
    }
    const weightKg = Number(weightRaw);
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg >= 500) {
      errors.push({
        row: rowNumber,
        reason: `体重「${weightRaw || '空'}」需要是 0 到 500 之间的数字`,
      });
      continue;
    }

    const note = noteRaw.length > 200 ? noteRaw.slice(0, 200) : noteRaw;
    rows.push(note === '' ? { date: dateValue, weightKg } : { date: dateValue, weightKg, note });
  }

  return { rows, errors };
}
