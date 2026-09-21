import { Suspense, lazy } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import RouteLoading from '@/components/common/RouteLoading';
import LandingPage from '@/pages/landing/LandingPage';

/**
 * 路由级代码分割。
 *
 * `LandingPage` **刻意保持同步引入**：它是匿名访客的第一屏（免注册计算器 + 隐私承诺），
 * 拆成独立 chunk 只会给这一屏多加一次往返 —— 而它恰恰是最需要立刻出现的一屏。
 * 其余页面全部按需加载：既缩小首屏主包，也让重依赖（如 `WeightPage` 动态引入的 ECharts，
 * 约 1 MB）只在真正访问该页时才请求。加新页面时记得同步 `lazy()` 与下面的路由表。
 */
const OnboardingPage = lazy(() => import('@/pages/onboarding/OnboardingPage'));
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'));
const DiaryPage = lazy(() => import('@/pages/diary/DiaryPage'));
const WeightPage = lazy(() => import('@/pages/weight/WeightPage'));
const ProfilePage = lazy(() => import('@/pages/profile/ProfilePage'));
const SettingsDataPage = lazy(() => import('@/pages/settings-data/SettingsDataPage'));
const ExercisePage = lazy(() => import('@/pages/exercise/ExercisePage'));
const HabitsPage = lazy(() => import('@/pages/habits/HabitsPage'));
const ToolsPage = lazy(() => import('@/pages/tools/ToolsPage'));
const FastingPage = lazy(() => import('@/pages/fasting/FastingPage'));
const ReportPage = lazy(() => import('@/pages/report/ReportPage'));
const AiPage = lazy(() => import('@/pages/ai/AiPage'));
const WhyNumbersPage = lazy(() => import('@/pages/why-numbers/WhyNumbersPage'));

/** 单条路由定义。 */
export interface AppRoute {
  /** 路由路径 */
  path: string;
  /** 路由元素 */
  element: ReactElement;
}

/**
 * 用应用外壳包裹页面（带顶部栏与底部导航）。
 *
 * `Suspense` 放在 `AppShell` **内部**：页面 chunk 到达前只让内容区显示兜底，
 * 顶栏与底部导航保持可见 —— 否则每次切换路由整页都会闪一下外壳。
 */
function withShell(page: ReactNode, title?: string): ReactElement {
  return (
    <AppShell {...(title === undefined ? {} : { title })}>
      <Suspense fallback={<RouteLoading />}>{page}</Suspense>
    </AppShell>
  );
}

/** 无外壳页面的 `Suspense` 包装（`/onboarding` 为全屏引导，不套 AppShell）。 */
function bare(page: ReactNode): ReactElement {
  return <Suspense fallback={<RouteLoading />}>{page}</Suspense>;
}

/**
 * 12 组路由（PRD §6）—— 全部可导航。
 *
 * 一期实现：`/`、`/onboarding`、`/dashboard`、`/diary`、`/weight`、`/profile`、`/settings/data`；
 * 二期实现：`/exercise`、`/habits`、`/tools`、`/fasting`、`/report`；三期 `/ai` 以**分期占位**存在，
 * 文案友好并标注「二期/三期即将到来」（不使用生硬字眼）。
 */
export const routes: AppRoute[] = [
  // 1. 落地页（免注册计算器 + 隐私承诺 + 免责声明）—— 同步引入，见文件顶部说明
  { path: '/', element: <LandingPage /> },

  // 2. 首次引导（免责声明确认 → 问卷 → 结果）
  { path: '/onboarding', element: bare(<OnboardingPage />) },

  // 3. 今天（生活流首页）——顶栏用品牌字标，页面 h1 才是「今天」，避免重复
  { path: '/dashboard', element: withShell(<DashboardPage />, '轻生活') },

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

  // 可解释性页：把「数字是怎么来的」做成 App 内可查（透明度 / 可溯源）
  { path: '/why-numbers', element: withShell(<WhyNumbersPage />, '数字是怎么来的') },

  // 兜底：未知路径回到落地页
  { path: '*', element: <Navigate to="/" replace /> },
];
