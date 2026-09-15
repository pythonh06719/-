import { useCallback, useEffect, useState } from 'react';
import type { ResolvedTheme, ThemeMode } from './tokens';
import { THEME_STORAGE_KEY } from './tokens';

/**
 * 深色模式 Hook（R2 / NFR-8 / TC-48）。
 *
 * - 默认 `system`：跟随 `prefers-color-scheme`
 * - 手动切换 `light` / `dark` 并持久化到 localStorage
 * - 通过 `<html class="dark">` 生效（Tailwind `darkMode: 'class'`）
 *
 * 所有 `window` / `matchMedia` 访问都做了存在性判断，保证在 jsdom / SSR 下不抛错。
 */

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'system';
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // 隐私模式等场景读取未成功时退回默认
  }
  return 'system';
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(MEDIA_QUERY).matches;
}

/** 把解析后的主题写入 `<html class>`，并同步 `theme-color`。 */
function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) {
    meta.setAttribute('content', resolved === 'dark' ? '#0f1a16' : '#2f9e78');
  }
}

/** 供在 React 之外初始化试用（如入口脚本防闪烁）。 */
export function initTheme(): ResolvedTheme {
  const mode = readStoredMode();
  const resolved: ResolvedTheme = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode;
  applyTheme(resolved);
  return resolved;
}

export interface UseThemeResult {
  /** 用户选择的模式（system / light / dark） */
  mode: ThemeMode;
  /** 解析后的实际主题 */
  resolved: ResolvedTheme;
  /** 切换模式并持久化 */
  setMode: (mode: ThemeMode) => void;
  /** 在浅色 / 深色间快速切换（切到显式值，脱离 system） */
  toggle: () => void;
}

/** 深色模式状态 Hook。 */
export function useTheme(): UseThemeResult {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    readStoredMode() === 'system' ? (prefersDark() ? 'dark' : 'light') : (readStoredMode() as ResolvedTheme),
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // 存储不可用时仅本次会话生效
    }
  }, []);

  useEffect(() => {
    const next: ResolvedTheme = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode;
    setResolved(next);
    applyTheme(next);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const media = window.matchMedia(MEDIA_QUERY);
    const onChange = (): void => {
      const next: ResolvedTheme = media.matches ? 'dark' : 'light';
      setResolved(next);
      applyTheme(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setMode]);

  return { mode, resolved, setMode, toggle };
}
