/**
 * 记录足迹日历的深浅口径（core/report/calendar.ts）—— C-1 的**唯一真源**（零 IO、零依赖）。
 *
 * 需求来源：`docs/PRD-新增功能探索-2026-09-28.md` §C-1 与 QC-2 ——
 * 用颜色**深浅**表示当天记录的「丰富度」，映射的是**当天有记录的模块数量**
 * （体重 / 饮食 / 饮水 / 习惯 / 运动 / 体重之外的变化），
 * **不映射**热量、营养或任何质量指标。
 *
 * ## 分档（几类算深）
 *
 * 把「记了几类」钳制到 **3 档**（PRD 举例：只记了体重 = 浅，记了饮食 + 体重 = 深）：
 * - `1` 类 → 第 1 档（浅）
 * - `2` 类 → 第 2 档（深）
 * - `≥3` 类 → 第 3 档（更深，封顶）
 * - `0` 类 → `0`，即**不点亮**（留白 —— 不是「第 0 档颜色」，无任何负向视觉）
 *
 * ⚠️ **这不是打分**：档位只反映「记的种类多不多」，与「记得好不好」无关；
 * 前端配色、图例与 `/why-numbers` ㉓ 都引用本函数，任何一侧不得自行分档。
 *
 * 本模块不得 import `@qsh/shared-types`（K12）—— 返回值为纯数字，天然满足。
 */

/** 深浅的最大档位（第 3 档 = 「3 类及以上」，与 `/why-numbers` ㉓ 同源）。 */
export const CALENDAR_DEPTH_MAX_LEVEL = 3;

/**
 * 把「当天有记录的模块数量」映射为深浅档位。
 *
 * @param recordedModuleCount 当天有记录的模块数量（≥0；非有限值按 0 处理）
 * @returns `0`（无记录 → 留白）或 `1` ~ {@link CALENDAR_DEPTH_MAX_LEVEL}
 */
export function calendarDepthLevel(recordedModuleCount: number): number {
  if (!Number.isFinite(recordedModuleCount)) {
    return 0;
  }
  const count = Math.floor(recordedModuleCount);
  if (count <= 0) {
    return 0;
  }
  return Math.min(CALENDAR_DEPTH_MAX_LEVEL, count);
}
