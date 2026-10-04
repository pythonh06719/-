/**
 * 饮食页两处「这是上次同步时的数据」标记（pages/diary/DiaryPage.tsx）。
 *
 * ## 这个测试在防什么
 *
 * 修复前，本页有**两条互不相干**的静默降级路径，屏幕上不留任何一个字：
 *
 * ① `groups = normalizeGroups(mealsQuery.data ?? cacheGet(CACHE_KEYS.meals(date)) ?? undefined)`
 *    ——「今天一共」的大数字、四个餐次各自的合计，全是旧记录，用户零提示。
 *    这是用户做「吃多少、还要不要动」决策的第二主路径（体重是第一）。
 *
 * ② `resolveDailyBudget()` 的 `readDailyBudget()` 退路（`DiaryPage.tsx:118`）
 *    —— 每餐「参考预算」这个**分母**是旧的。而 `/why-numbers:292` 已经写了
 *    「本机缓存只在断网时兜底」：文档承诺了兜底，却没给触发信号。
 *
 * 两条**必须分开**（用例③ 钉死）：它们来自两个独立请求（`/meals` 与 `/dashboard`），
 * 失效时刻不同。合并成一条会让用户不知道是「吃了多少」旧了还是「能吃多少」旧了 ——
 * 而后者正是决策依据。
 *
 * ## 为什么要有一条真实 HTTP 用例
 *
 * 这个缺陷的形状恰恰是「mock 出来的失败和成功长得一样」：
 * 若用 `vi.stubGlobal('fetch', ...)` 造失败，测试与被测行为**共享同一个假设**
 * ——「失败 = `fetch` 抛异常」。一旦真实链路里失败以别的形态出现，mock 测试仍全绿
 * 而缺陷复现。故本文件保留一条真起 `node:http`、真连接被拒（`ECONNREFUSED`）的用例。
 *
 * ## wait 锚点独立于被测行为
 *
 * 用例等的都是**前置条件**（查询状态机已落到终态）或**数据本身**，
 * 从不拿「标记出现了」当等待条件 —— 后者在被测行为误渲染时会超时，
 * 把「断言失败」伪装成「超时失败」，是假红而非真红。
 *
 * ⚠️ 特别提醒：`screen.getByText('今天一共')` **不能**当等待锚点 —— 它是首帧就存在的
 * 静态文案，那时 `isError` 还是 false、标记还没渲染。本文件一律等查询落终态。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ReactElement } from 'react';
import type { DashboardResponse, ListMealsResponse } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import { CACHE_KEYS, cacheClearAll, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import type { ThemeBudget } from '@/theme/tokens';

const TODAY = todayKey();
const DAILY_BUDGET = 1600;

/** 记录侧标记的主文案（与 `COPY.staleDataNotice` 同值，此处写死以免文案改动悄悄放过测试）。 */
const STALE_TEXT = '这些是上次同步时的数据，网络恢复后会自动更新。';
/** 预算侧标记的文案（`DiaryPage.tsx` 里的 `STALE_BUDGET_NOTICE`）。 */
const STALE_BUDGET_TEXT = '参考预算和进度条是上次同步时的数据，网络恢复后会自动更新。';

/** 记录侧查询键（与 `queryKeys.meals(date)` 同值）。 */
const MEALS_KEY = ['meals', TODAY];
/** 预算侧查询键（与 `queryKeys.dashboard(todayKey())` 同值）。 */
const DASHBOARD_KEY = ['dashboard', TODAY];

/** 模块加载时抓下的**原生 fetch**（在任何 `vi.stubGlobal` 之前）。见 `routeFetchTo` 处的注释。 */
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);

/** 造一条最小可用的饮食记录。 */
function mealLog(id: number, kcal: number): Record<string, unknown> {
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

/** 饮食响应：早餐一条 `kcal` 千卡。 */
function mealsPayload(kcal: number): ListMealsResponse {
  return {
    date: TODAY,
    groups: [{ mealType: 'breakfast', logs: [mealLog(1, kcal) as never], totalKcal: kcal }],
    totalKcal: kcal,
  };
}

/** 体重趋势（本页不关心，给合法空趋势即可）。 */
const WEIGHTS_PAYLOAD = {
  points: [],
  movingAverage7: [],
  stats: { minKg: null, maxKg: null, latestKg: null, changeKg: null },
  forecast: [],
  goalProgress: null,
};

/** 看板响应（`budget = null` 表示服务端没给预算）。 */
function dashboardPayload(budget: DashboardResponse['budget']): Record<string, unknown> {
  return {
    date: TODAY,
    goal: null,
    budget,
    intakeKcal: 300,
    burnedKcal: 0,
    remainingKcal: 0,
    progressRatio: 0,
    waterMl: 0,
    waterGoalMl: 1500,
    miniTrend: [],
    encouragement: '今天也照顾好自己',
    warnings: [],
  };
}

/** 统一响应包装（与后端全局拦截器一致）。 */
function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as Response;
}

/** 每条用例独立的 QueryClient（`retry: false` 让网络层失败立刻落地，不拖重试）。 */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 30 * 60_000, staleTime: 30_000, networkMode: 'offlineFirst' },
    },
  });
}

function renderDiary(client: QueryClient): void {
  const node: ReactElement = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(node);
}

/**
 * 等到两个查询**都真的落到终态**（成功或失败），再断言标记。
 *
 * ⚠️ 两个必须守住的点（都踩过）：
 * ① 不能只等旧数据出现：降级数据在首帧就在（缓存是同步读的），
 *    那样会在请求还没失败时就断言，看到的是「还没报错」的中间态 → 假红。
 * ② **不能接受 `state === undefined`**：查询尚未注册时 `getQueryState` 返回
 *    `undefined`，若把它当「已落终态」放过，`waitFor` 会在第一次轮询就返回 ——
 *    于是「关掉真实服务」发生在首个请求还在路上时，那次请求必然失败，
 *    用例就退化成「第一次就失败」，再也验不到「先成功后失败」这条真实路径。
 */
async function waitSettled(client: QueryClient): Promise<void> {
  await waitFor(() => {
    for (const key of [MEALS_KEY, DASHBOARD_KEY]) {
      const state = client.getQueryState(key);
      expect(state).toBeDefined();
      expect(state?.status === 'error' || state?.status === 'success').toBe(true);
      expect(state?.fetchStatus).not.toBe('fetching');
    }
  });
}

/**
 * 断言「标记**已经**上屏」。
 *
 * ## 为什么需要它（不是装饰）
 *
 * 查询状态机落地**早于** React 把该结果 commit 到 DOM。全量跑（CPU 紧张）时这个间隙
 * 被放大：`③a` 与真实 HTTP 那两条曾**只在全量里偶发转红、单跑必绿**。
 * 所以「状态机已落终态」不足以支撑紧接着的同步 DOM 断言。
 *
 * ## 为什么这样写是安全的（不会把缺陷伪装成超时）
 *
 * ⚠️ 被测行为若**误渲染**（该出现时不出现），这里仍然会超时转红 —— 与直接断言的结果
 * 相同（都是红），只是形式变成超时。所以它只解决「渲染慢」这一个方向，
 * 不会掩盖缺陷、不构成假绿。
 *
 * 反过来，**否定断言**（`queryByTestId` 应为 `null`）不能用本函数：
 * 「还没渲染」与「真的没渲染」无法区分，用它会把真缺陷放过 —— 否定断言一律
 * 在**同一个正向断言已确认上屏之后**同步执行（见各用例）。
 */
async function expectNotice(testid: string): Promise<HTMLElement> {
  // `findBy*` 内部就是「轮询 + getBy」，语义与 `waitFor(() => getBy…)` 一致，
  // 但类型上直接给出 HTMLElement，不需要任何强制转换。
  return screen.findByTestId(testid);
}

/**
 * 纯否定用例（该标记**不该**出现）在 `waitSettled` 之后还需要一步：**把 React 冲干净**。
 *
 * ## 为什么
 *
 * 否定断言的陷阱是「还没渲染」与「真的没渲染」在断言那一刻长得一模一样。
 * 上屏某个元素可以当锚点（本文件用 `expectNotice`），但**纯否定**用例没有元素可等：
 * ⑦ 的两条标记都不出现，⑥ 同步成功时两条也不出现 —— 屏幕上没有任何东西
 * 能证明 React 已经处理完这一轮结果。
 *
 * 于是这里用 `act` 显式冲掉待处理的更新与 effect。这是**唯一**正确的锚点：
 * 它不检查任何 DOM 行为，因此不会把「缺陷导致的不出现」也一起冲掉 ——
 * 若被测行为误渲染成「本该不出现却出现了」，`act` 之后 DOM 里确实有它，断言照样转红。
 */
async function flushCommit(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** 把某个键重取一遍并等它落终态（用于「恢复后自动消失」的验证）。 */
async function refetchAndSettle(client: QueryClient, queryKey: readonly unknown[]): Promise<void> {
  await client.invalidateQueries({ queryKey: [...queryKey] });
  await waitSettled(client);
}

/** 按路径分派的 fetch 桩。 */
type Route = (url: string) => Response | Promise<Response>;

/** 默认路由：饮食 300 kcal / 看板有预算 / 体重空趋势。 */
function defaultRoutes(mealsKcal = 300, budget: DashboardResponse['budget'] = {
  intakeRecommended: DAILY_BUDGET,
  bmr: 1300,
  tdee: 2000,
}): Route {
  return (url: string) => {
    if (url.includes('/dashboard')) return ok(dashboardPayload(budget));
    if (url.includes('/weights')) return ok(WEIGHTS_PAYLOAD);
    return ok(mealsPayload(mealsKcal));
  };
}

/** 网络层失败（`fetch` 抛异常 —— 与 `lib/api.ts` 的 catch 分支同形）。 */
function throwNetworkFail(): never {
  throw new TypeError('Failed to fetch');
}

function stubFetch(route: Route): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => route(String(url))),
  );
}

/** 把本机缓存填成「上次成功同步的结果」。 */
function seedCaches(mealsKcal: number, budget: number | null = DAILY_BUDGET): void {
  cacheSet<ListMealsResponse>(CACHE_KEYS.meals(TODAY), mealsPayload(mealsKcal));
  if (budget !== null) {
    cacheSet<ThemeBudget>(CACHE_KEYS.localBudget, { intakeRecommended: budget, bmr: 1300, tdee: 2000 });
  }
}

beforeEach(() => {
  cacheClearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cacheClearAll();
});

describe('饮食记录旧数据标记 · mock 网络层失败', () => {
  it('① /meals 网络失败且本机有旧记录 → 旧记录照常渲染，并挂出「上次同步」标记 + 同屏可点重试', async () => {
    seedCaches(300);
    stubFetch((url) => {
      if (url.includes('/meals')) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 旧记录仍在（降级不打断使用）
    expect(screen.getByText('燕麦片')).toBeInTheDocument();
    expect(screen.getByText(/今天一共/)).toBeInTheDocument();
    // 标记出现（用 `expectNotice` 等它上屏：见该函数注释里「为什么需要它」）
    const notice = await expectNotice('diary-stale-meals-notice');
    expect(screen.getByText(STALE_TEXT)).toBeInTheDocument();
    // 出路必须同屏可达
    expect(within(notice).getByRole('button', { name: '重新试试' })).toBeInTheDocument();
    // 不该出现任何新数字（NFR-11：这轮不引入需要解释的数字）
    expect(notice.textContent).not.toMatch(/\d+\s*(分钟|小时|天)前/);
  });

  it('② /meals 网络失败但本机没有任何旧记录 → 不挂标记（没有数字展示，就不凭空指控）', async () => {
    stubFetch((url) => {
      if (url.includes('/meals')) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 纯否定：先冲干净 React，否则「还没渲染」会被当成「没渲染」而假绿
    await flushCommit();
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
  });

  it('③a 两条标记**互不牵连**：记录侧正常、看板侧失败 → 只出现预算那一条', async () => {
    // 合并成一条的后果：用户看到提示却不知道是「吃了多少」旧了还是「能吃多少」旧了。
    seedCaches(300);
    stubFetch((url) => {
      if (url.includes('/dashboard')) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // ⚠️ 顺序要紧：先确认预算那条**已上屏**，再同步断言记录那条不存在。
    // 反过来写（先断不存在）会把「记录标记只是渲染得慢」误判成通过 —— 那正是
    // 本用例在负载下偶发失败的原因（查询已落终态、commit 还没跟上）。
    const budgetNotice = await expectNotice('diary-stale-budget-notice');
    expect(screen.getByText(STALE_BUDGET_TEXT)).toBeInTheDocument();
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
  });

  it('③b 两条标记**互不牵连**：看板侧正常、记录侧失败 → 只出现记录那一条', async () => {
    seedCaches(300);
    stubFetch((url) => {
      if (url.includes('/meals')) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 记录那条在（等它上屏）
    const mealsNotice = await expectNotice('diary-stale-meals-notice');
    expect(mealsNotice).toBeInTheDocument();
    // 预算那条不在
    expect(screen.queryByTestId('diary-stale-budget-notice')).toBeNull();
  });

  it('④ /dashboard 网络失败且缓存里有预算 → 参考预算照常显示，并挂出预算那一条标记', async () => {
    seedCaches(300);
    stubFetch((url) => {
      if (url.includes('/dashboard')) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 兜底生效：预算数字确实在（页面上有分母）
    expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`参考预算 ${DAILY_BUDGET}`))).toBeInTheDocument();
    // 但必须告诉用户它是旧的
    const budgetNotice = await expectNotice('diary-stale-budget-notice');
    expect(within(budgetNotice).getByRole('button', { name: '重新试试' })).toBeInTheDocument();
    expect(budgetNotice.textContent).not.toMatch(/\d+\s*(分钟|小时|天)前/);
  });

  it('⑤ /dashboard 网络失败且**缓存里也没有预算** → 不渲染预算段，预算标记也不出现（不凭空指控）', async () => {
    // ⚠️ 这条守的是**渲染位置**：标记嵌在 `daily-budget` 块内部，
    // `dailyBudget === null` 时整块不渲染，标记自然无从出现。
    // 它**不**守 `showingStaleBudget` 里的某个布尔分支 —— 那个分支若被撤掉，本条仍会绿
    // （「注释承诺 vs 实际断言」自查时实测过）。所以下面两行断言都指向「屏幕上没有预算数字」
    // 这一个可观察事实，不暗示在守某个内部条件。
    seedCaches(300, null);
    stubFetch((url) => {
      if (url.includes('/dashboard')) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 纯否定：先冲干净 React（见 `flushCommit` 注释）
    await flushCommit();
    expect(screen.queryByTestId('daily-budget')).toBeNull();
    expect(screen.queryByTestId('diary-stale-budget-notice')).toBeNull();
    // 顺带钉住：预算那一句确实一个字符都没上屏
    expect(document.body.textContent ?? '').not.toContain('参考预算');
  });

  it('⑥ 同步成功 → 两条标记都不挂（新数据不该被说成旧的）', async () => {
    stubFetch(defaultRoutes(300));

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 先冲干净 React，纯否定断言才成立（见 `flushCommit` 注释）
    await flushCommit();
    expect(screen.getByText('燕麦片')).toBeInTheDocument();
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
    expect(screen.queryByTestId('diary-stale-budget-notice')).toBeNull();
  });

  it('⑦ 业务错误（500）→ 两条标记都不挂（不把服务端问题说成网络不稳）', async () => {
    seedCaches(300);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/meals') || String(url).includes('/dashboard')) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ data: null, error: { code: 'E_SERVER', message: '服务端在开小差' } }),
          } as Response;
        }
        return ok(WEIGHTS_PAYLOAD);
      }),
    );

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    await flushCommit();
    expect(screen.getByText('燕麦片')).toBeInTheDocument();
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
    expect(screen.queryByTestId('diary-stale-budget-notice')).toBeNull();
  });

  it('⑧ 点「重新试试」且重取成功后 → 对应那一条标记自动消失（出路真的有效）', async () => {
    seedCaches(300);
    let mealsOk = false;
    stubFetch((url) => {
      if (url.includes('/meals') && !mealsOk) return throwNetworkFail();
      return defaultRoutes()(url);
    });

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);
    const notice = await expectNotice('diary-stale-meals-notice');

    // 恢复：把桩换成成功，再点同屏那个「重新试试」
    mealsOk = true;
    await userEvent.click(within(notice).getByRole('button', { name: '重新试试' }));
    await waitFor(() => {
      expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
    });
  }, 20_000);
});

describe('饮食记录旧数据标记 · 真实 HTTP（连接被拒）', () => {
  /** 本用例起过的所有服务，afterEach 统一关掉，避免端口泄漏影响后续文件。 */
  const servers: Server[] = [];

/**
 * 真起一个返回完整三接口数据的 HTTP 服务，返回它的 base URL。
 *
 * ⚠️ 服务端必须吐**真的 JSON 响应体** `{ data, error: null }`（后端全局拦截器的形状），
 * 而不是把一个「仿 Response 对象」`JSON.stringify` 掉 —— 后者的 `json` 是函数，
 * 序列化后会被丢掉，`lib/api.ts` 拿不到 `data` 字段、返回 `undefined`，
 * 于是 react-query 抛 `"data is undefined"`。那个错与本用例要验的东西毫无关系，
 * 却会让用例退化成「第一次请求就失败」。
 *
 * ⚠️ 本用例刻意**不 mock fetch**：它的价值就在于请求真的走一遍 TCP。
 */
async function startServer(mealsKcal: number): Promise<string> {
  const created = createServer((req, res) => {
    const url = req.url ?? '';
    let data: unknown;
    if (url.includes('/dashboard')) {
      data = dashboardPayload({ intakeRecommended: DAILY_BUDGET, bmr: 1300, tdee: 2000 });
    } else if (url.includes('/weights')) {
      data = WEIGHTS_PAYLOAD;
    } else {
      data = mealsPayload(mealsKcal);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data, error: null }));
  });
  servers.push(created);
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  const address = created.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

  async function stopServer(target: Server): Promise<void> {
    target.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      target.close(() => resolve());
    });
  }

  /**
   * 把 `lib/api.ts` 发的相对路径（`/api/meals`）改写到真实服务的绝对地址。
   *
   * ⚠️ 用**模块加载时抓下来的原生 fetch**（`NATIVE_FETCH`），不能用「调用时的全局 fetch」：
   * ① `vi.stubGlobal('fetch', …)` 之后全局 `fetch` 就是桩本身，桩里再调 `fetch(...)`
   *    会无限自我递归（表现为「所有请求都失败」，恰好会掩盖真实行为）；
   * ② 更隐蔽的是第二次改写路由：那时抓到的「原生 fetch」其实已是上一个桩，
   *    于是新地址被拼到旧地址后面 → 请求永远打不到新服务，而测试会以为「重试没生效」。
   */
  function routeFetchTo(baseUrl: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        NATIVE_FETCH(`${baseUrl}${String(input)}`, init),
      ),
    );
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    cacheClearAll();
    await Promise.all(servers.splice(0).map((item) => stopServer(item)));
  });

  it('真实链路：先真连同步成功，服务停掉后重取失败 → 两条标记都出现，且能靠「重新试试」恢复', async () => {
    // 先把「上次成功同步的结果」放进本机缓存，模拟上一次会话留下的副本
    seedCaches(300);

    const firstUrl = await startServer(300);
    routeFetchTo(firstUrl);

    const client = newClient();
    renderDiary(client);
    await waitSettled(client);

    // 第一段：真实 HTTP 成功 → 两条标记都不该在
    // 先冲干净 React，第一段的纯否定断言才成立
    await flushCommit();
    expect(screen.getByText('燕麦片')).toBeInTheDocument();
    expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
    expect(screen.queryByTestId('diary-stale-budget-notice')).toBeNull();

    // 把真实服务关掉：此后请求会在**网络层**失败（ECONNREFUSED → fetch 抛 TypeError
    // → `lib/api.ts` 转成 E_NETWORK）。这是本用例不靠 mock 的核心价值：
    // 它验证的是真实失败链路，而不是我们「假设失败长什么样」。
    await stopServer(servers[0]!);
    await refetchAndSettle(client, MEALS_KEY);
    await refetchAndSettle(client, DASHBOARD_KEY);

    // 旧记录 + 旧预算都还在，且两条标记都出现（各等其上屏，见 `expectNotice`）
    expect(screen.getByText('燕麦片')).toBeInTheDocument();
    expect(screen.getByTestId('daily-budget')).toBeInTheDocument();
    const mealsNotice = await expectNotice('diary-stale-meals-notice');
    expect(screen.getByText(STALE_TEXT)).toBeInTheDocument();
    const budgetNotice = await expectNotice('diary-stale-budget-notice');
    expect(screen.getByText(STALE_BUDGET_TEXT)).toBeInTheDocument();

    // 出路验证：重新起一个真实服务 → 各点各的「重新试试」→ 对应标记消失
    const secondUrl = await startServer(450);
    routeFetchTo(secondUrl);

    await userEvent.click(within(mealsNotice).getByRole('button', { name: '重新试试' }));
    await waitFor(() => {
      expect(screen.queryByTestId('diary-stale-meals-notice')).toBeNull();
    });
    // 数字确实换成了新的：顶部「今天一共」与早餐那一行都变成 450
    expect(screen.getAllByText(/450/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/300/)).toBeNull();

    await userEvent.click(within(budgetNotice).getByRole('button', { name: '重新试试' }));
    await waitFor(() => {
      expect(screen.queryByTestId('diary-stale-budget-notice')).toBeNull();
    });
  }, 30_000);
});