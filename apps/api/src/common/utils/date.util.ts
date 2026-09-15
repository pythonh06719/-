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

/** 两个日期键之间的天数差（`to − from`，按本地日历天）。 */
export function diffDays(fromKey: string, toKey: string): number {
  const from = parseLocalDateKey(fromKey).getTime();
  const to = parseLocalDateKey(toKey).getTime();
  return Math.round((to - from) / 86_400_000);
}
