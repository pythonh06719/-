import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse, ListMealsResponse, WeightUnit } from '@qsh/shared-types';
import { isNetworkError } from '@/lib/api';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { formatDateLine, todayKey } from '@/lib/format';
import { energyLabel, toDisplayEnergy, toDisplayWeight, useUnitStore, weightLabel } from '@/lib/units';
import {
  COPY,
  cupProgress,
  cupText,
  encouragementForHour,
  greetingForHour,
  lifeNarrative,
  mealSummaryLine,
  mealSummaryTag,
} from '@/lib/copy';
import { DEFAULT_WATER_GOAL_ML, WATER_QUICK_ADD_ML } from '@/theme/tokens';
import Sparkline from '@/components/common/Sparkline';
import SafetyBanner from '@/components/feedback/SafetyBanner';
import EncouragementText from '@/components/feedback/EncouragementText';

/**
 * 今日「今天」页（`/dashboard`，PRD §6 第 3 行 / US-05）。
 *
 * 心法：**动作优先，数据其次；说人话，不说指标话。** 页面按「今天的生活流」组织：
 *
 * ① 时段问候 + 一句生活叙事（走到哪说到哪，不评价）
 * ② 今日行动卡（主 CTA）：记一餐 / 喝一杯水 / 动一动
 * ③ 生活化摘要：**不给百分比、不给评分**；只说生活用语 + 真实绝对值（热量）
 *    与「第几杯」（喝水）。详见摘要卡上方那段注释。
 * ④ 这周的小变化（迷你体重趋势）+ 安全提示 + 一句鼓励
 *
 * 语气约束（PRD §7）：绝不使用红色恐吓 / 负罪感文案。
 * 离线 / 后端未就绪时回退到本地缓存副本，绝不白屏（TC-47）。
 */

interface WaterState {
  totalMl: number;
  /** 最近一次添加的时间戳（用于「撤销上一条」） */
  history: number[];
}

const EMPTY_WATER: WaterState = { totalMl: 0, history: [] };

function readWater(date: string): WaterState {
  return cacheGet<WaterState>(`qsh:cache:water:${date}`) ?? EMPTY_WATER;
}

/** 读取今天已记录的食物笔数（best-effort：来自日记页写入的缓存，缺省 0）。 */
function readMealCount(date: string): number {
  const cached = cacheGet<ListMealsResponse>(CACHE_KEYS.meals(date));
  if (cached === null || !Array.isArray(cached.groups)) {
    return 0;
  }
  return cached.groups.reduce((total, group) => total + (group.logs?.length ?? 0), 0);
}

/** 「这周的小变化」的一句话叙事（中性、不评判，涨跌都用平常口吻）。 */
function weightStory(
  trend: ReadonlyArray<{ weightKg: number | null }>,
  unit: WeightUnit,
): string {
  if (trend.length < 2) {
    return '再记两天，就能看出这几天的小变化了';
  }
  const first = trend[0]?.weightKg;
  const last = trend[trend.length - 1]?.weightKg;
  if (typeof first !== 'number' || typeof last !== 'number') {
    return '这几天的变化，交给趋势来看就好';
  }
  const delta = Math.round((last - first) * 10) / 10;
  if (Math.abs(delta) < 0.1) {
    return '这几天挺稳的，保持现在的节奏就好';
  }
  // 差值按**当前体重单位**换算后展示（存储恒为 kg，D-3）。
  const displayDelta = Math.abs(toDisplayWeight(delta, unit)).toFixed(1);
  if (delta < 0) {
    return `这周轻轻往下走了 ${displayDelta} ${weightLabel(unit)}，挺自然的`;
  }
  return `这周有点小波动（+${displayDelta} ${weightLabel(unit)}），很正常，看趋势就好`;
}

/** 由本地缓存的预算兜底构造看板数据（后端不可用时使用）。 */
function buildFallbackDashboard(date: string): DashboardResponse | null {
  const cached = cacheGet<DashboardResponse>(CACHE_KEYS.dashboard(date));
  if (cached !== null) {
    return cached;
  }
  const budget = cacheGet<DashboardResponse['budget']>(CACHE_KEYS.localBudget);
  if (budget === null) {
    return null;
  }
  return {
    date,
    goal: null,
    budget,
    intakeKcal: 0,
    burnedKcal: 0,
    remainingKcal: budget.intakeRecommended,
    progressRatio: 0,
    waterMl: 0,
    waterGoalMl: DEFAULT_WATER_GOAL_ML,
    miniTrend: [],
    encouragement: COPY.defaultEncouragement,
    warnings: [],
  };
}

export default function DashboardPage(): ReactElement {
  const date = todayKey();
  const hour = new Date().getHours();
  const unit = useUnitStore((state) => state.unit);
  /** 全局体重单位（D-3）：迷你趋势文案与读屏标签按此换算。 */
  const weightUnit = useUnitStore((state) => state.weightUnit);
  const [water, setWater] = useState<WaterState>(() => readWater(date));

  const dashboardQuery = useQuery({
    queryKey: queryKeys.dashboard(date),
    queryFn: () => api.get<DashboardResponse>('/dashboard', { date }),
  });

  // 成功时写入缓存，供离线查看（TC-47）
  useEffect(() => {
    if (dashboardQuery.data !== undefined) {
      cacheSet(CACHE_KEYS.dashboard(date), dashboardQuery.data);
    }
  }, [dashboardQuery.data, date]);

  const offline = dashboardQuery.isError && isNetworkError(dashboardQuery.error);
  const data = useMemo<DashboardResponse | null>(
    () => dashboardQuery.data ?? buildFallbackDashboard(date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dashboardQuery.data, date],
  );

  // 已记录笔数（best-effort 从日记缓存读取；刷新看板后重新计算）
  const mealCount = useMemo(
    () => readMealCount(date),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [date, dashboardQuery.dataUpdatedAt],
  );

  const persistWater = (next: WaterState): void => {
    setWater(next);
    cacheSet(`qsh:cache:water:${date}`, next);
  };

  const addWater = (): void => {
    persistWater({
      totalMl: water.totalMl + WATER_QUICK_ADD_ML,
      history: [...water.history, Date.now()],
    });
  };

  const undoWater = (): void => {
    if (water.history.length === 0) {
      return;
    }
    persistWater({
      totalMl: Math.max(0, water.totalMl - WATER_QUICK_ADD_ML),
      history: water.history.slice(0, -1),
    });
  };

  if (dashboardQuery.isLoading && data === null) {
    return (
      <section aria-busy="true" className="space-y-4">
        {/* 骨架必须是真表面的同款几何（圆角 token），否则数据到位那一刻会看到一次「变形」 */}
        <div className="h-28 animate-pulse rounded-card bg-cream-200 dark:bg-slate-800" />
        <div className="h-24 animate-pulse rounded-card bg-cream-200 dark:bg-slate-800" />
        <div className="h-40 animate-pulse rounded-2xl bg-brand-100 dark:bg-slate-800" />
        <p className="qsh-sr-only">正在读取今天的数据</p>
      </section>
    );
  }

  if (data === null) {
    return (
      <section aria-labelledby="dashboard-empty-title" className="space-y-5">
        <h1
          id="dashboard-empty-title"
          className="text-xl font-semibold text-slate-900 dark:text-slate-100"
        >
          {COPY.emptyToday}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          先花一分钟做完引导，今天怎么安排就有数了。
        </p>
        <div className="qsh-surface-warm flex items-center gap-4 p-5">
          <span aria-hidden="true" className="text-4xl">
            🌱
          </span>
          <p className="text-sm text-slate-700 dark:text-slate-300">
            不着急，了解你之后，我们再把今天过成自己的节奏。
          </p>
        </div>
        <Link
          to="/onboarding"
          className="qsh-touch-target inline-flex rounded-xl bg-brand-600 px-5 py-3 font-medium text-white"
        >
          去做引导问卷
        </Link>
      </section>
    );
  }

  const remainingDisplay = toDisplayEnergy(data.remainingKcal, unit);
  const intakeDisplay = toDisplayEnergy(data.intakeKcal, unit);
  const budgetDisplay = toDisplayEnergy(data.budget?.intakeRecommended ?? 0, unit);
  const waterGoal = data.waterGoalMl > 0 ? data.waterGoalMl : DEFAULT_WATER_GOAL_ML;
  const { cups, goalCups } = cupProgress(water.totalMl, waterGoal);
  const cupLabel = cups > 0 ? `第 ${cups} 杯 / 目标 ${goalCups} 杯` : goalCups > 0 ? `还没喝 / 目标 ${goalCups} 杯` : '还没喝';

  const greeting = greetingForHour(hour);
  const narrative = lifeNarrative({ mealCount, intakeKcal: data.intakeKcal });
  const summaryLine = mealSummaryLine({ intakeKcal: data.intakeKcal, progressRatio: data.progressRatio });
  const summaryTag = mealSummaryTag({ intakeKcal: data.intakeKcal, progressRatio: data.progressRatio });
  const isEmptyToday = mealCount === 0 && data.intakeKcal <= 0;
  // 摘要卡主行：无参考预算 → 中性引导；今天没记 → 动作导向（不与问候卡重复）；其余 → 生活化分档总结
  const summaryHeadline = data.budget == null
    ? COPY.noBudgetSummary
    : isEmptyToday
      ? COPY.emptyTodayAction
      : summaryLine;
  const encouragement =
    data.encouragement.trim() !== '' ? data.encouragement : encouragementForHour(hour);

  return (
    // C-6 宽屏（≥1024px）：`space-y-6` 单栏在 `lg` 变成三栏。移动端所有类名不变。
    //
    // ⚠️ 下方三栏各自的包裹 `<div>` **不是**多余的嵌套，**不要删** ——
    // CSS Grid 同一行内各列**共享行高**：若把卡片直接平铺进栅格，矮栏会被相邻高栏的行高
    // 撑出一段可见的空白。包裹块让每栏**独立自上而下堆叠**，栏内才没有空档。
    // ⚠️ 这个空档**只有真实浏览器（会排版）看得见，jsdom 不算布局 → 单测证明不了**；
    // 删掉包裹块时 `wide-layout.test.tsx` 仍会全绿（它只断言类名与 DOM 顺序）。
    //
    // 包裹块在移动端只是中性容器（`space-y-6` 与父级同款），卡片顺序 / 间距与改动前一致。
    // DOM 顺序 == 视觉「先左栏、再中栏、再右栏」→ **不改变焦点顺序**。
    <section
      aria-labelledby="dashboard-title"
      className="space-y-6 lg:grid lg:grid-cols-3 lg:items-start lg:gap-6 lg:space-y-0"
    >
      <header className="flex items-baseline justify-between gap-3 lg:col-span-3">
        <h1 id="dashboard-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          今天
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{formatDateLine(date)}</p>
      </header>

      {offline && (
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl bg-coral-50 px-4 py-2 text-xs text-coral-700 dark:bg-coral-900/30 dark:text-coral-200 lg:col-span-3"
        >
          {COPY.offlineNotice}
        </p>
      )}

      {/* 左栏（C-6，≥1024px）：今日状态 + 快捷动作。
          包裹块用于消除跨栏共享行高的空档 —— 理由与「删不得」的警告见上方栅格注释，**别删**。
          移动端这是一层中性包裹（`space-y-6` 与父级同款），间距 / 顺序与改动前一致。 */}
      <div className="space-y-6 lg:col-start-1">
        {/* ① 时段问候 + 一句生活叙事 */}
        <div className="qsh-surface-warm p-5">
          <p className="text-xl font-semibold text-warm-900 dark:text-warm-200">{greeting}</p>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{narrative}</p>
        </div>

        {/* ② 今日行动卡（主 CTA：动作优先，每次都是一大步） */}
        <section aria-label="今天可以做的事" className="grid grid-cols-3 gap-3">
          <Link to="/diary" className="qsh-action-card qsh-touch-target">
            <span aria-hidden="true" className="text-2xl">
              🍚
            </span>
            <span>记一餐</span>
            <span className="text-xs font-normal text-slate-600 dark:text-slate-400">
              早餐 / 午餐 / 晚餐
            </span>
          </Link>
          <button
            type="button"
            onClick={addWater}
            aria-label={`喝一杯水，加 ${WATER_QUICK_ADD_ML} 毫升`}
            className="qsh-action-card qsh-touch-target"
          >
            <span aria-hidden="true" className="text-2xl">
              💧
            </span>
            <span>喝一杯水</span>
            <span className="text-xs font-normal text-slate-600 dark:text-slate-400">
              {WATER_QUICK_ADD_ML} ml
            </span>
          </button>
          <Link to="/exercise" className="qsh-action-card qsh-touch-target">
            <span aria-hidden="true" className="text-2xl">
              🏃
            </span>
            <span>动一动</span>
            <span className="text-xs font-normal text-slate-600 dark:text-slate-400">散步也算</span>
          </Link>
        </section>

        {/* ②b 习惯 / 周报入口（导航缺口修复）——
            这两条路由此前全站没有任何入口，只能手输 URL。习惯打卡是每日动作、周报是
            核心的「回头看」，都放在主屏最自然。用同一套 `qsh-action-card`（模式 A），
            与上面的行动卡同一层级；文案走 `COPY.dashboard*Entry`，中性、不催。
            单独成行（grid-cols-2）而非并入上面 3 列：既保住上面「记一餐 / 喝一杯水 /
            动一动」三足鼎立的主 CTA 排布，也让这两项不至于挤成第 4、5 个格子。 */}
        <section aria-label="每天和每周" className="grid grid-cols-2 gap-3">
          <Link to="/habits" className="qsh-action-card qsh-touch-target">
            <span aria-hidden="true" className="text-2xl">
              ✅
            </span>
            <span>{COPY.dashboardHabitsEntry}</span>
            <span className="text-xs font-normal text-slate-600 dark:text-slate-400">
              {COPY.dashboardHabitsEntryHint}
            </span>
          </Link>
          <Link to="/report" className="qsh-action-card qsh-touch-target">
            <span aria-hidden="true" className="text-2xl">
              📊
            </span>
            <span>{COPY.dashboardReportEntry}</span>
            <span className="text-xs font-normal text-slate-600 dark:text-slate-400">
              {COPY.dashboardReportEntryHint}
            </span>
          </Link>
        </section>
      </div>

      {/* 中栏（C-6，≥1024px）：今天的记录 + 喝水。同左栏 —— 这层包裹块别删（见上方栅格注释）。 */}
      <div className="space-y-6 lg:col-start-2">
        {/* ③ 生活化摘要。
            ⚠️ 这里原本是「热量进度环」：一个 96px 的珊瑚色圆环，环内写「117% / 今日进度」。
            它是全屏最大、最饱和的元素 —— 形态本身就把「超标 17%」呈现成了**一个评分**，
            与同屏喝水「灰色小字 + 第几杯」的轻描淡写自相矛盾（同一屏两套标准）。
            故**降级为纯文字**：进度关系由下面两行已过审文案承担 ——
              · `summaryTag` 胶囊：「宽宽松松 / 舒服 / 刚开始」（定性，不给分数）
              · `summaryHeadline`：「今天吃得丰富一些，明天照常就好」（生活口吻，不评判）
              · 数字行：「已摄入 1404 kcal / 参考 1200 kcal」（**绝对值**，比百分比更精确，
                且不像评分；未超参考时是「还能吃 XXX kcal」，更友好）
            刻意**不再显示百分比**：一个孤零零的「117%」即使缩成小字，仍然是在给用户
            报一个成绩。本页已有的绝对值 + 定性措辞已把「超标 / 达标 / 还差多少」讲全了，
            没有任何信息损失。`/diary` 的「参考预算 1200 kcal · …」是同一口径的既有正解。
            （`ProgressRing` 组件本身**未删** —— `/weight` 目标进度与 `/onboarding` 仍在复用。） */}
        <div className="qsh-surface-warm p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">今天的记录</h2>
            <span className="qsh-chip">{summaryTag}</span>
          </div>

          {/* 主行：生活化表达（数字降权，D 修） */}
          <p className="mt-4 text-lg font-semibold text-slate-800 dark:text-slate-100">
            {isEmptyToday && (
              <span aria-hidden="true" className="mr-2 align-middle text-2xl">
                🥗
              </span>
            )}
            {summaryHeadline}
          </p>
          {/* 空态日：给一个直达动作；有记录日：真实数字，小字号等宽呈现 */}
          {isEmptyToday ? (
            <Link
              to="/diary"
              className="qsh-touch-target mt-2 inline-flex items-center text-sm font-medium text-brand-700 dark:text-brand-300"
            >
              去记早餐 →
            </Link>
          ) : (
            <p className="qsh-tnum mt-1 text-xs text-slate-600 dark:text-slate-400">
              {data.remainingKcal < 0
                ? `已摄入 ${intakeDisplay} ${energyLabel(unit)} / 参考 ${budgetDisplay} ${energyLabel(unit)}`
                : (
                  <>
                    还能吃 <span>{remainingDisplay}</span> {energyLabel(unit)}
                  </>
                )}
            </p>
          )}

          <Link
            to="/why-numbers"
            className="mt-3 inline-block text-sm font-medium text-brand-700 dark:text-brand-300"
          >
            这些数字是怎么来的 →
          </Link>
        </div>

        {/* 喝水：改说「第几杯」，真实毫升作为次要文字 */}
        <div className="qsh-surface p-5 dark:ring-slate-700">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">喝水</h2>
            <p className="text-sm text-warm-800 dark:text-warm-200">{cupLabel}</p>
          </div>
          <p
            className="mt-1 text-xs text-slate-500 dark:text-slate-400"
            role="status"
            aria-live="polite"
          >
            {cupText(water.totalMl, waterGoal)}
          </p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <p className="qsh-tnum text-xs text-slate-500 dark:text-slate-400">
              {water.totalMl} / {waterGoal} ml
            </p>
            <button
              type="button"
              onClick={undoWater}
              disabled={water.history.length === 0}
              className="qsh-touch-target rounded-xl px-4 text-sm text-slate-600 ring-1 ring-brand-100 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-700"
              aria-label="撤销上一次喝水记录"
            >
              撤销上一条
            </button>
          </div>
        </div>
      </div>

      {/* 右栏（C-6，≥1024px）：这周的小变化 + 安全提示与鼓励。同左栏 —— 这层包裹块别删。 */}
      <div className="space-y-6 lg:col-start-3">
        {/* 这周的小变化（迷你体重趋势） */}
        <div className="qsh-surface p-5 dark:ring-slate-700">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">这周的小变化</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{weightStory(data.miniTrend, weightUnit)}</p>
          <div className="mt-3">
            <Sparkline data={data.miniTrend} weightUnit={weightUnit} />
          </div>
          <Link
            to="/weight"
            className="mt-3 inline-block text-sm font-medium text-brand-600 dark:text-brand-300"
          >
            看看这几天的变化 →
          </Link>
        </div>

        <div className="space-y-3">
          <SafetyBanner warnings={data.warnings} />
          <EncouragementText text={encouragement} />
        </div>
      </div>
    </section>
  );
}
