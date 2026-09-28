import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { COPY } from '@/lib/copy';
import { queryClient } from '@/lib/queryClient';
import { initTheme } from '@/theme/useTheme';
import { initPwa } from '@/pwa/registerSW';
import { dismissSplash } from './splash';

// 样式：Tailwind 入口 + 深色模式 + 无障碍
import './styles/index.css';
import './theme/dark.css';
import './theme/a11y.css';

// 尽早应用主题，避免首屏闪烁；注册 PWA 与离线同步（不发任何通知，NFR-10）
initTheme();
initPwa();

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('找不到 #root 挂载节点，请检查 index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    {/*
     * GAP-10 最外层兜底：`App` 内部还有一层路由级错误边界，但有两种情况会绕开它 ——
     * ① `App` **自身**（或 `BrowserRouter` / provider 层）抛错，此时路由还没建立；
     * ② 路由懒加载的 `import()` 失败（离线 / 部署换了 chunk 哈希），
     *    React 在**渲染期**把这个 Promise 拒绝重新抛出，而它常发生在边界之上。
     * 这一层用最保守口径：不提「别的页面还能用」（路由可能已不可用），
     * 「回到首页」也只做整页跳转（内置兜底界面已如此实现）。
     */}
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// React 已挂载：让 index.html 里的首屏加载屏淡出（内部保证最短可见时长，幂等）
dismissSplash();
