/**
 * 「账号被停用」的会话收口测试（上线前全检 F-004 的配套修复）。
 *
 * 背景：F-004 让停用账号的旧 accessToken **按请求**失效（鉴权层返回 403
 * `E_AUTH_USER_DISABLED`）。但如果前端只把 401 当会话失效，被停用的用户会停在
 * 「已登录」假象里：页面不跳登录、每请求 403、无法自愈（安全官复核发现）。
 *
 * 本文件把「403 + E_AUTH_USER_DISABLED 也清会话」固化为回归用例，并**反向**钉住
 * 「其它 403 不清会话」—— 避免将来新增别的 403 语义时误把用户踢下线。
 *
 * 手法与 `api-error-path.test.ts` 一致：mock 全局 fetch，直打 `apiRequest`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, UNAUTHORIZED_EVENT, apiRequest } from '@/lib/api';
import { useAuthStore } from '@/lib/auth.store';

/** 构造最小可用的 fetch Response 替身。 */
function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

function mockFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

/** 执行 apiRequest 并捕获抛出的错误（无错误时返回 undefined）。 */
async function captureError(path: string): Promise<unknown> {
  try {
    await apiRequest<unknown>(path, { auth: true });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** 把 store 置为「已登录」态，返回是否仍持有 token 的读取器。 */
function signIn(): () => string | null {
  useAuthStore.setState({ accessToken: 'e2e-token', status: 'authenticated' });
  return () => useAuthStore.getState().accessToken;
}

let events: string[] = [];
function collectUnauthorized(): void {
  events = [];
  window.addEventListener(UNAUTHORIZED_EVENT, () => {
    events.push(UNAUTHORIZED_EVENT);
  });
}

beforeEach(() => {
  useAuthStore.getState().clear();
  collectUnauthorized();
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.getState().clear();
});

describe('停用账号的 403 会清会话（F-004 前端收口）', () => {
  it('403 E_AUTH_USER_DISABLED → 清 token + 广播未授权事件 + 抛出该错误码', async () => {
    const tokenOf = signIn();
    mockFetch(
      fakeResponse(403, {
        data: null,
        error: { code: 'E_AUTH_USER_DISABLED', message: '该账号已停用，如有疑问请联系我们' },
      }),
    );

    const error = await captureError('/auth/me');

    expect(tokenOf()).toBeNull();
    expect(events).toContain(UNAUTHORIZED_EVENT);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('E_AUTH_USER_DISABLED');
    expect((error as ApiClientError).status).toBe(403);
  });

  it('反向：其它 403（非停用）**不**清会话，避免误踢用户', async () => {
    const tokenOf = signIn();
    mockFetch(
      fakeResponse(403, { data: null, error: { code: 'E_HTTP_403', message: '没有权限访问该内容' } }),
    );

    const error = await captureError('/auth/me');

    expect(tokenOf()).toBe('e2e-token');
    expect(events).toEqual([]);
    expect((error as ApiClientError).status).toBe(403);
  });
});
