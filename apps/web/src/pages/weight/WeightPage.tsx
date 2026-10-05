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

/**
 * 本页新增的文案 —— **刻意放在文件局部常量**，本轮不改 `lib/copy.ts`。
 *
 * 语气沿用 PRD §7：陈述当前发生了什么 + 给一条同屏可达的出路，
 * 不用「失败 / 错误 / 崩溃」这类词，不含任何数字（NFR-11），也不用红 / 警示色。
 */
/** 「还在取」—— 首次进入且本机没有任何旧记录时的占位。 */
const TREND_LOADING = '正在取出这段时间的记录…';
/** 「取不到」—— 请求没通且本机也没有旧记录时的占位（详见 JSX 处的三分支注释）。 */
const TREND_LOAD_ERROR = '这段时间的记录暂时取不到，稍后再看看就好';

/**
 * 报表族的**前缀**查询键（`['report']`）：周报的体重变化、阶段回顾的起止体重、
 * 记录足迹日历的体重维度都在这段前缀下。
 *
 * 为什么从 `queryKeys` 的工厂**取首段**而不是手写 `['report']`：
 * `weeklyReport` / `periodReport` / `reportCalendar` 三个键都以同一段前缀开头，
 * 取工厂产物的第一段即可命中全部 —— 将来 `lib/queryClient.ts` 改键名，这里会跟着改，
 * 不会悄悄失配。传占位入参是必要的：这三个工厂都要求日期 / 月份参数，而前缀与参数无关。
 */
const REPORT_KEY_PREFIX: readonly string[] = queryKeys.reportCalendar('').slice(0, 1);

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
   * 「现在看到的是上次同步的数据」—— 请求失败且**确实渲染了旧数据**时才为真。
   *
   * 为什么要这个标记（数据可信度，非体验细节）：本页从上到下的每一个数字
   * —— 曲线、7 日均线、区间最低/最高/均值/净变化、平台期斜率、近期记录 ——
   * 全部由 `allPoints` 推出。而 `allPoints` 有两条**静默**的退路：
   * ① `trendQuery.data === undefined` → 退到本机 `CACHE_KEYS.weightPoints`；
   * ② react-query 的内存副本（`gcTime` 30min）→ 上次成功的结果被原样保留，
   *    后台 refetch 失败只把 `isError` 置真、**不动 `data`**。
   * 两条路都让「几分钟前的旧体重」和「刚同步的体重」长得一模一样，
   * 而用户要靠这个数字决定今天吃多少、还要不要动 —— 分不出来，数字就不可信。
   *
   * 为什么只认 `isNetworkError`：业务错误不该被说成「网络不稳定」，
   * 那类情况由各自的错误提示负责（`noticeFromError`）。
   *
   * 为什么还要 `allPoints.length > 0`：没有旧数据可显示时页面本就没有数字，
   * 这时挂一条「这些是上次同步的数据」是在指控一个不存在的展示。
   */
  const showingStaleData =
    trendQuery.isError && isNetworkError(trendQuery.error) && allPoints.length > 0;

  /**
   * 「还在取」与「取不到」—— 两个此前**完全缺失**的中间态（P1 状态混淆）。
   *
   * 修复前，`points` 为空时一律按 `allPoints.length === 0` 渲染 `COPY.emptyWeight`
   * （「记录第一笔体重，之后就交给趋势吧」）。但「一个点都没有」有三种成因：
   *   ① **请求还没回来**（首次进入 / 弱网）→ 尚未知道有没有记录；
   *   ② **请求失败且本机没有旧记录** → 「还没取到」被说成「你一笔都还没记」，
   *      老用户会以为以前称的那些都没了 —— 一个不存在的损失；
   *   ③ 请求成功且真的没有记录 → 只有这时那句引导才成立。
   *
   * 判据统一带 `allPoints.length === 0`：`showingStaleData` 要求的正是它的反面，
   * 故两条路互斥 —— 有旧点可看时走「这是上次同步的数据」，一个点都没有时才谈「取不到」。
   */
  const trendLoadingEmpty = trendQuery.isLoading && allPoints.length === 0;
  const trendFailedEmpty = trendQuery.isError && allPoints.length === 0;
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
      // 报表的派生统计：周报「体重变化」、阶段回顾的起止体重与差值、记录足迹日历的
      // 体重维度，都是按全部体重日记聚合出来的（不是这一条传出去的），
      // 不失效就停在记这笔之前的旧值上。
      await queryClient.invalidateQueries({ queryKey: REPORT_KEY_PREFIX });
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
      <h1 id="weight-title" className="text-title font-semibold text-slate-900 dark:text-slate-100 lg:col-span-2">
        体重趋势
      </h1>

      {/*
        「这是上次同步的数据」标记（数据可信度）。
        ⚠️ 刻意**不显示相对时间**（「3 分钟前的数据」）：那是一个NFR-11 意义上的新数字，
        需要在 `/why-numbers` 有对应条目才能展示。改用「网络恢复后会自动更新」这句
        不含任何数字的说明 + 一个显式重试入口 —— 用户要的只是「怎么拿到新的」，不是「旧多久」。
        语气与配色：中性陈述（灰/品牌色），**不用红、不用警示色、不弹窗、不阻断记录**。
        「出路」必须同屏可达：`重新试试` 直接重跑本查询，成功后本条自动消失。
        `lg:col-span-2` 让它在宽屏下横跨两栏 —— 数字在两栏都有，提示也必须两栏都看得到。
      */}
      {showingStaleData && (
        <div
          role="status"
          aria-live="polite"
          data-testid="weight-stale-notice"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-slate-100 px-4 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300 lg:col-span-2"
        >
          <span>{COPY.staleDataNotice}</span>
          <button
            type="button"
            onClick={() => {
              void trendQuery.refetch();
            }}
            disabled={trendQuery.isFetching}
            className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
          >
            {trendQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
          </button>
        </div>
      )}

      {/* 左栏（C-6）：记录与曲线。包裹块用于消除跨栏共享行高的空档 —— 理由与「删不得」的
          警告见上方栅格注释，**别删**。移动端为中性包裹块，间距 / 顺序与改动前一致。 */}
      <div className="space-y-5 lg:col-start-1">
        <form
          className="qsh-surface space-y-3 p-5"
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
                className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:text-slate-100"
              />
            </label>
            <label className="text-sm text-slate-600 dark:text-slate-300">
              {weightInputLabel(weightUnit)}
              <input
                inputMode="decimal"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                placeholder={weightUnit === 'jin' ? '如：120' : '如：59.8'}
                className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:text-slate-100"
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
              className="mt-1 w-full rounded-control border border-brand-100 px-3 py-2 dark:border-slate-600 dark:text-slate-100"
            />
          </label>
          <button
            type="submit"
            disabled={addWeight.isPending}
            className="qsh-touch-target w-full rounded-control bg-brand-600 py-3 font-medium text-white transition duration-qsh-base ease-qsh-out hover:bg-brand-700 disabled:opacity-60"
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
            className="rounded-card bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
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

        <div className="qsh-surface p-5">
          <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">体重曲线与 7 日均线</h2>

          {/* 区间切换（C4）：近 7 / 30 / 90 天。分段控件语义用 role=group + aria-pressed。
              只切换「看哪一段」，不触发新请求；默认 90 天，尽量贴近改动前的观感。
              ⚠️ 原先这里（与上方 h2）各写了一个 `px-1`，用来抵消容器 `p-4` 与卡内
              其他 `p-5` 卡片不一致的观感 —— 那是用局部内边距补容器内边距的典型症状，
              容器统一到 `p-5` 后两处 `px-1` 均已删除。 */}
          <div role="group" aria-label={COPY.weightRangeLabel} className="mt-2 flex flex-wrap gap-1.5">
            {WEIGHT_RANGE_DAYS_OPTIONS.map((days) => {
              const active = days === rangeDays;
              return (
                <button
                  key={days}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRangeDays(days)}
                  className={`qsh-touch-target rounded-full px-3 py-1 text-xs font-medium transition duration-qsh-fast ease-qsh-out ${
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

          {/*
            曲线区为空时的三分支：**正在取 / 取不到 / 真的还没记**（理由见 `trendLoadingEmpty`）。

            三者在此互斥且穷尽：`allPoints.length > 0` 时的降级由页面顶部
            `weight-stale-notice` 负责，两条路不重叠、不互相替代。

            为什么不复用表单内那条 `notice`：它是**动作反馈槽**（「已经记下今天的体重啦」/
            范围提示 / 离线入队），把「这一页面压根没读出来」混进去会让两种下一步冲突。

            配色与文案：中性灰底 + 品牌色动作（与 `weight-stale-notice` 同一样式），
            不用红 / 警示色；文案不含任何数字（NFR-11）；出路**同屏可达**。
          */}
          {trendLoadingEmpty ? (
            <p
              role="status"
              data-testid="weight-trend-loading"
              className="mt-3 px-1 text-sm text-slate-500 dark:text-slate-400"
            >
              {TREND_LOADING}
            </p>
          ) : trendFailedEmpty ? (
            <div
              role="status"
              aria-live="polite"
              data-testid="weight-trend-error"
              className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            >
              <span>{TREND_LOAD_ERROR}</span>
              <button
                type="button"
                onClick={() => {
                  void trendQuery.refetch();
                }}
                disabled={trendQuery.isFetching}
                data-testid="weight-trend-retry"
                className="qsh-touch-target rounded-control px-2 py-1 font-medium text-brand-700 underline underline-offset-2 disabled:opacity-60 dark:text-brand-300"
              >
                {trendQuery.isFetching ? COPY.staleDataRetrying : COPY.staleDataRetry}
              </button>
            </div>
          ) : points.length === 0 ? (
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
          <div className="qsh-surface p-3">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatMin}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatWeightNumber(stats.minKg, weightUnit)}
            </dd>
          </div>
          <div className="qsh-surface p-3">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatMax}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatWeightNumber(stats.maxKg, weightUnit)}
            </dd>
          </div>
          <div className="qsh-surface p-3">
            <dt className="text-xs text-slate-500 dark:text-slate-400">{COPY.weightStatMean}</dt>
            <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
              {formatWeightNumber(stats.meanKg, weightUnit)}
            </dd>
          </div>
          <div className="qsh-surface p-3">
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

        <div className="qsh-surface p-5">
          <h2 className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">近期记录</h2>
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
