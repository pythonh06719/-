import { toLocalDateKey } from '@qsh/core';

/**
 * 日期与数字格式化（lib/format.ts）—— 全部使用**本地时区**（K5 / D1）。
 *
 * ⚠️ 硬约束：**禁止** `toISOString().slice(0, 10)` 生成日期键（会因 UTC 偏移产生错位），
 * 日期键一律经由 `toLocalDateKey` 或本文件中的纯函数生成/解析。
 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const WEEKDAYS_SHORT = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 当前设备本地时区的今天（`YYYY-MM-DD`）。 */
export function todayKey(now: Date = new Date()): string {
  return toLocalDateKey(now);
}

/** 解析 `YYYY-MM-DD` 为本地时区当日 00:00 的 Date（非法输入回退 `new Date(value)`）。 */
export function parseDateKey(key: string): Date {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(key);
  if (matched === null) {
    return new Date(key);
  }
  return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
}

/** 是否为合法的 `YYYY-MM-DD`。 */
export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** 日期键加减天数（本地时区，自动跨月/跨年）。 */
export function addDays(key: string, delta: number): string {
  const date = parseDateKey(key);
  date.setDate(date.getDate() + delta);
  return toLocalDateKey(date);
}

/** 两个日期键相差天数（`b - a`）。 */
export function diffDays(a: string, b: string): number {
  const start = parseDateKey(a).getTime();
  const end = parseDateKey(b).getTime();
  return Math.round((end - start) / (24 * 3600 * 1000));
}

/** 星期文案（`周五`）。 */
export function weekdayLabel(key: string): string {
  return WEEKDAYS[parseDateKey(key).getDay()] ?? '';
}

/** 一周七天的短标签（`一`…`日`），供迷你趋势轴使用。 */
export function weekdayShort(key: string): string {
  return WEEKDAYS_SHORT[parseDateKey(key).getDay()] ?? '';
}

/** `9月12日`。 */
export function formatMonthDay(key: string): string {
  const date = parseDateKey(key);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** `2026年9月12日`。 */
export function formatFullDate(key: string): string {
  const date = parseDateKey(key);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** `9月12日 周五`；今天/昨天/明天用更亲切的称谓。 */
export function formatDateLabel(key: string, now: Date = new Date()): string {
  const today = todayKey(now);
  if (key === today) {
    return `今天 · ${weekdayLabel(key)}`;
  }
  if (key === addDays(today, -1)) {
    return `昨天 · ${weekdayLabel(key)}`;
  }
  if (key === addDays(today, 1)) {
    return `明天 · ${weekdayLabel(key)}`;
  }
  return `${formatMonthDay(key)} · ${weekdayLabel(key)}`;
}

/** 数字千分位。 */
export function formatNumber(value: number, fractionDigits = 0): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** 体重（1 位小数）。 */
export function formatWeight(kg: number): string {
  return Number.isFinite(kg) ? kg.toFixed(1) : '—';
}

/** 有符号变化量（如 `-0.8` / `+0.3`）。 */
export function formatSigned(value: number, fractionDigits = 1): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(fractionDigits)}`;
}

/** 毫升 → 口语化（`1.5 L` / `250 ml`）。 */
export function formatMl(ml: number): string {
  if (ml >= 1000) {
    return `${(ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 1)} L`;
  }
  return `${Math.round(ml)} ml`;
}
