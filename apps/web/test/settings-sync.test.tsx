/**
 * 单位 / 深色设置落库与校准测试（GAP-4）。
 *
 * ## 背景（这是「文案已承诺、行为相反」的缺口）
 *
 * 导出 JSON 备份的页面上写着「JSON 可完整恢复」，后端导出 / 恢复链路的 `settings` 段
 * 也是**完整**的（真读真写 `userSettings` 表）。但前端**从不调用** `/users/settings`：
 * 单位（`lib/units.ts`）与深色（`theme/useTheme.ts`）只写本机 `localStorage`。
 * 后果：用户切到 kJ、开深色 → 导出 JSON 里仍是 `kcal / false` → 按承诺恢复后设置丢失。
 *
 * 本文件把修复后的契约固定下来：
 * - 切单位 / 切深色 → **确实调用** `PATCH /users/settings` 且 body 含对应字段；
 * - **localStorage 仍被写**（双层结构：快路径 + 服务端权威，不能退化）；
 * - 落库失败 → 本地仍生效、**不抛红**、静默重试；
 * - 登录后 `GET /users/settings` 返回非默认值 → 本地被校准（服务端为准）；
 * - 导出时 `payload.settings` 等于服务端值，**不被本地覆盖**。
 *
 * 手法：mock 全局 `fetch`（与既有 `settings-backup.test.tsx` 一致），
 * 断言实际请求 URL / method / body，而不是断言内部实现。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { UNIT_STORAGE_KEY, useUnitStore } from '@/lib/units';
import { hydrateThemeFromServer } from '@/theme/useTheme';
import { THEME_STORAGE_KEY } from '@/theme/tokens';
import { pushSettings } from '@/lib/settings-sync';
import SettingsDataPage from '@/pages/settings-data/SettingsDataPage';
import { createEmptyExportPayload } from '@/lib/csv';

vi.mock('@/lib/download', () => ({
  downloadTextFile: vi.fn(),
  downloadExportBundle: vi.fn(),
  readTextFile: vi.fn(),
}));

import { downloadExportBundle } from '@/lib/download';

/** 统一 `{ data, error }` 包装的成功响应。 */
function wrappedResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, error: null }),
  } as unknown as Response;
}

/** 记录每次 fetch 的 (url, method, body)，返回 mock。 */
function stubFetchOk(data: unknown = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => wrappedResponse(data));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** 从 fetch mock 中筛出对 `/users/settings` 的调用。 */
function settingsCalls(
  fetchMock: ReturnType<typeof vi.fn>,
): Array<{ url: string; method: string; body: unknown }> {
  return fetchMock.mock.calls
    .map((call) => ({
      url: String(call[0]),
      method: String((call[1] as RequestInit | undefined)?.method ?? 'GET'),
      body:
        (call[1] as RequestInit | undefined)?.body === undefined
          ? undefined
          : JSON.parse(String((call[1] as RequestInit).body)),
    }))
    .filter((entry) => entry.url.includes('/api/users/settings'));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // 复位 store 到默认：避免用例间相互污染
  useUnitStore.setState({ unit: 'kcal' });
  document.documentElement.classList.remove('dark');
});

describe('GAP-4：单位切换落库（setUnit / toggle）', () => {
  it('切单位 → PATCH /users/settings 且 body 含 unit', async () => {
    const fetchMock = stubFetchOk();

    useUnitStore.getState().setUnit('kj');

    await waitFor(() => {
      expect(settingsCalls(fetchMock).length).toBeGreaterThan(0);
    });

    const call = settingsCalls(fetchMock)[0];
    expect(call).toBeDefined();
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ unit: 'kj' });
  });

  it('toggle 也会落库（走同一路径）', async () => {
    const fetchMock = stubFetchOk();

    useUnitStore.getState().toggle(); // kcal → kj

    await waitFor(() => {
      expect(settingsCalls(fetchMock).length).toBeGreaterThan(0);
    });
    expect(settingsCalls(fetchMock)[0]?.body).toEqual({ unit: 'kj' });
  });

  it('切单位后 localStorage 仍被写（双层结构未退化，首屏无闪烁）', () => {
    stubFetchOk();

    useUnitStore.getState().setUnit('kj');

    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBe('kj');
    expect(useUnitStore.getState().unit).toBe('kj');
  });
});

describe('GAP-4：深色模式落库（setMode 走 useTheme）', () => {
  it('手动切深色 → PATCH /users/settings 且 body 含 darkMode=true', async () => {
    const fetchMock = stubFetchOk();
    const { useTheme } = await import('@/theme/useTheme');

    // 用一个最小宿主组件驱动 hook
    function Host(): JSX.Element {
      const { setMode } = useTheme();
      return (
        <button type="button" onClick={() => setMode('dark')}>
          go-dark
        </button>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText('go-dark'));

    await waitFor(() => {
      expect(settingsCalls(fetchMock).length).toBeGreaterThan(0);
    });
    expect(settingsCalls(fetchMock)[0]?.body).toEqual({ darkMode: true });
  });

  it('手动切浅色 → body 含 darkMode=false；localStorage 仍被写', async () => {
    const fetchMock = stubFetchOk();
    const { useTheme } = await import('@/theme/useTheme');

    function Host(): JSX.Element {
      const { setMode } = useTheme();
      return (
        <button type="button" onClick={() => setMode('light')}>
          go-light
        </button>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText('go-light'));

    await waitFor(() => {
      expect(settingsCalls(fetchMock).length).toBeGreaterThan(0);
    });
    expect(settingsCalls(fetchMock)[0]?.body).toEqual({ darkMode: false });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('GAP-4：落库失败不打断用户操作（无负罪感）', () => {
  it('pushSettings 失败 → 不抛错、静默重试一次', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    // 不 reject（fire-and-forget 契约）
    await expect(pushSettings({ unit: 'kj' })).resolves.toBeUndefined();
    // 首次 + 一次重试
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('切单位时落库失败 → 本地仍生效，不抛红', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    expect(() => useUnitStore.getState().setUnit('kj')).not.toThrow();
    expect(useUnitStore.getState().unit).toBe('kj');
    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBe('kj');
  });
});

describe('GAP-4：登录后服务端值校准本地', () => {
  it('服务端 unit=kj、本地为 kcal → 校准后本地变 kj 且落 localStorage', async () => {
    stubFetchOk({ unit: 'kj', darkMode: false, fastingEnabled: false, waterGoalMl: 2000 });
    useUnitStore.setState({ unit: 'kcal' });

    const { hydrateUnitFromServer } = await import('@/lib/units');
    await hydrateUnitFromServer();

    expect(useUnitStore.getState().unit).toBe('kj');
    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBe('kj');
  });

  it('服务端 darkMode=true、本地为浅色 → 校准后加 dark class 且落 localStorage', async () => {
    stubFetchOk({ unit: 'kcal', darkMode: true, fastingEnabled: false, waterGoalMl: 2000 });
    document.documentElement.classList.remove('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');

    await hydrateThemeFromServer();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('服务端不可达 → 校准静默跳过，本地保持原值（不白屏、不抛错）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.setState({ unit: 'kcal' });

    const { hydrateUnitFromServer } = await import('@/lib/units');
    await expect(hydrateUnitFromServer()).resolves.toBeUndefined();

    expect(useUnitStore.getState().unit).toBe('kcal');
  });
});

describe('GAP-4：导出时 payload.settings 反映服务端真值（不被本地覆盖）', () => {
  it('服务端 unit=kj/darkMode=true，本地为 kcal/浅色 → 导出的 JSON settings 取服务端值', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/users/settings')) {
        return wrappedResponse({
          unit: 'kj',
          darkMode: true,
          fastingEnabled: true,
          waterGoalMl: 2000,
        });
      }
      if (u.includes('/api/data/overview')) {
        return wrappedResponse({
          weights: { count: 0, from: null, to: null },
          meals: { count: 0, from: null, to: null },
          exercises: { count: 0, from: null, to: null },
          habits: { count: 0, from: null, to: null },
          water: { count: 0, from: null, to: null },
          wins: { count: 0, from: null, to: null },
        });
      }
      // /weights 与 /profile：返回空 / 最小可用
      return wrappedResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    // 本地故意与服务端不一致
    useUnitStore.setState({ unit: 'kcal' });
    document.documentElement.classList.remove('dark');

    render(
      <MemoryRouter>
        <SettingsDataPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '一键导出 JSON + CSV' }));

    await waitFor(() => {
      expect(downloadExportBundle).toHaveBeenCalledTimes(1);
    });

    const bundle = (downloadExportBundle as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { json: { settings: unknown } };
    expect(bundle.json.settings).toEqual({
      unit: 'kj',
      darkMode: true,
      fastingEnabled: true,
    });
  });

  it('服务端不可达 → 导出回退本地状态（离线仍可导出，体面降级）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.setState({ unit: 'kj' });

    render(
      <MemoryRouter>
        <SettingsDataPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: '一键导出 JSON + CSV' }));

    await waitFor(() => {
      expect(downloadExportBundle).toHaveBeenCalledTimes(1);
    });

    const bundle = (downloadExportBundle as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { json: { settings: { unit: string } } };
    expect(bundle.json.settings.unit).toBe('kj');
  });
});
