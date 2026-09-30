/**
 * 导航可达性（全站入口）测试 —— 钉死「已实现的路由都有应用内入口」。
 *
 * ## 背景（本轮修复的四条零入口路由）
 *
 * `/habits`、`/report`、`/fasting`、`/ai` 四条路由此前**已完整实现**，但全站没有
 * 任何导航入口，用户只能手输 URL。其中 `/fasting` 更是全站唯一能开关断食功能的
 * 地方（`FastingPage` 的「关闭断食功能」按钮），却不可达；`SettingsDataPage` 还向
 * 用户承诺「JSON 可完整恢复……设置（单位、深色、断食开关）」，承诺了却找不到入口。
 *
 * ## 本文件钉死的行为
 *
 * ① ★ 从 `/dashboard` 能到达 `/habits` 与 `/report`（链接存在且 `href` 正确）；
 * ② ★ 从 `/profile` 能到达 `/fasting`、`/ai`、`/tools`、`/why-numbers`；
 * ③ ★ **穷举校验**：遍历 `router/routes.tsx` 的路由表，断言除 `/`、`/onboarding`、`*`
 *    与 `BottomNav` 的 4 项外，**每一条路由都能在 Dashboard / Profile 渲染出的
 *    链接里找到** —— 这条能拦住「加了页面没加入口」这类回归（本轮缺陷的根因）。
 * ④ 底部导航刻意保持 4 项（不新增第 5 项）——用断言把这条决定钉住；
 * ⑤ 新入口文案不含禁用词 / 施压词，且不引入红色恐吓类名。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { DashboardResponse } from '@qsh/shared-types';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import ProfilePage from '@/pages/profile/ProfilePage';
import { routes } from '@/router/routes';
import { NAV_ITEMS } from '@/components/layout/BottomNav';
import { COPY } from '@/lib/copy';
import { cacheClearAll } from '@/lib/local-cache';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 看板接口的桩数据（含 miniTrend，让「这周的小变化」卡也渲染出 /weight 入口）。 */
const DASHBOARD_PAYLOAD: DashboardResponse = {
  date: '2026-09-12',
  goal: null,
  budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
  intakeKcal: 300,
  burnedKcal: 0,
  remainingKcal: 1200,
  progressRatio: 0.2,
  waterMl: 500,
  waterGoalMl: 1500,
  miniTrend: [
    { date: '2026-09-10', weightKg: 60.2 },
    { date: '2026-09-11', weightKg: 60 },
    { date: '2026-09-12', weightKg: 59.8 },
  ],
  encouragement: '今天也照顾好自己',
  warnings: [],
};

/** 统一的 `{ data, error: null }` 包装（与全仓测试一致）。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 桩 fetch：`/dashboard` 返回看板数据，`/profile` 返回空画像（页面不崩即可）。 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/dashboard')) {
        return ok(DASHBOARD_PAYLOAD);
      }
      if (url.includes('/profile')) {
        return ok({ profile: null, goal: null, budget: null, warnings: [] });
      }
      return ok(null);
    }),
  );
}

function renderAt(ui: ReactElement): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 取出某个渲染子树里所有 `a[href]` 的 href 集合。 */
function hrefsOf(container: HTMLElement): Set<string> {
  return new Set(
    Array.from(container.querySelectorAll('a[href]')).map(
      (anchor) => anchor.getAttribute('href') ?? '',
    ),
  );
}

/**
 * 等待 Dashboard 渲染完成。
 *
 * 锚点刻意用**不受缺陷注入影响的既有入口**（「记一餐」），而不是本轮新增的
 * 「习惯打卡」——否则一旦把那一条入口删掉，这里会因为等待超时而**假失败**，
 * 掩盖真正该红的断言（测试工装自身的耦合）。
 */
async function waitDashboard(container: HTMLElement): Promise<void> {
  await within(container).findByRole('link', { name: /记一餐/ });
}

/** 等待 Profile 渲染完成。锚点用「更多功能」标题（与具体条目解耦，同上）。 */
async function waitProfile(container: HTMLElement): Promise<void> {
  await within(container).findByRole('heading', { name: COPY.profileMoreTitle });
}

beforeEach(() => {
  cacheClearAll();
  localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// ① / ② 核心：四条修复路由从对应页面可达
// ---------------------------------------------------------------------------

describe('导航可达性 · /dashboard 的高频入口', () => {
  it('★ /dashboard 能到达 /habits（链接存在且 href 正确）', async () => {
    const { container } = renderAt(<DashboardPage />);

    const link = await within(container).findByRole('link', { name: /习惯打卡/ });
    expect(link).toHaveAttribute('href', '/habits');
  });

  it('★ /dashboard 能到达 /report（链接存在且 href 正确）', async () => {
    const { container } = renderAt(<DashboardPage />);

    const link = await within(container).findByRole('link', { name: /周报/ });
    expect(link).toHaveAttribute('href', '/report');
  });

  it('原有入口未受影响（记一餐 / 动一动 / 数字是怎么来的）', async () => {
    const { container } = renderAt(<DashboardPage />);
    const scoped = within(container);

    expect(await scoped.findByRole('link', { name: /记一餐/ })).toHaveAttribute(
      'href',
      '/diary',
    );
    expect(scoped.getByRole('link', { name: /动一动/ })).toHaveAttribute('href', '/exercise');
    expect(scoped.getByRole('link', { name: /这些数字是怎么来的/ })).toHaveAttribute(
      'href',
      '/why-numbers',
    );
  });
});

describe('导航可达性 · /profile 的「更多功能」兜底区', () => {
  it('★ /profile 能到达 /fasting（断食开关的唯一入口）', async () => {
    const { container } = renderAt(<ProfilePage />);

    const link = await within(container).findByRole('link', { name: /断食计时/ });
    expect(link).toHaveAttribute('href', '/fasting');
  });

  it('★ /profile 能到达 /ai', async () => {
    const { container } = renderAt(<ProfilePage />);

    const link = await within(container).findByRole('link', { name: /AI 助手/ });
    expect(link).toHaveAttribute('href', '/ai');
  });

  it('★ /profile 能到达 /tools', async () => {
    const { container } = renderAt(<ProfilePage />);

    const link = await within(container).findByRole('link', { name: /生活化工具/ });
    expect(link).toHaveAttribute('href', '/tools');
  });

  it('★ /profile 能到达 /why-numbers', async () => {
    const { container } = renderAt(<ProfilePage />);

    const link = await within(container).findByRole('link', {
      name: new RegExp(COPY.profileMoreWhyNumbers),
    });
    expect(link).toHaveAttribute('href', '/why-numbers');
  });

  it('原有设置类入口未受影响（数据管理 / 我的食物库）', async () => {
    const { container } = renderAt(<ProfilePage />);
    const scoped = within(container);

    expect(await scoped.findByRole('link', { name: /数据导出/ })).toHaveAttribute(
      'href',
      '/settings/data',
    );
    expect(scoped.getByRole('link', { name: /我的食物库/ })).toHaveAttribute(
      'href',
      '/settings/foods',
    );
  });
});

// ---------------------------------------------------------------------------
// ③ 穷举校验：路由表里每条路由都有入口（拦住「加了页面没加入口」的回归）
// ---------------------------------------------------------------------------

/** 无需应用内入口的路由：落地页 / 引导页是入口本身；`*` 是兜底重定向。 */
const NO_ENTRY_NEEDED = new Set(['/', '/onboarding', '*']);

describe('导航可达性 · 穷举校验（每条路由都有入口）', () => {
  it('★ 除 /、/onboarding、* 与 BottomNav 4 项外，每条路由都能在 Dashboard/Profile 里找到入口', async () => {
    // 1) 从**路由表本身**取路径清单（不是手抄一份，改路由表即被覆盖）
    const routePaths = routes.map((route) => route.path);

    // 2) BottomNav 的路径由组件导出，动态取（BottomNav 变了这里跟着变）
    const navPaths = new Set(NAV_ITEMS.map((item) => item.to));

    // 3) 需要「在 Dashboard / Profile 里找到入口」的路由
    const mustHaveEntry = routePaths.filter(
      (path) => !NO_ENTRY_NEEDED.has(path) && !navPaths.has(path),
    );
    // 至少有这几条（若过滤逻辑写错导致清单为空，这条会先失败）
    expect(mustHaveEntry).toContain('/habits');
    expect(mustHaveEntry).toContain('/report');
    expect(mustHaveEntry).toContain('/fasting');
    expect(mustHaveEntry).toContain('/ai');

    // 4) 渲染 Dashboard 与 Profile，收集全部入口链接
    const dashboard = renderAt(<DashboardPage />);
    await waitDashboard(dashboard.container);
    const profile = renderAt(<ProfilePage />);
    await waitProfile(profile.container);

    const reachable = new Set<string>([
      ...hrefsOf(dashboard.container),
      ...hrefsOf(profile.container),
    ]);

    // 5) 求差：应当没有遗漏
    const missing = mustHaveEntry.filter((path) => !reachable.has(path));
    expect(missing, `这些路由没有任何应用内入口：${missing.join(', ')}`).toEqual([]);
  });

  it('本轮修复的四条零入口路由，逐条确认可达', async () => {
    const dashboard = renderAt(<DashboardPage />);
    await waitDashboard(dashboard.container);
    const profile = renderAt(<ProfilePage />);
    await waitProfile(profile.container);

    const reachable = new Set<string>([
      ...hrefsOf(dashboard.container),
      ...hrefsOf(profile.container),
    ]);

    for (const path of ['/habits', '/report', '/fasting', '/ai']) {
      expect(reachable.has(path), `${path} 仍不可达`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 底部导航：刻意保持 4 项（不新增第 5 项）
// ---------------------------------------------------------------------------

describe('底部导航（BottomNav）', () => {
  it('刻意保持 4 项：今天 / 记录 / 变化 / 我的', () => {
    const paths = NAV_ITEMS.map((item) => item.to);
    expect(paths).toHaveLength(4);
    expect(paths).toEqual(['/dashboard', '/diary', '/weight', '/profile']);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 文案红线（PRD §7 无负罪感）+ 无红色恐吓
// ---------------------------------------------------------------------------

describe('导航入口 · 文案红线与视觉', () => {
  const BANNED = ['失败', '错误', '崩溃', '出错', '别忘了', '必须', '坚持', '达成', '达标'];

  it('新增入口文案不含禁用词 / 施压词', () => {
    const newCopy = [
      COPY.dashboardHabitsEntry,
      COPY.dashboardHabitsEntryHint,
      COPY.dashboardReportEntry,
      COPY.dashboardReportEntryHint,
      COPY.profileMoreTitle,
      COPY.profileMoreDesc,
      COPY.profileMoreFasting,
      COPY.profileMoreFastingHint,
      COPY.profileMoreAi,
      COPY.profileMoreExercise,
      COPY.profileMoreHabits,
      COPY.profileMoreTools,
      COPY.profileMoreReport,
      COPY.profileMoreWhyNumbers,
    ];
    for (const text of newCopy) {
      for (const banned of BANNED) {
        expect(text).not.toContain(banned);
      }
    }
  });

  it('入口不引入红色恐吓类名', async () => {
    const dashboard = renderAt(<DashboardPage />);
    await waitDashboard(dashboard.container);
    expect(dashboard.container.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);

    const profile = renderAt(<ProfilePage />);
    await waitProfile(profile.container);
    expect(profile.container.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });
});
