/**
 * 首屏加载屏控制（src/splash.ts）。
 *
 * 加载屏本体是 index.html 的原生节点 `#qsh-splash`（先于 bundle 渲染，避免首屏空白）；
 * React 挂载后由 `dismissSplash()` 淡出并「从 DOM 移除」——移除而非隐藏，
 * 才能不残留可聚焦元素、也不挡住后续点击（无障碍要求）。
 */

/**
 * 加载屏最短可见时长（ms）—— 与 index.html 的 CSS 动画时间预算配套，改一处必须同步核算另一处。
 *
 * 语义：这已不是单纯的「防止一闪而过的下限」，而是**有意的观赏期**（让人看清花园长成的样子）。
 * 因此配套了 `#qsh-skip` 跳过按钮：想看的人看，不愿等的人可一键跳过 —— 长展示与不被强留得以两全。
 *
 * ✅ 达标依据：**严格 `animationend` 口径**（scaleY 恰好到 1）。视觉口径（如 `scaleY ≥0.999`）
 * 只作参考、不得用于验收 —— 原因见文末警告。
 *
 * 编舞：花园最晚一组 `.qsh-d7` = `.20s 延迟 + .42s 生长 = .62s` 全部长完（名义值）。
 * 因动画早于 module eval 约 54ms 随首次渲染起跑，实测会略早于名义值；本机波动约 ±45ms。
 * 参考：本常量取 890ms 时，实测「定格 = 淡出起始 − animationend」为 234–282ms（当时的设计底线是 ≥200ms，
 * 890 正是贴着这条底线定的）。现值 3000ms 远高于该底线，定格约 2.3s —— 这是**刻意留出的观赏时间**，
 * 不再是「尽快消失」的取舍，故原先「加载屏总时长 ≤1500ms」的约束在本项目已不适用。
 *
 * ⚠️ 警告：`cubic-bezier(.22,.68,.28,1)` 末端切线 P3−P2 = (.72, 0)，**末端斜率 ≈ 0**，
 * 故 `scaleY` 从 0.999 爬到 1.0 还需约 45–70ms。**不得用 `scaleY ≥0.999` 这类视觉口径当达标依据**
 * —— 本项目已因此高估过一次余量（把视觉口径的 666ms 当作 animationend 口径去推定格）。
 *
 * 已知限制：`splashStartedAt` 取的是 module eval 时刻而非导航/解析时刻，故**慢加载**下会在
 * 「用户已经等了一段时间」的基础上再加满本常量。有了跳过按钮后，这条限制的实际影响已大幅削弱
 * （慢加载时用户可直接跳过），故不再视为需修的问题。
 */
export const SPLASH_MIN_VISIBLE_MS = 3000;

/**
 * 同一会话内**再次加载**时的短兜底（ms）。
 *
 * 完整观赏期只为「第一次见」准备；同一个会话里刷新页面、或从 PWA 再次进入时，
 * 用户已经看过花园了，再强留 3 秒就是纯等待 —— 此时只保留一个不至于白屏一闪的下限。
 * 会话以 `sessionStorage` 界定（关掉标签页即重置）。
 */
export const SPLASH_SHORT_VISIBLE_MS = 600;

/**
 * 剩余时间低于此值就不显示「跳过」按钮（ms）。
 *
 * 否则短兜底场景下按钮会闪现 0.6 秒又消失 —— 既点不到也像故障；观赏期的界定本就是
 * 「值不值得跳」，太短就不该出现这个入口。
 */
const SKIP_MIN_REMAINING_MS = 1000;

/** 淡出过渡时长（ms），与 index.html 里 `#qsh-splash` 的 transition 保持一致。 */
const SPLASH_FADE_MS = 300;

const SPLASH_ID = 'qsh-splash';
const FADE_CLASS = 'qsh-splash--out';
/** 跳过按钮的 DOM id（标记与样式定义在 index.html）。 */
const SKIP_ID = 'qsh-skip';
/** 会话级「已完整展示过观赏期」标记。 */
const SPLASH_SEEN_KEY = 'qsh:splash-seen';

/**
 * 本次加载该停留多久：首次完整观赏，同会话内后续加载用短兜底。
 *
 * 在**模块求值**时定一次（每页面加载只判定一次）；`sessionStorage` 在隐私模式下可能抛错，
 * 此时退回完整观赏期 —— 宁可多展示，也不要因异常让加载屏一闪而过。
 */
function resolveMinVisibleMs(): number {
  try {
    if (window.sessionStorage.getItem(SPLASH_SEEN_KEY) === '1') {
      return SPLASH_SHORT_VISIBLE_MS;
    }
    window.sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
  } catch {
    /* sessionStorage 不可用 → 走完整观赏期 */
  }
  return SPLASH_MIN_VISIBLE_MS;
}

const minVisibleMs = resolveMinVisibleMs();

/** 模块求值时刻 ≈ 首屏开始渲染时刻，用于估算加载屏已可见多久（只取一次，否则最短时长会失效）。 */
const splashStartedAt = Date.now();

/** 是否偏好「减少动态效果」。jsdom 下 matchMedia 可能不存在，做存在性判断后安全降级。 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 淡出并从 DOM 移除；「减少动态效果」时跳过过渡直接移除。 */
function fadeOutAndRemove(node: HTMLElement): void {
  if (prefersReducedMotion()) {
    node.remove();
    return;
  }
  node.classList.add(FADE_CLASS);
  window.setTimeout(() => {
    node.remove();
  }, SPLASH_FADE_MS);
}

/**
 * 淡出并移除首屏加载屏，并开放「跳过」。
 *
 * - 幂等：节点不存在时直接返回，可安全重复调用（React 严格模式会重复执行副作用）。
 * - 可见时长：渲染过快时补足到本次加载的额度（首访 `SPLASH_MIN_VISIBLE_MS`，
 *   同会话内再次加载 `SPLASH_SHORT_VISIBLE_MS`），已经超过额度则立即淡出。
 * - 跳过按钮只在**应用已就绪、且剩余时间值得跳**（≥ `SKIP_MIN_REMAINING_MS`）时显示：
 *   在那之前加载屏仍在遮挡 bundle 下载，此时「跳过」只会换来一片空白；而剩余时间太短时
 *   显示会让按钮一闪而过、既点不到又像故障。点击后立即淡出，不再等剩余时间。
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
  const remaining = Math.max(0, minVisibleMs - elapsed);

  // 用 `hidden` 兼作「是否已绑定过」的标记：二次调用不会重复挂监听
  const skip = document.getElementById(SKIP_ID);
  if (skip !== null && remaining >= SKIP_MIN_REMAINING_MS && skip.hidden) {
    skip.hidden = false;
    skip.addEventListener(
      'click',
      () => {
        const node = document.getElementById(SPLASH_ID);
        if (node !== null) {
          fadeOutAndRemove(node);
        }
      },
      { once: true },
    );
  }

  window.setTimeout(() => {
    // 定时器触发时节点可能已被「跳过」移除，重新取用保证幂等
    const node = document.getElementById(SPLASH_ID);
    if (node === null) {
      return;
    }
    fadeOutAndRemove(node);
  }, remaining);
}
