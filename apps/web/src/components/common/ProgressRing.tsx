import type { ReactElement } from 'react';
import { TOKENS } from '@/theme/tokens';

/**
 * 进度环（components/common/ProgressRing.tsx）—— 看板核心可视化（US-05 / R3.10）。
 *
 * **语气约束（PRD §7）**：绝不使用红色警示语义。
 * 超出 100% 时使用柔和的暖色（`coral`）渐进提示，环外文案保持中性。
 */

export interface ProgressRingProps {
  /** 进度比（0 ~ 1+，可超过 1） */
  value: number;
  /** 直径（px） */
  size?: number;
  /** 环宽（px） */
  strokeWidth?: number;
  /** 环内主文案（如百分比或剩余热量） */
  centerValue?: string;
  /** 环内副文案 */
  centerLabel?: string;
  /** 屏幕阅读器朗读文本；缺省由 `centerValue`/`centerLabel` 拼装 */
  ariaLabel?: string;
  /** 深色模式（决定渐变） */
  dark?: boolean;
}

/** 把任意数值限制到 [min, max]。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default function ProgressRing({
  value,
  size = 176,
  strokeWidth = 14,
  centerValue,
  centerLabel,
  ariaLabel,
  dark = false,
}: ProgressRingProps): ReactElement {
  const safeValue = Number.isFinite(value) ? value : 0;
  const ratio = clamp(safeValue, 0, 1);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const overBudget = safeValue > 1;

  const gradientStops = dark ? TOKENS.progressGradientDark : TOKENS.progressGradient;
  const strokeColor = overBudget ? TOKENS.coral[300] : `url(#qshProgressGradient)`;
  const label = ariaLabel ?? `${centerLabel ?? '进度'} ${Math.round(safeValue * 100)}%`;

  return (
    <div className="inline-flex items-center justify-center" role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id="qshProgressGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={gradientStops[0]} />
            <stop offset="50%" stopColor={gradientStops[1]} />
            <stop offset="100%" stopColor={gradientStops[2]} />
          </linearGradient>
        </defs>
        {/* 底环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={dark ? '#24443a' : '#d9ede4'}
          strokeWidth={strokeWidth}
        />
        {/* 进度环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {(centerValue !== undefined || centerLabel !== undefined) && (
        <div className="pointer-events-none absolute flex flex-col items-center" aria-hidden="true">
          {centerValue !== undefined && (
            <span className="qsh-tnum text-3xl font-semibold text-slate-800 dark:text-slate-100">
              {centerValue}
            </span>
          )}
          {centerLabel !== undefined && (
            <span className="mt-1 text-xs text-slate-600 dark:text-slate-400">{centerLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
