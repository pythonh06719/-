import { useState } from 'react';
import type { ReactElement } from 'react';

import ReportTabs from './ReportTabs';
import type { ReportTabKey } from './ReportTabs';
import WeeklyReportView from './WeeklyReportView';
import PeriodReportView from './PeriodReportView';
import FootprintView from './FootprintView';

/**
 * 回顾页外壳（`/report`，R4.1 / R4.2 / R11.1 / **R11.3 / R11.7** / **C-1**）。
 *
 * 结构（架构文档 §8.1）：
 * ```
 * ReportPage.tsx（外壳）
 * ├─ ReportTabs.tsx          role="tablist"：本周 | 这段时间 | 足迹
 * ├─ WeeklyReportView.tsx    现有周报 JSX 原样迁入（D-8）+ 多样性行（R11.7）
 * ├─ PeriodReportView.tsx    阶段回顾（R11.3，白名单 6 类指标）
 * └─ FootprintView.tsx       记录足迹日历（C-1，当月月历 + 深浅）
 * ```
 *
 * ⚠️ **默认选中「本周」（K27 / AC-11.3.1）**：`WeeklyReportView` 挂载即发出
 * `/report/weekly` 查询 —— `report-trends.test.tsx`（回归基线）依赖这一点。
 * 原周报 JSX 已原样迁入 `WeeklyReportView.tsx`（一行逻辑不改，Q-7）。
 * ⚠️ 三个 tab **互斥渲染**：只有当前 tab 的组件挂载（切走的组件会 unmount），
 * 因此切到「足迹」后不再有周报 / 阶段回顾的请求，反之亦然。
 */
export default function ReportPage(): ReactElement {
  const [tab, setTab] = useState<ReportTabKey>('weekly');

  return (
    // C-6 宽屏（≥1024px）：回顾页本身已是「周报 / 阶段回顾 / 足迹」的多栏载体，
    // 容器在 `lg` 放宽到 `max-w-5xl`（移动端仍 `max-w-xl`，一行不变）；各 tab 视图
    // 各自负责内部两栏栅格（见 WeeklyReportView / PeriodReportView）。
    // `lg:pb-8`：桌面端底部导航转为页内常驻（非固定浮层），无需再留 `pb-24` 的避让空间。
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4 lg:max-w-5xl lg:pb-8">
      <ReportTabs value={tab} onChange={setTab} />
      {tab === 'weekly' ? <WeeklyReportView /> : tab === 'period' ? <PeriodReportView /> : <FootprintView />}
    </div>
  );
}
