import type { ReactElement } from 'react';
import {
  COPY,
  plateauSlopeHint,
  plateauSlopeLine,
  plateauStalledLine,
} from '@/lib/copy';

/**
 * 平台期说明卡（pages/weight/PlateauCard.tsx，R2.7）。
 *
 * 触发时机由 `detectWeightPlateau`（`@qsh/core` 纯函数）决定：连续约 3 周
 * 7 日均线变化 < 0.3kg。本卡只做三件事：
 *   ① 解释「为什么」（身体适应 + 日常波动，**不指责、不暗示用户做错了什么**）
 *   ② 把视角从「每天的数字」拉到「4 周斜率」
 *   ③ 说明我们**不会**因此建议加大缺口
 *
 * 视觉与语气遵循 PRD §7：只用品牌色（**无红色恐吓语义**），文案全部来自 `lib/copy.ts`。
 */

export interface PlateauCardProps {
  /** 停滞天数（由 `detectWeightPlateau` 返回） */
  stalledDays: number;
  /** 近 4 周斜率 kg/周（`null` = 数据不足，此时不展示斜率那一行） */
  slope4wKgPerWeek: number | null;
}

export default function PlateauCard({
  stalledDays,
  slope4wKgPerWeek,
}: PlateauCardProps): ReactElement {
  return (
    <section
      aria-labelledby="plateau-title"
      className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
    >
      <h2 id="plateau-title" className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {COPY.plateauTitle}
      </h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{COPY.plateauBody}</p>

      <dl className="mt-3 space-y-2 rounded-xl bg-brand-50 p-4 dark:bg-brand-900/40">
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">这几周发生了什么</dt>
          <dd className="mt-0.5 text-sm text-slate-700 dark:text-slate-200">
            {plateauStalledLine(stalledDays)}
          </dd>
        </div>
        {slope4wKgPerWeek !== null && (
          <div>
            <dt className="text-xs text-slate-500 dark:text-slate-400">换个尺度看</dt>
            <dd className="mt-0.5 text-sm text-slate-700 dark:text-slate-200">
              <span className="block">{plateauSlopeLine(slope4wKgPerWeek)}</span>
              <span className="block">{plateauSlopeHint(slope4wKgPerWeek)}</span>
            </dd>
          </div>
        )}
      </dl>

      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{COPY.plateauFootnote}</p>
    </section>
  );
}
