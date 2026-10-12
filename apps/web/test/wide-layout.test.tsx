/**
 * C-6「桌面宽屏布局」验证（≥1024px = Tailwind `lg` 断点）。
 *
 * ## 这份测试能证明什么、不能证明什么（重要）
 * jsdom **不做真实布局**：它不会计算 `@media` 媒体查询，也不会排版栅格。
 * 因此本文件**不能**证明「桌面下真的并排成了两栏」。它能可靠证明的是：
 *
 * ① **移动端零回归（结构层）**：`<1024px` 生效的全部类名与改动前**逐字符相同**；
 *    宽屏布局类**一律带 `lg:` 前缀**（只在 `≥1024px` 生效），没有任何「无条件生效的宽屏栅格类」；
 * ② **宽屏布局确实存在**：目标页面的布局容器带有 `lg:grid` / `lg:grid-cols-*`；
 * ③ **DOM 结构有序**：三/两栏包裹块的顺序 == DOM 顺序 == 视觉顺序，关键区块（h2 / aria）仍在
 *    且次序不变；
 * ④ **焦点顺序合理（设计不变量）**：各栏 `lg:col-start-N` 在 DOM 顺序上**单调不减**；
 * ⑤ **移动端间距不变**：包裹块沿用与父级同款的纵向间距类（`space-y-section` /
 *    `space-y-5` / `flex flex-col gap-4`），故移动端卡片间距与原实现一致；
 *    （2026-10-12 语义间距迁移：`space-y-6` → `space-y-section`，同值 1.5rem）
 * ⑥ **无障碍不回退**：关键区域的 `role` / `aria-*` 仍在。
 *
 * 真实视觉（宽屏并排、移动端不变）由独立的浏览器截图核对负责，不在本文件内。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardResponse } from '@qsh/shared-types';
import AppShell from '@/components/layout/AppShell';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import WeightPage from '@/pages/weight/WeightPage';
import ReportPage from '@/pages/report/ReportPage';
import { COPY } from '@/lib/copy';
import { cacheClearAll } from '@/lib/local-cache';

/** AppShell 的 `main` 在改动前的**逐字符**类名（移动端零回归的基线）。 */
const BASELINE_MAIN_CLASS = 'mx-auto max-w-3xl animate-fade-in px-5 py-8';
const BASELINE_HEADER_CLASS = 'mx-auto flex max-w-3xl items-center justify-between px-5 py-3.5';

/**
 * 「只为宽屏准备」的栅格 / 列宽工具类：**一旦出现在布局容器上，必须带 `lg:` 前缀**。
 * 若某处去掉了 `lg:`（无条件生效），就会被下面的断言抓住 —— 这正是缺陷注入反验的靶点。
 */
const WIDE_ONLY_TOKENS = [
  'grid',
  'grid-cols-2',
  'grid-cols-3',
  'grid-flow-row-dense',
  'col-span-2',
  'col-span-3',
  'col-start-1',
  'col-start-2',
  'col-start-3',
  'max-w-5xl',
  'max-w-6xl',
] as const;

function classesOf(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** 断言：该元素上没有任何「无条件生效的宽屏栅格类」，且至少含一个 `lg:` 前缀类。 */
function expectWideClassesAllLgPrefixed(el: Element | null): void {
  const tokens = classesOf(el);
  for (const wide of WIDE_ONLY_TOKENS) {
    expect(tokens, `意外的无条件宽屏类 "${wide}"`).not.toContain(wide);
  }
  expect(tokens.some((t) => t.startsWith('lg:'))).toBe(true);
}

/** 取元素上 `lg:col-start-N` 的 N（无则 null）。 */
function colStartOf(el: Element): number | null {
  const found = classesOf(el).find((t) => /^lg:col-start-\d+$/.test(t));
  return found === undefined ? null : Number(found.replace('lg:col-start-', ''));
}

/** 断言：直系子元素里的 `lg:col-start-N` 单调不减（DOM 顺序 == 视觉列序 == 焦点顺序）。 */
function expectColumnMajorOrder(container: Element): void {
  const sequence = Array.from(container.children)
    .map(colStartOf)
    .filter((n): n is number => n !== null);
  expect(sequence.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < sequence.length; i += 1) {
    expect(sequence[i]!).toBeGreaterThanOrEqual(sequence[i - 1]!);
  }
}

function renderWithShell(page: React.ReactNode, wide: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppShell wide={wide}>{page}</AppShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const DASHBOARD_PAYLOAD: DashboardResponse = {
  date: '2026-09-28',
  goal: null,
  budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
  intakeKcal: 300,
  burnedKcal: 0,
  remainingKcal: 1200,
  progressRatio: 0.2,
  waterMl: 500,
  waterGoalMl: 2000,
  miniTrend: [
    { date: '2026-09-26', weightKg: 60.2 },
    { date: '2026-09-27', weightKg: 60 },
    { date: '2026-09-28', weightKg: 59.8 },
  ],
  encouragement: '今天也照顾好自己',
  warnings: [],
};

/** 周报载荷（含记录 → 走摘要 / 多样性 / 习惯 / 微量营养素四块）。 */
const WEEKLY_PAYLOAD = {
  from: '2026-09-22',
  to: '2026-09-28',
  days: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-09-${String(22 + i).padStart(2, '0')}`,
    intakeKcal: 1200 + i * 50,
    exerciseKcal: 100 + i * 5,
    waterMl: 1500,
    habitsDone: 1,
    habitsTotal: 3,
  })),
  avgIntakeKcal: 1350,
  totalExerciseKcal: 805,
  weightChangeKg: -0.4,
  distinctFoodCount: 3,
  distinctFoods: ['米饭', '鸡蛋', '青菜'],
  distinctFoodsTruncated: false,
  micronutrients: [
    { key: 'fiberG', name: '膳食纤维', unit: 'g', dailyAvg: 18, reference: 25, direction: 'atLeast' },
  ],
  referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
};

function stubFetch(data: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data, error: null }) })),
  );
}

/** 按 URL 派发响应（阶段回顾要 `/report/period` + `/foods/top` 两种数据）。 */
function stubFetchByUrl(pick: (url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: pick(String(input)), error: null }),
    })),
  );
}

/** 阶段回顾载荷（`hasAnyData` 为真 → 渲染指标卡 + 常吃 Top）。 */
const PERIOD_PAYLOAD = {
  days: 30,
  from: '2026-08-30',
  to: '2026-09-28',
  hasAnyData: true,
  loggedDays: 12,
  distinctFoodCount: 8,
  mealEntryCount: 25,
  topHabits: [],
  exercise: { sessions: 4, totalMinutes: 120 },
  winCount: 2,
  weight: null,
};

beforeEach(() => {
  cacheClearAll();
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});

// ---------------------------------------------------------------------------
// ★ 核心：移动端（<1024px）零回归
// ---------------------------------------------------------------------------

describe('★ 核心 · 移动端零回归（<1024px 不变）', () => {
  it('AppShell（默认 / 非 wide）的 main 类名与改动前逐字符相同，且不含任何 lg: 宽屏类', () => {
    const { container } = renderWithShell(<p>内容</p>, false);
    const main = container.querySelector('#main');
    expect(main).not.toBeNull();
    // 逐字符相等：证明窄屏路径上没有任何新增 / 改动
    expect(main?.getAttribute('class')).toBe(BASELINE_MAIN_CLASS);
    // 且没有「宽屏才能用」的类无条件生效
    expect(classesOf(main).some((t) => t.startsWith('lg:'))).toBe(false);
  });

  it('AppShell（wide）相对默认的**唯一**差异是追加了 lg:max-w-6xl（仍保留 max-w-3xl）', () => {
    const { container } = renderWithShell(<p>内容</p>, true);
    const main = container.querySelector('#main');
    const cls = main?.getAttribute('class') ?? '';
    expect(cls).toBe(`${BASELINE_MAIN_CLASS} lg:max-w-6xl`);
    // 移动端仍是原来的窄栏 —— 宽屏是增强不是替代
    expect(classesOf(main)).toContain('max-w-3xl');
    expectWideClassesAllLgPrefixed(main);
  });

  it('顶栏内层容器同样只在 lg 放宽（移动端类名不变）', () => {
    const { container: narrow } = renderWithShell(<p>内容</p>, false);
    expect(narrow.querySelector('header > div')?.getAttribute('class')).toBe(BASELINE_HEADER_CLASS);

    const { container: wide } = renderWithShell(<p>内容</p>, true);
    expect(wide.querySelector('header > div')?.getAttribute('class')).toBe(
      `${BASELINE_HEADER_CLASS} lg:max-w-6xl`,
    );
  });
});

// ---------------------------------------------------------------------------
// 今天页（/dashboard）：三栏
// ---------------------------------------------------------------------------

describe('今天页（/dashboard）宽屏三栏', () => {
  beforeEach(() => stubFetch(DASHBOARD_PAYLOAD));

  it('布局容器只有 lg: 前缀的栅格类，没有无条件生效的宽屏类（★ 缺陷注入靶点）', async () => {
    const { container } = renderWithShell(<DashboardPage />, true);
    await screen.findByText('今天也照顾好自己');
    const section = container.querySelector('section[aria-labelledby="dashboard-title"]');
    expect(section).not.toBeNull();
    expectWideClassesAllLgPrefixed(section);
    expect(classesOf(section)).toContain('lg:grid');
    expect(classesOf(section)).toContain('lg:grid-cols-3');
  });

  it('三栏（lg:col-start-1/2/3）列序单调 → 焦点顺序不乱跳', async () => {
    const { container } = renderWithShell(<DashboardPage />, true);
    await screen.findByText('今天也照顾好自己');
    const section = container.querySelector('section[aria-labelledby="dashboard-title"]')!;
    const starts = Array.from(section.children).map(colStartOf).filter((n): n is number => n !== null);
    expect(starts).toEqual([1, 2, 3]);
    expectColumnMajorOrder(section);
  });

  it('★ 移动端间距不变：包裹块沿用父级同款 `space-y-section`（窄屏卡片顺序 / 间距与改动前一致）', async () => {
    const { container } = renderWithShell(<DashboardPage />, true);
    await screen.findByText('今天也照顾好自己');
    const section = container.querySelector('section[aria-labelledby="dashboard-title"]')!;
    // header + 三个中性栏包裹块
    expect(Array.from(section.children).map((el) => el.tagName)).toEqual([
      'HEADER',
      'DIV',
      'DIV',
      'DIV',
    ]);
    // 「父子同款」：父级 section 与三个包裹块共用同一间距 token（2026-10-12 mt/space 语义化迁移后为 space-y-section）
    expect(classesOf(section)).toContain('space-y-section');
    for (const col of Array.from(section.querySelectorAll(':scope > div'))) {
      expect(classesOf(col)).toContain('space-y-section');
    }
    // 关键区块层级 / 归属不变
    expect(section.querySelector('section[aria-label="今天可以做的事"]')).not.toBeNull();
    expect(section.querySelector('section[aria-label="每天和每周"]')).not.toBeNull();
    // 三个卡片标题的 DOM 顺序与改动前一致（信息未丢、未重排）
    expect(Array.from(section.querySelectorAll('h2')).map((el) => el.textContent)).toEqual([
      '今天的记录',
      '喝水',
      '这周的小变化',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 变化页（/weight）：两栏
// ---------------------------------------------------------------------------

describe('变化页（/weight）宽屏两栏', () => {
  beforeEach(() => stubFetch([]));

  it('布局容器只有 lg: 前缀的栅格类，两栏结构存在', () => {
    const { container } = renderWithShell(<WeightPage />, true);
    const section = container.querySelector('section[aria-labelledby="weight-title"]');
    expect(section).not.toBeNull();
    expectWideClassesAllLgPrefixed(section);
    expect(classesOf(section)).toContain('lg:grid');
    expect(classesOf(section)).toContain('lg:grid-cols-2');
    expectColumnMajorOrder(section!);
  });

  it('左栏 = 记录与曲线（表单 / 曲线图），右栏 = 统计 + 近期记录 + 体重之外的变化', () => {
    const { container } = renderWithShell(<WeightPage />, true);
    const section = container.querySelector('section[aria-labelledby="weight-title"]')!;
    const leftCol = section.querySelector(':scope > .lg\\:col-start-1');
    const rightCol = section.querySelector(':scope > .lg\\:col-start-2');
    expect(leftCol).not.toBeNull();
    expect(rightCol).not.toBeNull();
    // 移动端间距类沿用父级同款 `space-y-5`
    expect(classesOf(leftCol)).toContain('space-y-5');
    expect(classesOf(rightCol)).toContain('space-y-5');
    // 表单 / 曲线在左栏
    expect(leftCol?.querySelector('form')).not.toBeNull();
    expect(leftCol?.textContent).toContain('体重曲线与 7 日均线');
    // 区间统计（<dl>）与「体重之外的变化」卡在右栏，未被丢失
    expect(rightCol?.querySelector('dl')).not.toBeNull();
    expect(rightCol?.querySelector('section[aria-labelledby="win-log-title"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 回顾页（/report）：周报两栏 + 容器放宽
// ---------------------------------------------------------------------------

describe('回顾页（/report）宽屏两栏', () => {
  beforeEach(() => stubFetch(WEEKLY_PAYLOAD));

  it('周报视图容器只有 lg: 前缀的两栏栅格类（移动端 flex 单栏不变）', async () => {
    const { container } = renderWithShell(<ReportPage />, true);
    await waitFor(() => {
      expect(screen.getByText(COPY.reportHabitTitle)).toBeDefined();
    });
    // 周选择器是栅格容器的第一个子节点 → 其父元素即两栏容器
    const weekSection = container.querySelector(`section[aria-label="${COPY.weekSwitchTitle}"]`);
    expect(weekSection).not.toBeNull();
    const grid = weekSection!.parentElement;
    expectWideClassesAllLgPrefixed(grid);
    expect(classesOf(grid)).toContain('lg:grid');
    expect(classesOf(grid)).toContain('lg:grid-cols-2');
    // 移动端仍是 flex 单栏（结构不塌），且间距类为 `flex flex-col gap-4`
    expect(classesOf(grid)).toContain('flex');
    expect(classesOf(grid)).toContain('flex-col');
    expect(classesOf(grid)).toContain('gap-4');
    expectColumnMajorOrder(grid!);

    // 两栏各自独立堆叠：左栏 = 摘要，右栏 = 习惯 / 微量营养素
    const cols = Array.from(grid!.children).filter((el) => colStartOf(el) !== null);
    expect(cols.map(colStartOf)).toEqual([1, 2]);
    expect(cols[0]?.textContent).toContain('近 7 天');
    expect(cols[1]?.textContent).toContain(COPY.reportHabitTitle);
  });

  it('回顾页容器只在 lg 放宽到 max-w-5xl（移动端仍 max-w-xl）', () => {
    const { container } = renderWithShell(<ReportPage />, true);
    const holder = container.querySelector('main > div');
    expect(classesOf(holder)).toContain('max-w-xl');
    expect(classesOf(holder)).toContain('lg:max-w-5xl');
    expectWideClassesAllLgPrefixed(holder);
  });

  it('阶段回顾（这段时间）也是两栏：档位占满一行，指标左 / 常吃右', async () => {
    stubFetchByUrl((url) => {
      if (url.includes('/report/period')) return PERIOD_PAYLOAD;
      if (url.includes('/foods/top')) {
        // 契约（`TopFoodItem`）：`foodItemId` 非空 ⟺ `food` 是完整 `FoodItem`。
        // 此前此桩只给了 `foodItemId: 1` 而**漏了 `food`**，靠 `Record<string, unknown>`
        // 的松类型蒙混过关 —— 若`PeriodReportView` 将来解引用 `item.food.id`，
        // 这里就会在运行时炸 `undefined`。按契约补齐（`lastLoggedDate` 同样必填）。
        return {
          days: 30,
          items: [
            {
              name: '米饭',
              dayCount: 5,
              foodItemId: 1,
              lastLoggedDate: '2026-09-20',
              food: {
                id: 1,
                name: '米饭',
                namePinyin: null,
                aliases: [],
                category: '主食',
                kcalPer100g: 116,
                proteinGPer100g: 2.6,
                fatGPer100g: 0.3,
                carbGPer100g: 25.9,
                fiberGPer100g: null,
                sodiumMgPer100g: null,
                saturatedFatGPer100g: null,
                sugarGPer100g: null,
                calciumMgPer100g: null,
                ironMgPer100g: null,
                potassiumMgPer100g: null,
                vitaminDUgPer100g: null,
                b12UgPer100g: null,
                magnesiumMgPer100g: null,
                servingUnits: [{ unit: '碗', grams: 200, label: '一碗' }],
                defaultServingGrams: 200,
                barcode: null,
                source: 'builtin',
                createdByUserId: null,
                isVerified: true,
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-01T00:00:00.000Z',
              },
            },
          ],
        };
      }
      return WEEKLY_PAYLOAD;
    });
    const { container } = renderWithShell(<ReportPage />, true);
    // 切到「这段时间」tab
    fireEvent.click(screen.getByRole('tab', { name: COPY.reportTabPeriod }));
    await waitFor(() => {
      expect(screen.getByRole('tablist', { name: '回顾档位' })).toBeDefined();
    });
    const grid = container.querySelector(`div[aria-label="${COPY.reportTabPeriod}"]`);
    expect(grid).not.toBeNull();
    // 等阶段回顾数据到位（指标卡 + 常吃 Top 渲染出来）再断言两栏
    await waitFor(() => {
      expect(container.querySelector('[data-testid="period-metrics"]')).not.toBeNull();
      expect(container.querySelector('#period-top-title')).not.toBeNull();
    });
    expectWideClassesAllLgPrefixed(grid);
    expect(classesOf(grid)).toContain('lg:grid-cols-2');
    // 档位行占满一行；指标左栏 / 常吃右栏，列序单调
    expect(colStartOf(grid!.children[0]!)).toBeNull(); // 档位行是 span-2，不带 col-start
    const starts = Array.from(grid!.children).map(colStartOf).filter((n): n is number => n !== null);
    expect(starts).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 无障碍不回退
// ---------------------------------------------------------------------------

describe('无障碍不回退（宽屏改造未破坏语义 / 焦点路径）', () => {
  it('今天 / 变化 / 回顾 的关键区域 role·aria-* 仍在', async () => {
    stubFetch(DASHBOARD_PAYLOAD);
    const dash = renderWithShell(<DashboardPage />, true);
    await screen.findByText('今天也照顾好自己');
    expect(
      dash.container.querySelector('section[aria-labelledby="dashboard-title"]'),
    ).not.toBeNull();
    // 顶部「跳到主要内容」链接仍是键盘可达的第一站
    expect(screen.getByRole('link', { name: '跳到主要内容' })).toBeDefined();
    expect(dash.container.querySelector('main#main')).not.toBeNull();
    dash.unmount();

    stubFetch([]);
    const weight = renderWithShell(<WeightPage />, true);
    expect(
      weight.container.querySelector('section[aria-labelledby="weight-title"]'),
    ).not.toBeNull();
    expect(weight.container.querySelector('main#main')).not.toBeNull();
    weight.unmount();

    stubFetch(WEEKLY_PAYLOAD);
    renderWithShell(<ReportPage />, true);
    // 回顾范围 Tab 列表语义完整
    expect(screen.getByRole('tablist', { name: '回顾范围' })).toBeDefined();
    expect(screen.getByRole('tab', { name: COPY.reportTabWeekly })).toBeDefined();
  });
});
