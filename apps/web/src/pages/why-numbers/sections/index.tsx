import type { ReactElement } from 'react';
import type { WhySectionEntry, WhySectionId } from '../why-sections';
import BudgetSection from './BudgetSection';
import DataSourceSection from './DataSourceSection';
import ExerciseSection from './ExerciseSection';
import GoalProgressSection from './GoalProgressSection';
import SimpleSection from './SimpleSection';
import type { SimpleSectionContent } from './types';
import {
  AI_USAGE_SECTION,
  BACKUP_SECTION,
  CHOICE_SECTION,
  DAILY_AVG_SECTION,
  DISTINCT_FOODS_SECTION,
  FASTING_SECTION,
  FOOTPRINT_SECTION,
  HABIT_STREAK_SECTION,
  MEAL_ORDER_SECTION,
  PERIOD_SECTION,
  PLATEAU_SECTION,
  PORTION_SECTION,
  PENDING_SYNC_SECTION,
  RESTORE_SECTION,
  SFA_SECTION,
  TAPER_SECTION,
  TOP_FOODS_SECTION,
  TOOL_MEMORY_SECTION,
  WATER_PROGRESS_SECTION,
  WEEKLY_SECTION,
  WEIGHT_RANGE_SECTION,
  WINS_SECTION,
} from './simple-sections';

/**
 * `/why-numbers` 26 条的**注册表**：锚点 id → 渲染函数。
 *
 * ## 它解决什么问题
 *
 * 改造前 26 条是 `WhyNumbersPage.tsx` 里 1549 行手写 JSX：加一条要在千行文件里找位置插拔，
 * 删一条要连删四段 JSX 还得惦记着别碰坏相邻条目，编号/标题与目录的漂移只能靠测试对拍兜底。
 *
 * 现在：
 *   - `WhyNumbersPage.tsx` 只做「按 `WHY_SECTIONS` 顺序逐条渲染」的薄壳；
 *   - 每条内容的去向只有两个：**专用组件**（①②③⑤，含表格 / 实时计算 / 卡片式补充说明）或
 *     **数据对象**（④、⑥…㉖，见 `simple-sections.tsx`）；
 *   - **标题与锚点永远来自 `why-sections.ts` 真源**（`WhySection` 对象透传），
 *     组件不自己抄一份 —— 「目录 ↔ 正文」漂移从源头消除；
 *   - 新增第 27 条时漏登记：`Record<WhySectionId, …>` 的 key 检查在**编译期**直接报错。
 *
 * ## key 与内容的绑定为什么不可能错位
 *
 * 数据化条目用 `[XXX_SECTION.id]: simple(XXX_SECTION)` 的 computed key ——
 * key 取自数据对象自己的 `id` 字面量（`as const` 保真），内容与锚点在源码里
 * 相邻且同源。写错 id 会撞上 `WhySectionId` 联合的穷尽性检查（编译期）。
 */

/** 渲染一条解释条目：`section` 携带真源的 id 与标题，组件只负责内容。 */
export type SectionRenderer = (section: WhySectionEntry) => ReactElement;

/** 把数据化条目的内容包成渲染函数（id/title 仍由真源经 `section` 传入）。 */
function simple(content: SimpleSectionContent): SectionRenderer {
  return (section) => <SimpleSection id={section.id} title={section.title} content={content} />;
}

/**
 * 26 条的渲染函数表。
 *
 * ⚠️ 这里是**唯一**需要手同步的地方：`why-sections.ts` 加了标题，这里必须加对应 key
 *    （编译期穷尽性检查会提醒你）；反过来这里多一个 key 也会编译报错。
 */
const RENDERERS: Readonly<Record<WhySectionId, SectionRenderer>> = {
  'why-budget-title': (section) => <BudgetSection id={section.id} title={section.title} />,
  'why-exercise-title': (section) => <ExerciseSection id={section.id} title={section.title} />,
  'why-data-title': (section) => <DataSourceSection id={section.id} title={section.title} />,
  'why-goal-progress-title': (section) => (
    <GoalProgressSection id={section.id} title={section.title} />
  ),
  [CHOICE_SECTION.id]: simple(CHOICE_SECTION),
  [PLATEAU_SECTION.id]: simple(PLATEAU_SECTION),
  [WEIGHT_RANGE_SECTION.id]: simple(WEIGHT_RANGE_SECTION),
  [WEEKLY_SECTION.id]: simple(WEEKLY_SECTION),
  [TAPER_SECTION.id]: simple(TAPER_SECTION),
  [MEAL_ORDER_SECTION.id]: simple(MEAL_ORDER_SECTION),
  [TOP_FOODS_SECTION.id]: simple(TOP_FOODS_SECTION),
  [BACKUP_SECTION.id]: simple(BACKUP_SECTION),
  [PERIOD_SECTION.id]: simple(PERIOD_SECTION),
  [DISTINCT_FOODS_SECTION.id]: simple(DISTINCT_FOODS_SECTION),
  [WINS_SECTION.id]: simple(WINS_SECTION),
  [SFA_SECTION.id]: simple(SFA_SECTION),
  [AI_USAGE_SECTION.id]: simple(AI_USAGE_SECTION),
  [PORTION_SECTION.id]: simple(PORTION_SECTION),
  [RESTORE_SECTION.id]: simple(RESTORE_SECTION),
  [TOOL_MEMORY_SECTION.id]: simple(TOOL_MEMORY_SECTION),
  [PENDING_SYNC_SECTION.id]: simple(PENDING_SYNC_SECTION),
  [DAILY_AVG_SECTION.id]: simple(DAILY_AVG_SECTION),
  [FOOTPRINT_SECTION.id]: simple(FOOTPRINT_SECTION),
  [FASTING_SECTION.id]: simple(FASTING_SECTION),
  [HABIT_STREAK_SECTION.id]: simple(HABIT_STREAK_SECTION),
  [WATER_PROGRESS_SECTION.id]: simple(WATER_PROGRESS_SECTION),
};

/**
 * 渲染一条解释条目。
 *
 * 形参用 `WhySectionEntry`（id 是字面量联合）而非宽泛的 `WhySection`：
 * `RENDERERS` 是 `Record<WhySectionId, …>`（编译期穷尽），字面量键查找直接命中、
 * 不需要兜底分支；传入宽泛 `string` 反而会被 TS 拒绝（索引类型不匹配）。
 */
export function renderSection(section: WhySectionEntry): ReactElement {
  return RENDERERS[section.id](section);
}
