import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, isNetworkError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { todayKey } from '@/lib/format';
import ShareCard from '@/components/feedback/ShareCard';

/**
 * 周报（`/report`，PRD §6 第 10 行 / R4.1 / R4.2 / R11.1，二期）。
 *
 * - 周维度摄入 / 运动消耗 / 饮水 / 习惯汇总：用趋势看自己，不做单日评判
 * - **微量营养素面板（免费差异化卖点）**：10 项日均 + DRI 参考条
 */

interface ReportDay {
  date: string;
  intakeKcal: number;
  exerciseKcal: number;
  waterMl: number;
  habitsDone: number;
  habitsTotal: number;
}

interface Micronutrient {
  key: string;
  name: string;
  unit: string;
  dailyAvg: number;
  reference: number;
  direction: string;
}

interface WeeklyReport {
  from: string;
  to: string;
  days: ReportDay[];
  avgIntakeKcal: number;
  totalExerciseKcal: number;
  weightChangeKg: number | null;
  micronutrients: Micronutrient[];
  referenceNote: string;
}

export default function ReportPage(): ReactElement {
  const endDate = todayKey();
  const reportQuery = useQuery({
    queryKey: queryKeys.weeklyReport(endDate),
    queryFn: () => api.get<WeeklyReport>('/report/weekly', { endDate }),
    retry: 0,
  });

  const report = reportQuery.data;
  const maxIntake = Math.max(1, ...(report?.days ?? []).map((day) => day.intakeKcal));

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4">
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

            <ul className="mt-4 space-y-2" aria-label="每日摄入">
              {report.days.map((day) => (
                <li key={day.date} className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="w-16 shrink-0">{day.date.slice(5)}</span>
                  <span className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                    <span
                      className="block h-full rounded-full bg-brand-400"
                      style={{ width: `${Math.round((day.intakeKcal / maxIntake) * 100)}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right">{Math.round(day.intakeKcal)} kcal</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              体重涨一点不用慌，{report.weightChangeKg !== null && report.weightChangeKg > 0 ? '波动很正常，看趋势就好' : '继续看趋势就好'}。
            </p>
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
    </div>
  );
}
