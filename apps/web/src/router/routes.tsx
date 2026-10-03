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
 * 其余页面全部按需加载：既缩小首屏主包，也让各页面的重依赖只在真正访问该页时才请求
 * （体重页曾动态引入 `ECharts`，约 1 MB；现已改为**手写 SVG、零图表库依赖**，见
 * `WeightChart.tsx`）。加新页面时记得同步 `lazy()` 与下面的路由表。
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
const MyFoodsPage = lazy(() => import('@/pages/foods/MyFoodsPage'));

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
 * `Suspense`放在 `AppShell` **内部**：页面 chunk 到达前只让内容区显示兜底，
 * 顶栏与底部导航保持可见 —— 否则每次切换路由整页都会闪一下外壳。
 *
 * ## `title`：顶栏一律用品牌字标，**不再逐页传页面名**
 *
 * 顶栏是**全局导航语境**（用户在 App 里，知道自己在哪）—— 它的职责是说「这是轻生活」，
 * 外加右侧的单位/主题开关；**页面在讲什么**由页内 h1 承担。
 *
 * 此前有 5 个路由往顶栏传了与页内标题**逐字相同**的名字，于是同屏出现两行一模一样的大字
 * （顶栏一行 + 页内 h1 一行），白白吃掉一屏首屏高度，也让「每页都有一个开始」的层级失效：
 *
 * | 路由 | 顶栏（已删） | 页内 h1（保留） |
 * |---|---|---|
 * | `/profile` | 我的 | 我的 |
 * | `/settings/data` | 数据管理 | 数据管理 |
 * | `/settings/foods` | 我的食物库 | 我的食物库（`COPY.myFoodsTitle`） |
 * | `/fasting` | 断食计时 | 断食计时 |
 * | `/why-numbers` | 数字是怎么来的 | 数字是怎么来的 |
 *
 * 全部改为不传 `title` → `AppShell` 落回默认值「轻生活」，与 `/dashboard` 一致
 * （顶栏「轻生活」+ 页内 h1「今天」）。**h1 一个都没动**。
 *
 * ⚠️ 保留顶栏页面名的只有一类：**顶栏名与 h1 不是同一句话**的页面 —— 它们不构成重复，
 * 且顶栏此时确实在提供定位信息。逐个核对过（截图证据见交付报告）：
 * `/diary`（记录 / 饮食记录）、`/weight`（变化 / 体重趋势）、
 * `/exercise`（运动与饮水 / 动一动）、`/habits`（习惯打卡 / h1 为 `qsh-sr-only` 不可见）、
 * `/report`·`/tools`·`/ai`（页面内无 h1，顶栏名是唯一标题，删了会失去定位）。
 *
 * `wide`（C-6）：≥1024px 放宽内容列宽，供多栏布局。**只给信息密度最高的 3 个页面开启**
 * （今天 / 变化 / 周报）；其余单栏页面在桌面维持 `max-w-3xl` 的舒适阅读宽度。
 */
function withShell(page: ReactNode, title?: string, wide = false): ReactElement {
  return (
    <AppShell {...(title === undefined ? {} : { title })} wide={wide}>
      <Suspense fallback={<RouteLoading />}>{page}</Suspense>
    </AppShell>
  );
}

/** 无外壳页面的 `Suspense` 包装（`/onboarding` 为全屏引导，不套 AppShell）。 */
function bare(page: ReactNode): ReactElement {
  return <Suspense fallback={<RouteLoading />}>{page}</Suspense>;
}

/**
 * 路由表（PRD §6）—— 每条路由都在应用内有可达入口。
 *
 * ⚠️ 本注释曾写「12 组路由……全部可导航」，但与实现不符：`/habits`、`/report`、
 * `/fasting`、`/ai` 四条路由**全站没有任何入口**，只能手输 URL（`/fasting` 甚至
 * 是全站唯一能开关断食功能的地方）。已补齐入口，下面按「入口分布」如实描述。
 *
 * 入口分布（每条路由都能从应用内某个页面到达）：
 * - 底部导航 `BottomNav`（刻意只有 4 项）：`/dashboard`、`/diary`、`/weight`、`/profile`；
 * - 「今天」页 `/dashboard` 的行动卡：`/diary`、`/exercise`、`/habits`、`/report`、
 *   `/why-numbers`、`/weight`，以及空态时的 `/onboarding`；
 * - 「我的」页 `/profile` 的设置类落点：`/settings/data`、`/settings/foods`，
 *   加「更多功能」区兜底列出不在底部导航里的页面：`/fasting`、`/ai`、`/exercise`、
 *   `/habits`、`/tools`、`/report`、`/why-numbers`；
 * - 落地页 `/` 与引导页 `/onboarding`：`/dashboard`、`/onboarding`、`/tools`。
 *
 * ⚠️ **新增页面时必须同时补一个应用内入口**，否则用户只能手输 URL —— 否则会踩
 * 本轮修复的同一个坑。「所有路由都有入口」由 `test/nav-reachability.test.tsx`
 * 穷举校验守着（遍历本路由表，断言除 `/`、`/onboarding`、`*` 与底部导航 4 项外，
 * 每条路由都能在 Dashboard / Profile 渲染出的链接里找到）。
 *
 * 一期实现：`/`、`/onboarding`、`/dashboard`、`/diary`、`/weight`、`/profile`、`/settings/data`；
 * 二期实现：`/exercise`、`/habits`、`/tools`、`/fasting`、`/report`；三期 `/ai`。
 */
export const routes: AppRoute[] = [
  // 1. 落地页（免注册计算器 + 隐私承诺 + 免责声明）—— 同步引入，见文件顶部说明
  { path: '/', element: <LandingPage /> },

  // 2. 首次引导（免责声明确认 → 问卷 → 结果）
  { path: '/onboarding', element: bare(<OnboardingPage />) },

  // 3. 今天（生活流首页）——顶栏用品牌字标，页面 h1 才是「今天」，避免重复
  //    C-6：wide —— 桌面下摊成三栏（今日动作 / 今天的记录 / 这周的小变化）
  { path: '/dashboard', element: withShell(<DashboardPage />, '轻生活', true) },

  // 4. 饮食记录（≤3 次点击记一餐）——顶栏名「记录」与页内 h1「饮食记录」不是同一句，保留定位
  { path: '/diary', element: withShell(<DiaryPage />, '记录') },

  // 5. 体重变化（7 日移动平均）——顶栏名「变化」与页内 h1「体重趋势」不同，保留
  //    C-6：wide —— 桌面下摊成两栏（记录与曲线 / 数据与回顾）
  { path: '/weight', element: withShell(<WeightPage />, '变化', true) },

  // 6. 我的（基础数据修改 + 参考来源）——顶栏曾传「我的」，与页内 h1 逐字重复，已删
  { path: '/profile', element: withShell(<ProfilePage />) },

  // 7. 数据管理（导出 / 导入 / 删除）——顶栏曾传「数据管理」，与页内 h1 逐字重复，已删
  { path: '/settings/data', element: withShell(<SettingsDataPage />) },

  // 7b. 我的食物库（C-4 第二步）：管理自己存进库的食物（改 / 删）
  //     ——顶栏曾传「我的食物库」，与页内标题逐字重复，已删
  { path: '/settings/foods', element: withShell(<MyFoodsPage />) },

  // 8~13. 生活化 / 追踪 / 回看类页面（均已实装；旧注释「分期占位」已过时 ——
  //        这些是正式路由，且已通过 /profile 的「更多功能」入口在全站可达）
  //  `/exercise`（运动与饮水 / 动一动）、`/habits`（习惯打卡，页内 h1 为 sr-only）、
  //  `/tools`、`/report`、`/ai`：顶栏名与页内标题不重复或页内无 h1，**保留**顶栏名。
  { path: '/exercise', element: withShell(<ExercisePage />, '运动与饮水') },
  { path: '/habits', element: withShell(<HabitsPage />, '习惯打卡') },
  { path: '/tools', element: withShell(<ToolsPage />, '生活化工具') },
  // 断食计时 ——顶栏曾传「断食计时」，与页内 h1 逐字重复，已删
  { path: '/fasting', element: withShell(<FastingPage />) },
  { path: '/report', element: withShell(<ReportPage />, '周报', true) },
  // 三期（T05 三期）：AI 助手（每日总结 / 今日方案 / 自由提问 + 食物识别）
  { path: '/ai', element: withShell(<AiPage />, 'AI 助手') },

  // 可解释性页：把「数字是怎么来的」做成 App 内可查（透明度 / 可溯源）
  // ——顶栏曾传「数字是怎么来的」，与页内 h1 逐字重复，已删（**只改路由表，未动页面文件**）
  { path: '/why-numbers', element: withShell(<WhyNumbersPage />) },

  // 兜底：未知路径回到落地页
  { path: '*', element: <Navigate to="/" replace /> },
];
