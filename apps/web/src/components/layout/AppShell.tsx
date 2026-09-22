import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import BottomNav from './BottomNav';
import BrandDecor from '@/components/common/BrandDecor';
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
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3.5">
          {/* 标题用 `text-title`（20px）而非正文号：页头是全站层级的地基，
              标题与正文同号会让每一页都「没有开始」 */}
          <p className="text-title font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            {title}
          </p>
          <div className="flex items-center gap-2">
            {/* 品牌角饰：一朵小花的「印章」，放在按钮左侧。shrink-0 保证它不会被标题挤扁 */}
            <BrandDecor variant="corner" className="h-6 w-6 shrink-0 text-brand-300 opacity-50" />
            <button
              type="button"
              onClick={toggleUnit}
              className="qsh-touch-target rounded-xl px-3 text-caption font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
              aria-label={`切换热量单位为${unit === 'kcal' ? '千焦' : '千卡'}，当前 ${energyLabel(unit)}`}
            >
              {energyLabel(unit)}
            </button>
            <button
              type="button"
              onClick={toggle}
              className="qsh-touch-target rounded-xl px-3 text-caption font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
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

      {/* 内容两侧多留一档呼吸（py-8）：全站每页统一；页面内部间距各自负责，此处不叠加 */}
      <main id="main" className="mx-auto max-w-3xl animate-fade-in px-5 py-8">
        {children}
      </main>

      <BottomNav />
    </div>
  );
}
