import type { ReactElement } from 'react';
import type { GoalProgress } from '@qsh/shared-types';
import ProgressRing from '@/components/common/ProgressRing';
import {
  COPY,
  goalBaselineLine,
  goalEtaLine,
  goalRemainingLine,
  goalTargetLine,
  maintenanceLine,
} from '@/lib/copy';

/**
 * 目标达成进度卡（pages/weight/GoalProgressCard.tsx，R2.7）。
 *
 * 回答「走到哪儿了 / 还要多久」；**已达成目标时切换为维持模式** ——
 * 不再显示「还需 X 周」，改为「已经到啦 + 维持热量」，绝不出现
 * 「继续减」「再接再厉制造缺口」之类的暗示（PRD §7）。
 *
 * 组件本身**不含任何文案常量**：所有措辞来自 `lib/copy.ts`，便于统一审校。
 * 数据由服务端算好（`WeightTrendResponse.goalProgress`），这里只负责渲染。
 */

export interface GoalProgressCardProps {
  /** 服务端算好的目标进度（`null` 时不渲染本卡，由调用方决定） */
  progress: GoalProgress;
}

export default function GoalProgressCard({ progress }: GoalProgressCardProps): ReactElement {
  const percent = Math.round(progress.progressRatio * 100);
  const title = progress.maintenance ? COPY.goalProgressReachedTitle : COPY.goalProgressTitle;

  /** 主行：维持模式给安抚 + 维持热量；未达成给「还差多少」。 */
  const primaryLine = progress.maintenance
    ? COPY.goalProgressReachedBody
    : progress.remainingKg !== null
      ? goalRemainingLine(progress.remainingKg)
      : goalTargetLine(progress.targetWeightKg);

  /** 副行：维持模式给维持热量；未达成优先给「还需几周」，算不出来才退回目标值。 */
  const secondaryLine = progress.maintenance
    ? progress.maintenanceKcal !== null
      ? maintenanceLine(progress.maintenanceKcal)
      : null
    : progress.etaWeeks !== null && progress.etaWeeks > 0
      ? goalEtaLine(progress.etaWeeks)
      : goalTargetLine(progress.targetWeightKg);

  return (
    <section
      aria-labelledby="goal-progress-title"
      className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
    >
      <h2 id="goal-progress-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {title}
      </h2>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-center">
        {/* `ProgressRing` 的环内文案是绝对定位，这里补一层定位上下文，保证居中稳定 */}
        <div className="relative inline-flex shrink-0 items-center justify-center">
          <ProgressRing
            value={progress.progressRatio}
            size={112}
            strokeWidth={10}
            centerValue={`${percent}%`}
            centerLabel={COPY.goalProgressRingLabel}
            ariaLabel={`${COPY.goalProgressRingLabel} ${percent}%`}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-1 text-center text-sm text-slate-600 sm:text-left dark:text-slate-300">
          <p className="font-medium text-slate-800 dark:text-slate-100">{primaryLine}</p>
          {secondaryLine !== null && <p>{secondaryLine}</p>}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {goalBaselineLine(progress.baselineKg, progress.targetWeightKg)}
          </p>
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{COPY.goalProgressFootnote}</p>
    </section>
  );
}
