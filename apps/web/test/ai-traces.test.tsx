/**
 * AI 执行轨迹测试（GAP-7，pages/ai/AiPage.tsx 第 4 个 tab「回答记录」）。
 *
 * 展示口径（可解释性 NFR-11，**克制**）：
 * - 展示：提问内容、状态、用到的工具名（中文映射）、每步耗时、整轮耗时；
 * - **不展示 `tokens`** —— 开发者指标，对用户无意义且易焦虑。
 *   本文件以「页面 HTML 不出现 token 数」这条断言把它钉死。
 *
 * 语气规范同 PRD §7：`failed` 不译成「失败」；空态指一条去路；读取不顺软着陆。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AiPage from '@/pages/ai/AiPage';
import { COPY } from '@/lib/copy';

/** `GET /ai/agent/traces` 的单条轨迹（含 tokens —— 但页面不得渲染它）。 */
interface Trace {
  id: number;
  question: string;
  status: string;
  answer: string;
  toolCalls: number;
  tokens: number;
  durationMs: number;
  createdAt: string;
  steps: Array<{ index: number; type: string; tool?: string; note?: string; ms?: number }>;
  pending: unknown | null;
}

/** 造一条轨迹。 */
function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: 1,
    question: '今天还能吃一个苹果吗',
    status: 'answered',
    answer: '可以，一个苹果大约 90 千卡。',
    toolCalls: 2,
    tokens: 1234,
    durationMs: 1500,
    createdAt: '2026-09-23T06:05:00.000Z',
    steps: [
      { index: 0, type: 'tool', tool: 'get_today_status', ms: 320 },
      { index: 1, type: 'tool', tool: 'search_food', ms: 180 },
      { index: 2, type: 'final', note: '组织回答' },
    ],
    pending: null,
    ...overrides,
  };
}

/** fetch 桩：只覆盖 `GET /ai/agent/traces`（AI 用量可优雅缺席）。 */
function stubTraces(options: {
  traces?: Trace[];
  fail?: boolean;
}): { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (method === 'GET' && url.includes('/api/ai/agent/traces')) {
        if (options.fail === true) {
          return {
            ok: false,
            status: 500,
            json: async () => ({
              data: null,
              error: { code: 'E_HTTP_500', message: '服务端在开小差，稍后我们再来一次' },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: options.traces ?? [], error: null }),
        } as Response;
      }
      if (method === 'GET' && url.includes('/api/ai/usage')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { date: '2026-09-23', used: 0, limit: 50, remaining: 50 },
            error: null,
          }),
        } as Response;
      }
      // 其它请求一律给空成功（本测试不触发）
      return { ok: true, status: 200, json: async () => ({ data: null, error: null }) } as Response;
    }),
  );
  return { calls };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiPage />
    </QueryClientProvider>,
  );
}

/** 切到「回答记录」tab。 */
async function openTraceTab(): Promise<void> {
  const tab = await waitFor(() => screen.getByRole('tab', { name: COPY.aiTraceTab }));
  fireEvent.click(tab);
}

describe('AI 执行轨迹（GAP-7）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('tab 存在且点击后调 GET /ai/agent/traces', async () => {
    const { calls } = stubTraces({ traces: [makeTrace()] });
    renderPage();

    await openTraceTab();

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/api/ai/agent/traces'))).toBe(true);
    });
  });

  it('展示提问内容 / 状态 / 工具名 / 耗时', async () => {
    stubTraces({ traces: [makeTrace()] });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByTestId('ai-trace-1')).toBeDefined();
    });
    // 提问内容
    expect(screen.getByText('今天还能吃一个苹果吗')).toBeDefined();
    // 状态（answered → 中性中文）
    expect(screen.getByText(COPY.aiTraceStatusAnswered)).toBeDefined();
    // 工具名（中文映射）
    expect(screen.getAllByText(/今日看板/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/食物库/).length).toBeGreaterThan(0);
    // 耗时（过程透明度）
    expect(screen.getByText(COPY.aiTraceStepMs(320))).toBeDefined();
    expect(screen.getByText(COPY.aiTraceDurationLine(1500))).toBeDefined();
  });

  it('★ 页面不出现 token 数（token 是开发者指标，刻意不展示）', async () => {
    stubTraces({ traces: [makeTrace({ tokens: 987654 })] });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByTestId('ai-trace-1')).toBeDefined();
    });
    // token 数与「token」字样都不得出现
    expect(document.body.innerHTML).not.toContain('987654');
    expect(document.body.innerHTML).not.toContain('token');
    expect(document.body.textContent ?? '').not.toContain('Token');
  });

  it('`failed` 不直译成「失败」（语气红线）', async () => {
    stubTraces({ traces: [makeTrace({ id: 2, status: 'failed' })] });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByTestId('ai-trace-2')).toBeDefined();
    });
    expect(screen.getByText(COPY.aiTraceStatusFailed)).toBeDefined();
    expect(COPY.aiTraceStatusFailed).not.toContain('失败');
    expect(document.body.textContent ?? '').not.toContain('失败');
  });

  it('need_confirm / max_steps / disabled 均有中性中文映射', async () => {
    stubTraces({
      traces: [
        makeTrace({ id: 3, status: 'need_confirm' }),
        makeTrace({ id: 4, status: 'max_steps' }),
        makeTrace({ id: 5, status: 'disabled' }),
      ],
    });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByText(COPY.aiTraceStatusNeedConfirm)).toBeDefined();
    });
    expect(screen.getByText(COPY.aiTraceStatusMaxSteps)).toBeDefined();
    expect(screen.getByText(COPY.aiTraceStatusDisabled)).toBeDefined();
  });

  it('无工具调用 → 中性说明「直接按你的记录答的」', async () => {
    stubTraces({
      traces: [makeTrace({ id: 6, steps: [{ index: 0, type: 'final', note: '组织回答' }] })],
    });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByText(COPY.aiTraceNoTools)).toBeDefined();
    });
  });

  it('空态：指一条去路（不复用冷冰冰的「暂无数据」）', async () => {
    stubTraces({ traces: [] });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByTestId('ai-trace-empty').textContent).toBe(COPY.aiTraceEmpty);
    });
    expect(document.body.textContent ?? '').not.toContain('暂无数据');
  });

  it('读取不顺 → 软着陆，且不得复用空态文案（读不到 ≠ 没问过）', async () => {
    stubTraces({ fail: true });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByTestId('ai-trace-error').textContent).toBe(COPY.aiTraceError);
    });
    expect(screen.queryByText(COPY.aiTraceEmpty)).toBeNull();
  });

  it('文案红线：轨迹相关新文案不含「失败 / 错误 / 崩溃」，且无红色类名', async () => {
    stubTraces({ traces: [makeTrace()] });
    renderPage();
    await openTraceTab();

    await waitFor(() => {
      expect(screen.getByTestId('ai-trace-1')).toBeDefined();
    });

    const newCopy: string[] = [
      COPY.aiTraceTab,
      COPY.aiTraceTitle,
      COPY.aiTraceDesc,
      COPY.aiTraceStatusAnswered,
      COPY.aiTraceStatusNeedConfirm,
      COPY.aiTraceStatusMaxSteps,
      COPY.aiTraceStatusFailed,
      COPY.aiTraceStatusDisabled,
      COPY.aiTraceStatusUnknown,
      COPY.aiTraceToolsPrefix,
      COPY.aiTraceNoTools,
      COPY.aiTraceDurationLine(1500),
      COPY.aiTraceStepMs(320),
      COPY.aiTraceEmpty,
      COPY.aiTraceError,
      COPY.aiTraceLoading,
      COPY.aiTraceLimitNote,
    ];
    for (const text of newCopy) {
      for (const banned of ['失败', '错误', '崩溃']) {
        expect(text).not.toContain(banned);
      }
    }
    // 轨迹卡片不得用红色
    const card = screen.getByTestId('ai-trace-1');
    expect(card.className).not.toContain('text-red');
    expect(card.className).not.toContain('bg-red');
  });
});
