import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { routes } from '@/router/routes';
import { UNAUTHORIZED_EVENT } from '@/lib/api';
import { useAuthStore } from '@/lib/auth.store';
import { hydrateUnitFromServer, useUnitStore } from '@/lib/units';
import { currentStoredMode, hydrateThemeFromServer } from '@/theme/useTheme';
import { registerSettingsOnlineFlush } from '@/lib/settings-sync';
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
 * 应用根组件：挂载路由（12 组路由，一期未开发页显示分期占位）、全局副作用监听
 * 与 PWA 新版本提示。
 */
export default function App(): ReactElement {
  return (
    <BrowserRouter>
      <UnauthorizedListener />
      <SettingsCalibrator />
      <Routes>
        {routes.map((item) => (
          <Route key={item.path} path={item.path} element={item.element} />
        ))}
      </Routes>
      {/* PWA 新版本提示挂在 Routes 同级（而非 AppShell 内）：`/` 与 `/onboarding`
          等裸路由不套外壳，只有挂在这一层才全站可见。 */}
      <UpdatePrompt />
    </BrowserRouter>
  );
}
