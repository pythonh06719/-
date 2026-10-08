/**
 * 断食计时页的查询三分支回归保护（`pages/fasting/FastingPage.tsx`）。
 *
 * ## 缺陷（P0）：请求失败 == 「永远在加载」
 *
 * `settingsQuery` 配了 `retry: 0`，而渲染只判`!settings`：
 *
 * ```
 * const settings = settingsQuery.data;
 * {!settings ? (<div className="animate-pulse …" />) : …}
 * ```
 *
 * 请求失败时 `data` 恒为 `undefined` → `!settings` 永真 → **两个灰色骨架块永不停下**。
 * 而「正在读取设置…」是 `qsh-sr-only`，**sighted 用户一个可见字都看不到**，
 * 页面上也没有任何重试按钮 —— 用户既不知道出了什么事，也只能靠刷新整页。
 *
 * 这是全仓唯一把「坏」渲染成「永远在加载」的地方
 * （`PeriodReportView` / `WeeklyReportView` 都用 `isLoading ? … : '暂时拿不到…'` 兜住了）。
 *
 * ## 本文件钉死的行为
 *
 * ① 加载中 → 骨架可见（`aria-busy` / `data-testid` 锚点），**不**提前报错；
 * ② 请求失败 → 出现**失败专属**区块，且**带可点的「重新试试」**（这是「入口不可用」）；
 * ③ 请求失败时**绝不能**只留骨架（骨架永真 = 缺陷正身）；
 * ④ 失败文案不含PRD §7 禁用词（不用「失败 / 错误 / 崩溃」当标题）；
 * ⑤ 点「重新试试」→ `refetch()`，成功后失败区块自动消失、真实设置上屏；
 * ⑥ 成功 → 显示当前方案与目标小时数（正向确认第三条分支确实通）。
 *
 * ## 等待锚点独立于被测行为
 *
 * 否定类断言（「骨架不该再出现」「失败块不该出现」）必须先用 `act` 冲掉待处理的
 * React 更新再查，否则「没渲染」可能只是「还没渲染完成」。做法见 `flushAll()`。
 *
 * ## 返工时的检查清单
 *
 * - 删掉 `isError` 分支 → ② 与 ③ 两条必须同时转红；
 * - 把失败块的「重新试试」按钮删掉 → ② 与 ⑤ 两条必须同时转红；
 * - 把失败文案换成「失败 / 错误」→ ④ 必须转红。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import FastingPage from '@/pages/fasting/FastingPage';
import { COPY } from '@/lib/copy';

/** PRD §7 禁用词：不用它们当失败提示（会变成指责式表达）。 */
const BANNED = ['失败', '错误', '崩溃', '出错'];

/** 已关闭的设置 —— 默认态，也是测试里最常用的一档。 */
const SETTINGS_OFF = {
  plan: '16:8',
  targetFastHours: 16,
  eatWindowStart: '12:00',
  enabled: false,
  disclaimerAckAt: null,
};

/**
 * 「默认关闭」态那句原文（成功分支的落屏锚点）。
 *
 * ⚠️ 它目前是 `FastingPage` 里的**内联字面量**、不在 `COPY` 里 —— 本轮不新增文案常量，
 * 故这里按原文断言。若将来把它收进 `COPY`，本常量替换为 `COPY.<key>` 即可。
 */
const DEFAULT_OFF_HINT = '计时器默认关闭。如果你想了解，我们会先把风险讲清楚，再由你决定。';

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FastingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 桩：`/fasting/settings` 可切成功 / 失败，`/fasting/current` 恒为「没有进行中的断食」。 */
function stubFetch(options: { settingsFail: boolean }): { calls: () => string[] } {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/fasting/settings')) {
      if (options.settingsFail) {
        throw new TypeError('Failed to fetch');
      }
      return ok(SETTINGS_OFF);
    }
    if (url.includes('/fasting/current')) {
      return ok(null);
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls: () => calls };
}

/** 把待处理的 React 更新全部冲掉（详见文件头「等待锚点」）。 */
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

describe('断食计时页 · 加载中', () => {
  it('★ 加载中显示骨架，不提前报错、也不渲染设置内容', async () => {
    const gate = new Promise<void>(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        await gate;
        const url = String(input);
        return url.includes('/fasting/settings') ? ok(SETTINGS_OFF) : ok(null);
      }),
    );
    renderPage();

    const skeleton = await screen.findByTestId('fasting-settings-loading');
    expect(skeleton).toBeInTheDocument();
    // 加载中不得出现失败区块，也不得先说「计时器默认关闭」（那是成功态的内容）
    expect(screen.queryByTestId('fasting-settings-error')).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.offlineNotice)).not.toBeInTheDocument();
  });
});

describe('断食计时页 · 请求失败', () => {
  it('★ 请求失败 → 显示失败区块，且骨架不再无限延续', async () => {
    stubFetch({ settingsFail: true });
    renderPage();

    // 缺陷正身：`retry: 0` + 只判 `!settings` 时，这里永远等不到 → 超时失败
    const errorBlock = await screen.findByTestId('fasting-settings-error');
    expect(errorBlock).toBeInTheDocument();

    await flushAll();
    expect(screen.queryByTestId('fasting-settings-loading')).not.toBeInTheDocument();
  });

  it('★ 请求失败 → 失败提示不含禁用词', async () => {
    stubFetch({ settingsFail: true });
    renderPage();

    const errorBlock = await screen.findByTestId('fasting-settings-error');
    for (const banned of BANNED) {
      expect(errorBlock).not.toHaveTextContent(banned);
    }
    expect(document.body.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });

  it('★ 请求失败 → 给出可点的「重新试试」（无重试入口 = 用户只能刷新整页）', async () => {
    stubFetch({ settingsFail: true });
    renderPage();

    await screen.findByTestId('fasting-settings-error');
    const retry = screen.getByTestId('fasting-settings-retry');
    expect(retry).toBeInTheDocument();
    expect(retry).not.toBeDisabled();
  });

  it('★ 请求失败 → 点「重新试试」后成功取回，失败区块消失、真实设置上屏', async () => {
    let fail = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/fasting/settings')) {
        if (fail) {
          throw new TypeError('Failed to fetch');
        }
        return ok(SETTINGS_OFF);
      }
      return ok(null);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await screen.findByTestId('fasting-settings-error');
    fail = false;
    const user = userEvent.setup();
    await user.click(screen.getByTestId('fasting-settings-retry'));

    // 正向确认第三条分支真的通了：默认关闭态的那句话上屏
    await screen.findByText(DEFAULT_OFF_HINT);
    expect(screen.queryByTestId('fasting-settings-error')).not.toBeInTheDocument();
  });
});

describe('断食计时页 · 成功', () => {
  it('成功 → 显示当前方案与目标小时数（正向确认 happy path）', async () => {
    stubFetch({ settingsFail: false });
    renderPage();

    await screen.findByText(DEFAULT_OFF_HINT);
    expect(screen.queryByTestId('fasting-settings-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fasting-settings-loading')).not.toBeInTheDocument();
  });
});