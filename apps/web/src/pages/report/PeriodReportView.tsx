import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PeriodDays, PeriodReport, TopFoodItem, TopFoodsResponse } from '@qsh/shared-types';
import { PERIOD_DAY_OPTIONS } from '@qsh/core';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { formatMonthDay, todayKey } from '@/lib/format';
import {
  COPY,
  periodDayOptionLabel,
  periodDistinctLine,
  periodExerciseLine,
  periodHabitsLine,
  periodLoggedDaysLine,
  periodMealEntryLine,
  periodRangeFallbackLine,
  periodRangeLine,
  periodTopDaysText,
  periodWinCountLine,
  topFoodsAria,
} from '@/lib/copy';
import { periodWeightDownLine, periodWeightUpLine } from '@/lib/weight-copy';
import { useUnitStore } from '@/lib/units';

/** 回顾页常吃 Top 条数（D-4：复用 `GET /foods/top`，不进 `PeriodReport` 白名单）。 */
const PERIOD_TOP_FOODS_LIMIT = 5;

/** 安全取字符串：非字符串（字段缺失 / 形态异常）一律收成空串，杜绝 `undefined.split` 抛错。 */
function safeStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 安全取有限数字：非有限数（字段缺失 / 形态异常）一律收成 0。 */
function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 阶段回顾视图（pages/report/PeriodReportView.tsx，R11.3）。
 *
 * ⚠️ **反评判红线（K26 / AC-11.3.2 / 11.3.3 / 11.3.6）—— 本组件的结构性约束**：
 * - 指标全部是**独立陈述句**，句子一律来自 `lib/copy.ts` 的 `period*Line()` 函数，
 *   组件里不内联拼数字句（集中一处过红线审）；
 * - **禁止** `role="meter"` / `<progress>` / 任何进度条；**禁止** `X/Y` 分数式与百分比 ——
 *   `PeriodReport` 类型只有白名单 6 类字段，结构上不存在分母；
 * - 体重 `weight === null`（含区间内只有一条）→ **整块不渲染**，不显示 0 也不显示「—」；
 *   有值时只说方向与差值，**后面不接任何判断句**（QR-4）；
 * - `winCount === 0` → 第 6 类整块不渲染（Q-5：0 在这里会被读成成绩）；
 * - 区间零记录（`hasAnyData === false`）→ **整屏空态**，不渲染任何指标卡（AC-11.3.5）；
 * - 常吃 Top5 复用 `GET /foods/top`（D-4），不足门槛 → 整块隐藏（AC-11.5.2 同规则）。
 */
export default function PeriodReportView(): ReactElement {
  const [days, setDays] = useState<PeriodDays>(30);
  const endDate = todayKey();
  /** 全局体重单位（D-3）：体重变化那行按此换算（计算仍为 kg）。 */
  const weightUnit = useUnitStore((state) => state.weightUnit);

  const reportQuery = useQuery({
    queryKey: queryKeys.periodReport(days, endDate),
    queryFn: () => api.get<PeriodReport>('/report/period', { days, endDate }),
    retry: 0,
  });
  const report = reportQuery.data;

  const topQuery = useQuery({
    queryKey: queryKeys.foodTop(days, PERIOD_TOP_FOODS_LIMIT),
    queryFn: () => api.get<TopFoodsResponse>('/foods/top', { days, limit: PERIOD_TOP_FOODS_LIMIT }),
    // 没有任何记录时不必请求（整屏空态已覆盖）
    enabled: report?.hasAnyData === true,
    retry: 0,
  });

  const hasReport = report !== undefined && reportQuery.isSuccess;
  const topItems: TopFoodItem[] =
    topQuery.data !== undefined && Array.isArray(topQuery.data.items) ? topQuery.data.items : [];

  // 防御（无 ErrorBoundary → 字段缺失 / 形态异常会整页白屏）：数组先 `Array.isArray`，
  // 对象先判存在并兜底默认值，`report` 可能来自旧缓存 / 测试桩通用返回。
  const topHabits = report !== undefined && Array.isArray(report.topHabits) ? report.topHabits : [];
  const exercise = report?.exercise;
  // 守卫须覆盖 null（不能只判 undefined）：异常响应 / 旧缓存可能给 null，
  // 与 `weight ?? null` 的对称写法保持一致（QA P3）。
  const hasExercise = exercise !== undefined && exercise !== null;
  const exerciseSessions = hasExercise && Number.isFinite(exercise.sessions) ? exercise.sessions : 0;
  const exerciseMinutes = hasExercise && Number.isFinite(exercise.totalMinutes) ? exercise.totalMinutes : 0;
  const weight = report?.weight ?? null;
  /** `weight` 字段在「取值处」收口：非 null 但非对象（数组 / 字符串等形态异常）也视为无数据，
   *  否则 `.deltaKg` 取到 `undefined` 会走到 `periodWeightUpLine(undefined)`（虽函数内有兜底，口径仍应干净）。 */
  const hasWeightDelta =
    typeof weight === 'object' &&
    weight !== null &&
    typeof (weight as { deltaKg?: unknown }).deltaKg === 'number' &&
    Number.isFinite((weight as { deltaKg: number }).deltaKg) &&
    (weight as { deltaKg: number }).deltaKg !== 0;
  const weightDeltaKg = hasWeightDelta ? (weight as { deltaKg: number }).deltaKg : 0;
  /** 区间起止：非字符串（字段缺失）收成空串。 */
  const rangeFrom = safeStr(report?.from);
  const rangeTo = safeStr(report?.to);
  /** 两端都有真实日期才走 `periodRangeLine`；否则退化为「档位（这段时间暂时取不到具体日期）」——
   *  **不**把空串喂给 `formatMonthDay`（那会得到 `NaN月NaN日`，既难看又像数据异常）。 */
  const hasRange = rangeFrom !== '' && rangeTo !== '';
  const rangeLine = hasRange
    ? periodRangeLine(safeNum(report?.days), rangeFrom, rangeTo, formatMonthDay)
    : periodRangeFallbackLine(periodDayOptionLabel(safeNum(report?.days)));

  return (
    <div className="flex flex-col gap-4" aria-label={COPY.reportTabPeriod}>
      {/* 档位切换：近 30 天 / 近 365 天（QR-3 只两档） */}
      <div role="tablist" aria-label="回顾档位" className="flex gap-1.5">
        {PERIOD_DAY_OPTIONS.map((option) => (
          <button
            key={option}
            role="tab"
            type="button"
            aria-selected={days === option}
            onClick={() => setDays(option)}
            className={[
              'qsh-touch-target shrink-0 rounded-pill px-4 text-sm transition',
              days === option
                ? 'bg-brand-600 text-white'
                : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
            ].join(' ')}
          >
            {periodDayOptionLabel(option)}
          </button>
        ))}
      </div>

      {!hasReport ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
          {reportQuery.isLoading ? '正在整理这段时间…' : '暂时拿不到回顾，稍后再看看'}
        </p>
      ) : !report.hasAnyData ? (
        /* 整屏空态：不渲染任何指标卡（AC-11.3.5） */
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
          {COPY.periodEmpty}
        </p>
      ) : (
        <section className="qsh-surface p-5" aria-labelledby="period-metrics-title">
          <h2 id="period-metrics-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {COPY.reportTabPeriod}
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400" data-testid="period-range">
            {rangeLine}
          </p>

          {/* 六项白名单指标：全部独立陈述句（句子来自 copy.ts，组件不拼数字） */}
          <ul className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-200" data-testid="period-metrics">
            <li>{periodLoggedDaysLine(safeNum(report.loggedDays))}</li>
            <li>{periodDistinctLine(safeNum(report.distinctFoodCount))}</li>
            <li>{periodMealEntryLine(safeNum(report.mealEntryCount))}</li>
            {topHabits.length > 0 && <li>{periodHabitsLine(topHabits)}</li>}
            {exerciseSessions > 0 && (
              <li>{periodExerciseLine(exerciseSessions, exerciseMinutes)}</li>
            )}
            {safeNum(report.winCount) > 0 && <li data-testid="period-win-count">{periodWinCountLine(safeNum(report.winCount))}</li>}
          </ul>

          {/* 体重变化：只有首末两条**不同**记录才渲染；只说方向与差值，不接判断句（QR-4） */}
          {hasWeightDelta && (
            <p
              className="mt-4 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
              data-testid="period-weight"
            >
              {weightDeltaKg < 0
                ? periodWeightDownLine(weightDeltaKg, weightUnit)
                : periodWeightUpLine(weightDeltaKg, weightUnit)}
            </p>
          )}
        </section>
      )}

      {/* 常吃 Top5（复用 `GET /foods/top`，D-4）：不足门槛 → 整块隐藏（AC-11.5.2 同规则） */}
      {hasReport && report.hasAnyData && topItems.length > 0 && (
        <section className="qsh-surface p-5" aria-labelledby="period-top-title">
          <h2 id="period-top-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {COPY.periodTopTitle}
          </h2>
          <ul className="mt-3 space-y-2">
            {topItems.map((item) => (
              <li
                key={item.foodItemId ?? item.name}
                aria-label={topFoodsAria(item.name, item.dayCount, days)}
                className="flex items-center justify-between gap-3 rounded-control px-4 py-3 ring-1 ring-brand-100 dark:ring-slate-700"
              >
                <span className="min-w-0 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  {item.name}
                </span>
                <span className="qsh-tnum shrink-0 text-xs text-slate-600 dark:text-slate-300">
                  {periodTopDaysText(item.dayCount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
