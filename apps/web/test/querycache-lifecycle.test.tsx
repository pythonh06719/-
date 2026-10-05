/**
 * react-query 缓存的生命周期（护栏测试）。
 *
 * ## 背景：本机数据是**两层**
 *
 * | 层 | 存放 | 典型清除者 |
 * |---|---|---|
 * | localStorage 副本（`qsh:cache:*` + 偏好键） | 浏览器 | `cacheClearAll()` / `useAuthStore.clear()` |
 * | **react-query 内存缓存**（档案 / 体重 / 看板 / 预算） | 内存 | `queryClient.clear()` / `invalidateQueries` |
 *
 * 此前只清了第一层：换账号、一键清数据、401 之后，内存里上一个账号的档案与看板仍在
 * （`gcTime` 30 分钟内不重取），屏上显示的还是旧账号的数字。
 *
 * ## 本文件钉死的行为
 *
 * ① 401（`UNAUTHORIZED_EVENT`）→ 内存缓存被清空；
 * ② 「我的」页退出登录 → 内存缓存被清空；
 * ③ `/settings/data` 一键清除数据 → 内存缓存被清空；
 * ④ ★ 改基础资料 → `profile` / `['dashboard']` / `['weights']` 被**真的重取**
 *    （「预算已经重新算好」这句承诺在屏幕上兑现）；
 * ⑤ 恢复 JSON 备份 → 档案 / 记录类查询被失效（承诺「档案、目标和设置会采用备份内容」）；
 * ⑥ CSV 导入历史体重 → 体重趋势被失效；
 * ⑦ 完成引导 → `profile` / `['dashboard']` 被失效（跳到看板不停在「去做引导问卷」空态）。
 *
 * ## 测试工装上的两条纪律
 *
 * - **失效与否用「探针真的重取」来判定**，而不是看代码有没有写 `invalidateQueries`：
 *   探针是一个**已挂载**的 `useQuery`（`invalidateQueries` 默认只重取 active 查询，
 *   未挂载的键静默失效、不可观测）。计数从 0 → ≥1 即证明失效生效。
 * - `fetch` 桩**只对 `/api/*` 作答**，其余转发给**模块加载时**抓到的原生 fetch
 *   （`NATIVE_FETCH`）。若在桩内部再取 `globalThis.fetch`，拿到的会是当前这个桩
 *   → 自我递归，表现为「所有请求都失败」，恰好把真实行为掩盖掉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import App from '@/App';
import ProfilePage from '@/pages/profile/ProfilePage';
import SettingsDataPage from '@/pages/settings-data/SettingsDataPage';
import BackupRestoreCard from '@/pages/settings-data/BackupRestoreCard';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';
import { UNAUTHORIZED_EVENT } from '@/lib/api';
import { queryClient, queryKeys } from '@/lib/queryClient';
import { useAuthStore } from '@/lib/auth.store';
import { cacheClearAll } from '@/lib/local-cache';
import { __resetMemoryQueueForTest, clearQueuedRequests } from '@/pwa/offline-queue';

/**
 * 模块加载时的原生 fetch（见文件头注释）。
 *
 * ⚠️ 必须是**模块加载时**抓的引用，不能在运行期取 `globalThis.fetch`（那时它是桩本身）。
 */
const NATIVE_FETCH: typeof globalThis.fetch | undefined = globalThis.fetch;

// ---------------------------------------------------------------------------
// 桩：download（文件读取 / 落盘）—— 这两个页面都靠它读用户选择的文件
// ---------------------------------------------------------------------------

vi.mock('@/lib/download', () => ({
  downloadTextFile: vi.fn(),
  downloadExportBundle: vi.fn(),
  readTextFile: vi.fn(),
}));

// eslint-disable-next-line import/first
import { readTextFile } from '@/lib/download';

/** 用 vi.fn 的视角使用被 mock 的 `readTextFile`。 */
const mockedReadTextFile = readTextFile as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// 桩：fetch
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** 响应解析：按 URL 片段给数据；返回 `undefined` 表示空数据。 */
type Resolver = (url: string, method: string, body: unknown) => unknown;

function installFetch(resolver: Resolver): Call[] {
  const calls: Call[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    if (!url.includes('/api/')) {
      // 非业务请求（blob: / data: 等）交给原生 fetch —— 见文件头「两条纪律」。
      if (typeof NATIVE_FETCH !== 'function') {
        throw new Error(`未桩的请求：${url}`);
      }
      return NATIVE_FETCH(input as RequestInfo, init);
    }

    return { ok: true, status: 200, json: async () => ({ data: resolver(url, method, body), error: null }) };
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

/** 计数某个方法的请求（按 URL 片段过滤）。 */
function countCalls(calls: Call[], method: string, urlFragment: string): number {
  return calls.filter((call) => call.method === method && call.url.includes(urlFragment)).length;
}

// ---------------------------------------------------------------------------
// 探针：把「失效」变成可观测的「真的重取了一次」
// ---------------------------------------------------------------------------

interface RefetchCounter {
  n: number;
}

/**
 * 缓存探针：以给定 `queryKey` 挂一个 `useQuery`。
 *
 * 由于 `invalidateQueries` 默认只重取 **active** 查询，未挂载的键即使被标记失效也
 * 观察不到（会写成一条恒为真的假绿断言）。这里让它真正挂载，重取次数即为证据。
 */
function CacheProbe({
  queryKey,
  counter,
}: {
  queryKey: readonly unknown[];
  counter: RefetchCounter;
}): ReactElement {
  useQuery({
    queryKey: queryKey as QueryKey,
    queryFn: async () => {
      counter.n += 1;
      return `fetched-${counter.n}`;
    },
  });
  return <span data-testid="cache-probe" />;
}

/** 新建计数器（初始值固定为 0，避免「未定义」被当成没重取）。 */
function newCounter(): RefetchCounter {
  return { n: 0 };
}

/** 等探针被重取（正向断言：0 → ≥1）。 */
async function expectRefetched(counter: RefetchCounter, label: string): Promise<void> {
  await waitFor(
    () => expect(counter.n, `${label} 未被重取（invalidateQueries 没生效）`).toBeGreaterThan(0),
    { timeout: 3000 },
  );
}

// ---------------------------------------------------------------------------
// 桩数据
// ---------------------------------------------------------------------------

const TODAY = '2026-09-12';

/** 旧档案（改基础资料**之前**的预算：建议摄入 1500）。 */
const PROFILE_OLD = {
  profile: {
    gender: 'female',
    birthDate: '1995-01-01',
    heightCm: 165,
    activityLevel: 'sedentary',
    dietaryPreference: [],
    conditions: [],
  },
  goal: { startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 },
  budget: { intakeRecommended: 1500, bmr: 1180, tdee: 1420 },
};

/** 新档案（服务端重算后的预算：建议摄入 1600）。 */
const PROFILE_NEW = {
  ...PROFILE_OLD,
  profile: { ...PROFILE_OLD.profile, heightCm: 180 },
  budget: { intakeRecommended: 1600, bmr: 1260, tdee: 1510 },
};

/** 未引导（无目标无预算）—— 看板空态的判定指纹。 */
const PROFILE_EMPTY = { profile: null, goal: null, budget: null, warnings: [] };

/** 未引导时的看板载荷（`goal === null && budget === null`）。 */
const DASHBOARD_EMPTY = { date: TODAY, goal: null, budget: null, intakeKcal: 0, warnings: [] };

const WEIGHT_TREND_OLD = [{ date: '2026-09-10', weightKg: 60.2 }];

const RESTORE_PREVIEW = {
  previewToken: 'preview-token-a',
  schemaVersion: 2,
  counts: { weights: 2, meals: 3, exercises: 1, habits: 4, water: 5, wins: 2 },
  dateRange: { from: '2026-08-01', to: '2026-09-12' },
  mergeStrategy: 'same-day-replace',
};

const RESTORE_RESULT = {
  restored: { weights: 2, meals: 3, exercises: 1, habits: 4, water: 5, wins: 2 },
  dateRange: { from: '2026-08-01', to: '2026-09-12' },
  mergeStrategy: 'same-day-replace',
};

// ---------------------------------------------------------------------------
// 渲染助手
// ---------------------------------------------------------------------------

/**
 * 用**模块级单例** `queryClient` 作为 provider 的客户端。
 *
 * 生产里 `main.tsx` 注入 provider 的正是这个单例，所以页面内直接引用单例
 * （`queryClient.clear()` / `invalidateQueries`）与 provider 里那份是同一个对象；
 * 测试里两边必须也指向同一份，否则断言的是另一个缓存、恒为假绿。
 */
function renderWithClient(node: ReactElement): ReturnType<typeof render> {
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

/** 读取「当前热量预算」卡里的「建议摄入」值。 */
function recommendedIntake(): string {
  const dt = screen.queryByText('建议摄入');
  const dd = dt?.parentElement?.querySelector('dd');
  return (dd?.textContent ?? '').trim();
}

// ---------------------------------------------------------------------------
// 生命周期钩子
// ---------------------------------------------------------------------------

beforeEach(async () => {
  window.localStorage.clear();
  cacheClearAll();
  // 单例缓存归零：用例之间不互相污染（否则上一例的 `setQueryData` 会流到下一例）
  queryClient.clear();
  useAuthStore.setState({
    accessToken: null,
    user: null,
    onboardingCompleted: false,
    status: 'anonymous',
  });
  __resetMemoryQueueForTest();
  await clearQueuedRequests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});

afterEach(async () => {
  // 冲掉可能仍在路上的更新，避免「还没渲染」被读成「没渲染」
  await act(async () => {});
});

// ---------------------------------------------------------------------------
// ① 401 → 清空内存缓存
// ---------------------------------------------------------------------------

describe('401 自动登出 · react-query 内存缓存', () => {
  it('★ 收到 UNAUTHORIZED_EVENT 后内存缓存被清空（换账号不看到上一个账号的数字）', async () => {
    installFetch(() => PROFILE_OLD);
    queryClient.setQueryData(queryKeys.profile as QueryKey, PROFILE_OLD);
    queryClient.setQueryData(queryKeys.weightTrend as QueryKey, WEIGHT_TREND_OLD);
    expect(queryClient.getQueryData(queryKeys.weightTrend as QueryKey)).not.toBeUndefined();

    renderWithClient(<App />);
    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    });

    // 断言口径刻意选**没有观察者**的 `weightTrend`：它不会被「清空后立刻重取」重新填上，
    // 于是「缓存真的被移除」这件事是确定的（而不是在等一个会被回填的键变 undefined）。
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.weightTrend as QueryKey)).toBeUndefined(),
    );
  });
});

// ---------------------------------------------------------------------------
// ② 退出登录 → 清空内存缓存
// ---------------------------------------------------------------------------

describe('退出登录 · react-query 内存缓存', () => {
  it('★ 点「退出登录」后内存缓存被清空（localStorage 之外的第二层）', async () => {
    installFetch(() => PROFILE_OLD);
    useAuthStore.setState({ accessToken: 'token-a', status: 'authenticated' });
    queryClient.setQueryData(queryKeys.profile as QueryKey, PROFILE_OLD);
    queryClient.setQueryData(queryKeys.weightTrend as QueryKey, WEIGHT_TREND_OLD);

    renderWithClient(
      <MemoryRouter>
        <ProfilePage />
      </MemoryRouter>,
    );

    const logout = await screen.findByRole('button', { name: '退出登录' });
    await act(async () => {
      fireEvent.click(logout);
    });

    // 口径同 ①：取没有观察者的 `weightTrend`，避开「清完立刻被重取回填」的竞态
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.weightTrend as QueryKey)).toBeUndefined(),
    );
    // 登录态同步归零（既有行为不被本轮改动破坏）
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ 一键清除数据 → 清空内存缓存
// ---------------------------------------------------------------------------

describe('一键清除数据 · react-query 内存缓存', () => {
  it('★ 「删除我的全部数据」确认后内存缓存被清空', async () => {
    installFetch(() => ({ deleted: true }));
    queryClient.setQueryData(queryKeys.profile as QueryKey, PROFILE_OLD);
    queryClient.setQueryData(queryKeys.weightTrend as QueryKey, WEIGHT_TREND_OLD);

    renderWithClient(
      <MemoryRouter>
        <SettingsDataPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除我的全部数据' }));
    const confirm = await screen.findByRole('button', { name: '确认删除' });
    await act(async () => {
      fireEvent.click(confirm);
    });

    // 正向锚点：删除结果提示上屏（不是首帧就存在的元素）
    await screen.findByText('你的数据已经从本机移除。感谢这段日子的使用。');
    // 口径同 ①：取没有观察者的 `weightTrend`
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.weightTrend as QueryKey)).toBeUndefined(),
    );
  });
});

// ---------------------------------------------------------------------------
// ④ ★ 改基础资料后预算真的重取（「已经重新算好」不是空话）
// ---------------------------------------------------------------------------

describe('改基础资料 · 预算派生数据重取', () => {
  it('★ 保存后屏上的「建议摄入」变成服务端重算值，且看板 / 体重进度被重取', async () => {
    const calls = installFetch(() => PROFILE_NEW);
    queryClient.setQueryData(queryKeys.profile as QueryKey, PROFILE_OLD);
    queryClient.setQueryData(queryKeys.dashboard(TODAY) as QueryKey, {
      date: TODAY,
      budget: PROFILE_OLD.budget,
    });
    queryClient.setQueryData(queryKeys.weightTrend as QueryKey, WEIGHT_TREND_OLD);

    const dashboardRefetch = newCounter();
    const weightsRefetch = newCounter();

    renderWithClient(
      <MemoryRouter>
        <ProfilePage />
        <CacheProbe queryKey={queryKeys.dashboard(TODAY)} counter={dashboardRefetch} />
        <CacheProbe queryKey={queryKeys.weightTrend} counter={weightsRefetch} />
      </MemoryRouter>,
    );

    // 前提：缓存是旧的（30 秒 staleTime 内不重取 —— 这正是缺陷得以出现的前提）
    await waitFor(() => expect(recommendedIntake()).toBe('1500 kcal'));
    await act(async () => {});
    expect(countCalls(calls, 'GET', '/api/profile')).toBe(0);
    expect(dashboardRefetch.n).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '保存并重新计算' }));

    // 承诺兑现：屏幕上的数字真的变了（不是只有一句提示语）
    await waitFor(() => expect(recommendedIntake()).toBe('1600 kcal'));
    expect(countCalls(calls, 'PATCH', '/api/profile')).toBe(1);
    expect(countCalls(calls, 'GET', '/api/profile')).toBe(1);

    // 派生视图同样被重取（看板「建议摄入」与「变化」页的体重进度）
    await expectRefetched(dashboardRefetch, "['dashboard']");
    await expectRefetched(weightsRefetch, "['weights']");
  });
});

// ---------------------------------------------------------------------------
// ⑤ 恢复 JSON 备份 → 档案 / 记录类查询失效
// ---------------------------------------------------------------------------

describe('恢复 JSON 备份 · 失效集合', () => {
  it('★ 合并成功后档案与看板被重取（不用手动刷新才看得到）', async () => {
    installFetch((url) => {
      if (url.includes('/data/restore/preview')) return RESTORE_PREVIEW;
      if (url.includes('/data/restore')) return RESTORE_RESULT;
      return undefined;
    });
    mockedReadTextFile.mockResolvedValue('{"meta":{}}');

    queryClient.setQueryData(queryKeys.profile as QueryKey, PROFILE_OLD);
    queryClient.setQueryData(queryKeys.dashboard(TODAY) as QueryKey, DASHBOARD_EMPTY);

    const profileRefetch = newCounter();
    const dashboardRefetch = newCounter();

    renderWithClient(
      <>
        <BackupRestoreCard />
        <CacheProbe queryKey={queryKeys.profile} counter={profileRefetch} />
        <CacheProbe queryKey={queryKeys.dashboard(TODAY)} counter={dashboardRefetch} />
      </>,
    );

    fireEvent.change(screen.getByLabelText('选择 JSON 备份文件'), {
      target: { files: [new File(['{}'], 'backup.json', { type: 'application/json' })] },
    });
    await screen.findByTestId('restore-preview');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认合并这份备份' }));
    });
    await screen.findByTestId('restore-result');

    await expectRefetched(profileRefetch, 'profile');
    await expectRefetched(dashboardRefetch, "['dashboard']");
  });
});

// ---------------------------------------------------------------------------
// ⑥ CSV 导入历史体重 → 体重趋势失效
// ---------------------------------------------------------------------------

describe('CSV 导入历史体重 · 失效集合', () => {
  it('★ 导入成功后体重趋势被重取（曲线不再停在导入前）', async () => {
    installFetch((url) =>
      url.includes('/data/import/weights')
        ? { imported: 2, skipped: 0, errors: [] }
        : undefined,
    );
    mockedReadTextFile.mockResolvedValue(
      ['date,weightKg,note', '2026-07-01,65.2,', '2026-07-02,65,早上'].join('\n'),
    );

    queryClient.setQueryData(queryKeys.weightTrend as QueryKey, WEIGHT_TREND_OLD);
    const weightsRefetch = newCounter();

    renderWithClient(
      <MemoryRouter>
        <SettingsDataPage />
        <CacheProbe queryKey={queryKeys.weightTrend} counter={weightsRefetch} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('选择 CSV 文件'), {
      target: { files: [new File(['x'], 'weights.csv', { type: 'text/csv' })] },
    });

    // 正向锚点：导入结果提示上屏（不是首帧就存在的元素）
    await screen.findByText(/导入完成/);
    await expectRefetched(weightsRefetch, "['weights']");
  });
});

// ---------------------------------------------------------------------------
// ⑦ 完成引导 → profile / dashboard 失效（跳到看板不停在空态）
// ---------------------------------------------------------------------------

describe('完成引导 · 失效集合', () => {
  it('★ 提交引导后 profile 与 dashboard 被重取（看板不再停在「去做引导问卷」）', async () => {
    const calls = installFetch((url) => (url.includes('/onboarding') ? PROFILE_NEW : undefined));

    queryClient.setQueryData(queryKeys.profile as QueryKey, PROFILE_EMPTY);
    queryClient.setQueryData(queryKeys.dashboard(TODAY) as QueryKey, DASHBOARD_EMPTY);

    const profileRefetch = newCounter();
    const dashboardRefetch = newCounter();

    renderWithClient(
      <MemoryRouter>
        <OnboardingPage />
        <CacheProbe queryKey={queryKeys.profile} counter={profileRefetch} />
        <CacheProbe queryKey={queryKeys.dashboard(TODAY)} counter={dashboardRefetch} />
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '我已了解，开始填写' }));
    await user.click(screen.getByRole('button', { name: '看看我的预算' }));
    await user.click(screen.getByRole('button', { name: '保存并进入今日看板' }));

    // 正向锚点：引导确实提交成功了（否则后面的失效断言无从谈起）
    await waitFor(() => expect(countCalls(calls, 'POST', '/api/onboarding')).toBe(1));
    await expectRefetched(profileRefetch, 'profile');
    await expectRefetched(dashboardRefetch, "['dashboard']");
  });
});
