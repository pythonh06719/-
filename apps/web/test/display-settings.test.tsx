/**
 * 显示设置（深色模式）—— 2026-10-13 从顶栏迁入「我的」页。
 *
 * ## 背景
 *
 * 顶栏原有三个切换按钮（热量单位 / 体重单位 / 深色）。用户拍板拆分：
 * **单位留顶栏**（看数字时高频），**深色进设置**（设一次就忘，且配齐「跟随系统」——
 * 顶栏 `toggle` 一旦离开 `system` 就回不去，`useTheme.setMode` 一直支持三态）。
 *
 * ## 本文件钉死的行为
 *
 * ① 三态选择渲染（跟随系统 / 浅色 / 深色），默认选中「跟随系统」；
 * ② 选「深色」→ `<html class="dark">` 生效 + localStorage 落 manual 值；
 * ③ 选回「跟随系统」→ 脱离 manual（jsdom 的 `matchMedia` 恒浅色 → class 摘除）；
 * ④ 顶栏**不再有**深色按钮、两个单位开关仍在（拆分决策的回归保护）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import DisplaySettings from '@/pages/profile/DisplaySettings';
import { COPY } from '@/lib/copy';
import { THEME_STORAGE_KEY } from '@/theme/tokens';

beforeEach(() => {
  window.localStorage.clear();
  // `<html class>` 是文档级状态：上一个用例留下的 dark 会污染后续断言
  document.documentElement.classList.remove('dark');
  // `setMode` 会 fire-and-forget 推 `PATCH /users/settings`（落库契约由 settings-sync.test.tsx 钉）——
  // 这里只保证不真发网络请求：桩一个成功响应即可。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: {}, error: null }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DisplaySettings（深色模式三态）', () => {
  it('渲染「显示」卡与三个选项，默认选中跟随系统', () => {
    render(<DisplaySettings />);

    expect(screen.getByRole('heading', { name: COPY.displayTitle })).toBeInTheDocument();
    const select = screen.getByLabelText(COPY.displayThemeLabel) as HTMLSelectElement;
    expect(select.value).toBe('system');
    expect(screen.getByRole('option', { name: COPY.displayThemeSystem })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: COPY.displayThemeLight })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: COPY.displayThemeDark })).toBeInTheDocument();
  });

  it('选「深色」→ html 加 dark class 且 localStorage 落 manual 值', async () => {
    const user = userEvent.setup();
    render(<DisplaySettings />);

    await user.selectOptions(screen.getByLabelText(COPY.displayThemeLabel), 'dark');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('选回「跟随系统」→ 脱离 manual，class 摘除（jsdom 偏好恒为浅色）', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<DisplaySettings />);

    // 起始即 manual dark（hook 初始化时读 localStorage）
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.selectOptions(screen.getByLabelText(COPY.displayThemeLabel), 'system');

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });
});

describe('顶栏拆分（单位留、深色走）', () => {
  it('顶栏没有深色按钮，两个单位开关仍在', () => {
    render(
      <MemoryRouter>
        <AppShell>
          <p>内容</p>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: '切换到深色模式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '切换到浅色模式' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /切换热量单位/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /切换体重单位/ })).toBeInTheDocument();
  });
});
