import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import BottomNav from './BottomNav';
import { useTheme } from '@/theme/useTheme';
import { energyLabel, useUnitStore } from '@/lib/units';
import { COPY } from '@/lib/copy';

/**
 * 应用外壳（components/layout/AppShell.tsx）。
 *
 * - 移动端：顶部标题栏 + 底部导航；桌面端：内容居中，导航转为胶囊条（响应式）
 * - 全局开关：深色模式（跟随系统 / 手动）、热量单位 kcal ↔ kJ
 * - 无障碍：跳过导航链接、`main` 语义区、离线状态 `aria-live` 提示（TC-48）
 * - **不发任何用户未开启的通知**（NFR-10）
 */

export interface AppShellProps {
  /** 页面内容 */
  children: ReactNode;
  /** 顶栏标题（缺省「轻生活」） */
  title?: string;
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

export default function AppShell({ children, title = '轻生活' }: AppShellProps): ReactElement {
  const { resolved, toggle } = useTheme();
  const unit = useUnitStore((state) => state.unit);
  const toggleUnit = useUnitStore((state) => state.toggle);
  const online = useOnlineStatus();

  return (
    <div className="min-h-screen bg-brand-50 pb-20 dark:bg-slate-900 md:pb-8">
      <a href="#main" className="qsh-skip-link">
        跳到主要内容
      </a>

      <header className="sticky top-0 z-30 border-b border-brand-100 bg-white/90 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <p className="text-base font-semibold text-slate-800 dark:text-slate-100">{title}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleUnit}
              className="qsh-touch-target rounded-xl px-3 text-xs font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
              aria-label={`切换热量单位为${unit === 'kcal' ? '千焦' : '千卡'}，当前 ${energyLabel(unit)}`}
            >
              {energyLabel(unit)}
            </button>
            <button
              type="button"
              onClick={toggle}
              className="qsh-touch-target rounded-xl px-3 text-xs font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
              aria-label={resolved === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            >
              {resolved === 'dark' ? '浅色' : '深色'}
            </button>
          </div>
        </div>
      </header>

      {!online && (
        <p
          role="status"
          aria-live="polite"
          className="bg-coral-50 px-5 py-2 text-center text-xs text-coral-700 dark:bg-coral-900/30 dark:text-coral-200"
        >
          {COPY.offlineNotice}
        </p>
      )}

      <main id="main" className="mx-auto max-w-3xl animate-fade-in px-5 py-6">
        {children}
      </main>

      <BottomNav />
    </div>
  );
}
