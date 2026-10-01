import type { ReactElement } from 'react';
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
 */
export default function ReportTabs({ value, onChange }: ReportTabsProps): ReactElement {
  const tabs: ReadonlyArray<{ key: ReportTabKey; label: string }> = [
    { key: 'weekly', label: COPY.reportTabWeekly },
    { key: 'period', label: COPY.reportTabPeriod },
    { key: 'footprint', label: COPY.reportTabFootprint },
  ];

  return (
    <div role="tablist" aria-label="回顾范围" className="flex gap-1.5">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          type="button"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={[
            'qsh-touch-target shrink-0 rounded-pill px-4 text-sm transition',
            value === tab.key
              ? 'bg-brand-600 text-white'
              : 'bg-brand-50 text-slate-600 dark:bg-slate-900 dark:text-slate-300',
          ].join(' ')}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
