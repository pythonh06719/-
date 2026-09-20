import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
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
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

// React 已挂载：让 index.html 里的首屏加载屏淡出（内部保证最短可见时长，幂等）
dismissSplash();
