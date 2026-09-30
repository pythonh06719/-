import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { routes } from '@/router/routes';
import { UNAUTHORIZED_EVENT } from '@/lib/api';
import { useAuthStore } from '@/lib/auth.store';
import { hydrateUnitFromServer, useUnitStore } from '@/lib/units';
import { currentStoredMode, hydrateThemeFromServer } from '@/theme/useTheme';
import { registerSettingsOnlineFlush } from '@/lib/settings-sync';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { COPY } from '@/lib/copy';
import UpdatePrompt from '@/pwa/UpdatePrompt';

/**
 * 401 监听器：登录态过期时清理本地会话并回到「我的」页重新登录。
 * 放在 Router 内部以使用 `useNavigate`（ARCHITECTURE §1.7）。
 */
function UnauthorizedListener(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const onUnauthorized = (): void => {
      useAuthStore.getState().clear();
      navigate('/profile', { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate]);
  return null;
}

/**
 * 设置校准器（GAP-4）：登录态建立后，用服务端权威设置校准本地的单位与深色模式；
 * 并注册「联网补推」监听，确保离线改动不被服务端旧值吞掉。
 *
 * ## 为什么需要它
 *
 * 单位 / 深色此前只存本机 `localStorage`，导出的 JSON 备份却承诺「设置可完整恢复」。
 * 恢复备份会把**服务端**设置改成备份里的值，本地若不校准，导出的 JSON 会与服务端不一致 ——
 * 「可完整恢复」就是空话。本组件是该承诺成立的最后一环。
 *
 * ## 时序（**不阻塞首屏**）
 *
 * 本机 `localStorage` 的读取发生在首屏之前（`initTheme` / `useUnitStore` 模块初始化，
 * 避免闪烁）；本组件在其后异步拉取服务端值并覆盖。刚好处于「已登录」时校准一次，
 * 每次会话内改账号（登出再登录）会因 `accessToken` 变化重新校准一次。
 *
 * ## P0-2：离线改动不被吞
 *
 * 校准函数内部**先补推 dirty**（见 `lib/settings-sync.ts`），本地改动未推成功时拒绝校准；
 * 同时本组件注册 `online` 事件监听，恢复联网时补推待同步设置。
 *
 * ⚠️ 全程 fire-and-forget：服务端不可达时静默跳过，不阻塞渲染、不弹任何错误。
 */
function SettingsCalibrator(): null {
  const accessToken = useAuthStore((state) => state.accessToken);
  const status = useAuthStore((state) => state.status);
  /** 已校准的 token：同一 token 只校准一次，避免重复请求与「校准覆盖用户刚改的值」抖动。 */
  const calibratedFor = useRef<string | null>(null);

  // P0-2：联网时补推待同步设置（读取当前本地值，最后值语义）。
  useEffect(() => {
    return registerSettingsOnlineFlush(() => {
      const localMode = currentStoredMode();
      return {
        unit: useUnitStore.getState().unit,
        weightUnit: useUnitStore.getState().weightUnit,
        ...(localMode === 'system' ? {} : { darkMode: localMode === 'dark' }),
      };
    });
  }, []);

  useEffect(() => {
    if (accessToken === null || status !== 'authenticated') {
      return;
    }
    if (calibratedFor.current === accessToken) {
      return;
    }
    calibratedFor.current = accessToken;
    void (async () => {
      await Promise.all([hydrateUnitFromServer(), hydrateThemeFromServer()]);
    })();
  }, [accessToken, status]);

  return null;
}

/**
 * 路由级兜底界面（GAP-10）。
 *
 * `ErrorBoundary` 是类组件，而「回到首页」要用路由跳转（`useNavigate`）才能**不整页刷新**地
 * 离开坏页面；hook 不能写在类组件里。这里用一个**普通函数组件**把 `useNavigate` 注入进去，
 * 作为 `renderFallback` 传给边界 —— 边界只负责「什么时候显示兜底」，导航能力由这里提供。
 *
 * ⚠️ 与内置兜底界面（`window.location.assign('/')`）的区别：本组件渲染在 `BrowserRouter` 内部，
 * 用路由跳转不会丢失 SPA 状态（主题、query cache），体验更好；这也是把边界放在
 * `BrowserRouter` **内部**、而不是包住整个 `App` 的原因。
 */
function RouteFallback({ reset }: { reset: () => void }): ReactElement {
  const navigate = useNavigate();

  const handleHome = (): void => {
    // 先重置边界（下次进入别的路由时不会立刻又落回兜底），再跳转。
    reset();
    navigate('/', { replace: true });
  };

  return (
    <div className="min-h-screen bg-brand-50 px-5 py-8 dark:bg-slate-900">
      <div
        role="alert"
        className="mx-auto max-w-3xl rounded-2xl bg-white p-6 text-center shadow-sm dark:bg-slate-800"
      >
        <p className="text-title font-semibold tracking-tight text-slate-800 dark:text-slate-100">
          {COPY.pageFallbackTitle}
        </p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{COPY.pageFallbackDesc}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-xl border border-brand-200 bg-white px-4 py-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-brand-200 dark:hover:bg-slate-700"
          >
            {COPY.pageFallbackRetry}
          </button>
          <button
            type="button"
            onClick={handleHome}
            className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2"
          >
            {COPY.pageFallbackHome}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 应用根组件：挂载路由（12 组路由，一期未开发页显示分期占位）、全局副作用监听
 * 与 PWA 新版本提示。
 *
 * ## GAP-10：把「路由页面」整段套进错误边界
 *
 * 层级刻意是 `BrowserRouter > ErrorBoundary > (Routes + UpdatePrompt)`：
 *
 * - 边界在 `BrowserRouter` **内部** —— 与 `UnauthorizedListener`（依赖 `useNavigate`）同级，
 *   所以「401 回登录页」这条链路即使某个页面抛错也照常工作；
 * - 边界在 `Routes` **外层** —— 任何路由页面（含 `AppShell` 外壳内的页面）渲染抛错都被接住，
 *   不会卸载整棵树导致整页白屏；
 * - `UpdatePrompt` 也在边界内：它渲染的是浮层，若自身抛错同样不应白屏。
 *
 * 兜底界面用 `RouteFallback`（可用 `useNavigate`，跳转不刷新页面）。
 */
export default function App(): ReactElement {
  return (
    <BrowserRouter>
      <UnauthorizedListener />
      <SettingsCalibrator />
      <ErrorBoundary
        renderFallback={(reset: () => void): ReactNode => <RouteFallback reset={reset} />}
      >
        <Routes>
          {routes.map((item) => (
            <Route key={item.path} path={item.path} element={item.element} />
          ))}
        </Routes>
        {/* PWA 新版本提示挂在 Routes 同级（而非 AppShell 内）：`/` 与 `/onboarding`
            等裸路由不套外壳，只有挂在这一层才全站可见。 */}
        <UpdatePrompt />
      </ErrorBoundary>
    </BrowserRouter>
  );
}
