/**
 * 本地日期工具（零依赖纯函数，ARCHITECTURE §7 K5 / D1）。
 *
 * **硬性约束**：日粒度一律使用**本地时区**的 `YYYY-MM-DD`；
 * 禁止使用 `toISOString().slice(0, 10)`（会因 UTC 偏移产生日期错位）。
 *
 * 时间不通过 `Date.now()` 获取，一律由参数注入，保证纯函数可测（K8）。
 */

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 将 `Date` 转为**本地时区**的 `YYYY-MM-DD` 日期键。
 *
 * @param date 任意 Date（按运行环境的本地时区解读）
 */
export function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 解析 `YYYY-MM-DD` 字符串为**本地时区**当日 00:00 的 `Date`。
 * 非该格式时回退到原生 `new Date(value)`。
 */
function parseDateOnly(value: string): Date {
  const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (!matched) {
    return new Date(value);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  return new Date(year, month - 1, day);
}

/**
 * 由出生日期与当前时间计算周岁年龄（纯函数，时间由参数注入）。
 *
 * 生日当天及之后按新一岁计；未过生日则减 1 岁。
 *
 * @param birthDate 出生日期（`YYYY-MM-DD` 字符串或 `Date`）
 * @param now 当前时间（用于计算，注入以避免依赖运行时时钟）
 * @returns 周岁年龄；输入非法时返回 `NaN`
 */
export function ageFromBirthDate(birthDate: string | Date, now: Date): number {
  const birth = typeof birthDate === 'string' ? parseDateOnly(birthDate) : birthDate;

  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

/**
 * 校验 `YYYY-MM-DD` 是否为**真实存在的日历日期**（含位数与闰年检查）。
 *
 * 供 CSV 导入等外部输入边界使用（PRD §9.3）：`2026-02-30` 之类不存在的日期必须拒绝。
 */
export function isLocalDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
