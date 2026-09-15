/**
 * 输出取整工具（ARCHITECTURE §4.4）。
 *
 * 中间链路保留浮点，**仅输出取整**；此处的工具只用于输出字段的最后一步取整。
 */

/** 四舍五入保留 1 位小数。 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 四舍五入保留 2 位小数。 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
