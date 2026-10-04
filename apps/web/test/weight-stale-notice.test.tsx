/**
 * 体重页「这是上次同步时的数据」标记（pages/weight/WeightPage.tsx）。
 *
 * ## 这个测试在防什么
 *
 * 修复前：请求失败 → `allPoints` 静默退到本机缓存 → 曲线 / 均线 / 区间统计 /
 * 平台期斜率全部照常渲染，**页面上没有任何一个字说这些数字是旧的**。
 * 用户拿「十分钟前的体重」当「刚称的体重」做今天吃多少的决定。
 *
 * ## 为什么要有一条真实 HTTP 用例
 *
 * 这个缺陷的形状恰恰是「mock 出来的失败和成功长得一样」：
 * 若用 `vi.stubGlobal('fetch', ...)` 造失败，测试与被测行为**共享同一个假设**
 * —— 「失败 = `fetch` 抛异常」。一旦真实链路里失败以别的形态出现（例如返回
 * 一个无法 `JSON.parse` 的响应体、或连接被拒），mock 测试仍全绿而缺陷复现。
 * 故本文件保留一条真起 `node:http` 服务、真连接被拒（`ECONNREFUSED`）的用例：
 * 它不假设失败的形态，只断言「真实网络层失败时标记会出现，且用户能自救」。
 *
 * ## wait 锚点独立于被测行为
 *
 * 用例等的都是**前置条件**（查询状态机已落到终态）或**数据本身**，
 * 从不拿「标记出现了」当等待条件 —— 后者在被测行为误渲染时会超时，
 * 把「断言失败」伪装成「超时失败」，是假红而非真红。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { WeightTrendResponse } from '@qsh/shared-types';
import WeightPage from '@/pages/weight/WeightPage';
import { CACHE_KEYS, cacheClearAll, cacheSet } from '@/lib/local-cache';
import { clearPlateauVisibility } from '@/lib/plateau-visibility';
import { addDays, todayKey } from '@/lib/format';

/** 标记的主文案（与 WeightPage.tsx 里的 JSX 逐字对应）。 */
const STALE_TEXT = '这些是上次同步时的数据，网络恢复后会自动更新。';

/** 体重趋势查询键（与 `lib/queryClient.ts` 的 `queryKeys.weightTrend` 同值）。 */
const TREND_KEY = ['weights', 'trend'];

/**
 * 模块加载时抓下的**原生 fetch**（在任何 `vi.stubGlobal` 之前）。
 * 真实 HTTP 用例的转发桩必须调它 —— 见 `routeFetchTo` 处的注释。
 */
const NATIVE_FETCH = globalThis.fetch.bind(globalThis);

/** 造一份最小可用的趋势响应。 */
function trendPayload(weightKg: number): WeightTrendResponse {
  const points = [
    // 30 天前：落在默认 90 天区间内，一定会出现在「近期记录」里 → 可作断言锚点
    { date: addDays(todayKey(), -30), weightKg },
    { date: addDays(todayKey(), -1), weightKg: weightKg - 0.2 },
  ];
  return {
    points,
    movingAverage7: points.map((point) => ({ date: point.date, value: point.weightKg })),
    stats: { minKg: weightKg - 0.2, maxKg: weightKg, latestKg: weightKg - 0.2, changeKg: -0.2 },
    forecast: [],
    goalProgress: null,
  };
}

function renderWeightPage(client: QueryClient): void {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WeightPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 每条用例独立的 QueryClient（`retry: false` 让网络层失败立刻落地，不拖重试）。 */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 30 * 60_000, staleTime: 30_000, networkMode: 'offlineFirst' },
    },
  });
}

/**
 * 等到体重查询**真的落到终态**（成功或失败）且不再fetch 中，再断言标记。
 *
 * ⚠️ 不能只等旧数据行出现：降级数据在首帧就在（缓存是同步读的），
 * 那样会在请求还没失败时就断言，看到的是「还没报错」的中间态 → 假红。
 */
async function waitTrendSettled(client: QueryClient): Promise<void> {
  await waitFor(() => {
    const state = client.getQueryState(TREND_KEY);
    expect(state === undefined || state.status === 'error' || state.status === 'success').toBe(true);
    expect(state?.fetchStatus).not.toBe('fetching');
  });
}

/** 造一个「成功」的 fetch 桩（正例：同步成功时不挂标记）。 */
function stubOkFetch(data: WeightTrendResponse): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data, error: null }),
    })),
  );
}

/** 造一个「网络层失败」的 fetch 桩（`fetch` 抛异常 —— 与 `lib/api.ts` 的 catch 分支同形）。 */
function stubNetworkFailFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
}

describe('WeightPage 旧数据标记：mock 网络层失败', () => {
  beforeEach(() => {
    cacheClearAll();
    clearPlateauVisibility();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求失败且本机有旧数据 → 旧体重照常渲染，并挂出「上次同步」的标记', async () => {
    // 先把「上次成功同步的结果」放进本机缓存（模拟上一次会话留下的副本）
    cacheSet(CACHE_KEYS.weightPoints, trendPayload(70).points);
    stubNetworkFailFetch();

    const client = newClient();
    renderWeightPage(client);
    await waitTrendSettled(client);

    // 旧数据仍在（降级不打断使用）
    expect(screen.getByText('70.0 kg')).toBeDefined();
    expect(screen.getByTestId('weight-stale-notice')).toBeInTheDocument();
    expect(screen.getByText(STALE_TEXT)).toBeInTheDocument();
    // 出路必须同屏可达
    expect(screen.getByRole('button', { name: '重新试试' })).toBeInTheDocument();
    // 不该出现任何新数字（NFR-11：这轮不引入需要解释的数字）
    expect(screen.getByTestId('weight-stale-notice').textContent).not.toMatch(/\d+\s*(分钟|小时|天)前/);
  });

  it('请求失败但本机没有任何旧数据 → 不挂标记（没有数字展示，就不凭空指控）', async () => {
    stubNetworkFailFetch();

    const client = newClient();
    renderWeightPage(client);
    await waitTrendSettled(client);

    expect(screen.getByText('还没有记录')).toBeDefined();
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
  });

  it('同步成功 → 不挂标记（新数据不该被说成旧的）', async () => {
    stubOkFetch(trendPayload(70));

    const client = newClient();
    renderWeightPage(client);
    await waitTrendSettled(client);

    expect(screen.getByText('70.0 kg')).toBeDefined();
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
  });

  it('业务错误（如 500）→ 不挂「网络不稳定」标记（不把服务端问题说成网络问题）', async () => {
    cacheSet(CACHE_KEYS.weightPoints, trendPayload(70).points);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ data: null, error: { code: 'E_SERVER', message: '服务端在开小差' } }),
      })),
    );

    const client = newClient();
    renderWeightPage(client);
    await waitTrendSettled(client);

    expect(screen.getByText('70.0 kg')).toBeDefined();
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
  });
});

describe('WeightPage 旧数据标记：真实 HTTP（连接被拒）', () => {
  /** 本用例起过的所有服务，afterEach 统一关掉，避免端口泄漏影响后续文件。 */
  const servers: Server[] = [];

  /** 真起一个返回趋势数据的 HTTP 服务，返回它的 base URL。 */
  async function startServer(weightKg: number): Promise<string> {
    const created = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: trendPayload(weightKg), error: null }));
    });
    servers.push(created);
    await new Promise<void>((resolve) => {
      created.listen(0, '127.0.0.1', resolve);
    });
    const address = created.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** 关掉某个服务（保留在 `servers` 里由 afterEach 兜底 close 幂等）。 */
  async function stopServer(target: Server): Promise<void> {
    target.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      target.close(() => resolve());
    });
  }

  /**
   * 把 `lib/api.ts` 发的相对路径（`/api/weights`）改写到真实服务的绝对地址。
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

  beforeEach(() => {
    cacheClearAll();
    clearPlateauVisibility();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(servers.splice(0).map((item) => stopServer(item)));
  });

  it('真实链路：先真连同步成功，服务停掉后重取失败 → 标记出现，且能靠「重新试试」恢复', async () => {
    const firstUrl = await startServer(70);
    routeFetchTo(firstUrl);

    const client = newClient();
    renderWeightPage(client);
    await waitTrendSettled(client);

    // 第一段：真实 HTTP 成功 → 不该挂标记
    expect(screen.getByText('70.0 kg')).toBeDefined();
    expect(screen.queryByTestId('weight-stale-notice')).toBeNull();

    // 把真实服务关掉：此后请求会在**网络层**失败（ECONNREFUSED → fetch 抛 TypeError
    // → `lib/api.ts` 转成 E_NETWORK）。这是本用例不靠 mock 的核心价值：
    // 它验证的是真实失败链路，而不是我们「假设失败长什么样」。
    await stopServer(servers[0]!);

    await client.invalidateQueries({ queryKey: TREND_KEY });
    await waitTrendSettled(client);

    // 旧数据仍在 + 标记出现
    expect(screen.getByText('70.0 kg')).toBeInTheDocument();
    expect(screen.getByTestId('weight-stale-notice')).toBeInTheDocument();
    expect(screen.getByText(STALE_TEXT)).toBeInTheDocument();

    // 出路验证：重新起一个真实服务 → 点「重新试试」→ 标记消失、数字更新
    const secondUrl = await startServer(66);
    routeFetchTo(secondUrl);

    await userEvent.click(screen.getByRole('button', { name: '重新试试' }));
    await waitFor(() => {
      expect(screen.queryByTestId('weight-stale-notice')).toBeNull();
    });
    expect(screen.getByText('66.0 kg')).toBeInTheDocument();
  }, 20_000);
});