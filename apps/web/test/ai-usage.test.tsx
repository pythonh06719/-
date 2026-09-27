/**
 * AI 页「剩余次数」接线测试（B6，pages/ai/AiPage.tsx）。
 *
 * 钉死四件事：
 * ① 拿到用量 → 显示「今天还能问 N 次」（数字来自 `GET /api/ai/usage`）；
 * ② 剩余为 0 → 中性措辞「今天问得挺多了，明天再来也行」，
 *    **不含**「已达上限 / 超限 / 次数用尽 / 用完了」等评判式说法（PRD §7 硬红线）；
 * ③ 用量接口取不到（500 / 网络错误）→ 整行不显示，页面其他部分照常渲染（不报错、不白屏）；
 * ④ AI 未配置（未用到 usage 也能降级）时入口仍在，不因用量缺失而拦住用户。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import AiPage from '@/pages/ai/AiPage';

/** 统一 `{ data, error }` 包装的 fetch stub；按 URL 分派，未匹配的返回 200 空数据。 */
function stubFetch(options: {
  usage?: { date: string; used: number; limit: number; remaining: number };
  usageFails?: boolean;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? '');
      if (url.includes('/ai/usage')) {
        if (options.usageFails === true) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ data: null, error: { code: 'E_INTERNAL', message: '服务器开小差了' } }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ data: options.usage, error: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: null, error: null }) };
    }),
  );
}

function renderAiPage(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AiPage />
    </QueryClientProvider>,
  );
}

describe('AiPage 剩余次数（B6）', () => {
  beforeEach(() => {
    stubFetch({ usage: { date: '2026-09-12', used: 8, limit: 50, remaining: 42 } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('显示当日剩余次数（数字直接来自 GET /ai/usage）', async () => {
    renderAiPage();

    expect(await screen.findByText(/今天还能问 42 次/)).toBeInTheDocument();
    expect(screen.getByText('明天会重新计')).toBeInTheDocument();
  });

  it('剩余为 0 时用中性措辞，不出现「已达上限 / 超限 / 次数用尽」', async () => {
    stubFetch({ usage: { date: '2026-09-12', used: 50, limit: 50, remaining: 0 } });
    renderAiPage();

    expect(await screen.findByText('今天问得挺多了，明天再来也行')).toBeInTheDocument();
    expect(screen.queryByText(/还能问/)).toBeNull();

    // 硬红线：页面任何位置都不得出现评判式限额措辞
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/已达上限|超限|次数用尽|用完了|超额|超标/);
  });

  it('用量接口失败 → 整行不显示，页面照常渲染（不报错、不白屏）', async () => {
    stubFetch({ usageFails: true });
    renderAiPage();

    // 三个 tab 与食物识别入口都在（说明没有因为拿不到用量而崩）
    expect(screen.getByRole('tab', { name: '每日总结' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '今日方案' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '自由提问' })).toBeInTheDocument();
    expect(screen.getByText('描述识别食物')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText(/还能问/)).toBeNull();
      expect(screen.queryByText('今天问得挺多了，明天再来也行')).toBeNull();
    });
    // 也不把后端错误文案甩给用户
    expect(screen.queryByText('服务器开小差了')).toBeNull();
  });

  it('网络错误（fetch 抛错）同样不白屏', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    renderAiPage();

    await waitFor(() => {
      expect(screen.queryByText(/还能问/)).toBeNull();
    });
    expect(screen.getByRole('tab', { name: '每日总结' })).toBeInTheDocument();
  });
});
