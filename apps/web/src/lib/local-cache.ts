/**
 * 本地缓存（lib/local-cache.ts）—— 离线可看历史（TC-47 / ARCHITECTURE §1.9）。
 *
 * 用 `localStorage` 存放「最近一次成功获取」的只读数据副本：
 * 断网或后端未就绪时，页面回退到这份副本而不是白屏。
 *
 * ⚠️ 不缓存任何敏感接口（导出 / 删除 / AI / 鉴权），与 §1.9 策略一致。
 */

const CACHE_PREFIX = 'qsh:cache:';

/** 缓存键常量（集中管理，避免拼写漂移）。 */
export const CACHE_KEYS = {
  dashboard: (date: string) => `${CACHE_PREFIX}dashboard:${date}`,
  meals: (date: string) => `${CACHE_PREFIX}meals:${date}`,
  weightPoints: `${CACHE_PREFIX}weights:points`,
  foodsRecent: `${CACHE_PREFIX}foods:recent`,
  localBudget: `${CACHE_PREFIX}budget:local`,
} as const;

/** 写入缓存（静默处理：隐私模式 / 容量超限不应影响主流程）。 */
export function cacheSet<T>(key: string, value: T): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略
  }
}

/** 读取缓存（不存在或损坏时返回 `null`）。 */
export function cacheGet<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 删除指定缓存。 */
export function cacheRemove(key: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

/** 清空所有本应用缓存（账号硬删除 / 退出登录时调用，TC-41）。 */
export function cacheClearAll(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.startsWith(CACHE_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 忽略
  }
}
