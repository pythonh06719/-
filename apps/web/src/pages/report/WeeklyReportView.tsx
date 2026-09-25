import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WeeklyReport } from '@qsh/shared-types';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { todayKey } from '@/lib/format';
import { COPY, reportHabitRateLabel, weeklyWeightReading } from '@/lib/copy';
import ShareCard from '@/components/feedback/ShareCard';
import IntakeExerciseChart from './IntakeExerciseChart';
import WeeklyDiversityRow from './WeeklyDiversityRow';

/**
 * 周报视图（pages/report/WeeklyReportView.tsx）。
 *
 * ⚠️ **D-8：现有周报 JSX 原样迁入**（原 `ReportPage.tsx`，R4.1 / R4.2 / R11.1 / C2）——
 * 一行逻辑不改、样式类名一个字符不改（Q-7），只挪位置 + 类型改从 shared-types 导入（D-2）。
 * `report-trends.test.tsx`（回归基线）直接渲染 `ReportPage` 并断言这里的周报内容，
 * 默认 tab 就是「本周」，weekly 查询挂载时照常发出（K27）。
 *
 * R11.7：趋势图 section 之后追加一行「这周吃到了 N 种不同的食物」（可展开）。
 */
export default function WeeklyReportView(): ReactElement {
  const endDate = todayKey();
  const reportQuery = useQuery({
    queryKey: queryKeys.weeklyReport(endDate),
    queryFn: () => api.get<WeeklyReport>('/report/weekly', { endDate }),
    retry: 0,
  });

  const report = reportQuery.data;

  /**
   * 习惯达成率（C2）：一周累计打卡次数 ÷ 一周应打卡槽位（7 天 × 每日习惯数）。
   * 无任何习惯（槽位为 0）时为 `null` —— 此时不显示 0%，而是给一句中性引导。
   */
  const habitsDoneTotal = (report?.days ?? []).reduce((sum, day) => sum + day.habitsDone, 0);
  const habitsSlotsTotal = (report?.days ?? []).reduce((sum, day) => sum + day.habitsTotal, 0);
  const habitRate = habitsSlotsTotal > 0 ? Math.round((habitsDoneTotal / habitsSlotsTotal) * 100) : null;

  return (
    <>
      {/* 分享卡片（三期）：周报关键数据 → 720×960 PNG，仅含变化量等非敏感信息 */}
      {report && (
        <ShareCard
          weekLabel={`${report.from.slice(5)} ~ ${report.to.slice(5)}`}
          avgIntakeKcal={report.avgIntakeKcal}
          totalExerciseKcal={report.totalExerciseKcal}
          weightChangeKg={report.weightChangeKg}
          encouragement="这一周都好好吃饭了，值得记下来"
        />
      )}
      {!report ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:bg-slate-800 dark:text-slate-400">
          {reportQuery.isLoading ? '正在整理这一周…' : '暂时拿不到周报，稍后再看看'}
        </p>
      ) : (
        <>
          <section className="qsh-surface p-5">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              近 7 天（{report.from} ~ {report.to}）
            </h2>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-700">
                <p className="text-xs text-slate-500 dark:text-slate-300">日均摄入</p>
                <p className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">{report.avgIntakeKcal}</p>
                <p className="text-xs text-slate-500 dark:text-slate-300">kcal</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-700">
                <p className="text-xs text-slate-500 dark:text-slate-300">运动消耗</p>
                <p className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">{report.totalExerciseKcal}</p>
                <p className="text-xs text-slate-500 dark:text-slate-300">kcal</p>
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
              <IntakeExerciseChart days={report.days} />
            </div>

            {/* 逐日精确数值（图表给对比、列表给数字），沿用既有列表形式 */}
            <ul className="mt-4 space-y-1.5" aria-label="每日摄入与运动">
              {report.days.map((day) => (
                <li
                  key={day.date}
                  className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400"
                >
                  <span className="w-12 shrink-0">{day.date.slice(5)}</span>
                  <span className="flex-1 text-right text-slate-600 dark:text-slate-300">
                    摄入 {Math.round(day.intakeKcal)} · 运动 {Math.round(day.exerciseKcal)} kcal
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
              {report.micronutrients.map((item) => {
                const percent = Math.min(150, Math.round((item.dailyAvg / Math.max(1, item.reference)) * 100));
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
                        style={{ width: `${percent}%` }}
                        role="meter"
                        aria-valuenow={percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${item.name}日均占参考值百分比`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{report.referenceNote}</p>
          </section>
        </>
      )}
    </>
  );
}
