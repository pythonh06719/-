/**
 * Service Worker 离线策略（pwa/service-worker.ts）—— ARCHITECTURE §1.9。
 *
 * 本模块是**策略单一真源**：缓存名与「数据 → 策略」映射在此声明，
 * 由 `vite.config.ts` 在构建时注入 Workbox（`vite-plugin-pwa` → `generateSW`）。
 *
 * 策略总览：
 *
 * | 数据 | 策略 | 说明 |
 * | --- | --- | --- |
 * | 应用壳（HTML/JS/CSS/字体/SVG） | 预缓存（CacheFirst） | 断网可打开（TC-47） |
 * | 食物库（只读） | StaleWhileRevalidate | 离线仍可搜索记录（NFR-4） |
 * | 历史记录（饮食/体重/看板） | NetworkFirst + 缓存兜底 | 离线可查看历史与当日（TC-47） |
 * | 敏感接口（鉴权/导出/删除/AI） | NetworkOnly | 不缓存，仅联网可用 |
 */

/** Workbox 缓存名（与 vite.config.ts 共享，避免字符串漂移）。 */
export const CACHE_NAMES = {
  /** 应用壳预缓存 */
  appShell: 'qsh-app-shell',
  /** 食物库（只读） */
  foods: 'qsh-foods',
  /** 历史记录（饮食 / 体重 / 看板） */
  history: 'qsh-history',
  /** 敏感接口（占位，实际不缓存） */
  sensitive: 'qsh-sensitive',
} as const;

/** 应用壳预缓存的文件类型（构建产物 glob）。 */
export const APP_SHELL_GLOB_PATTERNS: readonly string[] = ['**/*.{js,css,html,svg,woff2}'];

/** 离线策略说明（供「离线可用性」自检与文档展示）。 */
export interface OfflineStrategyEntry {
  /** 匹配的接口前缀（人类可读） */
  match: string;
  /** Workbox 策略名 */
  handler: 'CacheFirst' | 'NetworkFirst' | 'StaleWhileRevalidate' | 'NetworkOnly';
  /** 说明 */
  note: string;
}

/** 数据 → 策略映射（与 vite.config.ts 的 runtimeCaching 保持一致）。 */
export const OFFLINE_STRATEGY: readonly OfflineStrategyEntry[] = [
  { match: '应用壳 / 静态资源', handler: 'CacheFirst', note: '断网也能打开应用（TC-47）' },
  { match: '/api/foods*', handler: 'StaleWhileRevalidate', note: '食物库离线可搜索（NFR-4）' },
  {
    match: '/api/meals* /api/weights* /api/dashboard*',
    handler: 'NetworkFirst',
    note: '离线可查看历史与当日记录（TC-47）',
  },
  {
    match: '/api/auth* /api/onboarding* /api/profile* /api/data* /api/ai*',
    handler: 'NetworkOnly',
    note: '敏感接口不缓存，仅联网可用',
  },
];
