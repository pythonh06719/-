import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ReportCalendarKind, ReportCalendarResponse } from '@qsh/shared-types';
import { calendarDepthLevel } from '@qsh/core';

import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { formatMonthDay } from '@/lib/format';
import {
  COPY,
  footprintCalendarAria,
  footprintDayAria,
  footprintLegendLevel,
  footprintMonthSummary,
  footprintMonthTitle,
} from '@/lib/copy';
import { WEEKDAY_HEADERS, addMonths, buildMonthCells, currentMonthKey } from '@/lib/month-grid';

/**
 * 记录足迹（pages/report/FootprintView.tsx，C-1）—— `/report` 的第三个 tab。
 *
 * 一张**当月月历**：有记录的日期点亮，颜色**深浅**表示当天记录的**丰富度**
 * （= 有记录的模块**种类数**，口径见 `@qsh/core` 的 `calendarDepthLevel` / `/why-numbers` ㉓）。
 *
 * ## 语气红线（PRD §7 / C-1，自动化封口见 `test/report-calendar.test.tsx`）
 * - **只表示「有没有记 / 记了几类」**，不表示好坏、不表示热量高低、不打分；
 * - **缺记录的日子留白**：不填灰、不画叉、不写「未完成」；
 * - 页面**不出现**「连续 / 断 / 完成率 / 达成率 / 缺失」等词，**也没有任何百分比 / 分母**；
 * - 只在用户**主动进入该 tab** 时取数，不做任何主动提醒（NFR-10）。
 *
 * 点格 → 复用既有「一日档案」：`/diary?date=YYYY-MM-DD`。
 */

/** 深浅色阶（1 浅 → 3 最深）。只用品牌色，**不用红色 / 警示色**。 */
const SHADE_BY_LEVEL: Readonly<Record<number, string>> = {
  1: 'bg-brand-100 text-brand-800 dark:bg-brand-900/50 dark:text-brand-200',
  2: 'bg-brand-300 text-brand-900 dark:bg-brand-700 dark:text-brand-100',
  3: 'bg-brand-500 text-white dark:bg-brand-400 dark:text-brand-900',
};

/** 色阶档位（1 ~ 3），用于图例。 */
const LEGEND_LEVELS: readonly number[] = [1, 2, 3];

export default function FootprintView(): ReactElement {
  const thisMonth = currentMonthKey();
  const [month, setMonth] = useState<string>(thisMonth);

  const calendarQuery = useQuery({
    queryKey: queryKeys.reportCalendar(month),
    queryFn: () => api.get<ReportCalendarResponse>('/report/calendar', { month }),
    retry: 0,
  });

  /** 日期 → 当天有记录的模块种类集合（仅**有记录**的日子会出现在响应里）。 */
  const kindsByDate = useMemo(() => {
    const map = new Map<string, readonly ReportCalendarKind[]>();
    for (const day of calendarQuery.data?.days ?? []) {
      map.set(day.date, day.kinds);
    }
    return map;
  }, [calendarQuery.data]);

  const cells = useMemo(() => buildMonthCells(month), [month]);
  const recordedDays = calendarQuery.data?.days.length ?? 0;
  const monthLabel = footprintMonthTitle(month);
  const isCurrentMonth = month >= thisMonth;
  const isEmptyMonth = calendarQuery.isSuccess && recordedDays === 0;

  return (
    // C-6 宽屏（≥1024px）：单张月历不适合摊进多栏 —— 7 列格子拉满 5xl 会变成超大方块。
    // 故 `lg` 下把整卡居中并限宽（`max-w-lg`），格子尺寸回到与移动端相近的舒适区。
    // 移动端类名不变。
    <section
      data-testid="report-footprint"
      aria-labelledby="footprint-title"
      className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700 lg:mx-auto lg:max-w-lg"
    >
      <h2 id="footprint-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {COPY.footprintTitle}
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{COPY.footprintDesc}</p>

      {/* 月份切换：只换「看哪个月」，取数方式不变 */}
      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonth((current) => addMonths(current, -1))}
          aria-label={COPY.footprintPrevMonthAria}
          className="qsh-touch-target rounded-lg px-3 text-sm text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
        >
          {COPY.footprintPrevMonth}
        </button>
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200" data-testid="footprint-month">
          {monthLabel}
        </span>
        {isCurrentMonth ? (
          <button
            type="button"
            disabled
            aria-label={COPY.footprintNextMonthAria}
            className="qsh-touch-target rounded-lg px-3 text-sm text-slate-300 ring-1 ring-brand-100 dark:text-slate-600 dark:ring-slate-700"
          >
            {COPY.footprintNextMonth}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setMonth((current) => addMonths(current, 1))}
            aria-label={COPY.footprintNextMonthAria}
            className="qsh-touch-target rounded-lg px-3 text-sm text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
          >
            {COPY.footprintNextMonth}
          </button>
        )}
      </div>

      {/* 汇总行：**只有分子，没有分母**（有空分母就会被读成完成度） */}
      {calendarQuery.isSuccess && (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300" data-testid="footprint-summary">
          {isEmptyMonth ? COPY.footprintEmptyMonth : footprintMonthSummary(recordedDays)}
        </p>
      )}

      {calendarQuery.isLoading && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{COPY.footprintLoading}</p>
      )}

      {/* 读取不顺：软着陆，**不渲染空网格**（否则会把「读不到」误说成「一天没记」） */}
      {calendarQuery.isError && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-testid="footprint-error">
          {COPY.footprintLoadError}
        </p>
      )}

      {calendarQuery.isSuccess && (
        <>
          <div
            role="group"
            aria-label={footprintCalendarAria(monthLabel, recordedDays)}
            data-testid="footprint-grid"
            className="mt-3 grid grid-cols-7 gap-1.5"
          >
            {WEEKDAY_HEADERS.map((label, index) => (
              <span
                key={`weekday-${index}`}
                aria-hidden="true"
                className="text-center text-[10px] text-slate-400 dark:text-slate-500"
              >
                {label}
              </span>
            ))}
            {cells.map((date, index) => {
              // 月初 / 月末补位：纯占位，无任何视觉与语义
              if (date === null) {
                return <span key={`pad-${index}`} aria-hidden="true" className="aspect-square" />;
              }

              const kinds = kindsByDate.get(date);
              const level = calendarDepthLevel(kinds?.length ?? 0);
              const dayNumber = Number(date.slice(8, 10));

              // 无记录的日子：**留白**（只有淡淡的日期数字，无填充 / 无边框 / 无叉 / 不标红）
              if (level === 0) {
                return (
                  <span
                    key={date}
                    data-date={date}
                    data-blank="true"
                    aria-hidden="true"
                    className="flex aspect-square items-center justify-center rounded-[5px] text-xs text-slate-300 dark:text-slate-600"
                  >
                    {dayNumber}
                  </span>
                );
              }

              // 有记录的日子：点亮（深浅 = 当天记录的种类数），点格 → 那一天的档案
              return (
                <Link
                  key={date}
                  to={`/diary?date=${date}`}
                  data-date={date}
                  data-level={level}
                  aria-label={footprintDayAria(formatMonthDay(date), kinds?.length ?? 0)}
                  className={`flex aspect-square items-center justify-center rounded-[5px] text-xs font-medium transition ${SHADE_BY_LEVEL[level] ?? ''}`}
                >
                  {dayNumber}
                </Link>
              );
            })}
          </div>

          {/* 图例：把「深浅」讲清楚（中性陈述，不评判） */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span>{COPY.footprintLegendNote}</span>
            <span className="flex items-center gap-2">
              {LEGEND_LEVELS.map((level) => (
                <span key={level} className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-3 w-3 rounded-[4px] ${SHADE_BY_LEVEL[level] ?? ''}`}
                  />
                  <span>{footprintLegendLevel(level)}</span>
                </span>
              ))}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
