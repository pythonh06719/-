/**
 * CSV 历史体重导入接线测试（GAP-6：改走批量接口）。
 *
 * 核心断言只有一条：**不再逐行 POST**。
 * - 在线：导入 3 行 → **恰好 1 次** `POST /data/import/weights`，且**一次都不发** `POST /weights`；
 * - 离线（`navigator.onLine === false`）：走逐行 `enqueueRequest`，**不发批量请求**
 *   —— 保留「部分成功可恢复」；
 * - 结果提示展示的是**服务端返回的** `imported` / `skipped`（不是前端自己数的行数）；
 * - 明细分两种形状：`{ row, reason }`（与后端一致）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsDataPage from '@/pages/settings-data/SettingsDataPage';
import { __resetMemoryQueueForTest, clearQueuedRequests, listQueuedRequests } from '@/pwa/offline-queue';

vi.mock('@/lib/download', () => ({
  downloadTextFile: vi.fn(),
  downloadExportBundle: vi.fn(),
  readTextFile: vi.fn(),
}));

import { readTextFile } from '@/lib/download';

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

const CSV = ['date,weightKg,note', '2026-07-01,65.2,', '2026-07-02,65,早上', '2026-07-03,64.8,'].join('\n');

/** stub fetch：记录全部请求，`/data/import/weights` 返回批量结果，其余返回空数据。 */
function stubFetch(
  captured: CapturedRequest[],
  importResult: { imported: number; skipped: number; errors: { row: number; reason: string }[] } = {
    imported: 3,
    skipped: 0,
    errors: [],
  },
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
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

    const data = url.includes('/data/import/weights')
      ? importResult
      : url.includes('/data/overview')
        ? { rows: [] }
        : url.includes('/data/export')
          ? {}
          : { points: [] };

    return { ok: true, status: 200, json: async () => ({ data, error: null }) };
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <SettingsDataPage />
    </MemoryRouter>,
  );
}

/** 选中一个 CSV 文件（`readTextFile` 已被 mock）。 */
async function pickCsv(): Promise<void> {
  (readTextFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(CSV);
  const input = screen.getByLabelText('选择 CSV 文件');
  const file = new File([CSV], 'weights.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1));
  // 等导入完成后出现的结果提示（在线路径是异步一次的）
  await screen.findByText(/导入完成/);
}

beforeEach(async () => {
  window.localStorage.clear();
  __resetMemoryQueueForTest();
  await clearQueuedRequests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // 默认在线
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});

describe('SettingsDataPage CSV 导入（GAP-6 批量接口）', () => {
  it('在线：3 行 → 恰好 1 次 POST /data/import/weights，且不发任何 POST /weights', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    renderPage();

    await pickCsv();

    const posts = captured.filter((item) => item.method === 'POST');
    const batchPosts = posts.filter((item) => item.url.includes('/data/import/weights'));
    const legacyPosts = posts.filter((item) => /\/api\/weights(\?|$)/.test(item.url));

    expect(batchPosts).toHaveLength(1);
    expect(legacyPosts).toHaveLength(0);

    // 传的是 rows（不是 csvText）：字段名对齐后端的 date / weightKg / note
    expect(batchPosts[0]?.body).toEqual({
      rows: [
        { date: '2026-07-01', weightKg: 65.2 },
        { date: '2026-07-02', weightKg: 65, note: '早上' },
        { date: '2026-07-03', weightKg: 64.8 },
      ],
    });
  });

  it('在线：结果提示展示的是服务端返回的 imported / skipped', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured, {
      imported: 1,
      skipped: 2,
      errors: [{ row: 3, reason: '日期「x」需要是 YYYY-MM-DD 格式' }],
    });
    renderPage();

    await pickCsv();

    const notice = await screen.findByText(/导入完成：成功 1 条，跳过 2 行。/);
    expect(notice).toBeInTheDocument();
    expect(screen.getByText(/第 3 行：日期「x」需要是 YYYY-MM-DD 格式/)).toBeInTheDocument();
  });

  it('离线：走逐行 enqueueRequest，不发批量请求', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    const captured: CapturedRequest[] = [];
    stubFetch(captured);
    renderPage();

    await pickCsv();

    const batchPosts = captured.filter((item) => item.url.includes('/data/import/weights'));
    expect(batchPosts).toHaveLength(0);

    // 3 行条目全部入队，保留部分成功的可恢复性
    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(3);
    expect(queued.map((item) => item.path)).toEqual(['/weights', '/weights', '/weights']);
    expect(queued[0]?.body).toEqual({ loggedAt: '2026-07-01', weightKg: 65.2 });

    // 结果提示照常（离线也算入「已收下」）
    expect(await screen.findByText(/导入完成：成功 3 条/)).toBeInTheDocument();
  });

  it('非法的 CSV 行不进请求体、只计入 skipped（在线路径）', async () => {
    const captured: CapturedRequest[] = [];
    stubFetch(captured, { imported: 1, skipped: 1, errors: [{ row: 3, reason: '体重越界' }] });
    (readTextFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      ['date,weightKg', '2026-07-01,65', '2026-07-02,9999'].join('\n'),
    );
    renderPage();

    const input = screen.getByLabelText('选择 CSV 文件');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'w.csv', { type: 'text/csv' })] },
    });

    await screen.findByText(/导入完成/);

    const batch = captured.find((item) => item.url.includes('/data/import/weights'));
    // 前端已在解析阶段剔掉非法行 —— 请求体里只有合法的那一条
    expect(batch?.body).toEqual({ rows: [{ date: '2026-07-01', weightKg: 65 }] });
  });
});
