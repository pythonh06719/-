/**
 * 服务端本地日期工具（ARCHITECTURE §7 K5 / D1）。
 *
 * **硬性约束**：日粒度一律使用**本地时区** `YYYY-MM-DD`；
 * 禁止 `toISOString().slice(0, 10)`（会因 UTC 偏移产生日期错位）。
 */

import { toLocalDateKey } from '@qsh/core';

/** `YYYY-MM-DD` 正则（宽松到 1 位月/日，与引擎解析一致）。 */
export const LOCAL_DATE_PATTERN = /^\d{4}-\d{1,2}-\d{1,2}$/;

/** 严格 `YYYY-MM-DD` 正则（供 DTO 校验）。 */
export const LOCAL_DATE_PATTERN_STRICT = /^\d{4}-\d{2}-\d{2}$/;

/** 今日（本地时区）`YYYY-MM-DD`。 */
export function todayLocalKey(now: Date = new Date()): string {
  return toLocalDateKey(now);
}

/** 解析 `YYYY-MM-DD` 为本地时区当日 00:00 的 `Date`。 */
export function parseLocalDateKey(dateKey: string): Date {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateKey);
  if (!matched) {
    return new Date(dateKey);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  return new Date(year, month - 1, day);
}

/** 日期键加减天数（本地时区），返回新的 `YYYY-MM-DD`。 */
export function addDays(dateKey: string, delta: number): string {
  const date = parseLocalDateKey(dateKey);
  date.setDate(date.getDate() + delta);
  return toLocalDateKey(date);
}

/** 判断字符串是否为合法的本地日期键。 */
export function isValidLocalDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN_STRICT.test(value)) {
    return false;
  }
  const date = parseLocalDateKey(value);
  return !Number.isNaN(date.getTime()) && toLocalDateKey(date) === value;
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 把「日粒度」字段值归一为 `YYYY-MM-DD`。
 *
 * 为什么需要这个函数：`logged_at` 在当前 SQLite schema 下是 `String`，直接 `.slice(0, 10)`
 * 可用；但迁移到 PG 的 `DateTime @db.Date` 后，Prisma 会返回 **`Date`**（UTC 00:00），
 * 对 `Date` 调 `.slice` 会直接 `TypeError`（本地不可复现的线上崩溃）。
 *
 * - `string`：取日期头部（兼容 `'YYYY-MM-DD'` 与 `dbgenerated` 写入的
 *   `'YYYY-MM-DDThh:mm:ss.sssZ'` 两种形态）；
 * - `Date`：date-only 列按 **UTC 分量**取值 —— `@db.Date` 语义就是「无时区的日历日」，
 *   Prisma 以 UTC 00:00 承载；用本地分量会在负时区把日期往回偏移一天。
 *
 * ⚠️ 这里刻意**不用** `value.toISOString().slice(0, 10)`：文件头已明令禁止该写法
 * （它对「当前时刻」会把 UTC 日误当本地日）；本函数只服务于**已是日期粒度**的值。
 */
export function toDateKey(value: string | Date): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  return value.slice(0, 10);
}

/** 两个日期键之间的天数差（`to − from`，按本地日历天）。 */
export function diffDays(fromKey: string, toKey: string): number {
  const from = parseLocalDateKey(fromKey).getTime();
  const to = parseLocalDateKey(toKey).getTime();
  return Math.round((to - from) / 86_400_000);
}

// ---------------------------------------------------------------------------
// 月份键 `YYYY-MM`（C-1 记录足迹日历的查询参数）
// ---------------------------------------------------------------------------

/** 严格 `YYYY-MM` 正则（供 DTO 校验）。 */
export const MONTH_PATTERN_STRICT = /^\d{4}-\d{2}$/;

/**
 * 判断字符串是否为合法的**月份键** `YYYY-MM`：格式正确且月份在 `01~12`。
 *
 * ⚠️ 服务端只接收 `01~12` 两位月（`2026-9` / `2026-13` 一律拒绝）——
 * 月份参数直接决定查询区间，宽松解析会静默落到别的月份（与 `endDate` 同口径，宁拒绝不猜测）。
 */
export function isValidMonthKey(value: unknown): value is string {
  if (typeof value !== 'string' || !MONTH_PATTERN_STRICT.test(value)) {
    return false;
  }
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

/** 某年某月的天数（不依赖 `Date`：避开 JS `Date` 对 0–99 年做 1900 偏移的坑）。 */
function daysInMonth(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const table = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1] ?? 31;
}

/**
 * 月份键 `YYYY-MM` → 该月的首日 / 末日（`YYYY-MM-01` / `YYYY-MM-DD`）。
 *
 * 非法入参返回 `null`（调用方转 400），**不做任何隐式默认**。
 */
export function monthDateRange(monthKey: string): { from: string; to: string } | null {
  if (!isValidMonthKey(monthKey)) {
    return null;
  }
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad2(daysInMonth(year, month))}` };
}
