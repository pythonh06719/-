import { useState } from 'react';
import type { ReactElement } from 'react';
import type { WeeklyReport } from '@qsh/shared-types';
import { COPY, diversityAria, diversityCountLine } from '@/lib/copy';

/**
 * 周报多样性行（pages/report/WeeklyDiversityRow.tsx，R11.7）。
 *
 * 一行「这周吃到了 N 种不同的食物」，整行可点展开清单（AC-11.7.1）。
 *
 * 红线（AC-11.7.3）：**只计数，不打分** —— 不评分、不推荐种类数、不说「还差 N 种」、
 * 无进度条 / `role="meter"` / 每类食物的营养标签。
 * 空值（`distinctFoodCount === 0` 或缺失）→ **整行隐藏**（AC-11.7.5：不显示「0 种」，
 * 0 在这里会被读成一种成绩）。
 *
 * 口径（K16）：`distinctFoodCount` 由服务端调 `@qsh/core` 的 `distinctFoodKeys` 得出，
 * 与阶段回顾（R11.3）的「食物种类数」**同一个函数**，本组件不做任何再计算。
 */
export default function WeeklyDiversityRow({ report }: { report: WeeklyReport }): ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  // 兼容老响应（向后兼容扩展字段可能缺失，AC-11.7.6）：缺失按 0 处理 → 整行隐藏
  const count = typeof report.distinctFoodCount === 'number' && Number.isFinite(report.distinctFoodCount)
    ? Math.max(0, Math.floor(report.distinctFoodCount))
    : 0;
  if (count === 0) {
    return null;
  }

  const foods = Array.isArray(report.distinctFoods) ? report.distinctFoods : [];
  const truncated = report.distinctFoodsTruncated === true;

  return (
    <div className="qsh-surface p-5" data-testid="weekly-diversity">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={diversityAria(count, expanded)}
        className="qsh-touch-target flex w-full items-center justify-between gap-3 rounded-control text-left transition-colors duration-qsh-base ease-qsh-out hover:bg-brand-50 dark:hover:bg-slate-700"
      >
        <span className="text-sm text-slate-700 dark:text-slate-200">{diversityCountLine(count)}</span>
        <span className="shrink-0 text-xs font-medium text-brand-700 dark:text-brand-300">
          {expanded ? COPY.diversityCollapse : COPY.diversityExpand}
        </span>
      </button>

      {expanded && (
        <div className="mt-3" data-testid="weekly-diversity-list">
          <p className="text-xs text-slate-500 dark:text-slate-400">{COPY.diversityListTitle}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {foods.map((name) => (
              <li
                key={name}
                className="rounded-pill bg-brand-50 px-3 py-1 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300"
              >
                {name}
              </li>
            ))}
          </ul>
          {truncated && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.diversityTruncated}</p>}
        </div>
      )}
    </div>
  );
}
