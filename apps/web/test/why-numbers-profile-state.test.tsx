/**
 * 「数字是怎么来的」页的查询三分支回归保护（`pages/why-numbers/WhyNumbersPage.tsx`）。
 *
 * ## 缺陷（P0）：三分支的判据用错了变量
 *
 * 该块的兜底文案按 `hasToken`（**登录状态**）二选一：
 *
 * ```
 * {hasToken ? '完成引导问卷后，这里会��你自己的资料实时算出每一步的分解。'
 *           : '登录并完成引导问卷后，…'}
 * ```
 *
 * 但真正决定「能不能算出你的数字」的是 `/profile` **请求成功与否**，不是有没有登录。
 * 三种状态在判据前是同一个 `live === null`：
 *
 * | 真实状态 | 用户看到的却是 |
 * |---|---|
 * | 已登录 + 档案齐全 | ✅ 分解表（正确） |
 * | 已登录 + 真没完成引导 | 「完成引导问卷后」（正确） |
 * | **已登录 + 请求失败** | **「完成引导问卷后」（错误！）** |
 * | 未登录 | 「登录并完成引导问卷后」（正确） |
 *
 * 第三行就是缺陷：`data = profileQuery.data ?? null` 把「请求失败」也收成了 `null`，
 * 与「真没引导」不可分。而这一页是**全站解释「我的数字从哪来」的门面**（导航长期挂入口），
 * 已完成引导的用户看到「完成引导问卷后」会以为引导没生效。
 * 与「数字可信」直接冲突：**拿不到 ≠ 没有**。
 *
 * ## 本文件钉死的行为
 *
 * ① 已登录 + 请求失败 → **绝不能**出现「完成引导问卷后」；
 * ② 已登录 + 请求失败 → 出现失败专属区块，且**带可点的「重新试试」**；
 * ③ 失败文案不含PRD §7 禁用词（不用「失败 / 错误 / 崩溃」当标题）；
 * ④ 已登录 + 请求失败 → 点「重新试试」成功取回后，分解表上屏、失败区块消失；
 * ⑤ **未登录仍读得到本页**（`enabled: hasToken`，且兜底说的是「登录并…」而非「完成…」）——
 *    防止为修① 而误伤P3 收口的「登出状态也可读」。
 * ⑥ 已登录 + 档案齐全 → 分解表真的上屏（正向确认 happy path 没被改坏）。
 *
 * ## 返工时的检查清单
 *
 * - 把 `isError` 分支删掉 → ① 与 ② 两条必须同时转红；
 * - 把判据改回只按 `hasToken` → ① 必须转红；
 * - 失败文案里出现禁用词 → ③ 必须转红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import WhyNumbersPage from '@/pages/why-numbers/WhyNumbersPage';
import { useAuthStore } from '@/lib/auth.store';

/** PRD §7 禁用词：不用它们当失败提示（会变成指责式表达）。 */
const BANNED = ['失败', '错误', '崩溃', '出错'];

/** 缺陷正身所在的那句（已登录 + 取不到时**绝不能**出现）。 */
const MISLEADING = '完成引导问卷后';

/** 未登录时**应该**出现的那句（含「登录并」前缀，与上面那句是两句不同的文案）。 */
const LOGGED_OUT_HINT = '登录并完成引导问卷后';

/** 一份完整的档案 + 目标（happy path用）。 */
const FULL_PROFILE = {
  profile: {
    gender: 'female',
    birthDate: '1995-06-15',
    heightCm: 165,
    activityLevel: 'light',
  },
  goal: {
    startWeightKg: 60,
    targetWeightKg: 55,
    targetWeeks: 12,
    weeklyLossKg: 0.4167,
  },
  budget: null,
};

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/**
 * 渲染本页并把登录态设好。
 *
 * @param loggedIn 是否已登录（决定 `enabled: hasToken`，进而决定 `/profile` 会不会发出去）
 */
function renderPage(loggedIn: boolean): void {
  useAuthStore.setState({ accessToken: loggedIn ? 'test-token' : null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WhyNumbersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  useAuthStore.setState({ accessToken: null });
});

describe('why-numbers 页 · 已登录但请求失败', () => {
  it('★ 已登录 + 请求失败 → 不得显示「完成引导问卷后」（读不到 ≠ 没引导）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderPage(true);

    // 缺陷正身：判据只看 `hasToken`，故这里必然出现 MISLEADING 那句 → 转红
    await screen.findByTestId('why-numbers-profile-error');
    expect(screen.queryByText(new RegExp(MISLEADING))).not.toBeInTheDocument();
  });

  it('★ 已登录 + 请求失败 → 给出可点的「重新试试」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderPage(true);

    await screen.findByTestId('why-numbers-profile-error');
    const retry = screen.getByTestId('why-numbers-profile-retry');
    expect(retry).toBeInTheDocument();
    expect(retry).not.toBeDisabled();
  });

  it('★ 已登录 + 请求失败 → 失败提示不含禁用词', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderPage(true);

    const errorBlock = await screen.findByTestId('why-numbers-profile-error');
    for (const banned of BANNED) {
      expect(errorBlock).not.toHaveTextContent(banned);
    }
  });

  it('★ 已登录 + 请求失败 → 点「重新试试」成功取回后分解表上屏', async () => {
    let fail = true;
    const fetchMock = vi.fn(async () => {
      if (fail) {
        throw new TypeError('Failed to fetch');
      }
      return ok(FULL_PROFILE);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage(true);

    await screen.findByTestId('why-numbers-profile-error');
    fail = false;
    const user = userEvent.setup();
    await user.click(screen.getByTestId('why-numbers-profile-retry'));

    // 正向确认 happy path真的通了：分解表的第一行「你的年龄」上屏
    await screen.findByText('你的年龄');
    expect(screen.queryByTestId('why-numbers-profile-error')).not.toBeInTheDocument();
  });
});

describe('why-numbers 页 · 未登录仍可读（P3 收口，防误伤）', () => {
  it('未登录 → 说的是「登录并完成引导问卷后」，且不发 /profile', async () => {
    const fetchMock = vi.fn(async () => ok(FULL_PROFILE));
    vi.stubGlobal('fetch', fetchMock);
    renderPage(false);

    await screen.findByText(new RegExp(LOGGED_OUT_HINT));
    // `enabled: hasToken` → 未登录时压根不该发 /profile
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('why-numbers 页 · 正常路径', () => {
  it('已登录 + 档案齐全 → 分解表上屏，且没有失败区块', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(FULL_PROFILE)));
    renderPage(true);

    await screen.findByText('你的年龄');
    expect(screen.queryByTestId('why-numbers-profile-error')).not.toBeInTheDocument();
  });

  it('已登录 + 真没完成引导 → 说的是「完成引导问卷后」（这一支必须保留）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ profile: null, goal: null, budget: null })));
    renderPage(true);

    await screen.findByText(new RegExp(MISLEADING));
    expect(screen.queryByTestId('why-numbers-profile-error')).not.toBeInTheDocument();
  });
});