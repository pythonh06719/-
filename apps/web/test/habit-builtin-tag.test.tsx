/**
 * 「内置」元信息标注测试（pages/habits/HabitsPage.tsx）。
 *
 * ## 为什么需要这个标注
 *
 * 上一轮修掉了 `code` 重复的数据完整性缺陷（后端 `69e234a`）：自建习惯与内置习惯
 * 不再能共用同一个 `code`，用户的备份也恢复得回来。但那只解决了**数据正确**，
 * 没解决**用户看得懂**：内置的「喝水达标」与自建的「喝水达标」两张卡几乎一样，
 * 用户仍然分不清哪个是自己建的。这个标注就是补这条信息。
 *
 * ## 钉死的三条行为
 *
 * 1. **内置渲染出标注、自建不渲染** —— 标注若对自建也出现，就成了无意义噪音；
 * 2. **标注是中性小字、不是徽章** —— 它是事实说明，视觉权重必须低于旁边的
 *    「先停一停」操作按钮。故断言它**没有**底色 / 边框 / 圆角（不引入第三类形态语言）；
 * 3. **读屏用户也要拿得到这条信息** —— 打卡 `<button>` 带显式 `aria-label`，
 *    而 `aria-label` 按 accname 规范**覆盖全部后代文本**，所以名字旁边那个可见的
 *    「内置」在按钮朗读里是听不到的。必须同时并入 `aria-label`，
 *    且可见 span 标 `aria-hidden` 以免浏览模式下重复朗读成噪音。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import HabitsPage from '@/pages/habits/HabitsPage';
import { COPY } from '@/lib/copy';
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

function stubFetch(list: HabitFixture[]): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/api/habits')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { today: todayKey(), habits: list }, error: null }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: null, error: null }) };
  });
  vi.stubGlobal('fetch', fetchMock);
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

/** 主列表里某张卡的可访问名（打卡按钮的 aria-label）。 */
function checkButtonLabel(id: number): string {
  return screen.getByTestId(`habit-check-${id}`).getAttribute('aria-label') ?? '';
}

/** 找到名字旁那个标注元素（`aria-hidden` 的可见 span），按文本取。 */
function builtinTag(): HTMLElement | null {
  return screen.queryAllByText(COPY.habitBuiltinTag).find(
    (node) => node.getAttribute('aria-hidden') === 'true',
  ) ?? null;
}

describe('内置标注 · 只标内置、自建不加', () => {
  it('★ 内置习惯渲染出「内置」标注', async () => {
    stubFetch([habit({ id: 1, name: '喝水达标', isBuiltin: true })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    expect(builtinTag()).not.toBeNull();
  });

  it('★ 自建习惯**不**渲染标注（否则是无意义噪音）', async () => {
    stubFetch([habit({ id: 2, name: '我自己加的', isBuiltin: false })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-2')).toBeInTheDocument());
    expect(builtinTag()).toBeNull();
  });

  it('混合列表：标注数量恰等于内置习惯数量', async () => {
    stubFetch([
      habit({ id: 1, name: '喝水达标', isBuiltin: true }),
      habit({ id: 2, name: '早睡', isBuiltin: true }),
      habit({ id: 3, name: '睡前拉伸', isBuiltin: false }),
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-3')).toBeInTheDocument());
    expect(screen.getAllByText(COPY.habitBuiltinTag)).toHaveLength(2);
  });

  /**
   * 标注出现在**名字旁边**，不是别处 —— 用 DOM 关系钉死，避免以后重构挪走它
   * （挪到卡片角落就失去了「这是关于这个名字的」这层含义）。
   */
  it('标注与习惯名字同处一个容器（是名字的附属说明，不是卡片级装饰）', async () => {
    stubFetch([habit({ id: 1, name: '喝水达标', isBuiltin: true })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    const tag = builtinTag();
    expect(tag).not.toBeNull();
    // 名字与标注共享同一个父容器
    expect(tag?.parentElement).toBe(screen.getByText('喝水达标').parentElement);
  });
});

describe('内置标注 · 样式克制（是元信息，不是徽章）', () => {
  it('★ 标注只有小字与中性色：没有底色、边框、圆角（不与操作按钮争夺注意力）', async () => {
    stubFetch([habit({ id: 1, name: '喝水达标', isBuiltin: true })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    const className = builtinTag()?.className ?? '';

    expect(className).toContain('text-xs');
    // 中性色（浅/深色各一档），与全站元信息文字同一口径
    expect(className).toContain('text-slate-500');
    expect(className).toContain('dark:text-slate-400');
    // 不引入「徽章」形态语言
    expect(className).not.toMatch(/bg-/);
    expect(className).not.toMatch(/border/);
    expect(className).not.toMatch(/rounded/);
  });
});

describe('内置标注 · 无障碍（读屏用户也要拿得到，且不重复成噪音）', () => {
  /**
   * 关键：`aria-label` 按 accname 规范**覆盖全部后代文本**。打卡按钮在
   * `HabitsPage.tsx` 已有显式 `aria-label`，所以名字旁那个可见的「内置」在
   * **按钮自身的朗读里根本听不到**。不并入 `aria-label` 的话，
   * 读屏用户就永远拿不到「这条是内置的」—— 而这正是本页要解决的核心困惑。
   */
  it('★ 「内置」被并入打卡按钮的 aria-label（读屏用户能听到）', async () => {
    stubFetch([habit({ id: 1, name: '喝水达标', isBuiltin: true })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    expect(checkButtonLabel(1)).toContain(COPY.habitBuiltinTag);
    // 名字本身仍完整（不能被标注挤掉）
    expect(checkButtonLabel(1)).toContain('喝水达标');
  });

  it('自建习惯的 aria-label 不含「内置」（口径与可见标注一致）', async () => {
    stubFetch([habit({ id: 2, name: '睡前拉伸', isBuiltin: false })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-2')).toBeInTheDocument());
    expect(checkButtonLabel(2)).not.toContain(COPY.habitBuiltinTag);
  });

  /**
   * 可见 span 标 `aria-hidden` 的原因：它的信息**已经**在 `aria-label` 里了。
   * 不标的话，浏览模式（虚拟光标）下读屏会把按钮当整体念一遍 aria-label、
   * 又在走到这个 span 时念一次「内置」—— 同一信息读两遍，正是噪音。
   */
  it('可见的「内置」span 带 aria-hidden（信息已由 aria-label 承担，不重复朗读）', async () => {
    stubFetch([habit({ id: 1, name: '喝水达标', isBuiltin: true })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    expect(builtinTag()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('标注不是可交互元素（不用 label/button，避免被读成可点）', async () => {
    stubFetch([habit({ id: 1, name: '喝水达标', isBuiltin: true })]);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('habit-check-1')).toBeInTheDocument());
    const tag = builtinTag();
    expect(tag?.tagName).toBe('SPAN');
  });
});
