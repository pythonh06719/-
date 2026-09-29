/**
 * GAP-11 收尾 · 习惯「停用 / 重新开始」前端接线测试（pages/habits/HabitsPage.tsx）。
 *
 * ## 背景
 *
 * `afb1216` 只做了后端接口，前端**零停用入口** → 误建的习惯永久留在列表。
 * 本文件钉死前端接线，并守住两条最容易踩的坑：
 * ① **内置习惯不给停用按钮** —— 内置模板（`isBuiltin:true`）停用会 404，给了按钮等于骗用户；
 * ② **停用按钮不嵌套在打卡按钮里** —— 嵌套 `<button>` 是非法 HTML（GAP-1 收藏按钮踩过）。
 *
 * ## 分区口径
 *
 * 后端 `GET /habits` **不过滤** `isActive`（返回全部）；主列表只放未停用的，
 * 停用的收进底部「先停下来的」区域（默认收起）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import HabitsPage from '@/pages/habits/HabitsPage';
import { COPY, habitRestartAria, habitStopAria } from '@/lib/copy';
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

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * fetch 桩：`GET /habits` 返回可变列表；`PATCH /habits/:id` 按 body 的 `isActive`
 * 更新该条（模拟服务端），使「失效重取后分区变化」可被断言。
 */
function stubFetch(initial: HabitFixture[]): { patchCalls: () => Call[] } {
  const calls: Call[] = [];
  let current = initial;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });

    if (method === 'GET' && url.includes('/api/habits')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { today: todayKey(), habits: current }, error: null }),
      };
    }
    if (method === 'PATCH' && /\/api\/habits\/\d+$/.test(url)) {
      const id = Number(/\/api\/habits\/(\d+)$/.exec(url)?.[1]);
      const isActive = body?.isActive === true;
      current = current.map((item) => (item.id === id ? { ...item, isActive } : item));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: current.find((item) => item.id === id) ?? null, error: null }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: null, error: null }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { patchCalls: () => calls.filter((call) => call.method === 'PATCH') };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HabitsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GAP-11 · 前端分区（主列表 vs 先停下来的）', () => {
  it('主列表只渲染未停用的习惯；停用的不出现在主列表', async () => {
    stubFetch([habit({ id: 1, name: '喝水' }), habit({ id: 2, name: '早睡', isActive: false })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    expect(screen.queryByText('早睡')).not.toBeInTheDocument();
    // 停用项没丢：底部有「先停下来的」入口
    expect(screen.getByTestId('habit-stopped-toggle')).toBeInTheDocument();
  });

  it('已停用的习惯收在「先停下来的」区域（默认收起，展开后可见且可重新开始）', async () => {
    stubFetch([habit({ id: 1, name: '喝水' }), habit({ id: 2, name: '早睡', isActive: false })]);
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    // 默认收起：内容与说明都不在 DOM
    expect(screen.queryByText(COPY.habitStoppedSectionHint)).not.toBeInTheDocument();
    expect(screen.queryByTestId('habit-stopped-2')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('habit-stopped-toggle'));

    const row = await screen.findByTestId('habit-stopped-2');
    expect(within(row).getByText('早睡')).toBeInTheDocument();
    expect(screen.getByText(COPY.habitStoppedSectionHint)).toBeInTheDocument();
    expect(within(row).getByTestId('habit-restart-2')).toBeInTheDocument();
  });

  it('没有停用项时不渲染「先停下来的」区域（空区域不出现）', async () => {
    stubFetch([habit({ id: 1, name: '喝水' })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    expect(screen.queryByTestId('habit-stopped-toggle')).not.toBeInTheDocument();
  });
});

describe('GAP-11 · 停用与重新开始的动作', () => {
  it('点「先停一停」→ PATCH /habits/:id，body 恰为 {isActive:false}；该条移出主列表', async () => {
    const stub = stubFetch([habit({ id: 1, name: '喝水' })]);
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('habit-stop-1'));

    await waitFor(() => expect(stub.patchCalls()).toHaveLength(1));
    const patch = stub.patchCalls()[0]!;
    expect(patch.url).toContain('/api/habits/1');
    expect(patch.body).toEqual({ isActive: false }); // 恰好这个 body，无多余字段

    await waitFor(() => expect(screen.queryByTestId('habit-check-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('habit-stopped-toggle')).toBeInTheDocument();
    expect(screen.getByText(COPY.habitStoppedNotice)).toBeInTheDocument();
  });

  it('点「重新开始」→ PATCH /habits/:id，body 恰为 {isActive:true}；该条回到主列表', async () => {
    const stub = stubFetch([habit({ id: 2, name: '早睡', isActive: false })]);
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('habit-stopped-toggle'));
    await user.click(await screen.findByTestId('habit-restart-2'));

    await waitFor(() => expect(stub.patchCalls()).toHaveLength(1));
    expect(stub.patchCalls()[0]!.body).toEqual({ isActive: true });

    await waitFor(() => expect(screen.getByTestId('habit-check-2')).toBeInTheDocument());
    expect(screen.getByText(COPY.habitRestartedNotice)).toBeInTheDocument();
  });
});

describe('GAP-11 · 两个必须守住的坑', () => {
  it('★ 内置习惯（isBuiltin:true）不显示「先停一停」按钮（点了必 404）', async () => {
    stubFetch([habit({ id: 1, name: '喝水', isBuiltin: true }), habit({ id: 2, name: '自建拉伸' })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    // 内置：无停用按钮
    expect(screen.queryByTestId('habit-stop-1')).not.toBeInTheDocument();
    // 自建：有停用按钮（对照组，证明按钮确实会渲染）
    expect(screen.getByTestId('habit-stop-2')).toBeInTheDocument();
  });

  it('★ 「先停一停」按钮不是打卡按钮的后代（不嵌套 button）', async () => {
    stubFetch([habit({ id: 1, name: '喝水' })]);
    renderPage();

    const check = await screen.findByTestId('habit-check-1');
    const stop = screen.getByTestId('habit-stop-1');

    // 按钮的 closest('button') 是它自己 → 没有被任何外层 <button> 包住
    expect(stop.closest('button')).toBe(stop);
    expect(check.contains(stop)).toBe(false);
    // 两者是同一张卡片下的兄弟层级
    expect(stop.parentElement?.parentElement).toBe(check.parentElement);
    expect(stop.textContent).toBe(COPY.habitStop);
  });
});

describe('GAP-11 · 文案红线（PRD §7 无负罪感）', () => {
  it('新文案不含「删除 / 放弃 / 失败 / 错误」，且整页无红色类名', async () => {
    const newTexts: string[] = [
      COPY.habitStop,
      COPY.habitRestart,
      COPY.habitStoppedNotice,
      COPY.habitRestartedNotice,
      COPY.habitUpdateMissed,
      COPY.habitStoppedSectionTitle,
      COPY.habitStoppedSectionHint,
      COPY.habitStoppedShow,
      COPY.habitStoppedHide,
      habitStopAria('喝水'),
      habitRestartAria('喝水'),
    ];
    for (const text of newTexts) {
      for (const banned of ['删除', '放弃', '失败', '错误']) {
        expect(text).not.toContain(banned);
      }
    }

    stubFetch([habit({ id: 1, name: '喝水' }), habit({ id: 2, name: '早睡', isActive: false })]);
    renderPage();
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByTestId('habit-stop-1')).toBeInTheDocument());
    await user.click(screen.getByTestId('habit-stopped-toggle'));
    await waitFor(() => expect(screen.getByTestId('habit-restart-2')).toBeInTheDocument());

    expect(document.body.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });

  it('停用 / 重新开始按钮的读屏语句含习惯名（长列表可分辨）', async () => {
    stubFetch([habit({ id: 1, name: '喝水' }), habit({ id: 2, name: '早睡', isActive: false })]);
    renderPage();
    const user = userEvent.setup();

    expect(await screen.findByTestId('habit-stop-1')).toHaveAccessibleName('先停一停「喝水」，之后随时可以重新开始');
    await user.click(screen.getByTestId('habit-stopped-toggle'));
    expect(await screen.findByTestId('habit-restart-2')).toHaveAccessibleName('重新开始「早睡」');
  });
});
