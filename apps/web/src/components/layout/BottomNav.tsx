import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';

/**
 * 底部导航（components/layout/BottomNav.tsx）—— 移动端优先（NFR-9）。
 *
 * 四个一级入口：今天 / 记录 / 变化 / 我的（显示文案生活化；**路由 path 保持不变**）。
 * 桌面端由 `AppShell` 转为顶部横向导航。
 * 无障碍：使用 `<nav>` + `aria-current`（NavLink 自动设置），触控目标 ≥44px（NFR-7）。
 */

interface NavItem {
  /** 路由 */
  to: string;
  /** 文案 */
  label: string;
  /** 图标路径（stroke 风格，无第三方图标库依赖） */
  icon: ReactElement;
}

function DashboardIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9" strokeLinecap="round" />
      <path d="M12 12l5-3" strokeLinecap="round" />
    </svg>
  );
}

function DiaryIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 3h9a3 3 0 0 1 3 3v15H8a2 2 0 0 1-2-2V3z" strokeLinejoin="round" />
      <path d="M6 3v16a2 2 0 0 0 2 2" strokeLinecap="round" />
      <path d="M10 9h5M10 13h5" strokeLinecap="round" />
    </svg>
  );
}

function WeightIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 19l5-6 4 3 7-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProfileIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" />
    </svg>
  );
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/dashboard', label: '今天', icon: <DashboardIcon /> },
  { to: '/diary', label: '记录', icon: <DiaryIcon /> },
  { to: '/weight', label: '变化', icon: <WeightIcon /> },
  { to: '/profile', label: '我的', icon: <ProfileIcon /> },
];

export default function BottomNav(): ReactElement {
  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-brand-100 bg-white/95 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 md:static md:mx-auto md:mt-8 md:max-w-3xl md:rounded-2xl md:border"
    >
      <ul className="mx-auto flex max-w-3xl items-stretch justify-between px-2">
        {NAV_ITEMS.map((item) => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              className={({ isActive }) =>
                [
                  'qsh-touch-target flex flex-col items-center gap-1 rounded-xl py-2.5 text-xs transition',
                  isActive
                    ? 'font-semibold text-brand-700 dark:text-brand-300'
                    : 'text-slate-500 hover:text-brand-600 dark:text-slate-400',
                ].join(' ')
              }
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
