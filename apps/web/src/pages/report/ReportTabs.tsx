import type { ReactElement } from 'react';
import SegmentedControl from '@/components/common/SegmentedControl';
import type { SegmentedItem } from '@/components/common/SegmentedControl';
import { COPY } from '@/lib/copy';

/** `/report` 的标签页键（**足迹**为 C-1 新增的第三个 tab）。 */
export type ReportTabKey = 'weekly' | 'period' | 'footprint';

interface ReportTabsProps {
  value: ReportTabKey;
  onChange: (tab: ReportTabKey) => void;
}

/**
 * `/report` 标签页外壳（pages/report/ReportTabs.tsx，R11.3 / AC-11.3.1 / **C-1**）。
 *
 * ⚠️ **默认选中「本周」（K27）**：`ReportPage` 的初始 state 就是 `'weekly'`，
 * 周报查询在挂载时无条件发出 —— `report-trends.test.tsx`（回归基线）依赖这一点，不许改。
 * 顺序固定为「本周 | 这段时间 | 足迹」，`足迹` 在最后（回顾 → 落点，由聚合到逐日）。
 *
 * 2026-10-12（UI 评审 P1）：按钮皮肤收敛到通用 `SegmentedControl`（本处即该组件的
 * 视觉基准：pill 实心 brand-600 选中态 + 白底细环未选态）。改动**逐像素不变**——
 * 旧实现的类名原样搬进了组件，切过来的唯一目的是让 `/ai` `/diary` 有唯一真源可抄。
 */
export default function ReportTabs({ value, onChange }: ReportTabsProps): ReactElement {
  const tabs: ReadonlyArray<SegmentedItem<ReportTabKey>> = [
    { key: 'weekly', label: COPY.reportTabWeekly },
    { key: 'period', label: COPY.reportTabPeriod },
    { key: 'footprint', label: COPY.reportTabFootprint },
  ];

  return <SegmentedControl items={tabs} value={value} onChange={onChange} ariaLabel="回顾范围" />;
}
