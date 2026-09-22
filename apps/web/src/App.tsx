import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { routes } from '@/router/routes';
import { UNAUTHORIZED_EVENT } from '@/lib/api';
import { useAuthStore } from '@/lib/auth.store';
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
 * 应用根组件：挂载路由（12 组路由，一期未开发页显示分期占位）、全局副作用监听
 * 与 PWA 新版本提示。
 */
export default function App(): ReactElement {
  return (
    <BrowserRouter>
      <UnauthorizedListener />
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
