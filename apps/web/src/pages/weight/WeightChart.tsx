import { useMemo } from 'react';
import type { ReactElement } from 'react';
import ReactECharts from 'echarts-for-react';

/**
 * 体重趋势图（pages/weight/WeightChart.tsx）。
 *
 * 单独成模块并由 `WeightPage` **动态导入**（`React.lazy`）：
 * ECharts 体积较大，按需加载可显著减小首屏主包（NFR-3：首屏可交互 < 2s）。
 *
 * 两个系列：
 * - 「体重」：原始记录点（浅色）
 * - 「7 日均线」：移动平均（深色、更粗），弱化单日波动（TC-34）
 */

export interface WeightChartProps {
  /** 日期轴（`YYYY-MM-DD`） */
  dates: readonly string[];
  /** 原始体重序列 */
  weights: readonly number[];
  /** 7 日移动平均序列（与 `dates` 对齐，`null` 为断点） */
  movingAverage: ReadonlyArray<number | null>;
}

export default function WeightChart({
  dates,
  weights,
  movingAverage,
}: WeightChartProps): ReactElement {
  const option = useMemo(() => {
    // 单数据点时 `scale: true` 会回落到底层默认区间（如 40–160），点被压在中间；
    // 手动把 y 轴收紧到 [数值-3, 数值+3]，并保证不出现负体重。
    const singleValue = weights.length === 1 ? weights[0] : undefined;
    const yAxisRange =
      typeof singleValue === 'number'
        ? { min: Math.max(0, singleValue - 3), max: singleValue + 3 }
        : { scale: true };

    return {
      // bottom 留出图例区，避免图例与横轴日期文字重叠压字
      grid: { left: 40, right: 16, top: 24, bottom: 56 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { fontSize: 10, color: '#7d9489' },
      },
      yAxis: {
        type: 'value',
        ...yAxisRange,
        axisLabel: { fontSize: 10, color: '#7d9489' },
        splitLine: { lineStyle: { color: 'rgba(125,148,137,0.18)' } },
      },
      legend: { data: ['体重', '7 日均线'], bottom: 0, textStyle: { fontSize: 11 } },
      series: [
        {
          name: '体重',
          type: 'line',
          smooth: true,
          symbolSize: 5,
          data: weights,
          lineStyle: { color: '#8cc9ab', width: 2 },
          itemStyle: { color: '#8cc9ab' },
        },
        {
          name: '7 日均线',
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: movingAverage,
          lineStyle: { color: '#248263', width: 3 },
          itemStyle: { color: '#248263' },
        },
      ],
    };
  }, [dates, weights, movingAverage]);

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge lazyUpdate />;
}
