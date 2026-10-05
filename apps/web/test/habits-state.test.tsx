/**
 * 习惯页两处缺陷的回归保护（`pages/habits/HabitsPage.tsx`）。
 *
 * ## 缺陷 1（P0）：请求失败 == 「还没有习惯」
 *
 * `habits = habitsQuery.data?.habits ?? []`，请求失败时 `data` 为 undefined → `habits` 退回 `[]`；
 * 而当时的 `useQuery` 只取了 `data`，页面里**没有任何 `isError` 分支** ——
 * 于是「加载 / 出错 / 真空」三态挤在同一个判据 `habits.length === 0` 上。
 * 后果：一次 500 或一次断网，`/habits` 就对用户说「还没有习惯，从下面加一个开始吧」，
 * **把「我没把数据取回来」说成「你还没开始」**。
 *
 * 本文件要求：出错时必须出现**失败专属**的区块（含可点的「重新试试」），
 * 且**绝不能**同时出现「还没有习惯」那句（那正是缺陷的正身）。
 *
 * ## 缺陷 2（P1）：连续天数被 `aria-label` 吞掉
 *
 * 打卡 `<button>` 有显式 `aria-label`，而「当前连续 N 天 · 历史最佳 M 天」是它的**后代**。
 * 按 accname 规范，`aria-label` **覆盖全部后代文本** → 读屏用户完全拿不到这两个数。
 * 本文件按本仓判据验收：先把信息并进 `aria-label`，可见副本才 `aria-hidden`。
 *
 * ## 等待锚点独立于被测行为
 *
 * - 正向断言一律用 `findBy*` / `waitFor` 真的等上屏；
 * - **否定类断言（某元素不该出现）必须先用 `act` 冲掉待处理的 React 更新**再查。
 *   否则「没渲染」可能只是「还没渲染完成」，测试什么也没证明（装饰性等待）。
 *   具体做法见 `flushAll()`：它把宏任务队列跑干，再同步查询 DOM。
 *
 * ## 返工时的检查清单
 *
 * - 删掉 `isError` 分支 → 「500 → 错误区块」与「500 → 的不是空状态」两条必须同时转红；
 * - 把 `isError` 的判据改回 `habits.length === 0` → 上面的失败用例必须转红；
 * - 从 aria-label 里拿掉连续/最佳 → ARIA 三条必须同时转红。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import HabitsPage from '@/pages/habits/HabitsPage';
import { todayKey } from '@/lib/format';

/** `GET /habits` 的单个习惯（与后端 `HabitWithStats` 同形）。 */
interface HabitFixture {
  id: number;
  code: string;
  name: string;
  icon: string | null;
  targetPerDay: number;
  isActive: boolean;
  isBuiltin: boolean;
  doneToday: boolean;
  currentStreak: number;
  bestStreak: number;
  recentDates: string[];
}

/** 页面上的新增文案（HabitsPage.tsx 内的局部常量，抄在这里是为了用例可读、不再去读源码）。 */
const LOAD_ERROR_TEXT = '这一页暂时读不到你的习惯，稍后再来看看就好';
const LOAD_RETRY_TEXT = '重新试试';
const LOADING_TEXT = '正在取回你的习惯…';
const EMPTY_TEXT = '还没有习惯，从下面加一个开始吧';

function habit(overrides: Partial<HabitFixture> & { id: number; name: string }): HabitFixture {
  return {
    code: `code_${overrides.id}`,
    icon: '💧',
    targetPerDay: 1,
    isActive: true,
    isBuiltin: false,
    doneToday: false,
    currentStreak: 0,
    bestStreak: 0,
    recentDates: [],
    ...overrides,
  };
}

/** 200 响应。 */
function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as unknown as Response;
}

/** `GET /habits` 永久 500。 */
function stubHabitsServerError(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 500,
    json: async () => ({ data: null, error: { code: 'E_INTERNAL', message: '服务端在开小差' } }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** `GET /habits` 直接断（网络层抛错，`isNetworkError` 为真）。 */
function stubHabitsNetworkDown(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** `GET /habits` 成功返回 `habits`。 */
function stubHabitsOk(habits: HabitFixture[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/habits')) {
      return ok({ today: todayKey(), habits });
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HabitsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/**
 * 把待处理的 React 更新全部冲掉（宏任务 + 效果 + 由 promise 触发的重渲染）。
 *
 * ⚠️ 只用于**否定类断言之前**：要证明「某元素不在」就必须先给 React 全部机会把它渲染出来，
 * 否则我们证明的只是「还没轮到它渲染」。 `await waitFor(() => {})` 不够 —— 它只等一个 tick。
 */
async function flushAll(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('P0 · 请求失败 ≠ 还没有习惯', () => {
  it('★ 500 → 显示失败专属区块（含「重新试试」），且不出现「还没有习惯」', async () => {
    stubHabitsServerError();
    renderPage();

    const box = await screen.findByTestId('habits-load-error');
    expect(within(box).getByText(LOAD_ERROR_TEXT)).toBeInTheDocument();

    // 缺陷正身：失败时不得以「空」的措辞上屏
    await flushAll();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.queryByText(LOADING_TEXT)).toBeNull();
  });

  it('★ 断网 → 同样是失败区块，不是「还没有习惯」', async () => {
    stubHabitsNetworkDown();
    renderPage();

    expect(await screen.findByTestId('habits-load-error')).toBeInTheDocument();
    await flushAll();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

});

/**
 * 三态互斥 —— 用**三个独立用例**而不是「一个用例里连渲三次」来验证。
 *
 * ⚠️ 曾经踩过的坑：在同一个用例里 `render → unmount → render` 相邻渲染之间 DOM 会互相污染
 * （前一个 QueryClient 的最后一帧还没 flush 掉），于是「第三个不存在某个元素」这类断言
 * 可能查到的是**上一个树**的残留 —— 那样的断言什么也没证明。
 * 拆成独立用例后，每个用例都由 RTL 的 cleanup 保证干净。
 */
describe('P0 · 三态互斥（加载 / 失败 / 真·空 各自独占屏幕）', () => {
  /** 加载中：fetch 永不 settle。 */
  function renderPending(): void {
    const gate = new Promise<void>(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return ok({ today: todayKey(), habits: [] });
      }),
    );
    renderPage();
  }

  it('加载中只有「正在取回」，不闪空态、不提前报错', async () => {
    renderPending();

    expect(await screen.findByText(LOADING_TEXT)).toBeInTheDocument();
    await flushAll();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.queryByTestId('habits-load-error')).toBeNull();
  });

  it('失败时有失败区块、没有空态、也没有加载文案', async () => {
    stubHabitsServerError();
    renderPage();

    expect(await screen.findByTestId('habits-load-error')).toBeInTheDocument();
    await flushAll();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.queryByText(LOADING_TEXT)).toBeNull();
  });

  it('200 且确实零条 → 才有「还没有习惯」，且既无加载文案也无失败区块', async () => {
    stubHabitsOk([]);
    renderPage();

    expect(await screen.findByText(EMPTY_TEXT)).toBeInTheDocument();
    await flushAll();
    expect(screen.queryByTestId('habits-load-error')).toBeNull();
    expect(screen.queryByText(LOADING_TEXT)).toBeNull();
  });
});

describe('P0 · 失败态的出路：「重新试试」真的重取', () => {
  it('点「重新试试」→ 重发一次 GET /habits；成功后失败区块消失、习惯列表出现', async () => {
    const fetchMock = stubHabitsServerError();
    renderPage();

    await screen.findByTestId('habits-load-error');
    // 成功只要还在触发 mutate/invalidate 就会再打请求，这里换成「下一次就成功」
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/habits')) {
        return ok({ today: todayKey(), habits: [habit({ id: 7, name: '睡前拉伸' })] });
      }
      return ok(null);
    });

    const before = fetchMock.mock.calls.length;
    const user = userEvent.setup();
    await user.click(screen.getByTestId('habits-load-retry'));

    // 等待失败区块真的消失 —— 这是「成功后自动消失」的正身，不能用 flush 糊过去
    await waitFor(() => {
      expect(screen.queryByTestId('habits-load-error')).toBeNull();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(await screen.findByTestId('habit-check-7')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it('已经有习惯可列时不再叠一条「读不到」（实实在在列出来了就别说没读到）', async () => {    // 首次成功 → 列表上屏；随后 refetch 失败（`data` 被保留，只有 `isError` 转真）。
    // 此时再叠一条「读不到你的习惯」就与屏幕上正在显示的列表自相矛盾。
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls += 1;
        if (url.includes('/api/habits') && calls === 1) {
          return ok({ today: todayKey(), habits: [habit({ id: 1, name: '喝水' })] });
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ data: null, error: { code: 'E_INTERNAL', message: 'boom' } }),
        };
      }),
    );
    const client = renderPage();
    await screen.findByTestId('habit-check-1');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['habits'] });
    });
    await flushAll();

    expect(screen.getByTestId('habit-check-1')).toBeInTheDocument();
    expect(screen.queryByTestId('habits-load-error')).toBeNull();
    // 这条是 P0 的下限：任何失败形态下都不能说「你还没有习惯」
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it('已经是失败态时再点「重新试试」仍然失败 → 停回失败区块，不会退化成空状态', async () => {
    const fetchMock = stubHabitsServerError();
    renderPage();

    const user = userEvent.setup();
    await screen.findByTestId('habits-load-error');
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getByTestId('habits-load-retry'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });
    // 重取仍失败 → 用户看到的还是「读不到 + 可以再试一次」，不是「你还没有习惯」
    expect(await screen.findByTestId('habits-load-error')).toBeInTheDocument();
    expect(await screen.findByText(LOAD_RETRY_TEXT)).toBeInTheDocument();
    await flushAll();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });
});

describe('P0 · 已经有习惯可列时不必再报失败', () => {
  it('已经有习惯可列时不再叠一条「读不到」（实实在在列出来了就别说没读到）', async () => {
    // 首次成功 → 列表上屏；随后 refetch 失败（`data` 被保留，只有 `isError` 转真）。
    // 此时再叠一条「读不到你的习惯」会与屏幕上正在显示的列表自相矛盾。
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls += 1;
        if (url.includes('/api/habits') && calls === 1) {
          return ok({ today: todayKey(), habits: [habit({ id: 1, name: '喝水' })] });
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ data: null, error: { code: 'E_INTERNAL', message: 'boom' } }),
        };
      }),
    );
    const client = renderPage();
    await screen.findByTestId('habit-check-1');

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['habits'] });
    });
    await flushAll();

    expect(screen.getByTestId('habit-check-1')).toBeInTheDocument();
    expect(screen.queryByTestId('habits-load-error')).toBeNull();
    // 这条是 P0 的下限：任何失败形态下都不能说「你还没有习惯」
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });
});

describe('P0 · 文案与配色红线（PRD §7：不指责、不焦虑、不用红）', () => {
  it('失败区块的文案不含「错误 / 失败 / 异常 / 删除」，且整页无红色类名', async () => {
    stubHabitsServerError();
    renderPage();

    const box = await screen.findByTestId('habits-load-error');
    const texts = [LOAD_ERROR_TEXT, LOAD_RETRY_TEXT];
    for (const text of texts) {
      for (const banned of ['错误', '失败', '异常', '删除', '放弃']) {
        expect(text).not.toContain(banned);
      }
    }
    expect(within(box).getByText(LOAD_RETRY_TEXT)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });

  it('失败区块是中性灰（slate），且地色带 `bg-slate-100` 深色为 `bg-slate-800`', async () => {
    stubHabitsServerError();
    renderPage();

    const box = await screen.findByTestId('habits-load-error');
    expect(box.className).toContain('bg-slate-100');
    expect(box.className).toContain('text-slate-600');
    expect(box.className).toContain('dark:bg-slate-800');
    expect(box.className).toContain('dark:text-slate-300');
  });

  it('失败区块可被读屏播报（role=status），且不弹窗、不遮挡页面其余部分', async () => {
    stubHabitsServerError();
    renderPage();

    const box = await screen.findByTestId('habits-load-error');
    expect(box.getAttribute('role')).toBe('status');
    // 不遮挡、不弹窗：它只是页面流里的一个块，没有 fixed/absolute 定位类
    expect(box.className).not.toMatch(/\bfixed\b|\babsolute\b/);
  });
});

describe('P1 · 连续天数必须进入读屏（不被 aria-label 吞掉）', () => {
  it('★ 打卡按钮的可访问名含「当前连续 N 天」与「历史最佳 M 天」', async () => {
    stubHabitsOk([habit({ id: 1, name: '喝水', currentStreak: 3, bestStreak: 12, doneToday: true })]);
    renderPage();

    const button = await screen.findByTestId('habit-check-1');
    // 用计算出来的可访问名（不是读源码里的字符串拼接）验收 —— 这才是读屏真正拿到的东西
    expect(button).toHaveAccessibleName('喝水，今天已打卡，当前连续 3 天，历史最佳 12 天');
  });

  it('★ 两个数字与实际数据一致，且与可见那一行同口径（读屏与肉眼不打架）', async () => {
    stubHabitsOk([habit({ id: 5, name: '睡前拉伸', currentStreak: 7, bestStreak: 21 })]);
    renderPage();

    const button = await screen.findByTestId('habit-check-5');
    const accessibleName = button.getAttribute('aria-label') ?? '';
    expect(accessibleName).toContain('当前连续 7 天');
    expect(accessibleName).toContain('历史最佳 21 天');

    // 可见那一行同时在屏（字面对齐）
    expect(screen.getByText('当前连续 7 天 · 历史最佳 21 天')).toBeInTheDocument();
  });

  it('可见的那一行必须 aria-hidden（信息已并入 aria-label，不重复朗读）', async () => {
    stubHabitsOk([habit({ id: 1, name: '喝水', currentStreak: 2, bestStreak: 5 })]);
    renderPage();

    await screen.findByTestId('habit-check-1');
    const visible = screen.getByText('当前连续 2 天 · 历史最佳 5 天');
    expect(visible.getAttribute('aria-hidden')).toBe('true');
  });

  it('★ 「内置」与今天打卡状态都还在 —— 连续天数并入时不许把既有信息挤掉', async () => {
    stubHabitsOk([habit({ id: 1, name: '喝水达标', isBuiltin: true, doneToday: false, currentStreak: 0, bestStreak: 8 })]);
    renderPage();

    const button = await screen.findByTestId('habit-check-1');
    expect(button).toHaveAccessibleName('喝水达标，内置，今天还没打卡，当前连续 0 天，历史最佳 8 天');
  });

  it('读出来是分句而非一长串连写（相邻信息之间用中文逗号分隔）', async () => {
    stubHabitsOk([habit({ id: 1, name: '喝水', currentStreak: 1, bestStreak: 1 })]);
    renderPage();

    const name = (await screen.findByTestId('habit-check-1')).getAttribute('aria-label') ?? '';
    expect(name.split('，')).toHaveLength(4);
    expect(name).not.toMatch(/[A-Za-z]{3,}/);
  });
});
