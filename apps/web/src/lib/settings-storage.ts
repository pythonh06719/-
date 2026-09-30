/**
 * 设置类本地偏好键（lib/settings-storage.ts）—— **零依赖**模块。
 *
 * ## 为什么单独抽出（GAP-4 复核修复 · P0-1）
 *
 * 单位（`qsh:unit`）、体重单位（`qsh:weightUnit`，D-3）与深色（`qsh:theme`）是**跟着账号走的偏好**，登出换账号时必须清除，
 * 否则新账号在离线（`fetchServerSettings()` 失败、校准静默跳过）时会看到**上一个账号**
 * 的单位、体重单位与深色设置 —— 跨账号数据残留。
 *
 * 清理点是 `auth.store.ts` 的 `clear()`（登出与 401 两条路径的共同入口）。
 * 但 `auth.store` 是 store 层：若它去 import `units.ts` / `theme/useTheme.ts`，
 * 会形成 `auth.store → units → settings-sync → api → auth.store` 的**循环依赖**。
 *
 * 故把「键名 + 清理」收敛到这个**不 import 任何东西**的小模块：
 * `auth.store` 与 `units.ts` / `useTheme.ts` 都只依赖它，依赖图是单向的，零循环。
 *
 * ⚠️ 这两个键**刻意不带** `qsh:cache:` 前缀 —— 它们属于「账号偏好」而非「离线只读缓存」，
 * `cacheClearAll()` 的 `qsh:cache:` 前缀语义不应被撑大（职责分离），故在此单独清理。
 */

/** 单位偏好本地键（与 `units.ts` 的 `UNIT_STORAGE_KEY` 同值）。 */
export const UNIT_PREFERENCE_KEY = 'qsh:unit';

/** 体重单位偏好本地键（与 `units.ts` 的 `WEIGHT_UNIT_STORAGE_KEY` 同值，D-3）。 */
export const WEIGHT_UNIT_PREFERENCE_KEY = 'qsh:weightUnit';

/** 深色模式偏好本地键（与 `theme/tokens.ts` 的 `THEME_STORAGE_KEY` 同值）。 */
export const THEME_PREFERENCE_KEY = 'qsh:theme';

/** 所有「跟账号走的设置类偏好键」，登出时应一并清除。 */
export const PREFERENCE_KEYS: readonly string[] = [
  UNIT_PREFERENCE_KEY,
  WEIGHT_UNIT_PREFERENCE_KEY,
  THEME_PREFERENCE_KEY,
];

/**
 * 清除全部设置类本地偏好（登出 / 401 自动登出时调用）。
 *
 * 静默：`localStorage` 不可用（隐私模式）时忽略，不抛错、不阻塞登出。
 */
export function clearPreferenceKeys(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    for (const key of PREFERENCE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // 忽略：清不掉也不应阻断登出流程
  }
}
