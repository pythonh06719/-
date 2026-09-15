import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateWeightLogRequest,
  Paginated,
  WeightLog,
  WeightTrendPoint,
  WeightTrendResponse,
} from '@qsh/shared-types';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { CACHE_KEYS, cacheGet, cacheSet } from '@/lib/local-cache';
import { addDays, formatFullDate, formatSigned, todayKey } from '@/lib/format';
import { COPY } from '@/lib/copy';
import { computeMovingAverage7d, computeTrendStats, isWeightRising, toTrendPoints } from '@/lib/trend';
import { enqueueRequest } from '@/pwa/offline-queue';

/** ECharts 图表按需加载，避免拖慢首屏主包（NFR-3）。 */
const WeightChart = lazy(() => import('./WeightChart'));

/**
 * 体重趋势（`/weight`，PRD §6 第 6 行 / R7.1 / R7.2 / TC-34）。
 *
 * - 每日体重记录（建议早晨空腹）+ 备注
 * - ECharts 趋势图：实际体重曲线 + **7 日移动平均线**
 * - 7 日移动平均优先取后端 `movingAverage7`（契约 `WeightTrendResponse.movingAverage7`）；后端不可用时用 `lib/trend.ts` 的**纯函数**本地计算
 * - 体重上涨时展示中性文案「波动很正常，看趋势就好」（不指责、不制造焦虑）
 */

/** 把任意后端返回形态归一为趋势点。 */
function normalizePoints(response: WeightTrendResponse | Paginated<WeightLog> | WeightLog[]): WeightTrendPoint[] {
  if (Array.isArray(response)) {
    return toTrendPoints(response);
  }
  if ('points' in response) {
    return toTrendPoints(response.points);
  }
  return toTrendPoints(response.items ?? []);
}

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

export default function WeightPage(): ReactElement {
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(todayKey());
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const trendQuery = useQuery({
    queryKey: queryKeys.weightTrend,
    queryFn: () => api.get<WeightTrendResponse | Paginated<WeightLog>>('/weights', { limit: 200 }),
  });

  useEffect(() => {
    if (trendQuery.data !== undefined) {
      cacheSet(CACHE_KEYS.weightPoints, normalizePoints(trendQuery.data));
    }
  }, [trendQuery.data]);

  const cachedPoints = cacheGet<WeightTrendPoint[]>(CACHE_KEYS.weightPoints) ?? [];
  const points = useMemo<WeightTrendPoint[]>(
    () => (trendQuery.data !== undefined ? normalizePoints(trendQuery.data) : cachedPoints),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trendQuery.data],
  );
  const movingAverage = useMemo(
    () => resolveMovingAverage(trendQuery.data, points),
    [trendQuery.data, points],
  );
  const stats = useMemo(() => computeTrendStats(points), [points]);
  const rising = useMemo(() => isWeightRising(points), [points]);

  const addWeight = useMutation({
    mutationFn: (payload: CreateWeightLogRequest) => api.post<WeightLog>('/weights', payload),
    onSuccess: async () => {
      setWeight('');
      setNote('');
      setNotice('已经记下今天的体重啦');
      await queryClient.invalidateQueries({ queryKey: queryKeys.weightTrend });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(todayKey()) });
    },
    onError: async (_error, variables) => {
      await enqueueRequest({ path: '/weights', method: 'POST', body: variables });
      setWeight('');
      setNote('');
      setNotice(COPY.offlineQueued);
    },
  });

  const chartData = useMemo(
    () => ({
      dates: points.map((point) => point.date),
      weights: points.map((point) => point.weightKg),
      movingAverage: movingAverage.map((point) => point.value),
    }),
    [points, movingAverage],
  );

  const handleSubmit = (): void => {
    const value = Number(weight);
    if (!Number.isFinite(value) || value <= 0 || value >= 500) {
      setNotice('体重填一个 0 到 500 之间的数字就好');
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
    <section aria-labelledby="weight-title" className="space-y-5">
      <h1 id="weight-title" className="text-xl font-semibold text-slate-900 dark:text-slate-100">
        体重趋势
      </h1>

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
            体重（kg）
            <input
              inputMode="decimal"
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              placeholder="如：59.8"
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

      {rising && (
        <p
          role="status"
          className="rounded-2xl bg-brand-50 px-4 py-3 text-sm font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          {COPY.weightFluctuation}
        </p>
      )}

      <div className="qsh-surface rounded-2xl p-4 dark:bg-slate-800 dark:ring-slate-700">
        <h2 className="px-1 text-sm font-semibold text-slate-800 dark:text-slate-100">体重曲线与 7 日均线</h2>
        {points.length === 0 ? (
          <p className="mt-3 px-1 text-sm text-slate-500 dark:text-slate-400">{COPY.emptyWeight}</p>
        ) : (
          <div className="mt-2 h-64 w-full" aria-label="体重趋势折线图">
            <Suspense
              fallback={
                <p className="flex h-full items-center justify-center text-sm text-slate-400">
                  正在准备图表…
                </p>
              }
            >
              <WeightChart
                dates={chartData.dates}
                weights={chartData.weights}
                movingAverage={chartData.movingAverage}
              />
            </Suspense>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-center">
        <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
          <dt className="text-xs text-slate-500 dark:text-slate-400">最低</dt>
          <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
            {stats.minKg === null ? '—' : stats.minKg.toFixed(1)}
          </dd>
        </div>
        <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
          <dt className="text-xs text-slate-500 dark:text-slate-400">最高</dt>
          <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
            {stats.maxKg === null ? '—' : stats.maxKg.toFixed(1)}
          </dd>
        </div>
        <div className="qsh-surface rounded-2xl p-3 dark:bg-slate-800 dark:ring-slate-700">
          <dt className="text-xs text-slate-500 dark:text-slate-400">净变化</dt>
          <dd className="qsh-tnum mt-1 font-semibold text-slate-800 dark:text-slate-100">
            {stats.changeKg === null ? '—' : formatSigned(stats.changeKg)}
          </dd>
        </div>
      </dl>

      <p className="px-1 text-xs text-slate-400 dark:text-slate-500">
        趋势图默认展示最近 {points.length} 笔记录
        {points.length > 0 ? `，起始于 ${formatFullDate(points[0]?.date ?? todayKey())}` : ''}。
        {points.length > 0 && movingAverage.length > 0
          ? ` 7 日均线为最近 ${Math.min(7, points.length)} 个自然日的平均值。`
          : ''}
        想看更早的记录，可以继续往上翻。
      </p>

      <div className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">近期记录</h2>
        {points.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">还没有记录</p>
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
                    {point.weightKg.toFixed(1)} kg
                  </span>
                </li>
              ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          参考：{addDays(todayKey(), -6)} 起的 7 日窗口用于计算移动平均。
        </p>
      </div>
    </section>
  );
}
