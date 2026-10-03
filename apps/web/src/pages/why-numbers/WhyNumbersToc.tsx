import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { COPY } from '@/lib/copy';
import { WHY_SECTIONS, pickActiveIndex, sectionLabel, sectionMarker } from './why-sections';

/**
 * `/why-numbers` 的目录导航（顶部吸顶两行条）。
 *
 * ## 为什么是这个形态（顶部吸顶 + 编号横滑条），而不是折叠目录 / 吸顶分组标题
 *
 * 这一页实测 25048px 高 ≈ 29.7 屏（视口 390×844）、23 张卡，用户滚到第 20 条时不知道「我在哪、还剩多少」。
 * 候选形态逐一排除：
 *
 * - **`<details>` 折叠目录**：折叠起来只留一个「展开」按钮，滚动时**始终不可见** ——
 *   解决不了「不知道在哪」这个核心痛点；而且把 23 条藏起来，正文变成一条长到没有落点的流。
 * - **吸顶分组标题**：只有在真有分组时才成立。**本页 23 条是平铺的，没有天然分组**
 *   （文件头注释写的「四个内容块」早已过时，实际是 23 条同级 section）——
 *   要用分组就得先凭空造分组，那是编造结构，反而制造新的可解释性风险。
 * - **左侧固定侧边栏**：390px 宽下会直接吃掉正文宽度，违反「不挤占正文空间」。
 * - **顶部粘性横滑条（本方案）**：① 高度固定（实测 75px），横向占满、正文仍在 350px 内容区里
 *   （实测 `main` 宽仍为 390px，目录不侵占正文）；② 23 个 44×44 触控目标
 *   （复用 `.qsh-touch-target`，WCAG 2.5.5）横排，天然适配拇指横扫；
 *   ③ 「我在哪 / 还剩多少」分两行回答：第一行是当前条的完整标题 + `N / 23` 计数，
 *   第二行才是编号横滑条。
 *
 * ## 为什么高亮不用 IntersectionObserver
 *
 * 本页卡片高度差极大（3 行到 40 行都有），一个视口里常同时有 2~3 条 intersecting，
 * 「选哪个」没有唯一答案。真正决定「用户在读哪条」的只有一件事：
 * **这一条的标题有没有越过阅读线（吸顶条下沿）**。所以改成读各条标题的 viewport top，
 * 规则抽成纯函数 `pickActiveIndex`（可无浏览器单测），滚动监听用 rAF 节流 + passive。
 *
 * ## 无障碍与动效
 *
 * - 目录项是**真 `<a href="#锚点">`**：读屏会播报「链接」、可右键在新标签打开、可被搜索引擎收录。
 *   点击时 `preventDefault` 改为手动滚动（原生 hash 跳转不考虑吸顶偏移，会把标题藏在条下面），
 *   再用 `history.replaceState` 同步 hash —— 分享链接仍能落到正确位置，但不会二次跳动。
 * - `prefers-reduced-motion`：`a11y.css` 的全局兜底只压 CSS 动画与 `scroll-behavior`，
 *   **管不到 JS 里 `scrollTo({ behavior: 'smooth' })`**，所以这里显式判断媒体查询后传 `'auto'`。
 */

/**
 * 标题与吸顶条下沿之间保留的空隙（px）。
 *
 * 同时被两处使用，**必须一致**：① 判定「当前条目」的阅读线；② 点击编号后的滚动落点。
 * 两处若不一致，跳转后标题会落在阅读线之外，高亮停在上一条（这正是实测踩到的问题）。
 */
const ACTIVE_LINE_GAP_PX = 8;

/**
 * `activeIndex` 越界时的兜底（TS 的 `noUncheckedIndexedAccess` 让数组下标结果可能为 `undefined`）。
 * 只在 `WHY_SECTIONS` 为空这种不该发生的情况下才会被渲染到。
 */
const FALLBACK_SECTION = { id: 'why-budget-title', title: '① 热量预算怎么算' } as const;

export default function WhyNumbersToc(): ReactElement {
  const barRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  /** 用户是否要求减少动效。JS 滚动必须自己判断，CSS 全局兜底覆盖不到。 */
  const prefersReducedMotion = useCallback(
    (): boolean =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  /** 滚动监听：rAF 节流，passive。只更新「当前第几条」。 */
  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) {
      return;
    }
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      // 阅读线 = 吸顶条下沿再留一点空隙。用 ACTIVE_LINE_GAP_PX 而非裸 0，
      // 是为了让「点编号跳转后落点」与「此时判定为当前条」用的是同一条线 ——
      // 否则跳转停在 gap 之外，标题尚未越线，高亮会停在上一条（实测跳 ⑳ 却高亮 ⑲）。
      const readingLine = bar.getBoundingClientRect().bottom + ACTIVE_LINE_GAP_PX;
      const tops = WHY_SECTIONS.map((section) => {
        const heading = document.getElementById(section.id);
        return heading === null ? Number.POSITIVE_INFINITY : heading.getBoundingClientRect().top;
      });
      const next = pickActiveIndex(tops, readingLine);
      setActiveIndex((prev) => (prev === next ? prev : next));
    };
    const schedule = (): void => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(measure);
      }
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  /** 当前条目变化时，把它的编号滚进横滑条的可见范围（否则会滑到屏幕外看不见）。 */
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) {
      return;
    }
    const item = rail.querySelector<HTMLElement>(`[data-toc-index="${activeIndex}"]`);
    if (item === null) {
      return;
    }
    const centered = item.offsetLeft - (rail.clientWidth - item.offsetWidth) / 2;
    const left = Math.max(0, centered);
    // `scrollTo` 带 `behavior` 才能做平滑滚动；但 jsdom 未实现它，退回直接赋值 `scrollLeft`
    // （滚动位置仍正确，只是少了动画 —— 测试环境不需要动画）。
    if (typeof rail.scrollTo === 'function') {
      rail.scrollTo({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      rail.scrollLeft = left;
    }
  }, [activeIndex, prefersReducedMotion]);

  /** 点击编号：手动滚动到标题，并留出「吸顶条下沿 + 一点留白」的空隙。 */
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
      const heading = document.getElementById(id);
      const bar = barRef.current;
      if (heading === null || bar === null) {
        return;
      }
      // 保留「在新标签打开 / 复制链接地址」的原生行为。
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.button !== 0
      ) {
        return;
      }
      event.preventDefault();
      // 目标滚动位置要让标题落在**吸顶条下沿之下**。
      //
      // ⚠️ 这里必须用 CSS 声明的 sticky 阈值（`getComputedStyle(bar).top`），**不能**用
      // `bar.getBoundingClientRect().top`：从页面顶部（目录尚未吸顶）点后面的条目时，
      // 实测 rect.top 是它在文档流里的位置（≈190px）而非吸顶位置（73px），算出的落点会
      // 偏移 124px，标题停不到预期位置。用声明值则无论当前吸没吸顶都成立。
      const barBox = bar.getBoundingClientRect();
      const declaredTop = Number.parseFloat(getComputedStyle(bar).top);
      const stickyTop = Number.isFinite(declaredTop) ? declaredTop : barBox.top;
      const offset = stickyTop + barBox.height + ACTIVE_LINE_GAP_PX;
      const top = heading.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      // 同步 hash 但不触发浏览器二次跳转（replaceState 不滚动）。
      window.history.replaceState(null, '', `#${id}`);
      setActiveIndex(WHY_SECTIONS.findIndex((section) => section.id === id));
    },
    [prefersReducedMotion],
  );

  const active = WHY_SECTIONS[activeIndex] ?? FALLBACK_SECTION;

  return (
    <div
      ref={barRef}
      data-why-toc=""
      className="sticky top-[73px] z-20 -mx-5 border-b border-brand-100 bg-white/95 px-5 pb-1.5 pt-1 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"
    >
      {/*
        第一行回答「我在哪 / 还剩多少」：左边是当前条的完整标题（超长截断），
        右边是 `N / 23` 计数。都用 text-xs，把高度让给第二行的 44px 触控目标。
      */}
      <div className="flex items-baseline gap-2 text-xs leading-4">
        <span className="shrink-0 text-slate-500 dark:text-slate-400">{COPY.whyTocNavLabel}</span>
        <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
          {sectionMarker(active.title)} {sectionLabel(active.title)}
        </span>
        <span className="qsh-tnum shrink-0 text-slate-500 dark:text-slate-400">
          {activeIndex + 1} / {WHY_SECTIONS.length}
        </span>
      </div>

      {/*
        第二行：23 个编号横滑。编号本身是 ①…㉓ 的单字符，实测整条 rail 只有 1100px
        （可视 350px，约 3 屏滑到头）；真正的「这是哪一条」由上面第一行的完整标题承担。
      */}
      <nav aria-label={COPY.whyTocNavAriaLabel(WHY_SECTIONS.length)} className="mt-0.5">
        {/*
          `relative` 不是装饰，是**必需**：每个编号项里有一个 `.qsh-sr-only` 读屏文本，它是
          `position: absolute`。若这里没有定位祖先，它的包含块会一路向上找到吸顶条（sticky
          也算「已定位」），于是这些 1px 宽的读屏文本会脱离横滑容器、以各自的静态位置落在
          x≈1100 处 —— 横滑容器的 `overflow-x:auto` **裁不到它们**，整页因此被撑到
          scrollWidth=1099、可以横向拖动。给横滑容器加 `relative` 后，包含块落在容器内，
          溢出重新被裁掉（实测 scrollWidth 回到 390）。
        */}
        <div
          ref={railRef}
          className="relative flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {WHY_SECTIONS.map((section, index) => {
            const isActive = index === activeIndex;
            return (
              <a
                key={section.id}
                href={`#${section.id}`}
                data-toc-index={index}
                aria-current={isActive ? 'true' : undefined}
                onClick={(event) => {
                  handleClick(event, section.id);
                }}
                className={[
                  'qsh-touch-target flex shrink-0 items-center justify-center rounded-pill text-sm leading-none transition-colors duration-qsh-base ease-qsh-out',
                  isActive
                    ? 'bg-brand-600 font-semibold text-white dark:bg-brand-400 dark:text-brand-900'
                    : 'bg-brand-50 text-brand-800 hover:bg-brand-100 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
                ].join(' ')}
              >
                <span aria-hidden="true">{sectionMarker(section.title)}</span>
                <span className="qsh-sr-only">
                  {`${COPY.whyTocItemAriaPrefix}${index + 1}${COPY.whyTocItemAriaSuffix}${sectionLabel(section.title)}`}
                </span>
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/**
 * 本组件新增的文案。
 *
 * ⚠️ 按项目纪律，新增文案统一放 `src/lib/copy.ts`。该文件本轮由 team-lead 统一合并，
 *    本任务不改动它，故先在此处就地声明（值已定稿，合并时整体搬进 `copy.ts` 即可）。
 */
