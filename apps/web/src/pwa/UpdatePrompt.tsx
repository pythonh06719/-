import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { applyServiceWorkerUpdate, onServiceWorkerUpdate, SW_UPDATE_EVENT } from './registerSW';

/**
 * PWA 新版本提示条（pwa/UpdatePrompt.tsx）。
 *
 * 为什么需要它：`registerType: 'autoUpdate'` 的产物会自行 `skipWaiting()` + `clientsClaim()`，
 * 新 SW 接管后**当前页面跑的仍是旧包**，只有下一次导航才会拿到新代码。
 * 与其替用户决定何时刷新（可能打断正在填写的表单），不如把选择权交回去：
 * 检测到新版本 → 浮出一条温和的提示 → 用户点它才 reload。
 *
 * 无障碍与布局要点：
 * - 外层容器**常驻**并带 `role="status"` + `aria-live="polite"`：屏幕阅读器只会朗读
 *   「插入进既有 live region 的内容」，容器后建则内容不会被播报；
 * - 外层 `pointer-events-none` + 内层 `pointer-events-auto`：fixed 全宽容器默认会吞掉
 *   背后页面的点击，这里让浮层只接收自己那一块的指针事件；
 * - 整条提示即按钮（≥44px 触控目标），语义直接是「点击刷新」，不额外堆装饰；
 * - 不主动发通知、不阻塞任何操作（NFR-10）。
 */
export default function UpdatePrompt(): ReactElement {
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    const show = (): void => setHasUpdate(true);
    // ① 回调订阅（`main.tsx` 注册 SW 时挂上的通知；更新早于挂载发生时会立即补触发一次）
    const unsubscribe = onServiceWorkerUpdate(show);
    // ② 自定义事件（同一事实的另一条出口，便于页面其它部分自行驱动 / 观测）
    window.addEventListener(SW_UPDATE_EVENT, show);
    return () => {
      unsubscribe();
      window.removeEventListener(SW_UPDATE_EVENT, show);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-5 md:bottom-6"
    >
      {hasUpdate && (
        <button
          type="button"
          onClick={applyServiceWorkerUpdate}
          className="qsh-touch-target pointer-events-auto flex animate-fade-in items-center gap-2 rounded-pill bg-brand-600 px-4 py-3 text-body font-medium text-white shadow-qsh-3 transition hover:bg-brand-700 dark:bg-brand-900 dark:text-brand-100 dark:ring-1 dark:ring-brand-700 dark:hover:bg-brand-800"
        >
          <span>有新版本，点击刷新就能用上</span>
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M20 12a8 8 0 1 1-2.34-5.66" />
            <path d="M20 4v4.5h-4.5" />
          </svg>
        </button>
      )}
    </div>
  );
}
