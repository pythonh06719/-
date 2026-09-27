import Taro from '@tarojs/taro'
import type { ApiResponse, ApiError } from '@qsh/shared-types'

import { API_BASE_URL } from '../config'
import { tokenStorage } from './storage'

export class ApiClientError extends Error {
  code: string
  status: number
  fields?: Record<string, string>
  constructor(
    message: string,
    code: string,
    status: number,
    fields?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.fields = fields
  }
}

function buildUrl(
  base: string,
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return base
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return qs ? `${base}?${qs}` : base
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  auth?: boolean
  query?: Record<string, string | number | undefined>
}

/**
 * 统一请求封装：替 fetch，走 Taro.request；自动带 Bearer；统一解包 {data,error} 信封。
 * 401 → 清 token + 广播 qsh:unauthorized；网络失败 → E_NETWORK。
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, query } = options
  const url = buildUrl(`${API_BASE_URL}/api${path}`, query)
  const header: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) {
    const token = tokenStorage.get()
    if (token) header.Authorization = `Bearer ${token}`
  }

  // ⚠️ 这里刻意用**最小结构化类型**而不是 `Taro.request.SuccessCallbackResult<unknown>`：
  // 后者会触发 TS2344（`Taro.request` 的泛型约束只接受 `string | IAnyObject | ArrayBuffer`，
  // 而我们要把响应体当 `unknown` 再逐步收窄）。我们只用得到 `statusCode` / `data` 两个字段。
  let res: { statusCode: number; data: unknown }
  try {
    res = await Taro.request({ url, method, data: body as any, header })
  } catch {
    throw new ApiClientError('网络异常，请检查网络后重试', 'E_NETWORK', 0)
  }

  const status = res.statusCode
  const payload = res.data as
    | ApiResponse<T>
    | ApiError
    | Record<string, unknown>
    | null

  if (status === 401) {
    tokenStorage.clear()
    Taro.eventCenter.trigger('qsh:unauthorized')
    throw new ApiClientError('登录已过期，请重新登录', 'E_AUTH_UNAUTHORIZED', 401)
  }
  if (status < 200 || status >= 300) {
    const err = (payload ?? {}) as Partial<ApiError>
    throw new ApiClientError(
      err.message || '请求失败，请稍后再试',
      err.code || `E_HTTP_${status}`,
      status,
      err.fields,
    )
  }
  // 成功信封 { data, error: null }；业务失败 { data:null, error:{...} }
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    (payload as { error?: unknown }).error
  ) {
    const err = (payload as { error: ApiError }).error
    throw new ApiClientError(
      err.message || '操作失败',
      err.code || 'E_BUSINESS',
      status,
      err.fields,
    )
  }
  return (payload as ApiResponse<T>).data as T
}
