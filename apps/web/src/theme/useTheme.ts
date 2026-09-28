import { useCallback, useEffect, useState } from 'react';
import type { ResolvedTheme, ThemeMode } from './tokens';
import { THEME_STORAGE_KEY } from './tokens';
import { fetchServerSettings, pushSettings } from '@/lib/settings-sync';

/**
 * 深色模式 Hook（R2 / NFR-8 / TC-48）。
 *
 * - 默认 `system`：跟随 `prefers-color-scheme`
 * - 手动切换 `light` / `dark` 并持久化到 localStorage
 * - 通过 `<html class="dark">` 生效（Tailwind `darkMode: 'class'`）
 *
 * 所有 `window` / `matchMedia` 访问都做了存在性判断，保证在 jsdom / SSR 下不抛错。
 *
 * ## 双层持久化（GAP-4 修复）
 *
 * - **localStorage（快路径）**：手动模式跨会话保留、首屏前可读，避免主题闪烁；
 * - **服务端（权威值）**：手动切换时 `PATCH /users/settings` 写 `darkMode`，
 *   使导出的 JSON 备份「设置可完整恢复」成立（登录后由 `hydrateThemeFromServer` 校准）。
 *
 * 映射规则：服务端只有一个布尔 `darkMode`，无 `system` 概念 ——
 * 只在**手动**切换（`light` / `dark`）时落库；`system` 视为「未表态」，不覆盖服务端旧值。
 * 落库失败**不打断操作**、不弹红（见 `lib/settings-sync.ts`）。
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

/** 手动模式写入 localStorage（快路径）。`system` 也一并写入，保持与旧行为一致。 */
function persistModeLocally(mode: ThemeMode): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

/**
 * 登录后 / 启动时用服务端权威值校准深色模式。
 *
 * - 服务端 `darkMode` 为布尔，映射到手动模式 `dark` / `light`；
 * - 只覆盖 localStorage 与 `<html class>`，**不回写服务端**；
 * - 服务端不可达时静默返回，本地保持原值（不阻塞首屏、不白屏）。
 */
export async function hydrateThemeFromServer(): Promise<void> {
  const settings = await fetchServerSettings();
  if (settings === null) {
    return;
  }
  const next: ThemeMode = settings.darkMode ? 'dark' : 'light';
  persistModeLocally(next);
  applyTheme(next);
}

/** 供非 React 环境读取当前手动模式（用于服务端校准后判断是否需要刷新 React 状态）。 */
export function currentStoredMode(): ThemeMode {
  return readStoredMode();
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
    // 1) localStorage 快路径（立即生效，避免闪烁）
    persistModeLocally(next);
    // 2) 服务端权威值：仅手动 light / dark 映射为布尔 `darkMode` 落库（fire-and-forget，失败静默）
    if (next !== 'system') {
      void pushSettings({ darkMode: next === 'dark' });
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
