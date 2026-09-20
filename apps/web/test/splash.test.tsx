import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPLASH_MIN_VISIBLE_MS, dismissSplash } from '@/splash';

/** 与 splash.ts 内部的淡出时长保持一致，用于推进假定时器。 */
const SPLASH_FADE_MS = 300;

/** 造一个与 index.html 同 id 的加载屏节点。 */
function mountSplash(): HTMLElement {
  const element = document.createElement('div');
  element.id = 'qsh-splash';
  document.body.appendChild(element);
  return element;
}

/** 造一个与 index.html 同 id 的跳过按钮（index.html 里默认带 hidden）。 */
function mountSkip(): HTMLButtonElement {
  const button = document.createElement('button');
  button.id = 'qsh-skip';
  button.hidden = true;
  document.body.appendChild(button);
  return button;
}

/** 模拟不支持 matchMedia 之外还要可控的 reduced-motion 场景。 */
function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

afterEach(() => {
  document.getElementById('qsh-splash')?.remove();
  document.getElementById('qsh-skip')?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('dismissSplash', () => {
  it('没有加载屏节点时调用不抛错（幂等）', () => {
    vi.useFakeTimers();

    expect(() => dismissSplash()).not.toThrow();
    expect(() => dismissSplash()).not.toThrow();
    expect(document.getElementById('qsh-splash')).toBeNull();
  });

  it('存在节点时：先加淡出类，过渡结束后被移除', () => {
    vi.useFakeTimers();
    const splash = mountSplash();

    dismissSplash();

    // 最短可见时长内不应开始淡出
    expect(splash.classList.contains('qsh-splash--out')).toBe(false);

    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS);
    expect(splash.classList.contains('qsh-splash--out')).toBe(true);

    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(document.getElementById('qsh-splash')).toBeNull();
  });

  it('重复调用不会残留节点', () => {
    vi.useFakeTimers();
    mountSplash();

    dismissSplash();
    dismissSplash();

    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS + SPLASH_FADE_MS);
    expect(document.getElementById('qsh-splash')).toBeNull();
  });

  it('在「减少动态效果」下直接移除，不做过渡', () => {
    vi.useFakeTimers();
    stubMatchMedia(true);
    const splash = mountSplash();

    dismissSplash();
    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS);

    expect(document.getElementById('qsh-splash')).toBeNull();
    expect(splash.classList.contains('qsh-splash--out')).toBe(false);
  });

  it('jsdom 缺少 matchMedia 时安全降级（走过渡路径且不抛错）', () => {
    vi.useFakeTimers();
    // jsdom 默认不实现 matchMedia；显式取消任何残留 stub 后验证降级
    vi.stubGlobal('matchMedia', undefined);
    const splash = mountSplash();

    dismissSplash();
    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS + SPLASH_FADE_MS);

    expect(document.getElementById('qsh-splash')).toBeNull();
    expect(splash.classList.contains('qsh-splash--out')).toBe(true);
  });

  it('应用就绪后显示跳过按钮，点击立即移除（不等剩余观赏时间）', () => {
    vi.useFakeTimers();
    const splash = mountSplash();
    const skip = mountSkip();

    dismissSplash();

    // 应用已就绪（remaining > 0）→ 开放跳过入口
    expect(skip.hidden).toBe(false);

    skip.click();
    expect(splash.classList.contains('qsh-splash--out')).toBe(true);

    // 只需等淡出过渡，无需等满最短可见时长
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(document.getElementById('qsh-splash')).toBeNull();
  });

  it('已等满最短可见时长时不显示跳过按钮（无事可跳）', () => {
    vi.useFakeTimers();
    mountSplash();
    const skip = mountSkip();

    // 模拟「加载很慢、用户已经等够了」：把时钟推过最短可见时长
    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS + 1000);
    dismissSplash();

    expect(skip.hidden).toBe(true);

    vi.advanceTimersByTime(SPLASH_FADE_MS + 1);
    expect(document.getElementById('qsh-splash')).toBeNull();
  });

  it('二次调用不会重复绑定跳过（hidden 兼作已绑定标记）', () => {
    vi.useFakeTimers();
    const splash = mountSplash();
    const skip = mountSkip();

    dismissSplash();
    dismissSplash();

    skip.click();

    // 即使绑了两次，节点也只被移除一次、不抛错
    vi.advanceTimersByTime(SPLASH_FADE_MS);
    expect(document.getElementById('qsh-splash')).toBeNull();
    expect(splash.isConnected).toBe(false);
  });

  it('缺少跳过按钮时不抛错，仍按最短可见时长移除', () => {
    vi.useFakeTimers();
    mountSplash();

    expect(() => dismissSplash()).not.toThrow();

    vi.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS + SPLASH_FADE_MS);
    expect(document.getElementById('qsh-splash')).toBeNull();
  });
});
