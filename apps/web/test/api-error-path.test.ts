/**
 * HTTP 封装判空测试（lib/api.ts）。
 *
 * 背景：`apiRequest` 在 HTTP 200 时用 `payload.error != null` 判定业务错误。
 * 曾经写成 `payload.error !== null` —— `error` 字段**缺失**（`undefined`）时
 * `undefined !== null` 为真，会把正常响应误判为业务错误并抛异常。
 * 本文件把该修复固化为回归用例（验证用例应当入库，而不是只跑一次就删）。
 *
 * 手法：mock 全局 `fetch`，直打 `apiRequest`，覆盖各响应形态。
 * 用最小 Response 替身而非全局 `Response`，避免依赖运行环境的 fetch 实现。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, apiRequest } from '@/lib/api';

/** 构造最小可用的 fetch Response 替身。`invalidJson` 时 `json()` 抛错（模拟非 JSON 响应体）。 */
function fakeResponse(init: { status: number; body?: unknown; invalidJson?: boolean }): Response {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    json: async () => {
      if (init.invalidJson === true) {
        throw new SyntaxError('Unexpected token < in JSON');
      }
      return init.body;
    },
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

/** 把全局 fetch 换成返回给定响应的 mock，并返回该 mock 以便断言。 */
function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 执行 apiRequest 并捕获抛出的错误（无错误时返回 undefined）。 */
async function captureError<T>(path: string): Promise<unknown> {
  try {
    await apiRequest<T>(path, { auth: false });
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest 响应包装判空（lib/api.ts）', () => {
  it('HTTP 200 + error != null（业务错）→ 抛 ApiClientError（保留字段明细）', async () => {
    mockFetch(
      fakeResponse({
        status: 200,
        body: { data: null, error: { code: 'E_BIZ', message: '业务错误', fields: { a: 'x' } } },
      }),
    );

    const caught = await captureError('/x');
    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught).toMatchObject({ code: 'E_BIZ', message: '业务错误', status: 200, fields: { a: 'x' } });
  });

  it('HTTP 200 + error: null → 正常返回 data', async () => {
    mockFetch(fakeResponse({ status: 200, body: { data: { value: 1 }, error: null } }));

    await expect(apiRequest('/x', { auth: false })).resolves.toEqual({ value: 1 });
  });

  it('HTTP 200 + error 字段缺失 → 正常返回 data（本次修复目标：改动前会误抛）', async () => {
    mockFetch(fakeResponse({ status: 200, body: { data: { value: 2 } } }));

    await expect(apiRequest('/x', { auth: false })).resolves.toEqual({ value: 2 });
  });

  it('HTTP 500 + error != null → 抛 ApiClientError（状态与错误码取自响应体）', async () => {
    mockFetch(
      fakeResponse({
        status: 500,
        body: { data: null, error: { code: 'E_BOOM', message: '服务端异常' } },
      }),
    );

    const caught = await captureError('/x');
    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught).toMatchObject({ code: 'E_BOOM', message: '服务端异常', status: 500 });
  });

  it('HTTP 200 + 非 JSON 响应体 → 不抛，返回 undefined', async () => {
    mockFetch(fakeResponse({ status: 200, invalidJson: true }));

    await expect(apiRequest('/x', { auth: false })).resolves.toBeUndefined();
  });

  it('请求路径拼接为 /api + path', async () => {
    const fetchMock = mockFetch(fakeResponse({ status: 200, body: { data: 1, error: null } }));

    await apiRequest('/weights', { auth: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/weights');
  });
});
