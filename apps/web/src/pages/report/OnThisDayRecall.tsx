import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import type { ListMealsResponse, MealGroup, MealType } from '@qsh/shared-types';
import { onThisDayCandidates } from '@/lib/on-this-day';
import type { OnThisDayTarget } from '@/lib/on-this-day';

import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { formatFullDate, todayKey, weekdayLabel } from '@/lib/format';
import { resolveMealLogName } from '@/lib/meal-name';
import { MEAL_TYPE_LABELS, MEAL_TYPE_ORDER } from '@/pages/diary/meal-utils';
import { COPY, onThisDayOpenFullAria } from '@/lib/copy';

/**
 * 「历史上的今天」（D-4）—— 一年前 / 一个月前的今天，你记了什么。
 *
 * ## 落点：`/report` 的「足迹」tab 顶部（挂在 `FootprintView` 里）
 *
 * 选这里的理由：
 * - **语义最近**：足迹 tab 本来就是「往回看自己记过什么」的地方，
 *   「一年前的今天」是同一个心智模型的自然延伸，不新造入口；
 * - **主动进入才展示**（NFR-10）：足迹 tab 是第三个 tab，**必须主动点进来**才挂载，
 *   符合「不得主动弹窗 / 不得主动通知」；
 * - **零新增导航**：不往底部导航塞第五个图标，也不新增路由。
 *
 * ⚠️ 之所以**不放** `/dashboard`（打开 App 就能看到）：那才处在「主动推送」的边缘 ——
 * 一个未经请求就跳出来提醒「一年前你在吃这些」的卡片，本质上和通知无异，只是没响铃。
 * 放在足迹 tab 里，它就真的是「你主动翻到了它」。
 *
 * ## 零后端改动
 *
 * 复用现成的 `GET /meals?date=YYYY-MM-DD`（`ListMealsDto.date` 已支持任意历史日期），
 * **不需要**新接口：一年前 / 一个月前各查一次，与足迹月历的请求互不干扰。
 *
 * ## 语气红线（本组件的**主要**风险，自动化封口见 `test/on-this-day.test.tsx`）
 *
 * - ⛔ 文本不含「断签 / 连续 / 完成率 / 没记 / N 天没 / 断」等**任何**缺席语义；
 * - ⛔ **无分母**：不展示「共 N 餐」「记了 N 天」这类计数 —— 只列吃了什么；
 * - ⛔ **没有红色**：`bg-red|text-red|border-red|ring-red` 一个都不许出现；
 * - ⛔ **无历史时整块隐藏**（返回 `null`）：不留空卡、不写「暂无历史」，
 *   候选里那天没记录就**顺延**到下一个尺度，用户看不到任何「缺失」的痕迹；
 * - ⛔ 不做任何主动提醒：不弹窗、不轮询、不预取。
 * - ⛔ **不做时间尺度切换器**：一次只呈现一个尺度（`onThisDayCandidates` 的候选
 *   顺序固定「一年前 → 一个月前」，组件取第一个真有记录的）。切换器不只是「集邮册」，
 *   它会**诱导用户主动去查一个空尺度** —— 而「查了是空的」这个结果本身就是一次指控。
 *
 * ## NFR-11（可解释性）
 *
 * **不引入新口径数字**，故 `/why-numbers` 无需新增条目：
 * - 「一年前 / 一个月前」是**日期对齐**（`@/lib/on-this-day` 的 `onThisDayCandidates`），
 *   不是统计口径，不需要解释「这个数怎么来的」；
 * - 正文刻意**只列食物名**，不列条数与热量 —— 一旦出现「3 样」或「1800 kcal」
 *   就是一个新的数字，按 NFR-11 就得进 `/why-numbers`。
 *   **选择不展示，比新增一条解释更省事也更干净**（热量在此纯属评判噪音）。
 */

interface OnThisDayRecallProps {
  /** 今天（`YYYY-MM-DD`）；测试可注入，生产走本地时区当天。 */
  today?: string;
}

/** 一个餐次在回望卡里的展示形态。 */
interface RecallMealGroup {
  mealType: MealType;
  /** 该餐吃到的食物名（按记录顺序，已去掉空名）。 */
  names: string[];
}

/** 把 `ListMealsResponse` 压成「非空餐次 + 食物名」，跳过空餐与空名。 */
function toRecallGroups(response: ListMealsResponse | undefined): RecallMealGroup[] {
  const groups: MealGroup[] = response?.groups ?? [];
  const result: RecallMealGroup[] = [];
  for (const mealType of MEAL_TYPE_ORDER) {
    const group = groups.find((entry) => entry.mealType === mealType);
    const names = (group?.logs ?? [])
      .map((log) => resolveMealLogName(log).trim())
      .filter((name) => name !== '');
    if (names.length > 0) {
      result.push({ mealType, names });
    }
  }
  return result;
}

/** 取第一个真有记录的候选（`onThisDayCandidates` 已按「一年前 → 一个月前」排好序）。 */
function pickFirstWithRecords(
  candidates: readonly OnThisDayTarget[],
  responses: readonly (ListMealsResponse | undefined)[],
): { target: OnThisDayTarget; groups: RecallMealGroup[] } | null {
  for (let index = 0; index < candidates.length; index += 1) {
    const target = candidates[index];
    if (target === undefined) continue;
    const groups = toRecallGroups(responses[index]);
    if (groups.length > 0) {
      return { target, groups };
    }
  }
  return null;
}

export default function OnThisDayRecall({ today }: OnThisDayRecallProps = {}): ReactElement | null {
  const todayDate = today ?? todayKey();
  const candidates = useMemo(() => onThisDayCandidates(todayDate), [todayDate]);

  /**
   * 候选日逐个取数。
   *
   * `useQueries` 让 N 个候选走同一套 react-query 缓存：键复用既有的
   * `queryKeys.meals(date)`，因此点「看看那天」跳到 `/diary?date=<那天>` 时
   * **共享同一份数据**、不会重复请求。
   */
  const candidateQueries = useQueries({
    queries: candidates.map((candidate) => ({
      queryKey: queryKeys.meals(candidate.dateKey),
      queryFn: () => api.get<ListMealsResponse>('/meals', { date: candidate.dateKey }),
      retry: 0,
    })),
  });

  /**
   * 取第一个真有记录的候选。
   *
   * ⚠️ 这里**刻意不做 `useMemo`**：候选最多 2 个、每组最多几十条，
   * `pickFirstWithRecords` 是纯遍历、代价可忽略；而它的输入 `responses`
   * 每次渲染都是**新数组**，包 `useMemo` 反而会让依赖永远失效、只是徒增误导。
   */
  const found = pickFirstWithRecords(
    candidates,
    candidateQueries.map((query) => query.data),
  );

  /**
   * 🔴 **无历史记录 → 整块隐藏**（红线④）。
   *
   * 这里**刻意不区分「还在加载」与「确实没有」**：加载中先不渲染，
   * 加载完真有记录才出现。这样既不会闪一下空卡，也永远不会留下「暂无历史」的字样。
   *
   * ⚠️ 刻意**不返回任何空态 / 兜底引导** —— 一旦写了「那天还没有记录」，
   * 这个功能就变成了缺席指控。红线要求它不存在，所以此处只有 `return null`。
   */
  if (found === null) {
    return null;
  }

  const { target, groups } = found;
  const scaleLabel =
    target.scale === 'year' ? COPY.onThisDayScaleYear : COPY.onThisDayScaleMonth;
  const dateLabel = `${formatFullDate(target.dateKey)} · ${weekdayLabel(target.dateKey)}`;

  return (
    <section
      data-testid="on-this-day"
      data-scale={target.scale}
      aria-labelledby="on-this-day-title"
      className="qsh-surface p-5 dark:ring-slate-700"
    >
      <h2 id="on-this-day-title" className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {COPY.onThisDayTitle}
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{scaleLabel}</p>
      {/* 真实日期：给这段记忆一个落点（日期不是评判）。 */}
      <p className="text-xs text-slate-500 dark:text-slate-400" data-testid="on-this-day-date">
        {dateLabel}
      </p>

      <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{COPY.onThisDayLead}</p>

      {/* 那天吃了什么：按餐次分组，只列食物名。
          刻意不写「共 N 餐 / N 样 / N kcal」—— 计数与热量都是分母型数字（红线②③）。 */}
      <ul className="mt-2 space-y-2" data-testid="on-this-day-groups">
        {groups.map((group) => (
          <li key={group.mealType} data-meal-type={group.mealType}>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {MEAL_TYPE_LABELS[group.mealType]}
            </p>
            <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-200">
              {group.names.join('、')}
            </p>
          </li>
        ))}
      </ul>

      {/* 尾注：把「这只是回看」讲清楚 —— 反缺席指控。 */}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{COPY.onThisDayFootnote}</p>

      {/* 去那一天完整看 —— 复用 C-1 的 `/diary?date=`（DiaryPage 已支持该 query）。 */}
      <Link
        to={`/diary?date=${target.dateKey}`}
        data-testid="on-this-day-link"
        aria-label={onThisDayOpenFullAria(dateLabel)}
        className="qsh-touch-target mt-3 inline-block rounded-control bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 transition-colors duration-qsh-base ease-qsh-out hover:bg-brand-100 dark:bg-brand-900/40 dark:text-brand-200"
      >
        {COPY.onThisDayOpenFull}
      </Link>
    </section>
  );
}