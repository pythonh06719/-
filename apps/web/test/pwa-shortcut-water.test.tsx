/**
 * PWA 桌面快捷方式「喝一杯水」直达（C-2）测试。
 *
 * 背景：`public/manifest.webmanifest` 的 `shortcuts` 把「喝一杯水」指向
 * `/exercise?focus=water`，`ExercisePage` 落地即**直接记一杯水**（不做「聚焦高亮」折中 ——
 * 快捷方式的名字就是「喝一杯水」，再要求一次点击等于没直达）。
 *
 * 钉死四条（`?focus=water` 是一次**会有副作用**的直达，防重复是最关键的一条）：
 * ① 带 `?focus=water` → `POST /water` **恰好一次**；
 * ② 不带该参数 → **一次都不发**（正常打开 `/exercise` 不该被莫名记一杯）；
 * ③ **StrictMode 严格模式**下仍只记一杯（React 18 会故意 double-invoke effect）；
 * ④ 直达后 `?focus=water` 被摘掉 —— 刷新页面不会再加一杯。
 *
 * 语气硬约束（PRD §7 / NFR-11）：反馈只说「已记下一杯水」这一事实，
 * **不报杯数**（不出现「第 3 杯 / 还差 5 杯」）。
 */

import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ExercisePage from '@/pages/exercise/ExercisePage';
import { COPY } from '@/lib/copy';
import { cacheClearAll } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';

/** 今日日期（与页面 `todayKey()` 同源），用于校验 `POST /water` 的请求体。 */
const TODAY = todayKey();

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

const EMPTY_WATER_PAYLOAD = { date: TODAY, totalMl: 0, goalMl: 2000, logs: [] };
const EMPTY_EXERCISE_PAYLOAD = { date: TODAY, logs: [], totalKcal: 0 };

/**
 * stub 全局 `fetch`：区分 GET（页面加载）与 POST（记一杯水），
 * 返回统一 `{ data, error: null }` 包装（K2），并记录所有请求供断言。
 */
function stubFetch(captured: CapturedRequest[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
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
      captured.push({ method, url, body });

      // 饮水两处出口：写（POST）与读（GET）都要有数据，否则页面拿不到水总量
      const data = url.includes('/water') ? EMPTY_WATER_PAYLOAD : EMPTY_EXERCISE_PAYLOAD;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data, error: null }),
      };
    }),
  );
}

/** 把当前 `location.search` 暴露到 DOM，便于断言「参数已被摘掉」。 */
function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
}

function renderPage(options: { strict?: boolean; initialEntry?: string } = {}): void {
  const { strict = false, initialEntry = '/exercise?focus=water' } = options;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ExercisePage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** 只统计「记一杯水」的 POST 请求（排除其它写入）。 */
function waterPosts(captured: CapturedRequest[]): CapturedRequest[] {
  return captured.filter((item) => item.method === 'POST' && item.url.includes('/water'));
}

beforeEach(() => {
  cacheClearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PWA 快捷方式「喝一杯水」直达（/exercise?focus=water）', () => {
  it('带 ?focus=water → 恰好触发一次 POST /water', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);

    renderPage();

    await waitFor(() => expect(waterPosts(captured)).toHaveLength(1));
    // 稳定窗口：确认不会「后来居上」再补第二发
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waterPosts(captured)).toHaveLength(1);
    // 请求体带今日日期（与手动 +250ml 同一接口语义）
    expect(waterPosts(captured)[0]?.body).toEqual({ loggedDate: TODAY });
  });

  it('不带 ?focus=water → 一次都不发（正常打开不该被记一杯）', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);

    renderPage({ initialEntry: '/exercise' });

    // 等页面进入稳定态：喝水区块已渲染
    expect(await screen.findByRole('heading', { name: '喝水' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+250ml' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waterPosts(captured)).toHaveLength(0);
    expect(screen.queryByText(COPY.waterShortcutLogged)).toBeNull();
  });

  it('StrictMode 双调用下仍只记一杯（防重复核心用例）', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);

    renderPage({ strict: true });

    await waitFor(() => expect(waterPosts(captured)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 严格模式下 effect 会被故意跑两遍：这里断言**没有**第二杯
    expect(waterPosts(captured)).toHaveLength(1);
  });

  it('直达后把 focus=water 从 URL 摘掉（刷新不会再加一杯）', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);

    renderPage();

    await waitFor(() => expect(waterPosts(captured)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe(''));
    expect(screen.getByTestId('location-search').textContent).not.toContain('focus');
  });

  it('反馈是「已记下一杯水」这一事实陈述，不含杯数（NFR-11）', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);

    renderPage();

    const notice = await screen.findByText(COPY.waterShortcutLogged);
    expect(notice).toBeInTheDocument();
    // 硬约束 2：不出现任何催办式 / 计数式杯数展示
    expect(notice.textContent).not.toMatch(/第\s*\d+\s*杯/);
    expect(notice.textContent).not.toMatch(/还差|差\s*\d+|目标/);
  });
});
