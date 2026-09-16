import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import PhasePlaceholder from '@/components/common/PhasePlaceholder';
import LandingPage from '@/pages/landing/LandingPage';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import DiaryPage from '@/pages/diary/DiaryPage';
import WeightPage from '@/pages/weight/WeightPage';
import ProfilePage from '@/pages/profile/ProfilePage';
import SettingsDataPage from '@/pages/settings-data/SettingsDataPage';
import ExercisePage from '@/pages/exercise/ExercisePage';
import HabitsPage from '@/pages/habits/HabitsPage';
import ToolsPage from '@/pages/tools/ToolsPage';
import FastingPage from '@/pages/fasting/FastingPage';
import ReportPage from '@/pages/report/ReportPage';
import AiPage from '@/pages/ai/AiPage';

/** 单条路由定义。 */
export interface AppRoute {
  /** 路由路径 */
  path: string;
  /** 路由元素 */
  element: ReactElement;
}

/** 用应用外壳包裹页面（带顶部栏与底部导航）。 */
function withShell(page: ReactNode, title?: string): ReactElement {
  return <AppShell {...(title === undefined ? {} : { title })}>{page}</AppShell>;
}

/**
 * 12 组路由（PRD §6）—— 全部可导航。
 *
 * 一期实现：`/`、`/onboarding`、`/dashboard`、`/diary`、`/weight`、`/profile`、`/settings/data`；
 * 二期实现：`/exercise`、`/habits`、`/tools`、`/fasting`、`/report`；三期 `/ai` 以**分期占位**存在，
 * 文案友好并标注「二期/三期即将到来」（不使用生硬字眼）。
 */
export const routes: AppRoute[] = [
  // 1. 落地页（免注册计算器 + 隐私承诺 + 免责声明）
  { path: '/', element: <LandingPage /> },

  // 2. 首次引导（免责声明确认 → 问卷 → 结果）
  { path: '/onboarding', element: <OnboardingPage /> },

  // 3. 今天（生活流首页）
  { path: '/dashboard', element: withShell(<DashboardPage />, '今天') },

  // 4. 饮食记录（≤3 次点击记一餐）
  { path: '/diary', element: withShell(<DiaryPage />, '记录') },

  // 5. 体重变化（7 日移动平均）
  { path: '/weight', element: withShell(<WeightPage />, '变化') },

  // 6. 我的（基础数据修改 + 参考来源）
  { path: '/profile', element: withShell(<ProfilePage />, '我的') },

  // 7. 数据管理（导出 / 导入 / 删除）
  { path: '/settings/data', element: withShell(<SettingsDataPage />, '数据管理') },

  // 8~13. 分期占位（文案友好，不出现「未实现」字眼）
  { path: '/exercise', element: withShell(<ExercisePage />, '运动与饮水') },
  { path: '/habits', element: withShell(<HabitsPage />, '习惯打卡') },
  { path: '/tools', element: withShell(<ToolsPage />, '生活化工具') },
  { path: '/fasting', element: withShell(<FastingPage />, '断食计时') },
  { path: '/report', element: withShell(<ReportPage />, '周报') },
  // 三期（T05 三期）：AI 助手（每日总结 / 今日方案 / 自由提问 + 食物识别）
  { path: '/ai', element: withShell(<AiPage />, 'AI 助手') },

  // 兜底：未知路径回到落地页
  { path: '*', element: <Navigate to="/" replace /> },
];
