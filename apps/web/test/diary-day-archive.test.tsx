import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DiaryPage from '@/pages/diary/DiaryPage';
import { addDays, todayKey } from '@/lib/format';
import { cacheClearAll } from '@/lib/local-cache';

/**
 * 一日档案（N2）测试。
 *
 * 原先 `/diary` 只能靠 ‹ › 逐日翻，想看三个月前的某一天要点几十次、实际上等于看不了。
 * 这里钉死三件事：
 * ① 能直接翻到任意一天（原生日期控件，上限为今天）；
 * ② 翻到历史日时措辞跟着变（「这天一共」而不是「今天一共」）；
 * ③ 把那天的体重一起展示出来（有就显示，没有给中性提示 —— 不留空也不催促）。
 */

const TODAY = todayKey();
const PAST = addDays(TODAY, -90);

/** 统一响应包装（与后端全局拦截器一致）。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 按 URL 分流：`/weights` 给体重趋势，其余（`/meals`）给空饮食。 */
function stubFetch(weights: ReadonlyArray<{ date: string; weightKg: number }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/weights')) {
        return ok({
          points: weights.map((point) => ({ date: point.date, weightKg: point.weightKg })),
          movingAverage7: [],
          stats: { minKg: null, maxKg: null, latestKg: null, changeKg: null },
          forecast: [],
          goalProgress: null,
        });
      }
      return ok({ groups: [], totalKcal: 0 });
    }),
  );
}

function renderPage(initialDate?: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage {...(initialDate === undefined ? {} : { initialDate })} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cacheClearAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('一日档案（N2）', () => {
  it('提供日期控件，可直接翻到任意一天（上限为今天）', () => {
    stubFetch([]);
    renderPage();

    const picker = screen.getByLabelText('翻到') as HTMLInputElement;
    expect(picker).toBeInTheDocument();
    expect(picker.getAttribute('max')).toBe(TODAY);
    expect(picker.getAttribute('type')).toBe('date');
  });

  it('翻到历史日 → 措辞改为「这天一共」，并给出「回到今天」', async () => {
    stubFetch([]);
    renderPage(PAST);

    expect(screen.getByText('这天一共')).toBeInTheDocument();
    expect(screen.queryByText('今天一共')).not.toBeInTheDocument();

    const back = screen.getByRole('button', { name: '回到今天' });
    expect(back).toBeInTheDocument();
  });

  it('「回到今天」可用，点回后措辞恢复', async () => {
    stubFetch([]);
    renderPage(PAST);

    fireEvent.click(screen.getByRole('button', { name: '回到今天' }));

    await waitFor(() => {
      expect(screen.getByText('今天一共')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '回到今天' })).not.toBeInTheDocument();
  });

  it('展示那天的体重', async () => {
    stubFetch([{ date: PAST, weightKg: 58 }]);
    renderPage(PAST);

    await waitFor(() => {
      expect(screen.getByText('58.0')).toBeInTheDocument();
    });
    expect(screen.getByText('kg')).toBeInTheDocument();
  });

  it('那天没称体重 → 给中性提示，不留空也不催促', async () => {
    stubFetch([]);
    renderPage(PAST);

    await waitFor(() => {
      expect(screen.getByText(/这天没有称体重的记录/)).toBeInTheDocument();
    });
    // 语气硬约束：不得出现催促/评判性表述
    expect(screen.queryByText(/记得称|别忘了|应该称/)).not.toBeInTheDocument();
  });
});
