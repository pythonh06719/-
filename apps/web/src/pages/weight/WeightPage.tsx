import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateWeightLogRequest,
  GoalForecastPoint,
  GoalProgress,
  Paginated,
  WeightLog,
  WeightTrendPoint,
  WeightTrendResponse,
} from '@qsh/shared-types';
import { api, isNetworkError, noticeFromError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { addDays, formatFullDate, todayKey } from '@/lib/format';
import { COPY, weightInputLabel, weightRangeCaption, weightRangeName } from '@/lib/copy';
import {
  formatSignedWeight,
  formatWeight,
  formatWeightNumber,
  fromDisplayWeight,
  toDisplayWeight,
  useUnitStore,
} from '@/lib/units';
import { detectWeightPlateau } from '@qsh/core';
import {
  DEFAULT_WEIGHT_RANGE_DAYS,
  WEIGHT_RANGE_DAYS_OPTIONS,
  alignMovingAverage,
  computeMovingAverage7d,
  computeTrendStats,
  isWeightRising,
  normalizeTrendResponse,
  slicePointsByRange,
  toTrendPoints,
} from '@/lib/trend';
import type { WeightRangeDays } from '@/lib/trend';
import {
  markPlateauDismissed,
  markPlateauShown,
  readPlateauVisibilityState,
  shouldShowPlateau,
} from '@/lib/plateau-visibility';
import { enqueueRequest } from '@/pwa/offline-queue';
import BrandDecor from '@/components/common/BrandDecor';
import GoalProgressCard from './GoalProgressCard';
import PlateauCard from './PlateauCard';
import WinLogCard from './WinLogCard';

/** 趋势图按需加载（`React.lazy`），不占首屏主包（NFR-3）。 */
const WeightChart = lazy(() => import('./WeightChart'));

/**
 * 体重趋势（`/weight`，PRD §6 第 6 行 / R7.1 / R7.2 / TC-34）。
 *
 * - 每日体重记录（建议早晨空腹）+ 备注
 * - 手写 SVG 趋势图：实际体重曲线 + **7 日移动平均线**
 * - 7 日移动平均优先取后端 `movingAverage7`（契约 `WeightTrendResponse.movingAverage7`）；后端不可用时用 `lib/trend.ts` 的**纯函数**本地计算
 * - 体重上涨时展示中性文案「波动很正常，看趋势就好」（不指责、不制造焦虑）
 */

/** 把任意后端返回形态归一为趋势点。 */
// `/weights` 三种返回形态的归一化已提到 `lib/trend.ts` 的 `normalizeTrendResponse`
// —— 饮食页的「一日档案」也要用它，避免两处各写一份分支。

/** 取后端移动平均（若提供），否则本地计算。 */
function resolveMovingAverage(
  response: WeightTrendResponse | Paginated<WeightLog> | WeightLog[] | undefined,
  points: WeightTrendPoint[],
): Array<{ date: string; value: number | null }> {
  if (response !== undefined && !Array.isArray(response) && 'movingAverage7' in response) {
    const provided = response.movingAverage7;
    if (Array.isArray(provided) && provided.length > 0) {
      return provided;
    }
  }
  return computeMovingAverage7d(points);
}

/**
 * 取后端目标达成预测曲线（R2.6）。
 *
 * 响应为 `WeightTrendResponse` 时读取 `forecast`；为分页 / 数组形态（无该字段）时返回 `[]`。
 * 不新增网络请求 —— 复用已有 `trendQuery` 的返回体。
 */
function resolveForecast(
  response: WeightTrendResponse | Paginated<WeightLog> | WeightLog[] | undefined,
): GoalForecastPoint[] {
  if (response !== undefined && !Array.isArray(response) && 'forecast' in response) {
    const provided = response.forecast;
    if (Array.isArray(provided)) {
      return provided;
    }
  }
  return [];
}

/**
 * 取后端目标达成进度（R2.7）。
 *
 * 响应为 `WeightTrendResponse` 时读取 `goalProgress`；为分页 / 数组形态（无该字段）时返回 `null`。
 * 不新增网络请求 —— 复用已有 `trendQuery` 的返回体；`null` 表示「没有生效目标」，整张卡片不渲染。
 */
function resolveGoalProgress(
  response: WeightTrendResponse | Paginated<WeightLog> | WeightLog[] | undefined,
): GoalProgress | null {
  if (response !== undefined && !Array.isArray(response) && 'goalProgress' in response) {
    const provided = response.goalProgress;
    if (provided !== null && provided !== undefined && typeof provided === 'object') {
      return provided;
    }
  }
  return null;
}

export default function WeightPage(): ReactElement {
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(todayKey());
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  /** 全局体重单位（D-3）：只影响展示与输入换算，内部一律以 kg 记录 / 传参。 */
  const weightUnit = useUnitStore((state) => state.weightUnit);
  /**
   * 区间视图（C4）：默认选**最宽**的 90 天 —— 尽量贴近改动前「固定展示最近 200 笔」的观感。
   * 只改变「把哪一段摊开看」，不改变取数逻辑（仍只发一次 `/weights` 请求）。
   */
  const [rangeDays, setRangeDays] = useState<WeightRangeDays>(DEFAULT_WEIGHT_RANGE_DAYS);

  const trendQuery = useQuery({
    queryKey: queryKeys.weightTrend,
    queryFn: () => api.get<WeightTrendResponse | Paginated<WeightLog>>('/weights', { limit: 200 }),
  });

  useEffect(() => {
    if (trendQuery.data !== undefined) {
      cacheSet(CACHE_KEYS.weightPoints, normalizeTrendResponse(trendQuery.data));
    }
  }, [trendQuery.data]);

  const today = todayKey();
  const cachedPoints = cacheGet<WeightTrendPoint[]>(CACHE_KEYS.weightPoints) ?? [];
  /** 全量点：区间切片与平台期判定都以它为基准（移动平均也必须在全量上计算）。 */
  const allPoints = useMemo<WeightTrendPoint[]>(
    () => (trendQuery.data !== undefined ? normalizeTrendResponse(trendQuery.data) : cachedPoints),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trendQuery.data],
  );
  /**
   * 全量 7 日均线（优先后端 `movingAverage7`，离线时本地算）。
   *
   * 必须在**全量**点集上算：窗口跨区间左边界时需要区间外的历史，先切片再算会让左端 6 天偏小。
   */
  const fullMovingAverage = useMemo(
    () => resolveMovingAverage(trendQuery.data, allPoints),
    [trendQuery.data, allPoints],
  );
  /** 当前区间的点（近 `rangeDays` 天，闭区间）。 */
  const points = useMemo(
    () => slicePointsByRange(allPoints, rangeDays, today),
    [allPoints, rangeDays, today],
  );
  /** 与 `points` 平行对齐的均线值（按日期取值，缺失填 `null`）。 */
  const movingAverage = useMemo(
    () => alignMovingAverage(fullMovingAverage, points),
    [fullMovingAverage, points],
  );
  /** 区间统计（最低 / 最高 / 均值 / 净变化）—— `computeTrendStats` 只吃当前区间的点。 */
  const stats = useMemo(() => computeTrendStats(points), [points]);
  const rising = useMemo(() => isWeightRising(points), [points]);
  const forecast = useMemo(() => resolveForecast(trendQuery.data), [trendQuery.data]);
  const goalProgress = useMemo(() => resolveGoalProgress(trendQuery.data), [trendQuery.data]);
  /**
   * 平台期判定（R2.7）：用 `@qsh/core` 纯函数在前端算（离线也能用，不新增请求）。
   * **吃全量数据，而不是当前区间** —— 平台期是「最近几周」的大图景判断，与图表看哪一段无关；
   * 这样切换 7/30/90 天区间也不会让平台期卡忽隐忽现。
   * 优先用后端算好的 7 日均线；`asOf` 注入今天，用于「记录已停更就不谈平台期」的保护。
   */
  const plateau = useMemo(
    () =>
      allPoints.length === 0
        ? null
        : detectWeightPlateau({
            points: allPoints,
            movingAverage: fullMovingAverage,
            asOf: todayKey(),
          }),
    [allPoints, fullMovingAverage],
  );

  /**
   * 平台期卡的展示频控（AC-11.1.6）——**只压制展示，不改判定结果**：
   * `plateau.isPlateau` 仍是 `detectWeightPlateau()` 的原样输出，是否渲染另由本状态说了算。
   *
   * 判定**每次挂载只做一次**（用 `useRef` 上锁）：否则「展示后立刻写入已展示日期」会让
   * 下一次重算（如后台 refetch 触发 `plateau` 换引用）读到「今天已展示」而把卡片当场抽走。
   * 重新进入页面 = 重新挂载 = 重新判定 → 命中「同一天最多一次」而不再出现。
   */
  const [plateauVisible, setPlateauVisible] = useState(false);
  const plateauDecided = useRef(false);
  useEffect(() => {
    if (plateauDecided.current || plateau === null) {
      return;
    }
    plateauDecided.current = true;
    if (!plateau.isPlateau) {
      return;
    }
    if (shouldShowPlateau(readPlateauVisibilityState())) {
      markPlateauShown();
      setPlateauVisible(true);
    }
  }, [plateau]);

  /** 用户点「收起」：记录关闭时间（7 天内不再自动出现）并隐藏本卡。 */
  const handleDismissPlateau = (): void => {
    markPlateauDismissed();
    setPlateauVisible(false);
  };

  const addWeight = useMutation({
    mutationFn: (payload: CreateWeightLogRequest) => api.post<WeightLog>('/weights', payload),
    onSuccess: async () => {
      setWeight('');
      setNote('');
      setNotice('已经记下今天的体重啦');
      await queryClient.invalidateQueries({ queryKey: queryKeys.weightTrend });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(todayKey()) });
    },
    onError: async (error, variables) => {
      if (isNetworkError(error)) {
        // 真离线：入队待联网重放 + 立即反馈
        await enqueueRequest({ path: '/weights', method: 'POST', body: variables });
        setWeight('');
        setNote('');
        setNotice(COPY.offlineQueued);
        return;
      }
      // 业务错误（如日期不合法 / 已存在）：不入队（重放只会一直失败变毒消息），
      // 保留输入让用户修正，并给出中性提示。
      setNotice(noticeFromError(error, '这次体重没有记上，稍后再试一次就好'));
    },
  });

  const chartData = useMemo(
    () => ({
      dates: points.map((point) => point.date),
      weights: points.map((point) => point.weightKg),
      // `movingAverage` 已由 `alignMovingAverage` 对齐为与 `dates` 平行的 `number|null[]`
      movingAverage,
      forecast,
    }),
    [points, movingAverage, forecast],
  );

  const handleSubmit = (): void => {
    // 输入按**当前展示单位**理解，回写成 kg 真值（存储 / API 一律 kg，D-3）。
    const entered = Number(weight);
    const value = fromDisplayWeight(entered, weightUnit);
    if (!Number.isFinite(value) || value <= 0 || value >= 500) {
      // 提示里的范围按**当前单位**给出，避免斤模式下报一个看不懂的 kg 区间。
      const upper = Math.round(toDisplayWeight(500, weightUnit));
      setNotice(`体重填一个 0 到 ${upper} 之间的数字就好`);
      return;
    }
    const payload: CreateWeightLogRequest = {
      loggedAt: date,
      weightKg: value,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    };
    addWeight.mutate(payload);
  };

  return (
    // C-6 宽屏（≥1024px）：`space-y-5` 单栏在 `lg` 变成两栏。移动端所有类名不变。
    //
    // ⚠️ 下方两栏各自的包裹 `<div>` **不是**多余的嵌套，**不要删** ——
    // CSS Grid 同一行内各列**共享行高**：若把卡片直接平铺进栅格，矮栏会被相邻高栏的行高
    // 撑出一段可见的空白（本页真机实测过约 90px 空档）。包裹块让每栏**独立自上而下堆叠**，栏内才没有空档。
    // ⚠️ 这个空档**只有真实浏览器（会排版）看得见，jsdom 不算布局 → 单测证明不了**；
    // 删掉包裹块时 `wide-layout.test.tsx` 仍会全绿（它只断言类名与 DOM 顺序）。
    //
    // 左栏「记录与曲线」（表单 + 波动原因 + 趋势图），右栏「进度与回顾」（目标 / 平台期 /
    // 区间统计 / 近期记录 / 体重之外的变化）。DOM 顺序 == 视觉「先左栏再右栏」，焦点顺序不变。
    <section
      aria-labelledby="weight-title"
      className="space-y-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0"
    >
      <h1 id="weight-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100 lg:col-span-2">
        体重趋势
      </h1>

      {/* 左栏（C-6）：记录与曲线。包裹块用于消除跨栏共享行高的空档 —— 理由与「删不得」的
          警告见上方栅格注释，**别删**。移动端为中性包裹块，间距 / 顺序与改动前一致。 */}
      <div className="space-y-5 lg:col-start-1">
        <form
          className="qsh-surface space-y-3 rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            建议早晨空腹、上厕所后称重，数值更稳定。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-600 dark:text-slate-300">
              日期
              <input
                type="date"
                max={todayKey()}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-600 dark:text-slate-300">
              {weightInputLabel(weightUnit)}
              <input
                inputMode="decimal"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                placeholder={weightUnit === 'jin' ? '如：120' : '如：59.8'}
                className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </div>
          <label className="block text-sm text-slate-600 dark:text-slate-300">
            备注（可选，≤200 字）
            <input
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
              placeholder="如：昨天聚餐，睡得比较晚"
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <button
            type="submit"
            disabled={addWeight.isPending}
            className="qsh-touch-target w-full rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {addWeight.isPending ? '正在保存…' : '记录今天的体重'}
          </button>
          {notice !== null && (
            <p role="status" aria-live="polite" className="text-sm text-brand-700 dark:text-brand-300">
              {notice}
            </p>
          )}
        </form>

        {/* 体重波动的日常原因（N3）。
            ⚠️ 刻意**不做**数据因果归因（不说「因为你昨天吃多了」）—— 那会把身体正常的起伏
            变成一种指责，直接违背「无负罪感」这条硬约束。这里只陈述日常里本来就会让数字上浮的事，
            不做因果推断，判断权留给用户自己。 */}
        {rising && (
          <section
            aria-labelledby="weight-rise-title"
            className="rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
          >
            <h2 id="weight-rise-title" className="font-semibold">
              {COPY.weightRiseTitle}
            </h2>
            <p role="status" className="mt-1">
              {COPY.weightFluctuation}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>{COPY.weightRiseReasonWater}</li>
              <li>{COPY.weightRiseReasonFood}</li>
              <li>{COPY.weightRiseReasonSalt}</li>
              <li>{COPY.weightRiseReasonSleep}</li>
            </ul>
            <p className="mt-2 font-medium">{COPY.weightRiseClosing}</p>
          </section>
        )}

        <div className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
          <h2 className="px-1 text-base font-semibold text-slate-800 dark:text-slate-100">体重曲线与 7 日均线</h2>

          {/* 区间切换（C4）：近 7 / 30 / 90 天。分段控件语义用 role=group + aria-pressed。
              只切换「看哪一段」，不触发新请求；默认 90 天，尽量贴近改动前的观感。 */}
          <div role="group" aria-label={COPY.weightRangeLabel} className="mt-2 flex flex-wrap gap-1.5 px-1">
            {WEIGHT_RANGE_DAYS_OPTIONS.map((days) => {
              const active = days === rangeDays;
              return (
                <button
                  key={days}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRangeDays(days)}
                  className={`qsh-touch-target rounded-full px-3 py-1 text-xs font-medium transition ${
                    active
                      ? 'bg-brand-600 text-white'
                      : 'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {weightRangeName(days)}
                </button>
              );
            })}
          </div>

          {points.length === 0 ? (
            <p className="mt-3 px-1 text-sm text-slate-500 dark:text-slate-400">
              {allPoints.length === 0 ? COPY.emptyWeight : COPY.weightRangeEmpty}
            </p>
          ) : (
            <div className="mt-2 h-64 w-full" aria-label="体重趋势折线图">
              <Suspense
                fallback={
                  <p className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
                    正在准备图表…
                  </p>
                }
              >
                <WeightChart
                  dates={chartData.dates}
                  weights={chartData.weights}
                  movingAverage={chartData.movingAverage}
                  forecast={chartData.forecast}
                  unit={weightUnit}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>

      {/* 右栏（C-6，≥1024px）：进度与回顾。同左栏 —— 这层包裹块别删（消除跨栏共享行高空档，见上方注释）。
          移动端这是一层无样式的中性包裹块（`space-y-5` 与父级同款），视觉与结构语义与改动前一致；
          桌面下整体归入第 2 栏。 */}
      <div className="space-y-5 lg:col-start-2">
        {goalProgress !== null && <GoalProgressCard progress={goalProgress} />}

        {plateauVisible && plateau !== null && (
          <PlateauCard
            stalledDays={plateau.stalledDays}
            slope4wKgPerWeek={plateau.slope4wKgPerWeek}
            onDismiss={handleDismissPlateau}
          />
        )}

        <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatMin}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatWeightNumber(stats.minKg, weightUnit)}
            </dd>
          </div>
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatMax}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatWeightNumber(stats.maxKg, weightUnit)}
            </dd>
          </div>
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatMean}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatWeightNumber(stats.meanKg, weightUnit)}
            </dd>
          </div>
          <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatChange}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatSignedWeight(stats.changeKg, weightUnit)}
            </dd>
          </div>
        </dl>

        <p className="px-1 text-xs text-slate-600 dark:text-slate-400">
          {weightRangeCaption(
            rangeDays,
            points.length,
            points.length > 0 ? formatFullDate(points[0]?.date ?? today) : null,
          )}
          {movingAverage.some((value) => value !== null)
            ? ' 7 日均线在每个记录日往前 7 个自然日的窗口内取平均。'
            : ''}
          {COPY.weightRangeOlderHint}
        </p>

        <div className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">近期记录</h2>
          {points.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
              <BrandDecor variant="bloom" className="h-4 w-4 shrink-0 text-brand-300" />
              还没有记录
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {[...points]
                .reverse()
                .slice(0, 8)
                .map((point) => (
                  <li key={point.date} className="flex items-center justify-between text-sm">
                    <span className="text-slate-600 dark:text-slate-300">
                      {point.date === todayKey() ? `今天（${point.date}）` : formatFullDate(point.date)}
                    </span>
                    <span className="qsh-tnum text-slate-800 dark:text-slate-100">
                      {formatWeight(point.weightKg, weightUnit)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            参考：{addDays(todayKey(), -6)} 起的 7 日窗口用于计算移动平均。
          </p>
        </div>

        {/* 「体重之外的变化」（R11.4）：挂在体重页底部 —— 秤称不出来的变化也值得记（AC-11.4.1） */}
        <WinLogCard />
      </div>
    </section>
  );
}
