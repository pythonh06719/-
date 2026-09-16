import type { ReactElement } from 'react';

/**
 * 大数字展示（components/common/BigNumber.tsx）—— 看板「今日剩余热量」（US-05）。
 *
 * 数字足够大、单位独立、支持单位切换（kcal / kJ）。文案由调用方传入，保持中性（PRD §7）。
 * `size='md'` 用于「降级为次要信息」的场景（首页摘要卡），视觉权重更低。
 */

export interface BigNumberProps {
  /** 主数值（已按当前单位换算） */
  value: number | string;
  /** 单位文案（如 `kcal` / `kJ`） */
  unit?: string;
  /** 数值上方的小标题 */
  caption?: string;
  /** 数值下方的补充说明 */
  hint?: string;
  /** 视觉强调色：`brand` 正向 / `neutral` 中性 */
  tone?: 'brand' | 'neutral';
  /** 字号档位：`lg`（默认，主视觉）/ `md`（次要信息） */
  size?: 'lg' | 'md';
  /** 屏幕阅读器朗读文本 */
  ariaLabel?: string;
}

export default function BigNumber({
  value,
  unit,
  caption,
  hint,
  tone = 'brand',
  size = 'lg',
  ariaLabel,
}: BigNumberProps): ReactElement {
  const valueColor =
    tone === 'brand' ? 'text-brand-700 dark:text-brand-400' : 'text-slate-800 dark:text-slate-100';
  const valueSize = size === 'lg' ? 'text-5xl sm:text-6xl' : 'text-3xl sm:text-4xl';

  return (
    <div className="flex flex-col items-center text-center">
      {caption !== undefined && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{caption}</p>
      )}
      <p className="mt-1 flex items-baseline gap-1.5" aria-label={ariaLabel}>
        <span className={`qsh-tnum font-bold leading-none ${valueSize} ${valueColor}`}>
          {value}
        </span>
        {unit !== undefined && (
          <span className="text-base font-medium text-slate-500 dark:text-slate-400">{unit}</span>
        )}
      </p>
      {hint !== undefined && (
        <p className="mt-2 max-w-xs text-sm text-slate-500 dark:text-slate-400">{hint}</p>
      )}
    </div>
  );
}
