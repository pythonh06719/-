import { flushQueue } from './offline-queue';

/**
 * Service Worker 注册与离线队列自动同步（pwa/registerSW.ts）。
 *
 * - `registerType: 'autoUpdate'`：新版本就绪后自动接管，无需用户操作；
 * - 应用重新联网（`online` 事件）或首次加载时，自动尝试同步离线队列；
 * - **不发任何用户未开启的通知**（NFR-10）：本模块不调用 `Notification`。
 */

const SW_URL = '/sw.js';

let started = false;

/** 注册 Service Worker（幂等；不支持的环境静默跳过）。 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SW_URL).catch(() => {
      // 离线能力不可用不影响主流程
    });
  });
}

/** 启动「联网即同步」监听（幂等）。 */
export function startOfflineSync(): void {
  if (started || typeof window === 'undefined') {
    return;
  }
  started = true;

  const trySync = (): void => {
    void flushQueue();
  };

  window.addEventListener('online', trySync);
  // 首次加载若已联网，也尝试一次（清理上次会话遗留的队列）
  if (navigator.onLine) {
    trySync();
  }
}

/** 一次性初始化（供 `main.tsx` 调用）。 */
export function initPwa(): void {
  registerServiceWorker();
  startOfflineSync();
}

/** 当前是否离线（供 UI 展示离线提示）。 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
