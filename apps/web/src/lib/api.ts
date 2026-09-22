import type { AiFreeAskResponse, ApiResponse } from '@qsh/shared-types';
import { getAccessToken, useAuthStore } from './auth.store';

/**
 * HTTP 封装（lib/api.ts）—— 统一 `{ data, error }` 解包（ARCHITECTURE §7 K2 / §7 K3）。
 *
 * 约定：
 * - 所有请求打 `/api/*`（dev 由 Vite proxy 转发到 3000；生产由反向代理转发）
 * - 自动携带 `Authorization: Bearer <accessToken>`
 * - **401 自动清 token 并广播 `qsh:unauthorized`**（由路由层统一跳转登录）
 * - 网络异常 / 后端未就绪 → 抛出 `ApiClientError`，文案遵守 PRD §7（温和、不指责）
 *
 * ⚠️ 后端（T03）可能尚未启动：调用方**必须**对 `ApiClientError` 做优雅降级，
 * 不得白屏（T04 交付要求）。
 */

/** 网络不可达 / 后端未就绪时使用的错误码（区分于服务端业务错误码）。 */
export const NETWORK_ERROR_CODE = 'E_NETWORK';

/** 401 广播事件名。 */
export const UNAUTHORIZED_EVENT = 'qsh:unauthorized';

/** 统一 HTTP 方法集。 */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** 查询参数：`undefined` / `null` 的键会被自动忽略。 */
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/** 客户端错误：把「服务端错误码 / 网络异常」统一为可判别的对象。 */
export class ApiClientError extends Error {
  /** 错误码（`E_*`；网络异常为 `E_NETWORK`） */
  readonly code: string;
  /** HTTP 状态码（网络异常为 0） */
  readonly status: number;
  /** 字段级错误明细（可选） */
  readonly fields?: Record<string, string>;
  /** 原始异常（仅网络层） */
  override readonly cause?: unknown;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    fields?: Record<string, string>;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'ApiClientError';
    this.code = options.code;
    this.status = options.status;
    this.fields = options.fields;
    this.cause = options.cause;
  }
}

/** 是否网络层错误（用于决定「离线兜底」还是「展示业务错误」）。 */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === NETWORK_ERROR_CODE;
}

/** 状态码 → 温和的中文提示（PRD §7：不指责、不恐吓）。 */
const FRIENDLY_BY_STATUS: Record<number, string> = {
  400: '这次填写的信息好像还没填全，检查一下再试试就好',
  401: '登录状态已经过期，我们重新登录一次吧',
  403: '这部分内容暂时无法查看',
  404: '没有找到这条内容，换个条件再看看',
  409: '这个日期已经有一条记录了，我们更新它吧',
  422: '有些内容需要再确认一下',
  429: '操作有点频繁，稍等片刻再试一次就好',
  500: '服务端在开小差，稍后我们再来一次',
  502: '服务端在开小差，稍后我们再来一次',
  503: '服务端在开小差，稍后我们再来一次',
};

/** 网络不可达时的友好提示（离线时优先展示缓存内容）。 */
export const OFFLINE_MESSAGE = '网络好像不太稳定，先看看已经缓存的内容吧';

function friendlyMessage(status: number): string {
  return FRIENDLY_BY_STATUS[status] ?? '这一步没有成功，稍后我们再试一次就好';
}

/** 拼接查询串（自动跳过空值）。 */
export function buildUrl(path: string, query?: QueryParams): string {
  const base = path.startsWith('/') ? path : `/${path}`;
  if (query === undefined) {
    return base;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? base : `${base}?${qs}`;
}

function emitUnauthorized(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
}

/** 请求选项。 */
export interface RequestOptions {
  /** HTTP 方法，默认 GET */
  method?: HttpMethod;
  /** 请求体（自动 JSON 序列化） */
  body?: unknown;
  /** 查询参数 */
  query?: QueryParams;
  /** 是否附带鉴权头，默认 true */
  auth?: boolean;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** 底层请求：返回**已解包**的 `data`，未成功时抛 `ApiClientError`。 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, auth = true, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (auth) {
    const token = getAccessToken();
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(`/api${path}`, query), {
      method,
      headers,
      signal,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // 断网 / 后端未启动 / CORS 未成功统一归为网络层错误
    throw new ApiClientError({ code: NETWORK_ERROR_CODE, status: 0, message: OFFLINE_MESSAGE, cause });
  }

  // 无内容响应
  if (response.status === 204) {
    return undefined as T;
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    payload = null;
  }

  if (response.status === 401) {
    useAuthStore.getState().clear();
    emitUnauthorized();
    const unauthorizedMessage = payload?.error?.message ?? friendlyMessage(401);
    throw new ApiClientError({
      code: payload?.error?.code ?? 'E_AUTH_UNAUTHORIZED',
      status: 401,
      message: unauthorizedMessage,
    });
  }

  if (!response.ok) {
    const errorBody = payload?.error ?? null;
    throw new ApiClientError({
      code: errorBody?.code ?? `E_HTTP_${response.status}`,
      status: response.status,
      message: errorBody?.message ?? friendlyMessage(response.status),
      fields: errorBody?.fields,
    });
  }

  // HTTP 200 但业务包装内是错误（防御性处理）。
  // 用 `!= null` 而非 `!== null`：`error` 字段**缺失**（undefined）时也应视为「无错误」，
  // 否则 `undefined !== null` 为真会把正常响应误判为业务错误并抛异常。
  if (payload !== null && payload.error != null) {
    throw new ApiClientError({
      code: payload.error.code,
      status: response.status,
      message: payload.error.message,
      fields: payload.error.fields,
    });
  }

  if (payload !== null && 'data' in payload) {
    return payload.data as T;
  }

  return undefined as T;
}

/** 便捷方法集合。 */
export const api = {
  get: <T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T> =>
    apiRequest<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string): Promise<T> => apiRequest<T>(path, { method: 'DELETE' }),
} as const;


/**
 * 流式 Agent 事件（`POST /ai/agent/stream` 的 SSE 载荷）。
 *
 * `step` 的形状与后端 `AgentStep` 一致；`done` 携带与 `POST /ai/agent`
 * 相同的终态字段（status / answer / traceId / pending …）。
 */
export type AgentStreamEvent =
  | { type: 'start' }
  | {
      type: 'step';
      step: {
        index: number;
        type: string;
        tool?: string;
        note?: string;
        result?: string;
        args?: Record<string, unknown>;
        ms?: number;
      };
    }
  | {
      type: 'done';
      status: string;
      answer: string;
      steps: unknown[];
      tokens: number;
      durationMs: number;
      traceId: number | null;
      pending?: unknown;
      result: AiFreeAskResponse;
    }
  | { type: 'error'; message: string };

/**
 * SSE 流式请求（POST + `Authorization` + 请求体）。
 *
 * 为什么不用 `EventSource`：它只支持 GET 且无法带 `Authorization` 头 ——
 * Agent 需要带请求体的 POST，故用 `fetch` + `ReadableStream` 手工解析 SSE 帧。
 *
 * 协议：每条事件为 `data: {json}\n\n`；按空行分帧，并正确处理
 * 「一个事件被拆进多个 chunk」「一个 chunk 含多个事件」两种情况（用缓冲区累积）。
 *
 * ⚠️ 本函数**不内置降级**：流式不可用时抛 `E_STREAM_UNSUPPORTED`（或网络/HTTP 错误），
 * 由调用方决定回退策略 —— 现有唯一调用方 AiPage 的做法是「catch 后改调对应的非流式端点」，
 * 新增调用方请沿用同一模式（服务端 SSE 端点与普通端点共用同一套业务逻辑，回退是安全的）。
 */
export async function postStream(
  path: string,
  body: unknown,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const token = getAccessToken();
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(`/api${path}`), {
      method: 'POST',
      headers,
      signal,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiClientError({ code: NETWORK_ERROR_CODE, status: 0, message: OFFLINE_MESSAGE, cause });
  }

  if (response.status === 401) {
    useAuthStore.getState().clear();
    emitUnauthorized();
    throw new ApiClientError({ code: 'E_AUTH_UNAUTHORIZED', status: 401, message: friendlyMessage(401) });
  }

  if (!response.ok) {
    throw new ApiClientError({
      code: `E_HTTP_${response.status}`,
      status: response.status,
      message: friendlyMessage(response.status),
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    throw new ApiClientError({
      code: 'E_STREAM_UNSUPPORTED',
      status: response.status,
      message: '服务端未返回流式响应，请改用普通请求',
    });
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ApiClientError({
      code: 'E_STREAM_UNSUPPORTED',
      status: 0,
      message: '当前浏览器不支持流式读取',
    });
  }

  const decoder = new TextDecoder();
  let buffer = '';

  /** 解析一帧（可能含多行，只认 `data: ` 前缀）；单条坏帧忽略，不中断整条流。 */
  const flush = (chunk: string): void => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as AgentStreamEvent);
      } catch {
        /* 忽略 */
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      flush(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  // 收尾：流结束时缓冲区里可能还有最后一帧（未以空行结尾）
  if (buffer.length > 0) {
    flush(buffer);
  }
}
