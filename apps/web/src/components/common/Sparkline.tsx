import type { ReactElement } from 'react';
import { formatWeight } from '@/lib/format';

/**
 * 迷你趋势图（components/common/Sparkline.tsx）。
 *
 * 纯 SVG 实现（不依赖图表库），用于看板最近 7 天体重迷你趋势；
 * `null` 视为断点（该日无记录），不连线、不补零（诚实呈现，避免误导）。
 */

export interface SparklineProps {
  /** 数据点（按时间升序；`null` 表示当日无记录） */
  data: ReadonlyArray<{ date: string; weightKg: number | null }>;
  /** 宽度（px） */
  width?: number;
  /** 高度（px） */
  height?: number;
  /** 无障碍标签 */
  ariaLabel?: string;
}

export default function Sparkline({
  data,
  width = 260,
  height = 72,
  ariaLabel = '最近体重趋势',
}: SparklineProps): ReactElement {
  const numeric = data.filter(
    (point): point is { date: string; weightKg: number } => point.weightKg !== null,
  );

  if (numeric.length < 2) {
    return (
      <div
        className="flex h-[72px] items-center justify-center rounded-xl bg-brand-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
        style={{ width: '100%' }}
      >
        记录几笔体重后，这里会出现趋势
      </div>
    );
  }

  const weights = numeric.map((point) => point.weightKg);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const span = max - min === 0 ? 1 : max - min;
  const padding = 8;
  const stepX = (width - padding * 2) / Math.max(data.length - 1, 1);

  // 以「原始索引」定位 x，保证时间轴连续（缺失日留空）
  const coordinates = new Map<string, { x: number; y: number }>();
  data.forEach((point, index) => {
    if (point.weightKg === null) {
      return;
    }
    const x = padding + index * stepX;
    const y =
      height - padding - ((point.weightKg - min) / span) * (height - padding * 2);
    coordinates.set(point.date, { x, y });
  });

  const path = numeric
    .map((point, index) => {
      const coordinate = coordinates.get(point.date);
      if (coordinate === undefined) {
        return '';
      }
      return `${index === 0 ? 'M' : 'L'} ${coordinate.x.toFixed(1)} ${coordinate.y.toFixed(1)}`;
    })
    .join(' ');

  const latest = numeric[numeric.length - 1];

  return (
    <figure className="w-full">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${ariaLabel}，最新 ${latest === undefined ? '—' : formatWeight(latest.weightKg)} 公斤`}
      >
        <path d={path} fill="none" stroke="#2f9e78" strokeWidth={2.5} strokeLinecap="round" />
        {numeric.map((point) => {
          const coordinate = coordinates.get(point.date);
          if (coordinate === undefined) {
            return null;
          }
          return (
            <circle
              key={point.date}
              cx={coordinate.x}
              cy={coordinate.y}
              r={2.8}
              fill="#248263"
            />
          );
        })}
      </svg>
      <figcaption className="sr-only">
        最近 {data.length} 天体重趋势，共 {numeric.length} 笔记录
      </figcaption>
    </figure>
  );
}
