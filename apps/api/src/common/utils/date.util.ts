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
