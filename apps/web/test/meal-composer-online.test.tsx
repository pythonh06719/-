import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MealComposer from '@/pages/diary/MealComposer';

/**
 * MealComposer 在线兜底集成测试（Phase C-1）。
 *
 * 通过 stub `fetch`：本地 `/foods` 返回空 → 触发 `/foods/live-search` 在线结果 →
 * 点「加入并记录」调用 `/foods/import-external` → 进入既有份量确认流程。
 */

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

const LIVE_ITEM = {
  externalId: '9990000000001',
  name: '在线气泡水',
  category: '饮料',
  kcalPer100g: 2,
  proteinGPer100g: 0,
  fatGPer100g: 0,
  carbGPer100g: 0,
  servingUnits: [],
  defaultServingGrams: null,
  barcode: '9990000000001',
  brand: 'FeelGood',
  sourceUrl: 'https://world.openfoodfacts.org/product/9990000000001',
  source: 'openfoodfacts',
  license: 'ODbL 1.0',
};

const IMPORTED_FOOD = {
  id: 7,
  name: '在线气泡水',
  namePinyin: null,
  aliases: [],
  category: '饮料',
  kcalPer100g: 2,
  proteinGPer100g: 0,
  fatGPer100g: 0,
  carbGPer100g: 0,
  fiberGPer100g: null,
  sodiumMgPer100g: null,
  saturatedFatGPer100g: null,
  sugarGPer100g: null,
  calciumMgPer100g: null,
  ironMgPer100g: null,
  potassiumMgPer100g: null,
  vitaminDUgPer100g: null,
  b12UgPer100g: null,
  magnesiumMgPer100g: null,
  servingUnits: [],
  defaultServingGrams: null,
  barcode: '9990000000001',
  source: 'openfoodfacts',
  createdByUserId: null,
  isVerified: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderComposer(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer date="2026-09-12" mealType="lunch" onClose={vi.fn()} onSubmit={vi.fn(async () => undefined)} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MealComposer 在线食物库兜底', () => {
  it('本地无结果 → 展示在线结果 →「加入并记录」进入份量确认流程', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/foods/live-search')) {
          return ok({
            items: [LIVE_ITEM],
            found: 1,
            skipped: 0,
            degraded: false,
            source: 'openfoodfacts',
            license: 'ODbL 1.0',
          });
        }
        if (url.includes('/foods/import-external')) {
          return ok(IMPORTED_FOOD);
        }
        return ok({ items: [], total: 0, page: 1, pageSize: 20 });
      }),
    );

    renderComposer();
    fireEvent.change(screen.getByPlaceholderText('如：番茄、米饭、拿铁'), { target: { value: '气泡水' } });

    expect(await screen.findByText('在线气泡水')).toBeInTheDocument();
    // 来源/许可徽标（页脚也含同样关键词，故用 getAllByText）
    expect(screen.getAllByText(/Open Food Facts/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '加入并记录' }));

    expect(await screen.findByText('已经加入到食物库，确认份量就能记下')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认记录' })).toBeInTheDocument();
  });

  it('在线食物库不可用 → 给出无负罪感提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/foods/live-search')) {
          return ok({ items: [], found: 0, skipped: 0, degraded: true, source: 'openfoodfacts', license: 'ODbL 1.0' });
        }
        return ok({ items: [], total: 0, page: 1, pageSize: 20 });
      }),
    );

    renderComposer();
    fireEvent.change(screen.getByPlaceholderText('如：番茄、米饭、拿铁'), { target: { value: '气泡水' } });

    expect(await screen.findByText(/在线食物库暂时连不上/)).toBeInTheDocument();
  });

  it('提供「扫码查条码」入口', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ items: [], total: 0, page: 1, pageSize: 20 })));
    renderComposer();
    expect(screen.getByRole('button', { name: '扫码查条码' })).toBeInTheDocument();
  });
});
