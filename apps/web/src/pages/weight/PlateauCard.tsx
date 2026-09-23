import type { ReactElement } from 'react';
import {
  COPY,
  plateauSlopeHint,
  plateauSlopeLine,
  plateauStalledLine,
} from '@/lib/copy';

/**
 * 平台期说明卡（pages/weight/PlateauCard.tsx，R2.7 / AC-11.1.6）。
 *
 * 触发时机由 `detectWeightPlateau`（`@qsh/core` 纯函数）决定：连续约 3 周
 * 7 日均线变化 < 0.3kg。本卡只做三件事：
 *   ① 解释「为什么」（身体适应 + 日常波动，**不指责、不暗示用户做错了什么**）
 *   ② 把视角从「每天的数字」拉到「4 周斜率」
 *   ③ 说明我们**不会**因此建议加大缺口
 *
 * AC-11.1.6：卡片提供**温和的收起按钮**（`onDismiss`）—— 是否展示、收起后的频控
 * 都由 `WeightPage` 通过 `lib/plateau-visibility.ts` 决定；本组件只负责「点了要发生什么」。
 *
 * 视觉与语气遵循 PRD §7：只用品牌色（**无红色恐吓语义**），文案全部来自 `lib/copy.ts`。
 */

export interface PlateauCardProps {
  /** 停滞天数（由 `detectWeightPlateau` 返回） */
  stalledDays: number;
  /** 近 4 周斜率 kg/周（`null` = 数据不足，此时不展示斜率那一行） */
  slope4wKgPerWeek: number | null;
  /** 用户点「收起」时调用（由父组件写入本地频控状态并隐藏本卡） */
  onDismiss: () => void;
}

export default function PlateauCard({
  stalledDays,
  slope4wKgPerWeek,
  onDismiss,
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

      {/*
        AC-11.1.6：温和的收起按钮。刻意**不用**「关闭 / 忽略 / 不再显示」这类生硬字眼，
        也不用醒目的 ✕ 图标 —— 保留触控目标（qsh-touch-target）与无障碍标签。
      */}
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          aria-label={COPY.plateauDismissAria}
          className="qsh-touch-target inline-flex items-center rounded-xl px-3 py-2 text-xs font-medium text-slate-500 underline decoration-dotted underline-offset-4 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
        >
          {COPY.plateauDismiss}
        </button>
      </div>
    </section>
  );
}
