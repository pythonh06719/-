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
});
