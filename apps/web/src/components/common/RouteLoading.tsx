import type { ReactElement } from 'react';

/**
 * 路由懒加载兜底（components/common/RouteLoading.tsx）。
 *
 * 作为 `router/routes.tsx` 中 `Suspense` 的 fallback：页面 chunk 到达前占位，避免内容区空白一闪。
 *
 * 刻意只用**品牌徽标**而非整幅花园：花园 SVG 是 `index.html` 的首屏静态资源（必须内联，
 * 无法从 TS 引入），在这里重画会多出一份需要同步维护的副本；而路由切换通常是百毫秒级，
 * 轻量兜底更合适，视觉上也与首屏加载页同源（同一个「轻」字方块与绿意配色）。
 *
 * 无障碍：`role="status"` 会在出现时被读屏播报；呼吸动画用 `motion-safe:` 前缀，
 * 尊重「减少动态效果」偏好。
 */
export default function RouteLoading(): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="页面加载中"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-500 text-lg font-semibold text-white motion-safe:animate-pulse">
        轻
      </span>
      <span className="text-sm text-brand-700 dark:text-brand-200">加载中…</span>
    </div>
  );
}
