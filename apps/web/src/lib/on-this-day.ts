import { isDateKey } from '@/lib/format';
import { toLocalDateKey } from '@qsh/core';

/**
 * 「历史上的今天」（D-4）——「一年前 / 一个月前的今天」的日期对齐（零 IO 纯函数）。
 *
 * ## 落点说明：为什么在 `lib/` 而不是 `packages/core`
 *
 * 本项目日期纯函数有两个**并列**的归属：
 * - `packages/core/src/date/daykey.ts`：需要**前后端共用**的口径（K5 时区规则、`ageFromBirthDate`）；
 * - `apps/web/src/lib/format.ts`：**只有前端用**的日期工具（`addDays` / `diffDays` / `formatMonthDay` …）。
 *
 * 本模块属于后者：**只有回望卡一个调用方**（本功能零后端改动，不存在共用需求），
 * 故按既有惯例放进 `lib/`，与 `lib/month-grid.ts`（同样是「算给前端看的日期」）一致。
 *
 * ⚠️ 另有一层现实约束：`packages/core/src/index.ts` 是多人共改的 barrel，
 * 且 `@qsh/core` 只暴露 `.`（无子路径导出），前端必须经由 barrel 取函数。
 * 为避免与并行的其他任务争抢同一个 barrel，本模块自持于前端 `lib/`。
 *
 * ## 纯度与可测性（K8）
 *
 * 时间**一律由参数注入**，绝不读 `Date.now()`；所有边界（跨年 / 跨月 / 闰日）
 * 都能脱离 React 单测，测试不会随日历漂移。
 *
 * ## 语气红线
 *
 * 本模块只产出**日期键**，不是任何统计口径数字 —— 故本功能**不需要**在
 * `/why-numbers` 登记新条目（NFR-11）：没有新增任何「算出来的数字」。
 *
 * ⚠️ 调用方**只允许**用它取「那一天的日期」，**不得**由日期差派生
 * 「隔了 N 天」「连续 N 天」这类带分母的表述 —— 那会把回望变成缺席指控。
 */

/** 回望的时间尺度（一次只呈现一个，见 {@link onThisDayCandidates}）。 */
export type OnThisDayScale = 'year' | 'month';

/** 一个候选回望日。 */
export interface OnThisDayTarget {
  /** 时间尺度：`year` = 一年前，`month` = 一个月前。 */
  readonly scale: OnThisDayScale;
  /** 那一天的本地日期键（`YYYY-MM-DD`），已确认是**真实存在**的日历日。 */
  readonly dateKey: string;
}

/**
 * 某年某月的**最后一天**（内部工具）。
 *
 * ⚠️ 刻意用 `setFullYear` 而非 `new Date(year, ...)`：两位数年份会被引擎映射到 20xx
 *（`new Date(50, 0, 1)` 实为 1950 年），日期口径绝不能踩这个坑。
 */
function lastDayOfMonth(year: number, monthIndex: number): number {
  const probe = new Date(2000, 0, 1);
  // `day = 0` 表示「目标月的最后一天」（上月的第 0 天）。
  probe.setFullYear(year, monthIndex + 1, 0);
  return probe.getDate();
}

/**
 * 构造本地时区的 `Date`，并**钳制**到目标月的合法天数。
 *
 * 钳制是「一个月前的今天」在月末的既定口径（3 月 31 日 → 2 月 28 日），
 * 与「每月账单落在当月最后一天」同源；不钳制则会溢出成3 月 3 日那种明显错位的结果。
 */
function makeClampedLocalDate(year: number, monthIndex: number, day: number): Date {
  const safeDay = Math.min(Math.max(day, 1), lastDayOfMonth(year, monthIndex));
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, monthIndex, safeDay);
  return date;
}

/** 拆出日期键的年月日；非法或年份过小（不足以做「一年前」）时返回 `null`。 */
function partsOf(dateKey: string): { year: number; monthIndex: number; day: number } | null {
  if (!isDateKey(dateKey)) {
    return null;
  }
  const year = Number(dateKey.slice(0, 4));
  const monthIndex = Number(dateKey.slice(5, 7)) - 1;
  const day = Number(dateKey.slice(8, 10));
  // 年份 < 100 会踩两位数年份映射，且「一年前」落到公元 0 年没有意义。
  if (!Number.isFinite(year) || year < 100) {
    return null;
  }
  return { year, monthIndex, day };
}

/**
 * 「一年前的今天」；那一天在日历上**不存在**时返回 `null`。
 *
 * 唯一会不存在的日子是 **2 月 29 日**遇到非闰年（如 2028-02-29 → 2027-02-29）。
 *
 * ⚠️ 此处**刻意不钳制**到 2 月 28 日：那一天是「一年零一天前」，说成「一年前的今天」
 * 是不准确的。宁可少给一个候选（调用方顺延到「一个月前」），也不给一个假的对齐 ——
 * 这与本项目「宁可留白也不说错」的口径一致。
 */
export function resolveYearAgoDateKey(todayKey: string): string | null {
  const parts = partsOf(todayKey);
  if (parts === null) {
    return null;
  }
  const target = makeClampedLocalDate(parts.year - 1, parts.monthIndex, parts.day);
  // 回环校验：2 月 29 日会被引擎进位成 3 月 1 日 → 分量对不上 → 判定「不存在」。
  if (
    target.getFullYear() !== parts.year - 1 ||
    target.getMonth() !== parts.monthIndex ||
    target.getDate() !== parts.day
  ) {
    return null;
  }
  return toLocalDateKey(target);
}

/**
 * 「一个月前的今天」；目标月没有那一天时**钳制到当月最后一天**。
 *
 * - 2026-01-31 → 2025-12-31（跨年正常）
 * - 2026-03-31 → 2026-02-28（平年）/ 2026-02-29（闰年）
 * - 2028-02-29 → 2028-01-29（精确一个月，无需钳制）
 */
export function resolveMonthAgoDateKey(todayKey: string): string | null {
  const parts = partsOf(todayKey);
  if (parts === null) {
    return null;
  }
  const target = makeClampedLocalDate(parts.year, parts.monthIndex - 1, parts.day);
  return toLocalDateKey(target);
}

/**
 * 「历史上的今天」的候选日，**按优先级排序**（最多两个）。
 *
 * ## 排序即产品决策：为什么不提供一个「切换器」
 *
 * 候选顺序固定为「一年前 → 一个月前」，由调用方**取第一个真有记录的那天**。
 * 这带来两个关键性质：
 *
 * 1. **一次只呈现一个时间尺度** —— 页面上永远只有一张回望卡，
 *    不给「一年前 / 一个月前 / 两年前」的选择器。
 *    带选择器的版本会立刻退化成「打卡集邮册」：用户在挑一个尺度去集齐，
 *    而本功能的全部价值是「被动唤起一段记忆」，不是「挑选可集邮的条目」。
 *    **更关键**：选择器会让用户主动去查一个空尺度，而「空」这个结果
 *    本身就是一次缺席指控 —— 与本功能的初衷直接冲突。
 * 2. **空的那一天完全不可见** —— 若「一年前」无记录，用户看到的是「一个月前」那天，
 *    **不会看到任何关于「一年前」缺失的痕迹**（无空态、无引导、无计数）。
 *    这正是「无历史记录时整块隐藏」得以成立的原因：
 *    缺失不是被展示出来的，而是被**顺延**掉的。
 *
 * ⚠️ 调用方**不得**因为两个候选都没记录而渲染任何兜底文案 ——
 * 那会把「顺延」变成「缺席指控」。正确做法是整块隐藏。
 *
 * @param todayKey 今天（`YYYY-MM-DD`）
 * @returns 候选列表（可能为空 —— 非法输入，或该日不存在任何可回望的对齐日）
 */
export function onThisDayCandidates(todayKey: string): OnThisDayTarget[] {
  if (!isDateKey(todayKey)) {
    return [];
  }
  const targets: OnThisDayTarget[] = [];
  const yearAgo = resolveYearAgoDateKey(todayKey);
  if (yearAgo !== null && yearAgo < todayKey) {
    targets.push({ scale: 'year', dateKey: yearAgo });
  }
  const monthAgo = resolveMonthAgoDateKey(todayKey);
  if (monthAgo !== null && monthAgo < todayKey && monthAgo !== yearAgo) {
    targets.push({ scale: 'month', dateKey: monthAgo });
  }
  return targets;
}