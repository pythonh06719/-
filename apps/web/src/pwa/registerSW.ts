import { flushQueue } from './offline-queue';

/**
 * Service Worker 注册与离线队列自动同步（pwa/registerSW.ts）。
 *
 * - `registerType: 'autoUpdate'`：新版本就绪后由 SW 自行 `skipWaiting()` + `clientsClaim()`
 *   （构建产物 `dist/sw.js` 开头即如此），**不需要用户确认**即可接管；
 *   但接管只影响**下一次导航**，当前页面跑的仍是旧包 —— 所以这里检测到新版本后
 *   **提示**用户「点击刷新」，而不是静默 reload（避免打断正在填写的表单）。
 * - 应用重新联网（`online` 事件）或首次加载时，自动尝试同步离线队列；
 * - **不发任何用户未开启的通知**（NFR-10）：本模块不调用 `Notification`。
 */

const SW_URL = '/sw.js';

/** 「新版本已就绪」自定义事件名（除回调订阅外，页面也可直接监听该事件）。 */
export const SW_UPDATE_EVENT = 'qsh:sw-update';

/** 与 SW 约定的消息协议（vite-plugin-pwa 的 `prompt` 模式产物同样认这个消息）。 */
const SKIP_WAITING_MESSAGE: { type: 'SKIP_WAITING' } = { type: 'SKIP_WAITING' };

/** 等待新 SW 接管的最长时间：超时则直接刷新，避免卡在旧页面。 */
const TAKEOVER_TIMEOUT_MS = 1500;

let started = false;
/** 是否已注册过（幂等，避免重复挂监听）。 */
let registered = false;
/** 注册对象（供「立即更新」时找到 waiting 中的 worker）。 */
let currentRegistration: ServiceWorkerRegistration | null = null;
/** 「新版本已就绪」订阅者。 */
const updateListeners = new Set<() => void>();
/** 本次会话是否已通知过（重复通知会让提示条反复弹出）。 */
let updateNotified = false;
/** 是否已在刷新流程中（避免用户连点触发多次 reload）。 */
let reloading = false;

/** 广播「新版本已就绪」（同一会话只播一次）。 */
function notifyUpdate(): void {
  if (updateNotified) {
    return;
  }
  updateNotified = true;

  // 拷贝一份再遍历：回调里可能顺手退订，避免遍历中修改集合
  for (const listener of [...updateListeners]) {
    listener();
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT));
  }
}

/**
 * 订阅「新版本已就绪」。
 *
 * 若订阅前就已就绪（组件挂载晚于 SW 更新），回调会**立即补触发一次**，
 * 避免「更新发生在挂载之前 → 提示条永远不出现」。
 *
 * @param listener 就绪回调
 * @returns 退订函数（直接作为 `useEffect` 的返回值即可）
 */
export function onServiceWorkerUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  if (updateNotified) {
    listener();
  }
  return () => {
    updateListeners.delete(listener);
  };
}

/** 本次会话是否已检测到新版本。 */
export function hasServiceWorkerUpdate(): boolean {
  return updateNotified;
}

/**
 * 跟踪一个 worker：它安装完成（`installed`）且页面**已有**控制者时，
 * 说明这不是首次安装，而是「新版本就绪」。
 */
function trackWorker(worker: ServiceWorker | null): void {
  if (!worker) {
    return;
  }
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      notifyUpdate();
    }
  });
}

/** 挂上「新版本就绪」的三条检测路径（互相兜底，任一命中即通知）。 */
function watchRegistration(registration: ServiceWorkerRegistration): void {
  currentRegistration = registration;

  // ① 注册时就已有等待中的新版本（上一会话装好的，还没接管）
  if (registration.waiting && navigator.serviceWorker.controller) {
    notifyUpdate();
  }

  // ② 之后才发现新版本：`updatefound` → 跟踪 `installing`
  registration.addEventListener('updatefound', () => {
    trackWorker(registration.installing);
  });

  // ③ 注册完成的瞬间就已经在装新 worker（此时 `updatefound` 可能早于监听派发过）
  trackWorker(registration.installing);
}

/** 注册 Service Worker（幂等；不支持的环境静默跳过）。 */
export function registerServiceWorker(): void {
  if (registered || typeof window === 'undefined' || typeof navigator === 'undefined') {
    return;
  }
  if (!('serviceWorker' in navigator)) {
    return;
  }
  registered = true;

  // 首次安装时 controller 由 null 变为 worker 也会触发 `controllerchange`，
  // 那是「装好了」而不是「有新版本」—— 用注册前的快照区分这两种情况。
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) {
      notifyUpdate();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(SW_URL)
      .then((registration) => {
        watchRegistration(registration);
      })
      .catch(() => {
        // 离线能力不可用不影响主流程
      });
  });
}

/**
 * 应用新版本：让等待中的 SW 立即接管并刷新页面。
 *
 * 产物是 `autoUpdate`（SW 自行 `skipWaiting()`），通常**没有** waiting 中的 worker ——
 * 此时直接刷新即可拿到新包；若部署的是 `prompt` 模式产物（存在 waiting），
 * 则先 `postMessage({ type: 'SKIP_WAITING' })` 让它接管，接管后再刷新。
 */
export function applyServiceWorkerUpdate(): void {
  if (typeof window === 'undefined' || reloading) {
    return;
  }
  reloading = true;

  const reload = (): void => {
    if (typeof window === 'undefined') {
      return;
    }
    window.location.reload();
  };

  const waiting = currentRegistration?.waiting ?? null;
  if (!waiting || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    reload();
    return;
  }

  let reloaded = false;
  const reloadOnce = (): void => {
    if (reloaded) {
      return;
    }
    reloaded = true;
    reload();
  };

  waiting.postMessage(SKIP_WAITING_MESSAGE);
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  // 兜底：产物若未监听该消息，`controllerchange` 不会来，超时也要把页面刷掉
  window.setTimeout(reloadOnce, TAKEOVER_TIMEOUT_MS);
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
