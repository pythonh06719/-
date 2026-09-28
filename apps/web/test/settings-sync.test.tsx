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
import { __resetDirtyForTest, hasPendingSettings, pushSettings } from '@/lib/settings-sync';
import { clearPreferenceKeys } from '@/lib/settings-storage';
import { useAuthStore } from '@/lib/auth.store';
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
  // 复位 dirty 标记（内存 + localStorage）
  __resetDirtyForTest();
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

// ---------------------------------------------------------------------------
// P0-1（QA 证伪）：跨账号设置残留 —— 登出必须清掉 qsh:unit / qsh:theme
// ---------------------------------------------------------------------------

describe('P0-1：登出清偏好，杜绝跨账号残留', () => {
  it('clear() 之后 qsh:unit 与 qsh:theme 均被清除', () => {
    window.localStorage.setItem(UNIT_STORAGE_KEY, 'kj');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    useAuthStore.getState().clear();

    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('clear() 同步复位内存态：unit 回默认，dark class 移除', async () => {
    useUnitStore.getState().setUnit('kj');
    document.documentElement.classList.add('dark');

    useAuthStore.getState().clear();

    // 内存态复位是 fire-and-forget 的动态 import，等待微任务落地
    await waitFor(() => {
      expect(useUnitStore.getState().unit).toBe('kcal');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('登出 → 换账号登录：新账号拿到的是服务端值，而非上个账号的残留', async () => {
    // 账号 A：本地切到 kj / dark（落库失败，留下 dirty —— 模拟离线改动）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.getState().setUnit('kj');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    await waitFor(() => {
      expect(hasPendingSettings()).toBe(true);
    });

    // 登出（清偏好 + 复位内存态 + 清 dirty）
    useAuthStore.getState().clear();
    await waitFor(() => {
      expect(useUnitStore.getState().unit).toBe('kcal');
    });
    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    // 账号 A 的 dirty 绝不可带到账号 B
    expect(hasPendingSettings()).toBe(false);

    // 账号 B 登录：服务端偏好为 unit=kj、darkMode=false
    stubFetchOk({ unit: 'kj', darkMode: false, fastingEnabled: false, waterGoalMl: 2000 });
    const { hydrateUnitFromServer } = await import('@/lib/units');
    await hydrateUnitFromServer();

    // 校准后为新账号 B 的服务端值（无 dirty → 允许校准）
    expect(useUnitStore.getState().unit).toBe('kj');
  });

  it('clearPreferenceKeys 不触碰 qsh:cache:* 键（职责分离）', () => {
    window.localStorage.setItem('qsh:cache:meals:2026-09-24', '{}');
    window.localStorage.setItem(UNIT_STORAGE_KEY, 'kj');

    clearPreferenceKeys();

    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBeNull();
    // cache 前缀的键由 cacheClearAll 负责，clearPreferenceKeys 不应越界
    expect(window.localStorage.getItem('qsh:cache:meals:2026-09-24')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P0-2（QA 证伪）：离线改动被服务端静默吞掉 —— dirty 标记 + 联网重推
// ---------------------------------------------------------------------------

describe('P0-2：离线改动不被服务端吞掉', () => {
  it('离线切单位（pushSettings 失败）→ 本地保持用户选择，且标记 dirty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    useUnitStore.getState().setUnit('kj');
    // 等落库失败路径走完（首次 + 重试）
    await waitFor(() => {
      expect(hasPendingSettings()).toBe(true);
    });

    expect(useUnitStore.getState().unit).toBe('kj');
    expect(window.localStorage.getItem(UNIT_STORAGE_KEY)).toBe('kj');
  });

  it('补推失败但 GET 可达时 hydrate：**不**用服务端旧值覆盖本地改动', async () => {
    // 关键场景：PATCH 失败（dirty 留存）但 GET 仍可达 —— 这正是守卫要拦截的窗口。
    // 若只 mock 全离线，GET 也失败会返回 null，校准自然不发生，测不出守卫本身。
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH') {
        throw new Error('patch-failed');
      }
      // GET 返回服务端**旧值** kcal
      return wrappedResponse({
        unit: 'kcal',
        darkMode: false,
        fastingEnabled: false,
        waterGoalMl: 2000,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 本地切 kj（PATCH 失败 → dirty）
    const { pushSettings: push } = await import('@/lib/settings-sync');
    await push({ unit: 'kj' });
    useUnitStore.setState({ unit: 'kj' });
    expect(hasPendingSettings()).toBe(true);

    const { hydrateUnitFromServer } = await import('@/lib/units');
    await hydrateUnitFromServer();

    // 本地改动必须胜出：仍是 kj，不被服务端 kcal 覆盖
    expect(useUnitStore.getState().unit).toBe('kj');
    expect(hasPendingSettings()).toBe(true);
  });

  it('恢复联网 → 补推本地最新值，且推送成功后 dirty 清除', async () => {
    // 制造 dirty
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.getState().setUnit('kj');
    await waitFor(() => {
      expect(hasPendingSettings()).toBe(true);
    });

    // 联网：后续请求成功
    const fetchMock = stubFetchOk({ unit: 'kj', darkMode: false, fastingEnabled: false, waterGoalMl: 2000 });
    const { flushPendingSettings } = await import('@/lib/settings-sync');
    const pushed = await flushPendingSettings({ unit: useUnitStore.getState().unit });

    expect(pushed).toBe(true);
    const calls = settingsCalls(fetchMock);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.body).toEqual({ unit: 'kj' }); // 推的是**本地最新值**
    expect(hasPendingSettings()).toBe(false); // dirty 已清
  });

  it('联网后 hydrate：先补推本地值，再校准（最终本地 = 用户所选）', async () => {
    // 制造 dirty（离线切 kj）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    useUnitStore.getState().setUnit('kj');
    await waitFor(() => {
      expect(hasPendingSettings()).toBe(true);
    });

    // 联网：PATCH 成功，随后 GET 返回「已被本地上推后的」服务端值 kj
    stubFetchOk({ unit: 'kj', darkMode: false, fastingEnabled: false, waterGoalMl: 2000 });
    const { hydrateUnitFromServer } = await import('@/lib/units');
    await hydrateUnitFromServer();

    expect(useUnitStore.getState().unit).toBe('kj');
    expect(hasPendingSettings()).toBe(false);
  });

  it('深色同理：补推失败但 GET 可达时 hydrate 不被服务端旧值覆盖', async () => {
    // PATCH 失败（dirty 留存）但 GET 可达返回旧值 darkMode=false —— 隔离守卫本身
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PATCH') {
          throw new Error('patch-failed');
        }
        return wrappedResponse({
          unit: 'kcal',
          darkMode: false,
          fastingEnabled: false,
          waterGoalMl: 2000,
        });
      }),
    );
    document.documentElement.classList.add('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    await pushSettings({ darkMode: true });
    expect(hasPendingSettings()).toBe(true);

    await hydrateThemeFromServer();

    // 本地仍是深色（用户选择胜出）
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(hasPendingSettings()).toBe(true);
  });
});
