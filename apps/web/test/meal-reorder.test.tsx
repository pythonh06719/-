/**
 * 餐次拖拽排序（R3.8）测试。
 *
 * 钉死四件事（AC-3.8.7 是**一票否决项**）：
 * ① **降级控件组**（上移 / 下移 / 移动到某餐）存在，且带完整的 `aria-label`
 *    —— 断言一律用 `getByLabelText`，不靠 `data-testid`；
 * ② 拖拽 hook **不挂载**时降级控件照常工作（`MealItemRow` 是独立组件）；
 * ③ 上移 / 下移 / 跨餐移动都走同一条 `PATCH /meals/reorder`，
 *    `orderedIds` = **目标餐次的完整期望顺序**；
 * ④ 失败 / 离线 → 入队 + 回滚 + **中性**提示（不以「失败」作标题、不用红色）。
 *
 * 另外钉死 AC-3.8.2：拖拽与移动**不改变任何热量数字**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ListMealsResponse, MealLog, MealType } from '@qsh/shared-types';
import DiaryPage from '@/pages/diary/DiaryPage';
import MealItemRow from '@/pages/diary/MealItemRow';
import { COPY, mealMovedLine } from '@/lib/copy';
import { todayKey } from '@/lib/format';
import { cacheClearAll } from '@/lib/local-cache';
import { __resetMemoryQueueForTest, listQueuedRequests } from '@/pwa/offline-queue';

const TODAY = todayKey();

/** 造一条 `MealLog`（字段与契约一致，避免形状漂移）。 */
function makeLog(id: number, name: string, sortOrder: number, mealType: MealType = 'lunch'): MealLog {
  return {
    id,
    userId: 1,
    loggedDate: TODAY,
    mealType,
    foodItemId: null,
    customName: name,
    grams: 100,
    servingUnit: '克',
    servingQty: 1,
    kcal: 200,
    proteinG: null,
    fatG: null,
    carbG: null,
    fiberG: null,
    sodiumMg: null,
    source: 'quick_add',
    comboId: null,
    note: null,
    sortOrder,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

/** 午餐三条：番茄炒蛋(0) / 米饭(1) / 青菜(2)。 */
function mealsResponse(): ListMealsResponse {
  return {
    date: TODAY,
    groups: [
      { mealType: 'breakfast', logs: [], totalKcal: 0 },
      {
        mealType: 'lunch',
        logs: [makeLog(1, '番茄炒蛋', 0), makeLog(2, '米饭', 1), makeLog(3, '青菜', 2)],
        totalKcal: 600,
      },
      { mealType: 'dinner', logs: [], totalKcal: 0 },
      { mealType: 'snack', logs: [], totalKcal: 0 },
    ],
    totalKcal: 600,
  };
}

/** 统一响应包装。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

let captured: CapturedRequest[] = [];
/** PATCH 是否失败（用于回滚用例）。 */
let reorderShouldFail = false;

/** stub 一次 fetch：`/meals` 返回三条，`/reorder` 按开关成功或失败。 */
function stubFetch(): void {
  captured = [];
  reorderShouldFail = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/meals/reorder')) {
        captured.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
        if (reorderShouldFail) {
          throw new Error('offline');
        }
        return ok({ updated: [] });
      }
      if (url.includes('/weights')) {
        return ok({ points: [], movingAverage7: [], stats: {}, forecast: [], goalProgress: null });
      }
      return ok(mealsResponse());
    }),
  );
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DiaryPage initialDate={TODAY} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 等到午餐三条都渲染出来。 */
async function waitForRows(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText('番茄炒蛋')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByText('米饭')).toBeInTheDocument();
  });
}

/** 渲染一个**不挂载拖拽 hook** 的独立行（降级控件的一等公民验证）。 */
function renderRowOnly(overrides: Partial<Parameters<typeof MealItemRow>[0]> = {}): {
  onMoveUp: ReturnType<typeof vi.fn>;
  onMoveDown: ReturnType<typeof vi.fn>;
  onMoveTo: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
} {
  const handlers = {
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onMoveTo: vi.fn(),
    onRemove: vi.fn(),
  };
  render(
    <ul>
      <MealItemRow
        log={makeLog(1, '番茄炒蛋', 0)}
        name="番茄炒蛋"
        kcalLabel="200 kcal"
        gramsLabel="100g"
        canMoveUp={false}
        canMoveDown
        otherMeals={[
          { mealType: 'breakfast', label: '早餐' },
          { mealType: 'dinner', label: '晚餐' },
          { mealType: 'snack', label: '加餐' },
        ]}
        {...handlers}
        {...overrides}
      />
    </ul>,
  );
  return handlers;
}

beforeEach(() => {
  cacheClearAll();
  __resetMemoryQueueForTest();
  window.localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R3.8 降级控件（AC-3.8.7 一票否决）', () => {
  it('不挂载拖拽 hook 时，上移 / 下移 / 移动到某餐 三个控件照常工作', () => {
    const { onMoveUp, onMoveDown, onMoveTo, onRemove } = renderRowOnly();

    // 拖拽手柄不存在（hook 未挂载）
    expect(screen.queryByTestId('meal-drag-handle-1')).not.toBeInTheDocument();

    // 用完整的 aria-label 断言（而不是 data-testid）
    const up = screen.getByLabelText('把「番茄炒蛋」上移');
    const down = screen.getByLabelText('把「番茄炒蛋」下移');
    const moveSelect = screen.getByLabelText('把「番茄炒蛋」移动到另一餐');
    expect(up).toBeInTheDocument();
    expect(down).toBeInTheDocument();
    expect(moveSelect).toBeInTheDocument();

    // 「把「番茄炒蛋」移动到午餐」这条完整语句必须存在于无障碍树
    expect(screen.getByLabelText('把「番茄炒蛋」移动到早餐')).toBeInTheDocument();

    // 边界用 disabled，不隐藏控件
    expect(up).toBeDisabled();
    expect(down).toBeEnabled();

    fireEvent.click(down);
    expect(onMoveDown).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByLabelText('把「番茄炒蛋」移动到晚餐'));
    expect(onMoveTo).toHaveBeenCalledWith(1, 'dinner');

    fireEvent.click(screen.getByLabelText('删除 番茄炒蛋'));
    expect(onRemove).toHaveBeenCalledWith(1);
    expect(onMoveUp).not.toHaveBeenCalled();
  });

  it('挂载拖拽 hook 时手柄出现，但降级控件依旧存在（两条路径并存）', async () => {
    renderPage();
    await waitForRows();

    expect(screen.getByTestId('meal-drag-handle-1')).toBeInTheDocument();
    expect(screen.getByLabelText('把「番茄炒蛋」下移')).toBeInTheDocument();
    expect(screen.getByLabelText('把「番茄炒蛋」移动到早餐')).toBeInTheDocument();
  });
});

describe('R3.8 提交契约（AC-3.8.3）', () => {
  it('「下移」→ PATCH /meals/reorder，orderedIds = 本餐完整期望顺序', async () => {
    renderPage();
    await waitForRows();

    // 番茄炒蛋(1) 是第一条 → 上移 disabled
    expect(screen.getByLabelText('把「番茄炒蛋」上移')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('把「番茄炒蛋」下移'));

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    const request = captured[0] as CapturedRequest;
    expect(request.method).toBe('PATCH');
    expect(request.url).toContain('/api/meals/reorder');
    expect(request.body).toMatchObject({
      loggedDate: TODAY,
      mealType: 'lunch',
      orderedIds: [2, 1, 3],
    });
  });

  it('「移动到某餐」→ 追加到目标餐末尾（Q-1：简单、可预期）', async () => {
    renderPage();
    await waitForRows();

    fireEvent.click(screen.getByLabelText('把「青菜」移动到晚餐'));

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    // 晚餐原本是空的 → orderedIds 只有被移动的那一条
    expect(captured[0]?.body).toMatchObject({ mealType: 'dinner', orderedIds: [3] });
  });

  it('移动成功后播报「已经放到午餐了」，且不改动任何热量', async () => {
    renderPage();
    await waitForRows();

    // AC-3.8.2：移动前后本餐热量展示不变（仍是 600）
    expect(screen.getByText('600')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('把「青菜」移动到晚餐'));

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(mealMovedLine('晚餐'));
    });
    // 热量不因移动而重算
    expect(screen.getByText('600')).toBeInTheDocument();
  });
});

describe('R3.8 失败 / 离线（AC-3.8.9）', () => {
  it('失败 → 入队 + 中性提示，不以「失败」作标题、不用警示词', async () => {
    renderPage();
    await waitForRows();
    reorderShouldFail = true;

    fireEvent.click(screen.getByLabelText('把「番茄炒蛋」下移'));

    await waitFor(() => {
      expect(screen.getByText(COPY.reorderFailed)).toBeInTheDocument();
    });

    // 离线队列里留下这一条（恢复联网后自动重放）
    await waitFor(async () => {
      const queued = await listQueuedRequests();
      expect(queued).toHaveLength(1);
    });
    const queued = await listQueuedRequests();
    expect(queued[0]?.path).toBe('/meals/reorder');
    expect(queued[0]?.method).toBe('PATCH');

    // 语气硬约束：中性陈述
    for (const banned of ['失败', '错误', '警告', '请重试', '超标']) {
      expect(COPY.reorderFailed).not.toContain(banned);
    }
  });
});

describe('R3.8 引导条', () => {
  it('首次进入显示一次，可关闭并持久化', async () => {
    renderPage();
    await waitForRows();

    expect(screen.getByTestId('reorder-guide')).toHaveTextContent(COPY.reorderGuide);

    fireEvent.click(screen.getByLabelText(COPY.reorderGuideAriaClose));
    await waitFor(() => {
      expect(screen.queryByTestId('reorder-guide')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem('mealReorderGuideDismissed')).toBe('1');
  });
});
