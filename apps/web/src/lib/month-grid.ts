/**
 * 月历网格的纯计算（lib/month-grid.ts，C-1 记录足迹日历）。
 *
 * 只做「把 `YYYY-MM` 摊成一张按周排布的格子」这一件事 —— 不涉及颜色、不涉及数据。
 * 颜色深浅由 `@qsh/core` 的 `calendarDepthLevel` 决定（唯一口径），本文件不碰。
 *
 * ⚠️ 一律本地日期语义；`YYYY-MM` 非法时返回空数组 / 原值（调用方不会崩）。
 * ⚠️ JS `Date` 对 0–99 年会做 +1900 偏移，故计算星期时先 +400 年
 * （400 年一循环，星期与闰年规律完全一致）。
 */

/** 周一到周日的表头短标签（中国日历习惯以周一为一周开始）。 */
export const WEEKDAY_HEADERS: readonly string[] = ['一', '二', '三', '四', '五', '六', '日'];

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `YYYY-MM` 是否合法（格式 + 月份 01~12）。 */
export function isMonthKey(value: string): boolean {
  const matched = MONTH_KEY_PATTERN.exec(value);
  if (matched === null) {
    return false;
  }
  const month = Number(matched[2]);
  return month >= 1 && month <= 12;
}

/** 日期键 `YYYY-MM-DD` → 月份键 `YYYY-MM`。 */
export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

/** 当前本地月份的键 `YYYY-MM`。 */
export function currentMonthKey(now: Date = new Date()): string {
  const date = now;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** 某年某月的天数（不依赖 `Date`，规避 0–99 年偏移）。 */
function daysInMonth(year: number, month: number): number {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const table = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1] ?? 31;
}

/** 该月 1 号是星期几（周一 = 0 … 周日 = 6）。 */
function firstWeekdayIndex(year: number, month: number): number {
  const safeYear = year < 100 ? year + 400 : year;
  const day = new Date(Date.UTC(safeYear, month - 1, 1)).getUTCDay();
  return (day + 6) % 7;
}

/** 月份键加减若干月（自动跨年）；非法入参原样返回。 */
export function addMonths(monthKey: string, delta: number): string {
  const matched = MONTH_KEY_PATTERN.exec(monthKey);
  if (matched === null) {
    return monthKey;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (((total % 12) + 12) % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${pad2(nextMonth)}`;
}

/**
 * 把月份键摊成网格格子（左到右、上到下）。
 *
 * 返回长度恒为 7 的倍数；`null` 表示对齐用的**空格子**（月初 / 月末补位，不渲染日期）。
 */
export function buildMonthCells(monthKey: string): Array<string | null> {
  const matched = MONTH_KEY_PATTERN.exec(monthKey);
  if (matched === null) {
    return [];
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (month < 1 || month > 12) {
    return [];
  }
  const cells: Array<string | null> = [];
  const lead = firstWeekdayIndex(year, month);
  for (let index = 0; index < lead; index += 1) {
    cells.push(null);
  }
  const total = daysInMonth(year, month);
  for (let day = 1; day <= total; day += 1) {
    cells.push(`${monthKey}-${pad2(day)}`);
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  return cells;
}
