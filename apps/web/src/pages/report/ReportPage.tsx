import { useState } from 'react';
import type { ReactElement } from 'react';

import ReportTabs from './ReportTabs';
import type { ReportTabKey } from './ReportTabs';
import WeeklyReportView from './WeeklyReportView';
import PeriodReportView from './PeriodReportView';

/**
 * 回顾页外壳（`/report`，R4.1 / R4.2 / R11.1 / **R11.3 / R11.7**）。
 *
 * 结构（架构文档 §8.1）：
 * ```
 * ReportPage.tsx（外壳）
 * ├─ ReportTabs.tsx          role="tablist"：本周 | 这段时间
 * ├─ WeeklyReportView.tsx    现有周报 JSX 原样迁入（D-8）+ 多样性行（R11.7）
 * └─ PeriodReportView.tsx    阶段回顾（R11.3，白名单 6 类指标）
 * ```
 *
 * ⚠️ **默认选中「本周」（K27 / AC-11.3.1）**：`WeeklyReportView` 挂载即发出
 * `/report/weekly` 查询 —— `report-trends.test.tsx`（回归基线）依赖这一点。
 * 原周报 JSX 已原样迁入 `WeeklyReportView.tsx`（一行逻辑不改，Q-7）。
 */
export default function ReportPage(): ReactElement {
  const [tab, setTab] = useState<ReportTabKey>('weekly');

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4">
      <ReportTabs value={tab} onChange={setTab} />
      {tab === 'weekly' ? <WeeklyReportView /> : <PeriodReportView />}
    </div>
  );
}
