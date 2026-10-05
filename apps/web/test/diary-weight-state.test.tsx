/**
 * 四处「状态混淆 / 失效漏刷」的护栏（pages/diary/DiaryPage.tsx + pages/weight/WeightPage.tsx）。
 *
 * ## 本文件守的四件事
 *
 * ### ① P0 `/diary`：请求失败 + 无缓存 不能落成「今天还没记」
 *
 * 修复前，`isEmptyDay` 为真时无条件渲染 `COPY.emptyTodayDiary`（「今天还没记，从一顿早餐开始也行」）。
 * 而这个 `true` 有三种成因，页面只画了其中一种：
 *   - 请求还在路上 → 「还没记」是**尚未知道**的结论；
 *   - 请求失败且本机没缓存（新用户 / 刚清缓存 / 换设备）→ 把「没能读出来」说成「你还没记」，
 *     今天记过的用户会以为记录丢了 —— 一个**不存在的损失**；
 *   - 请求成功且当天真的没有记录 → 只有这时那句话才成立。
 * 页面上 22 处 `isError` 全在 `catch` 块里；唯一的 `mealsQuery.isError`（`:275` 附近）
 * 判据里带 `hasAnyLog`，要求「先有旧数据」才提示 —— 于是无缓存时**彻底沉默**。
 *
 * ### ② P1 `/weight`：同一形状
 *
 * `points.length === 0` 时按 `allPoints.length === 0` 渲染 `COPY.emptyWeight`
 * （「记录第一笔体重，之后就交给趋势吧」）；已有的 `showingStaleData` 也要求
 * `allPoints.length > 0`，无缓存时连「这是上次同步的数据」都不出现。症状同样是把
 * 「没能读出来」说成「你一笔都还没记」。
 *
 * ### ③ P1 记餐后报表 / 食物榜拿旧值
 *
 * `invalidate()` 原先只有 `meals(date)` + `dashboard(date)`。而周报摄入、阶段回顾的
 * 多样食物数 / 记录天数、足迹日历、常吃榜、上次份量、食用历史，都是按**全部记录**
 * 聚合出来的服务端结果 —— 少失效 `['report']` / `['foods']` 两族，用户看到的永远是
 * 记这一餐**之前**的旧值，且没有任何提示告诉他数字是旧的。
 *
 * ### ④ P1 记体重后报表拿旧值 —— 同 ③。
 *
 * ## 断言纪律（本文件严格自守，勿改）
 *
 * - **正向**（该出现的）：一律 `await screen.findBy*()` —— 轮询到真正上屏才断言；
 * - **否定**（不该出现的）：**必须**先有一个正向锚点已上屏（或 `flushCommit()` 冲干净
 *   React），再**同步** `queryBy*`。否则「还没渲染」会被当成「真的没渲染」→ 假绿；
 * - **断言顺序**：先 await 该出现的上屏，再同步断另一个不存在；
 * - **等待锚点不许用首帧就存在的静态元素**（如「今天一共」「体重趋势」标题）——
 *   那时查询还没失败，看到的只是中间态。
 *
 * ## 为什么用「探针查询」来验失效，而不是断言 `invalidateQueries` 被调几次
 *
 * 断言调用次数会把实现冻死（换成 `setQueryData` / `removeQueries` 就假红），
 * 而且**测不到真实效果**：真正要保的是「下一次进啰嗦 × 报表页时数据是新的」。
 * 探针是**挂载着的** `useQuery`（`invalidateQueries` 只重取 active 查询），
 * 数它的真实 HTTP 次数 —— 这才是用户视角的可观察事实。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { ListMealsResponse, MealLog, WeightTrendResponse } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import WeightPage from '@/pages/weight/WeightPage';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY, weightInputLabel } from '@/lib/copy';
import { CACHE_KEYS, cacheClearAll, cacheSet } from '@/lib/local-cache';
import { clearPlateauVisibility } from '@/lib/plateau-visibility';
import { addDays, todayKey } from '@/lib/format';
import { useUnitStore } from '@/lib/units';

const TODAY = todayKey();

/** 「重新试试」按钮的可及名（写死：动作存在与否是本轮的交付物之一，不跟随文案漂移）。 */
const RETRY_LABEL = '重新试试';

/** 本页新增的错误文案（与 DiaryPage.tsx 的局部常量逐字对应）。 */
const DIARY_ERROR_TEXT = '这一天的记录暂时取不到，稍后再看看就好';
/** 同上（WeightPage.tsx）。 */
const WEIGHT_ERROR_TEXT = '这段时间的记录暂时取不到，稍后再看看就好';

/** `/meals` 查询键。 */
const MEALS_KEY = ['meals', TODAY];
/** `/dashboard` 查询键。 */
const DASHBOARD_KEY = ['dashboard', TODAY];
/** `/weights` 查询键。 */
const TREND_KEY = ['weights', 'trend'];

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

/** 后端统一包装：成功。 */
function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as Response;
}

/** 后端统一包装：业务错误（不是网络层失败）。 */
function serverError(): Response {
  return {
    ok: false,
    status: 500,
    json: async () => ({ data: null, error: { code: 'E_SERVER', message: '服务端在开小差，稍后我们再来一次' } }),
  } as Response;
}

/** 网络层失败（`lib/api.ts` 的 catch 分支同形）。 */
function failNetwork(): never {
  throw new TypeError('Failed to fetch');
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

/** 按 method + API 路径数请求次数（`path` 形如 `/meals`，不含 `/api` 前缀）。 */
function countPath(log: readonly FetchCall[], path: string, method = 'GET'): number {
  return log.filter((call) => call.method === method && call.url.includes(`/api${path}`)).length;
}

type Route = (url: string, method: string) => Response | Promise<Response>;

/** 装一个按 URL 分派的 fetch 桩，返回可计数的调用日志。 */
function stubFetch(route: Route): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      return route(url, method);
    }),
  );
  return calls;
}

/** 每条用例独立的 QueryClient：`retry: false` 让网络层失败立刻落到 `isError`。 */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 30 * 60_000,
        staleTime: 30_000,
        networkMode: 'offlineFirst',
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * 把 React 的 pending 更新冲干净。
 *
 * ⚠️ 纯否定断言（某元素**不该**出现）之前必须调它：断言那一刻「还没渲染」与
 * 「真的没渲染」长得一模一样。`await act(...)` 是唯一既不依赖被测行为、
 * 也不会把「本来不该出现却出现了」一起冲掉的锚点。
 */
async function flushCommit(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// 饮食页的数据构造
// ---------------------------------------------------------------------------

/** 造一条最小可用的饮食记录。 */
function mealLog(id: number, kcal: number): MealLog {
  return {
    id,
    userId: 1,
    loggedDate: TODAY,
    mealType: 'breakfast',
    foodItemId: 1,
    customName: null,
    foodName: '燕麦片',
    grams: 100,
    servingUnit: null,
    servingQty: null,
    kcal,
    proteinG: null,
    fatG: null,
    carbG: null,
    fiberG: null,
    sodiumMg: null,
    source: 'search',
    comboId: null,
    note: null,
    sortOrder: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** `/meals` 响应：早餐放若干条记录。 */
function mealsPayload(logs: readonly MealLog[]): ListMealsResponse {
  return {
    date: TODAY,
    groups: [{ mealType: 'breakfast', logs: [...logs], totalKcal: logs.reduce((sum, log) => sum + log.kcal, 0) }],
    totalKcal: logs.reduce((sum, log) => sum + log.kcal, 0),
  };
}

/** `/dashboard` 响应。 */
function dashboardPayload(): Record<string, unknown> {
  return {
    date: TODAY,
    goal: null,
    budget: { intakeRecommended: 1600, bmr: 1300, tdee: 2000 },
    intakeKcal: 0,
    burnedKcal: 0,
    remainingKcal: 1600,
    progressRatio: 0,
    waterMl: 0,
    waterGoalMl: 1500,
    miniTrend: [],
    encouragement: '今天也照顾好自己',
    warnings: [],
  };
}

/** `/weights` 响应（本页不关心，给合法空趋势）。 */
const WEIGHTS_PAYLOAD: WeightTrendResponse = {
  points: [],
  movingAverage7: [],
  stats: { minKg: null, maxKg: null, latestKg: null, changeKg: null },
  forecast: [],
  goalProgress: null,
};

/** 默认成功路由：没有记录的一天 + 有预算的看板 + 空趋势。 */
function diaryDefault(url: string): Response {
  if (url.includes('/dashboard')) return ok(dashboardPayload());
  if (url.includes('/weights')) return ok(WEIGHTS_PAYLOAD);
  return ok(mealsPayload([]));
}

/** 把「上次成功同步的结果」写进本机缓存。 */
function seedMealsCache(logs: readonly MealLog[]): void {
  cacheSet<ListMealsResponse>(CACHE_KEYS.meals(TODAY), mealsPayload(logs));
}

/**
 * 等若干查询**真的落到终态**（成功或失败且不再 fetch）。
 *
 * ⚠️ 不能接受 `state === undefined`：查询还没注册那样也会通过，
 * 于是请求还在路上就断言，看到的是「还没失败」的中间态 → 假红。
 */
async function waitSettled(client: QueryClient, keys: readonly (readonly string[])[]): Promise<void> {
  await waitFor(() => {
    for (const key of keys) {
      const state = client.getQueryState(key);
      expect(state).toBeDefined();
      expect(state?.status === 'error' || state?.status === 'success').toBe(true);
      expect(state?.fetchStatus).not.toBe('fetching');
    }
  });
}

// ---------------------------------------------------------------------------
// 体重页的数据构造
// ---------------------------------------------------------------------------

/** 造一份最小可用的趋势响应。 */
function trendPayload(points: ReadonlyArray<{ date: string; weightKg: number }>): WeightTrendResponse {
  return {
    points: [...points],
    movingAverage7: points.map((point) => ({ date: point.date, value: point.weightKg })),
    stats: { minKg: 60, maxKg: 60, latestKg: 60, changeKg: 0 },
    forecast: [],
    goalProgress: null,
  };
}

/** 落在默认 90 天区间内的两点趋势。 */
const TREND_OK = trendPayload([
  { date: addDays(TODAY, -30), weightKg: 70 },
  { date: addDays(TODAY, -1), weightKg: 69.8 },
]);

// ---------------------------------------------------------------------------
// 「探针查询」：用真实 HTTP 次数验「失效真的传到了派生统计」
// ---------------------------------------------------------------------------

interface ProbeSpec {
  readonly label: string;
  /** `api.get()` 的路径（不含 `/api` 前缀），用于识别 fetch URL */
  readonly path: string;
  /** 查询键 —— 必须是业务页真正用的那一个 */
  readonly queryKey: readonly unknown[];
  readonly data: unknown;
}

/** 报表族三个键（周报 / 阶段回顾 / 足迹日历）—— 全部挂在 `['report']` 前缀下。 */
const REPORT_PROBES: readonly ProbeSpec[] = [
  { label: 'weekly', path: '/report/weekly', queryKey: queryKeys.weeklyReport(TODAY), data: { days: [] } },
  { label: 'period', path: '/report/period', queryKey: queryKeys.periodReport(30, TODAY), data: { days: [] } },
  { label: 'calendar', path: '/report/calendar', queryKey: queryKeys.reportCalendar('2026-09'), data: { days: [] } },
];

/** 食物族四个键（常吃榜 / 上次份量 / 食用历史 / 最近）—— 全部挂在 `['foods']` 前缀下。 */
const FOOD_PROBES: readonly ProbeSpec[] = [
  { label: 'recent', path: '/foods/recent', queryKey: queryKeys.foodRecent, data: [] },
  { label: 'top', path: '/foods/top', queryKey: queryKeys.foodTop(30, 10), data: [] },
  { label: 'last-portions', path: '/foods/last-portions', queryKey: queryKeys.foodLastPortions([1]), data: [] },
  { label: 'history', path: '/foods/history/1', queryKey: queryKeys.foodHistory(1), data: [] },
];

/** 若 URL 命中某个探针，回答它的数据；否则返回 `null` 交给业务路由兜底。 */
function answerProbe(specs: readonly ProbeSpec[], url: string): Response | null {
  for (const spec of specs) {
    if (url.includes(`/api${spec.path}`)) {
      return ok(spec.data);
    }
  }
  return null;
}

function ProbeRow({ spec }: { spec: ProbeSpec }): ReactElement {
  const query = useQuery({
    queryKey: [...spec.queryKey],
    queryFn: () => api.get<unknown>(spec.path),
  });
  return <p data-testid={`probe-${spec.label}`}>{query.isSuccess ? 'ready' : 'pending'}</p>;
}

/** 把探针查询**挂载**成 active —— `invalidateQueries` 只重取 active 查询。 */
function ProbeGroup({ specs }: { specs: readonly ProbeSpec[] }): ReactElement {
  return (
    <div aria-hidden="true">
      {specs.map((spec) => (
        <ProbeRow key={spec.label} spec={spec} />
      ))}
    </div>
  );
}

/** 记下每个探针当前的请求次数，作为「失效是否发生」的基线。 */
function probeBaseline(log: readonly FetchCall[], specs: readonly ProbeSpec[]): Map<string, number> {
  const base = new Map<string, number>();
  for (const spec of specs) {
    base.set(spec.label, countPath(log, spec.path));
  }
  return base;
}

/** 等所有探针都再取了一次（失效确实传到了派生统计）。 */
async function expectProbesRefetched(
  log: readonly FetchCall[],
  specs: readonly ProbeSpec[],
  baseline: ReadonlyMap<string, number>,
): Promise<void> {
  for (const spec of specs) {
    const before = baseline.get(spec.label) ?? 0;
    const after = countPath(log, spec.path);
    expect(
      after,
      `探针 ${spec.label}（${spec.path}）没有被失效重取：${before} → ${after}`,
    ).toBeGreaterThan(before);
  }
}

/** 等所有探针挂载完成（首次取数成功），确保基线是从「已被订阅」开始记的。 */
async function waitProbesReady(specs: readonly ProbeSpec[]): Promise<void> {
  for (const spec of specs) {
    // 正向锚点：`findByTestId` 轮询到 DOM 里出现该节点为止；
    // 这里要等的是它的**内容**变成 ready —— 用 waitFor 包一层。
    const node = await screen.findByTestId(`probe-${spec.label}`);
    await waitFor(() => {
      expect(node.textContent).toBe('ready');
    });
  }
}

function renderWithProviders(client: QueryClient, children: ReactElement): void {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cacheClearAll();
  clearPlateauVisibility();
  useUnitStore.setState({ unit: 'kcal', weightUnit: 'kg' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cacheClearAll();
  clearPlateauVisibility();
});

// ---------------------------------------------------------------------------
// ① `/diary`：请求失败 + 无缓存 ≠ 「今天还没记」
// ---------------------------------------------------------------------------

describe('饮食页 · 「还没记」只在真的没记时才说', () => {
  it('★ 网络失败 + 无缓存 → 给「暂时取不到」+ 可点重试，不再谎称「今天还没记」', async () => {
    stubFetch((url) => (url.includes('/meals') ? failNetwork() : diaryDefault(url)));
    const client = newClient();
    renderWithProviders(client, <DiaryPage />);
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);

    // 正向锚点：等错误块真的上屏，再同步做否定断言
    const box = await screen.findByTestId('diary-meals-error');
    expect(box).toHaveTextContent(DIARY_ERROR_TEXT);
    expect(within(box).getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    // 缺陷正身：不再用「还没记」盖住「没能读出来」
    expect(screen.queryByText(COPY.emptyTodayDiary)).toBeNull();
    // 没有任何旧记录在展示 → 不能挂「这些是上次同步时的数据」
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
    // 文案红线（PRD §7）+ 不引入需解释的新数字（NFR-11）
    expect(box.textContent ?? '').not.toMatch(/失败|错误|崩溃|超标/);
    expect(box.textContent ?? '').not.toMatch(/\d+/);
  }, 20_000);

  it('★ 业务错误（500）+ 无缓存 → 同样给错误态，且不挂「网络不稳」的旧数据标记', async () => {
    stubFetch((url) => (url.includes('/meals') ? serverError() : diaryDefault(url)));
    const client = newClient();
    renderWithProviders(client, <DiaryPage />);
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);

    const box = await screen.findByTestId('diary-meals-error');
    expect(box).toHaveTextContent(DIARY_ERROR_TEXT);
    expect(screen.queryByText(COPY.emptyTodayDiary)).toBeNull();
    // 红线：业务错误不得被说成「网络不稳定 / 上次同步」
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
  }, 20_000);

  it('请求还在路上 → 显示「正在取」，不闪「今天还没记」的引导空态', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch(async (url) => {
      if (url.includes('/meals')) {
        await gate;
        return ok(mealsPayload([]));
      }
      return diaryDefault(url);
    });
    const client = newClient();
    renderWithProviders(client, <DiaryPage />);

    // 正向锚点：加载块上屏 → 此刻 React 这一轮已提交，可同步做否定断言
    expect(await screen.findByTestId('diary-meals-loading')).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyTodayDiary)).toBeNull();
    expect(screen.queryByTestId('diary-meals-error')).toBeNull();

    // 落地后才给出真正的结论：「这一天确实还没记」
    release();
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);
    expect(await screen.findByText(COPY.emptyTodayDiary)).toBeInTheDocument();
    expect(screen.queryByTestId('diary-meals-loading')).toBeNull();
    expect(screen.queryByTestId('diary-meals-error')).toBeNull();
  }, 20_000);

  it('请求成功且当天真的没有记录 → 仍显示「今天还没记」（别把引导改坏）', async () => {
    stubFetch((url) => diaryDefault(url));
    const client = newClient();
    renderWithProviders(client, <DiaryPage />);
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);

    // 正向锚点：引导空态上屏
    expect(await screen.findByText(COPY.emptyTodayDiary)).toBeInTheDocument();
    expect(screen.queryByTestId('diary-meals-error')).toBeNull();
    expect(screen.queryByTestId('diary-meals-loading')).toBeNull();
  }, 20_000);

  it('★ 有缓存 + 网络失败 → 走「上次同步」那条路，不重复出现错误块（两条降级路径不许合并）', async () => {
    seedMealsCache([mealLog(1, 300)]);
    stubFetch((url) => (url.includes('/meals') ? failNetwork() : diaryDefault(url)));
    const client = newClient();
    renderWithProviders(client, <DiaryPage />);
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);

    // 正向锚点：先看「这是上次同步时的数据」上屏
    expect(await screen.findByTestId('diary-stale-meals-notice')).toBeInTheDocument();
    expect(screen.getByText('燕麦片')).toBeInTheDocument();
    // 有东西可看时不说「取不到」
    expect(screen.queryByTestId('diary-meals-error')).toBeNull();
    expect(screen.queryByTestId('diary-meals-loading')).toBeNull();
  }, 20_000);

  it('点「重新试试」真的会再发一次 /meals', async () => {
    const log = stubFetch((url) => (url.includes('/meals') ? failNetwork() : diaryDefault(url)));
    const client = newClient();
    renderWithProviders(client, <DiaryPage />);
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);

    const box = await screen.findByTestId('diary-meals-error');
    const before = countPath(log, '/meals');
    await userEvent.click(within(box).getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => {
      expect(countPath(log, '/meals')).toBeGreaterThan(before);
    });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// ③ 记餐后：报表族与食物族的派生统计必须跟着失效
// ---------------------------------------------------------------------------

describe('饮食页 · 写操作后派生统计跟着失效', () => {
  /** 报表族 + 食物族探针一起挂上。 */
  const ALL_PROBES: readonly ProbeSpec[] = [...REPORT_PROBES, ...FOOD_PROBES];

  it('★ 删一条记录后 → 周报 / 阶段回顾 / 足迹日历 / 常吃榜 / 上次份量 / 食用历史全部重取', async () => {
    let deleted = false;
    const log = stubFetch((url, method) => {
      const probe = answerProbe(ALL_PROBES, url);
      if (probe !== null) return probe;
      if (url.includes('/dashboard')) return ok(dashboardPayload());
      if (url.includes('/weights')) return ok(WEIGHTS_PAYLOAD);
      if (url.includes('/meals')) {
        if (method === 'DELETE') {
          deleted = true;
          return ok({ id: 1 });
        }
        return ok(deleted ? mealsPayload([]) : mealsPayload([mealLog(1, 300)]));
      }
      return ok(null);
    });

    const client = newClient();
    renderWithProviders(
      client,
      <>
        <ProbeGroup specs={ALL_PROBES} />
        <DiaryPage />
      </>,
    );
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);
    await waitProbesReady(ALL_PROBES);

    const baseline = probeBaseline(log, ALL_PROBES);
    // 基线必须是「每个探针都已经取过一次」，否则「0 → 1」会把首次挂载误算成失效
    for (const count of baseline.values()) {
      expect(count).toBeGreaterThan(0);
    }

    // 触发一次写操作：删掉屏幕上那条记录
    expect(screen.getByTestId('meal-item-1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '删除 燕麦片' }));

    // 锚点独立于被测行为：这一行消失只说明 `/meals` 那一路通了
    await waitFor(() => {
      expect(screen.queryByTestId('meal-item-1')).toBeNull();
    });
    await expectProbesRefetched(log, ALL_PROBES, baseline);
  }, 20_000);

  it('★ 另一条写路径（拖拽排序 / 上移）同样会带上这两族失效', async () => {
    // 写操作的**第二个入口**：记餐 / 删餐 / 改份量 / 套餐饮用 / 排序全部调用同一个
    // `invalidate()`，这里用「上移」验证它们不会被各自埋瞎的那份覆盖掉。
    const log = stubFetch((url, method) => {
      const probe = answerProbe(ALL_PROBES, url);
      if (probe !== null) return probe;
      if (url.includes('/dashboard')) return ok(dashboardPayload());
      if (url.includes('/weights')) return ok(WEIGHTS_PAYLOAD);
      if (url.includes('/meals/reorder')) return ok({ updated: 2 });
      if (url.includes('/meals')) return ok(mealsPayload([mealLog(1, 300), mealLog(2, 200)]));
      return ok(null);
    });

    const client = newClient();
    renderWithProviders(
      client,
      <>
        <ProbeGroup specs={ALL_PROBES} />
        <DiaryPage />
      </>,
    );
    await waitSettled(client, [MEALS_KEY, DASHBOARD_KEY]);
    await waitProbesReady(ALL_PROBES);

    const baseline = probeBaseline(log, ALL_PROBES);
    await userEvent.click(screen.getByTestId('meal-up-2'));

    // 锚点：排序请求确实发出去了（与被测的「失效」是同一条链上的前后两步）
    await waitFor(() => {
      expect(countPath(log, '/meals/reorder', 'PATCH')).toBe(1);
    });
    await expectProbesRefetched(log, ALL_PROBES, baseline);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// ② `/weight`：请求失败 + 无缓存 ≠ 「记录第一笔体重」
// ---------------------------------------------------------------------------

describe('体重页 · 「记录第一笔」只在真的没记时才说', () => {
  it('★ 网络失败 + 无缓存 → 给「暂时取不到」+ 可点重试，不再谎称「记录第一笔体重」', async () => {
    stubFetch((url) => (url.includes('/weights') ? failNetwork() : ok(null)));
    const client = newClient();
    renderWithProviders(client, <WeightPage />);
    await waitSettled(client, [TREND_KEY]);

    const box = await screen.findByTestId('weight-trend-error');
    expect(box).toHaveTextContent(WEIGHT_ERROR_TEXT);
    expect(within(box).getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    // 缺陷正身
    expect(screen.queryByText(COPY.emptyWeight)).toBeNull();
    expect(screen.queryByText(COPY.weightRangeEmpty)).toBeNull();
    // 没有任何旧数字在展示 → 不许挂「这是上次同步的数据」
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
    expect(box.textContent ?? '').not.toMatch(/失败|错误|崩溃|超标/);
    expect(box.textContent ?? '').not.toMatch(/\d+/);
  }, 20_000);

  it('★ 业务错误（500）+ 无缓存 → 同样给错误态，且不挂「上次同步」标记', async () => {
    stubFetch((url) => (url.includes('/weights') ? serverError() : ok(null)));
    const client = newClient();
    renderWithProviders(client, <WeightPage />);
    await waitSettled(client, [TREND_KEY]);

    const box = await screen.findByTestId('weight-trend-error');
    expect(box).toHaveTextContent(WEIGHT_ERROR_TEXT);
    expect(screen.queryByText(COPY.emptyWeight)).toBeNull();
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
  }, 20_000);

  it('请求还在路上 → 显示「正在取」，不闪「记录第一笔体重」', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch(async (url) => {
      if (url.includes('/weights')) {
        await gate;
        return ok(trendPayload([]));
      }
      return ok(null);
    });
    const client = newClient();
    renderWithProviders(client, <WeightPage />);

    expect(await screen.findByTestId('weight-trend-loading')).toBeInTheDocument();
    expect(screen.queryByText(COPY.emptyWeight)).toBeNull();
    expect(screen.queryByTestId('weight-trend-error')).toBeNull();

    release();
    await waitSettled(client, [TREND_KEY]);
    expect(await screen.findByText(COPY.emptyWeight)).toBeInTheDocument();
    expect(screen.queryByTestId('weight-trend-loading')).toBeNull();
    expect(screen.queryByTestId('weight-trend-error')).toBeNull();
  }, 20_000);

  it('请求成功且真的没有记录 → 仍显示「记录第一笔体重」（别把引导改坏）', async () => {
    stubFetch((url) => (url.includes('/weights') ? ok(trendPayload([])) : ok(null)));
    const client = newClient();
    renderWithProviders(client, <WeightPage />);
    await waitSettled(client, [TREND_KEY]);

    expect(await screen.findByText(COPY.emptyWeight)).toBeInTheDocument();
    expect(screen.queryByTestId('weight-trend-error')).toBeNull();
    expect(screen.queryByTestId('weight-trend-loading')).toBeNull();
  }, 20_000);

  it('★ 有缓存 + 网络失败 → 走「上次同步」那条路，不重复出现错误块', async () => {
    cacheSet(CACHE_KEYS.weightPoints, TREND_OK.points);
    stubFetch((url) => (url.includes('/weights') ? failNetwork() : ok(null)));
    const client = newClient();
    renderWithProviders(client, <WeightPage />);
    await waitSettled(client, [TREND_KEY]);

    expect(await screen.findByTestId('weight-stale-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('weight-trend-error')).toBeNull();
    expect(screen.queryByTestId('weight-trend-loading')).toBeNull();
    expect(screen.queryByText(COPY.emptyWeight)).toBeNull();
  }, 20_000);

  it('点「重新试试」真的会再发一次 /weights', async () => {
    const log = stubFetch((url) => (url.includes('/weights') ? failNetwork() : ok(null)));
    const client = newClient();
    renderWithProviders(client, <WeightPage />);
    await waitSettled(client, [TREND_KEY]);

    const box = await screen.findByTestId('weight-trend-error');
    const before = countPath(log, '/weights');
    await userEvent.click(within(box).getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => {
      expect(countPath(log, '/weights')).toBeGreaterThan(before);
    });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// ④ 记体重后：报表族的派生统计必须跟着失效
// ---------------------------------------------------------------------------

describe('体重页 · 记一笔之后报表跟着失效', () => {
  it('★ 记录成功后 → 周报 / 阶段回顾 / 足迹日历全部重取', async () => {
    const log = stubFetch((url, method) => {
      const probe = answerProbe(REPORT_PROBES, url);
      if (probe !== null) return probe;
      if (url.includes('/weights') && method === 'POST') return ok({ id: 1, weightKg: 60 });
      if (url.includes('/weights')) return ok(TREND_OK);
      return ok(null);
    });

    const client = newClient();
    renderWithProviders(
      client,
      <>
        <ProbeGroup specs={REPORT_PROBES} />
        <WeightPage />
      </>,
    );
    await waitSettled(client, [TREND_KEY]);
    await waitProbesReady(REPORT_PROBES);

    const baseline = probeBaseline(log, REPORT_PROBES);
    for (const count of baseline.values()) {
      expect(count).toBeGreaterThan(0);
    }

    // 用文案工厂取名（不要在本文件里手写单位字样 —— 那不属于本轮的被测内容）
    fireEvent.change(screen.getByLabelText(weightInputLabel('kg')), { target: { value: '60' } });
    await userEvent.click(screen.getByRole('button', { name: '记录今天的体重' }));

    // 锚点独立于被测行为：写入本身成功（表单反馈文案），与「报表有没有重取」不是同一件事
    await waitFor(() => {
      expect(countPath(log, '/weights', 'POST')).toBe(1);
    });
    await expectProbesRefetched(log, REPORT_PROBES, baseline);
  }, 20_000);

  it('★ 成功取到数据 → 不挂错误态也不挂加载态（纯否定：先冲干净 React）', async () => {
    // 这一条是**纯否定**用例（错误块与加载块都不该出现），屏幕上没有「只在成功时出现」的
    // 稳定锚点可用 → 必须先 `flushCommit()` 冲干净 React，否则「还没渲染」会被当成
    // 「真的没渲染」，用例假绿。
    stubFetch((url) => (url.includes('/weights') ? ok(TREND_OK) : ok(null)));
    const client = newClient();
    renderWithProviders(client, <WeightPage />);
    await waitSettled(client, [TREND_KEY]);

    await flushCommit();
    expect(screen.queryByTestId('weight-trend-error')).toBeNull();
    expect(screen.queryByTestId('weight-trend-loading')).toBeNull();
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
  }, 20_000);
});
