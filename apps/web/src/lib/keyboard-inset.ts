/**
 * 软键盘弹起的视口修正（iOS Safari 真机缺陷）。
 *
 * ## 根因
 *
 * iOS Safari 的**布局视口不随软键盘收缩**：键盘弹起时 `window.innerHeight`
 * 不变，收缩的只有 `visualViewport`。底部抽屉是 `fixed inset-0` 容器 +
 * 面板 `max-h-[88vh]`（按布局视口计算）+ 面板内部 `overflow-y-auto`：
 * 键盘一起，面板下半截（输入框、保存按钮）落在键盘底下；iOS 也**不会**把
 * fixed 容器里的内部滚动节点捞进可视区（只捞文档滚动节点）—— 用户看不见
 * 自己正在编辑什么，保存按钮也点不到。
 *
 * ## 修法
 *
 * 监听 `visualViewport`，把「布局视口被键盘吃掉的底部高度」写成 CSS 变量
 * `--qsh-keyboard-inset`（挂在 `<html>` 上）；抽屉把该变量加进容器
 * `padding-bottom`、从面板 `max-h` 里减掉，面板即整体抬到键盘之上。
 * 桌面端无软键盘，差值恒为 0，视觉零变化。
 *
 * Chrome Android 的布局视口随键盘收缩（默认行为），差值天然 ≈0，
 * 本模块在那里只是无害兜底。
 *
 * ## jsdom 限制（测试边界）
 *
 * jsdom 没有 `visualViewport` → `initKeyboardInset()` 直接跳过（不设变量），
 * CSS 侧一律带 `var(--qsh-keyboard-inset, 0px)` 兜底。**几何效果只能在真机
 * 验证**；单测只钉两件事：纯函数的阈值/边界，以及三个抽屉确实消费该变量
 * （接线缺口是本仓库最大技术债，写模块没人用等于没写）。
 */

/** CSS 变量名：挂在 `<html>` 上，单位 px，无键盘时为 `0px`。 */
export const KEYBOARD_INSET_VAR = '--qsh-keyboard-inset';

/**
 * 高度差超过该值才认定为软键盘（px）。
 *
 * iPhone 软键盘约 260~340px；Safari 地址栏显隐造成的 `visualViewport`
 * 收缩只有约 60~90px —— 不用阈值区分，就会把「地址栏收起」误判成键盘弹起，
 * 抽屉被无故抬高。
 */
export const KEYBOARD_INSET_THRESHOLD_PX = 150;

/**
 * 由视口度量求键盘遮挡高度（纯函数，边界全在单测里钉）。
 *
 * 公式为业界通用口径：布局视口底边到可视视口底边的距离。Safari 把页面
 * 往上推时 `offsetTop > 0`，不减它会**少算**被平移吃掉的高度。
 *
 * @param layoutHeight 布局视口高（`window.innerHeight`，键盘弹起时不变）
 * @param visualHeight 可视视口高（`visualViewport.height`，键盘弹起时收缩）
 * @param visualOffsetTop 可视视口相对布局视口的纵向偏移（`visualViewport.offsetTop`）
 * @returns 键盘高度（px，四舍五入）；无键盘或幅度不足阈值时为 0（永不为负）
 */
export function resolveKeyboardInset(
  layoutHeight: number,
  visualHeight: number,
  visualOffsetTop: number,
): number {
  const raw = Math.round(layoutHeight - visualHeight - visualOffsetTop);
  return raw >= KEYBOARD_INSET_THRESHOLD_PX ? raw : 0;
}

/** 已写入的高度；用于跳过无变化的重复 setProperty（scroll 事件很密集）。 */
let appliedInset = -1;

function applyInset(): void {
  const viewport = window.visualViewport;
  if (!viewport) {
    return;
  }
  const inset = resolveKeyboardInset(window.innerHeight, viewport.height, viewport.offsetTop);
  if (inset === appliedInset) {
    return;
  }
  appliedInset = inset;
  document.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${inset}px`);
}

/** 幂等标记：StrictMode 下启动路径的 init 调用可能跑两次。 */
let started = false;

/**
 * 应用启动时调用一次（与 `initTheme()` / `initPwa()` 并列，见 main.tsx）。
 *
 * 无 `visualViewport` 的老浏览器直接跳过：CSS 侧 `var(…, 0px)` 兜底为 0，
 * 行为退化为「不修键盘遮挡」—— 与修复前一致，不会更坏。
 */
export function initKeyboardInset(): void {
  if (started || typeof window === 'undefined' || !window.visualViewport) {
    return;
  }
  started = true;
  window.visualViewport.addEventListener('resize', applyInset);
  // Safari 推动页面时可视视口会平移（offsetTop 变化），只监听 resize 不够
  window.visualViewport.addEventListener('scroll', applyInset);
  applyInset();
}
