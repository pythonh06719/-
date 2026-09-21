/**
 * PWA 新版本提示条测试（pwa/UpdatePrompt.tsx）。
 *
 * 钉死三件事：
 * 1. 默认**不渲染提示**，但 `role="status"` 容器常驻 —— 屏幕阅读器只朗读「插入进既有
 *    live region 的内容」，容器后建则提示永远不会被播报（这是 aria-live 最常见的坑）；
 * 2. 收到更新通知后浮出，且提示本身**自己**接收指针事件（`pointer-events-auto`），
 *    外层全宽容器不吞点击（`pointer-events-none`）；
 * 3. 点击 → 触发刷新。
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import UpdatePrompt from '@/pwa/UpdatePrompt';
import { SW_UPDATE_EVENT } from '@/pwa/registerSW';

/** 替换 `window.location.reload`（jsdom 未实现导航）。 */
function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  });
  return reload;
}

describe('PWA 新版本提示条（UpdatePrompt）', () => {
  it('默认不显示提示，但 aria-live 容器常驻', () => {
    render(<UpdatePrompt />);

    expect(screen.queryByRole('button', { name: /点击刷新/ })).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('收到更新通知后浮出提示，点击即刷新', () => {
    const reload = stubReload();
    render(<UpdatePrompt />);

    // 事件派发会触发 setState：必须包在 act 里，否则 React 不会同步刷新（断言会落空）
    act(() => {
      window.dispatchEvent(new CustomEvent(SW_UPDATE_EVENT));
    });

    const prompt = screen.getByRole('button', { name: /点击刷新/ });
    expect(prompt).toBeInTheDocument();
    // 提示自己可点；外层 fixed 容器不拦截背后页面
    expect(prompt.className).toContain('pointer-events-auto');
    expect(prompt.parentElement?.className).toContain('pointer-events-none');

    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(prompt);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
