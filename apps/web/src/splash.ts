/**
 * 首屏加载屏控制（src/splash.ts）。
 *
 * 加载屏本体是 index.html 的原生节点 `#qsh-splash`（先于 bundle 渲染，避免首屏空白）；
 * React 挂载后由 `dismissSplash()` 淡出并「从 DOM 移除」——移除而非隐藏，
 * 才能不残留可聚焦元素、也不挡住后续点击（无障碍要求）。
 */

/**
 * 加载屏最短可见时长（ms），与 index.html 的 CSS 时间预算配套，改这里必须同步改那边。
 *
 * index.html 里花园最晚一组（.qsh-d7）在 `.30s 延迟 + .42s 生长 ≈ .72s` 才长完；
 * 950ms 保证「完整花园」长完后还能定格约 230ms 再淡出（淡出过渡 300ms），
 * 即用户一定看得见长满的树与花，而不是生长到一半就被淡出。
 */
export const SPLASH_MIN_VISIBLE_MS = 950;

/** 淡出过渡时长（ms），与 index.html 里 `#qsh-splash` 的 transition 保持一致。 */
const SPLASH_FADE_MS = 300;

const SPLASH_ID = 'qsh-splash';
const FADE_CLASS = 'qsh-splash--out';

/** 模块求值时刻 ≈ 首屏开始渲染时刻，用于估算加载屏已可见多久（只取一次，否则最短时长会失效）。 */
const splashStartedAt = Date.now();

/** 是否偏好「减少动态效果」。jsdom 下 matchMedia 可能不存在，做存在性判断后安全降级。 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 淡出并移除首屏加载屏。
 *
 * - 幂等：节点不存在时直接返回，可安全重复调用（React 严格模式会重复执行副作用）。
 * - 最短可见时长：渲染过快时补足到 {@link SPLASH_MIN_VISIBLE_MS}，已经超过则立即淡出。
 * - 减少动态效果时跳过过渡，直接移除。
 */
export function dismissSplash(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const splash = document.getElementById(SPLASH_ID);
  if (splash === null) {
    return;
  }

  // 时钟被回拨等异常下 elapsed 可能为负，钳到 0 保证行为可预期
  const elapsed = Math.max(0, Date.now() - splashStartedAt);
  const remaining = Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed);

  window.setTimeout(() => {
    // 定时器触发时节点可能已被其它调用移除，重新取用保证幂等
    const node = document.getElementById(SPLASH_ID);
    if (node === null) {
      return;
    }
    if (prefersReducedMotion()) {
      node.remove();
      return;
    }
    node.classList.add(FADE_CLASS);
    window.setTimeout(() => {
      node.remove();
    }, SPLASH_FADE_MS);
  }, remaining);
}
