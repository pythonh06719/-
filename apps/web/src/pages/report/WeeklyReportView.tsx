import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WeeklyReport } from '@qsh/shared-types';
import {
  canShiftWeekForward,
  hasAnyWeeklyRecord,
  resolveWeekWindow,
  shiftWeekEndDate,
  weeksBeforeToday,
} from '@qsh/core';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { formatMonthDay, todayKey } from '@/lib/format';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import {
  COPY,
  reportHabitRateLabel,
  weekRelativeLabel,
  weeklyLoadingLine,
  weeklyWeightReading,
} from '@/lib/copy';
import ShareCard from '@/components/feedback/ShareCard';
import IntakeExerciseChart from './IntakeExerciseChart';
import WeeklyDiversityRow from './WeeklyDiversityRow';

/** 安全取字符串：非字符串（字段缺失 / 形态异常）一律收成空串，杜绝 `undefined.slice` 抛错。 */
function safeStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 安全取数字：非有限数（字段缺失 / 形态异常）一律收成 0，杜绝 `NaN` 渗入展示。 */
function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 周报视图（pages/report/WeeklyReportView.tsx）。
 *
 * ⚠️ **D-8：现有周报 JSX 原样迁入**（原 `ReportPage.tsx`，R4.1 / R4.2 / R11.1 / C2）——
 * 一行逻辑不改、样式类名一个字符不改（Q-7），只挪位置 + 类型改从 shared-types 导入（D-2）。
 * `report-trends.test.tsx`（回归基线）直接渲染 `ReportPage` 并断言这里的周报内容，
 * 默认 tab 就是「本周」，weekly 查询挂载时照常发出（K27）。
 *
 * R11.7：趋势图 section 之后追加一行「这周吃到了 N 种不同的食物」（可展开）。
 *
 * **B2 · 可回看历史周**：`endDate` 不再硬编码今天 ——
 * - 「‹ 上一周 / 下一周 ›」按 7 天平移，`<input type="date">` 直接跳到某一周
 *   （复用 `DiaryPage` 的既有模式，不引第三方日期库）；
 * - **未来禁用**：`endDate` 一律不晚于今天，未来周按钮 `disabled`（不是隐藏后突然失效）；
 * - **往前翻不设硬上限**（后端 `GET /report/weekly?endDate=` 支持任意日期）；
 * - 周边界、翻周、「几周前」、空周判定**全部走 `@qsh/core` 的 `report/week.ts`**
 *   —— 与后端 `from = to − 6` 同一口径，前端不另算一套（口径唯一真源）。
 *
 * **换周不闪旧数据**：切周时查询键随之改变，未命中缓存即 `undefined` →
 * 渲染「正在整理 <目标周>…」占位，**刻意不用 `placeholderData: keepPreviousData`**
 * （那会让上一周的数字短暂出现在新一周的标题下）。
 *
 * **空态中性（无负罪感）**：历史周一条记录都没有时只给一句中性文案，
 * **不渲染**一整面 0 值（0 千卡 / 0 次打卡会被读成评判）。
 */
export default function WeeklyReportView(): ReactElement {
  const today = todayKey();
  const unit = useUnitStore((state) => state.unit);
  /** 正在回看的这一周的「最后一天」（窗口末日 = endDate）。 */
  const [endDate, setEndDate] = useState<string>(today);

  // 窗口口径下沉 core（与后端同一算式）；`null` 仅在今天非法时出现，兜底用今天。
  const weekWindow = resolveWeekWindow(endDate, today);
  const queryEndDate = weekWindow?.to ?? today;
  /** 这一周是几周前（0 = 本周）—— 供 UI 说清「自己在看哪一周」。 */
  const weeksBefore = weeksBeforeToday(endDate, today);
  /** 未来禁用：再往后一周就会越过今天时，按钮置灰（始终渲染，不隐藏）。 */
  const canGoForward = canShiftWeekForward(endDate, today);

  const reportQuery = useQuery({
    queryKey: queryKeys.weeklyReport(queryEndDate),
    queryFn: () => api.get<WeeklyReport>('/report/weekly', { endDate: queryEndDate }),
    retry: 0,
  });

  const report = reportQuery.data;

  // 防御（无 ErrorBoundary → 越界字段会整页白屏）：数组字段一律先 `Array.isArray` 收口，
  // 兼容旧缓存 / 测试桩通用返回 / 后端字段缺失等情况。
  const reportDays = report !== undefined && Array.isArray(report.days) ? report.days : [];
  const micronutrients = report !== undefined && Array.isArray(report.micronutrients) ? report.micronutrients : [];

  // 日期/文本字段在「取值处」收口成安全字符串：后端字段缺失时 `undefined.slice` / `undefined-拼接`
  // 会直接抛错（整页白屏）；收口后 `.slice` / 模板拼接只作用于字符串，缺字段退化到空串。
  const reportFrom = safeStr(report?.from);
  const reportTo = safeStr(report?.to);
  const referenceNote = safeStr(report?.referenceNote);

  /** 日期区间「起 ~ 止」；两端都取不到时退化为「近 7 天」（中性表述，不显示空 / undefined）。 */
  const rangeText =
    reportFrom !== '' && reportTo !== '' ? `${reportFrom} ~ ${reportTo}` : '近 7 天';

  /** 这一周是否留下过任何记录（空周判定也是口径，交给 core，不在组件里另写一套）。 */
  const hasRecords = report === undefined || hasAnyWeeklyRecord(report);

  /**
   * 习惯达成率（C2）：一周累计打卡次数 ÷ 一周应打卡槽位（7 天 × 每日习惯数）。
   * 无任何习惯（槽位为 0）时为 `null` —— 此时不显示 0%，而是给一句中性引导。
   */
  const habitsDoneTotal = reportDays.reduce((sum, day) => sum + safeNum(day.habitsDone), 0);
  const habitsSlotsTotal = reportDays.reduce((sum, day) => sum + safeNum(day.habitsTotal), 0);
  const habitRate = habitsSlotsTotal > 0 ? Math.round((habitsDoneTotal / habitsSlotsTotal) * 100) : null;

  /** 上一周：窗口末日 −7 天（往前翻不设上限）。 */
  const goPrevWeek = (): void => {
    setEndDate((current) => shiftWeekEndDate(current, -1, today));
  };

  /** 下一周：仅在不会越过今天时可点（按钮本身也已 disabled，这里是双保险）。 */
  const goNextWeek = (): void => {
    if (!canGoForward) {
      return;
    }
    setEndDate((current) => shiftWeekEndDate(current, 1, today));
  };

  /** 跳到某一周：直接选该周的末日，窗口边界交给 core 归一（未来日期被裁到今天）。 */
  const jumpToDate = (value: string): void => {
    const next = resolveWeekWindow(value, today);
    if (next !== null) {
      setEndDate(next.to);
    }
  };

  const windowLabel =
    weekWindow === null
      ? ''
      : `${formatMonthDay(weekWindow.from)} ~ ${formatMonthDay(weekWindow.to)} · ${weekRelativeLabel(weeksBefore)}`;

  return (
    <>
      {/* B2：周选择器（常驻渲染 —— 切周时控件不消失，避免闪烁） */}
      <section className="qsh-surface p-4" aria-label={COPY.weekSwitchTitle}>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={goPrevWeek}
            aria-label={COPY.weekPrevAria}
            className="qsh-touch-target rounded-lg px-3 text-sm text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
          >
            {COPY.weekPrev}
          </button>
          <button
            type="button"
            onClick={goNextWeek}
            disabled={!canGoForward}
            aria-label={COPY.weekNextAria}
            className="qsh-touch-target rounded-lg px-3 text-sm text-slate-600 ring-1 ring-brand-100 disabled:opacity-40 dark:text-slate-300 dark:ring-slate-700"
          >
            {COPY.weekNext}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-600 dark:text-slate-300" htmlFor="week-end-date">
            {COPY.weekJumpLabel}
            <input
              id="week-end-date"
              type="date"
              value={endDate}
              max={today}
              onChange={(event) => {
                const next = event.target.value;
                if (next !== '') {
                  jumpToDate(next);
                }
              }}
              className="ml-1.5 rounded-lg border border-brand-100 px-2 py-1 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          {endDate !== today && (
            <button
              type="button"
              onClick={() => setEndDate(today)}
              className="qsh-touch-target rounded-lg px-3 text-sm font-medium text-brand-700 ring-1 ring-brand-100 dark:text-brand-300 dark:ring-slate-700"
            >
              {COPY.weekBackToCurrent}
            </button>
          )}
        </div>

        {/* 窗口口径摊开讲：用户一看就知道自己在看哪一周（NFR-11 可解释性） */}
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400" data-testid="week-window-label">
          {windowLabel}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.weekWindowNote}</p>
      </section>

      {/* 分享卡片（三期）：周报关键数据 → 720×960 PNG，仅含变化量等非敏感信息 */}
      {report !== undefined && hasRecords && (
        <ShareCard
          weekLabel={reportFrom !== '' && reportTo !== '' ? `${reportFrom.slice(5)} ~ ${reportTo.slice(5)}` : '近 7 天'}
          avgIntakeKcal={report.avgIntakeKcal}
          totalExerciseKcal={report.totalExerciseKcal}
          weightChangeKg={report.weightChangeKg}
          unit={unit}
          encouragement="这一周都好好吃饭了，值得记下来"
        />
      )}
      {report === undefined ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
          {reportQuery.isLoading ? weeklyLoadingLine(windowLabel) : '暂时拿不到周报，稍后再看看'}
        </p>
      ) : !hasRecords ? (
        /* B2 空态：这一周一条记录都没有 —— 只说「哪一周 + 一句中性话」，不渲染任何 0 值指标。
           标题沿用 `report.from ~ report.to`：空态也要让用户看清自己在看哪一周（NFR-11）。 */
        <section className="qsh-surface p-5" data-testid="weekly-empty">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            近 7 天（{rangeText}）
          </h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{COPY.weeklyEmptyTitle}</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.weeklyEmptyNote}</p>
        </section>
      ) : (
        <>
          <section className="qsh-surface p-5">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              近 7 天（{rangeText}）
            </h2>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-700">
                <p className="text-xs text-slate-500 dark:text-slate-300">日均摄入</p>
                <p className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">{toDisplayEnergy(report.avgIntakeKcal, unit)}</p>
                <p className="text-xs text-slate-500 dark:text-slate-300">{energyLabel(unit)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-700">
                <p className="text-xs text-slate-500 dark:text-slate-300">运动消耗</p>
                <p className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">{toDisplayEnergy(report.totalExerciseKcal, unit)}</p>
                <p className="text-xs text-slate-500 dark:text-slate-300">{energyLabel(unit)}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-700">
                <p className="text-xs text-slate-500 dark:text-slate-300">体重变化</p>
                <p className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
                  {report.weightChangeKg === null ? '—' : report.weightChangeKg > 0 ? `+${report.weightChangeKg}` : report.weightChangeKg}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-300">kg</p>
              </div>
            </div>

            {/* 摄入 vs 运动（C2）：零依赖手写 SVG 柱状对比，柱高同一尺度 */}
            <h3 className="mt-4 text-sm font-semibold text-slate-800 dark:text-slate-100">
              {COPY.reportTrendTitle}
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.reportTrendCaption}</p>
            <div className="mt-2">
              <IntakeExerciseChart days={reportDays} />
            </div>

            {/* 逐日精确数值（图表给对比、列表给数字），沿用既有列表形式 */}
            <ul className="mt-4 space-y-1.5" aria-label="每日摄入与运动">
              {reportDays.map((day, index) => (
                <li
                  key={`${index}-${safeStr(day.date)}`}
                  className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400"
                >
                  <span className="w-12 shrink-0">{safeStr(day.date).length >= 5 ? safeStr(day.date).slice(5) : '—'}</span>
                  <span className="flex-1 text-right text-slate-600 dark:text-slate-300">
                    摄入 {toDisplayEnergy(safeNum(day.intakeKcal), unit)} · 运动 {toDisplayEnergy(safeNum(day.exerciseKcal), unit)} {energyLabel(unit)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {weeklyWeightReading(report.weightChangeKg)}
            </p>
          </section>

          {/* R11.7：饮食多样性行（趋势图 section 之后；count = 0 时整行隐藏，AC-11.7.5） */}
          <WeeklyDiversityRow report={report} />

          <section className="qsh-surface p-5">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {COPY.reportHabitTitle}
            </h2>
            {habitRate === null ? (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{COPY.reportHabitEmpty}</p>
            ) : (
              <>
                <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                  {reportHabitRateLabel(habitsDoneTotal, habitRate)}
                </p>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                  <div
                    className="h-full rounded-full bg-brand-400"
                    style={{ width: `${habitRate}%` }}
                    role="meter"
                    aria-valuenow={habitRate}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={COPY.reportHabitTitle}
                  />
                </div>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.reportHabitNote}</p>
              </>
            )}
          </section>

          <section className="qsh-surface p-5">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">微量营养素（日均）</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">免费提供，参考条按《中国居民膳食营养素参考摄入量》成人一般人群口径。</p>
            <ul className="mt-3 space-y-3">
              {micronutrients.map((item) => {
                // 视觉条长上限 150%（外层 overflow-hidden 会把超过 100% 的部分裁掉）。
                const barPercent = Math.min(150, Math.round((item.dailyAvg / Math.max(1, item.reference)) * 100));
                // ARIA 值必须落在 [aria-valuemin, aria-valuemax] = [0, 100] 内：
                // 直接把 150 喂给 aria-valuenow 是越界值，读屏会读到与视觉（条已满）不一致的数值。
                // 钳到 100 与「视觉上条已满」一致；真实数值由同行的「{dailyAvg} {unit}」文字给出。
                const ariaPercent = Math.min(100, barPercent);
                const onTrack = item.direction === 'atLeast' ? item.dailyAvg >= item.reference : item.dailyAvg <= item.reference;
                return (
                  <li key={item.key}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-slate-700 dark:text-slate-200">
                        {item.name}
                        <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                          参考{item.direction === 'atLeast' ? '≥' : '≤'} {item.reference} {item.unit}
                        </span>
                      </span>
                      <span className="text-slate-600 dark:text-slate-300">
                        {item.dailyAvg} {item.unit}
                      </span>
                    </div>
                    <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                      <div
                        className={`h-full rounded-full ${onTrack ? 'bg-brand-400' : 'bg-amber-300'}`}
                        style={{ width: `${barPercent}%` }}
                        role="meter"
                        aria-valuenow={ariaPercent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${item.name}日均占参考值百分比`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{referenceNote}</p>
          </section>
        </>
      )}
    </>
  );
}
