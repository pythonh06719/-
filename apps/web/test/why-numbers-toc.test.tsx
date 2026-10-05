/**
 * `/why-numbers` 目录导航 + 公式可读性护栏（`test/why-numbers-toc.test.tsx`）。
 *
 * ## 本文件钉死的行为
 *
 * ① **公式完整可读**（本轮 P0 的根因护栏，最重要）：
 *    BMR 那段的「男性 / 女性」两行曾因 `<dd className="shrink-0">` 拒绝收缩而溢出容器，
 *    末尾 `+ 5` 被切一半、`− 161` 整段不可见 —— 用户看不到完整计算式，直接破坏 NFR-11 可解释性红线。
 *    这里**不测像素**（jsdom 没有布局，测不了），而是测「让溢出成为可能的那几个 CSS 契约」：
 *    值必须可收缩（无 `shrink-0`）、必须允许在任意位置断行（`overflow-wrap: anywhere`）、
 *    父行必须允许换行（`flex-wrap`）、术语必须有宽度下限（避免被压成一字一行的竖排）。
 *    这几条一旦被撤掉，用例转红。
 *
 * ② **26 条编号连续且唯一**（`checkNumbering()` 返回空数组）—— 本项目出过编号重复的坑。
 *
 * ③ **目录与正文逐条对拍**：把 `WHY_SECTIONS` 的 26 条与页面**实际渲染**出来的 26 个 `<h2>`
 *    比对 id / 全文 / 顺序。任何人改了正文标题却没同步 `why-sections.ts`，这里就红。
 *
 * ④ **目录可用性**：渲染 26 个真链接（`href` 指向存在的锚点）、首项 `aria-current`、
 *    高亮随滚动位置推进（用 `pickActiveIndex` 的纯函数单测覆盖）。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import WhyNumbersPage from '@/pages/why-numbers/WhyNumbersPage';
import WhyNumbersToc from '@/pages/why-numbers/WhyNumbersToc';
import {
  CIRCLED_NUMERALS,
  WHY_SECTIONS,
  checkNumbering,
  pickActiveIndex,
  sectionLabel,
  sectionMarker,
} from '@/pages/why-numbers/why-sections';

// ---------------------------------------------------------------------------
// 测试装置
// ---------------------------------------------------------------------------

/** 页面只读 `/profile`，未登录时该请求被跳过；这里给一个干净的 QueryClient 即可。 */
function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WhyNumbersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderToc(): ReturnType<typeof render> {
  return render(<WhyNumbersToc />);
}

/** 取出页面上真实渲染的全部 `<h2>`（目录区的标题不参与，因为目录不渲染 h2）。 */
function renderedHeadings(root: HTMLElement): { id: string; text: string }[] {
  return Array.from(root.querySelectorAll('h2')).map((node) => ({
    id: node.id,
    text: (node.textContent ?? '').trim(),
  }));
}

// ---------------------------------------------------------------------------
// ① 公式完整可读（本轮 P0 根因护栏）
// ---------------------------------------------------------------------------

describe('BMR 公式完整可读（P0：值被容器裁切）', () => {
  it('两条公式的文本本身是完整的（尾部 + 5 / − 161 一个字都没少）', () => {
    const { container } = renderPage();
    const text = container.textContent ?? '';
    // 逐字断言尾部。用户报障的现象就是「+ 5 只露一半」「− 16 之后不可见」。
    expect(text).toContain('10×体重(kg) + 6.25×身高(cm) − 5×年龄 + 5');
    expect(text).toContain('10×体重(kg) + 6.25×身高(cm) − 5×年龄 − 161');
  });

  it('公式值不得带 shrink-0（拒绝收缩 = 溢出容器 = 被 body overflow-x:hidden 静默裁掉）', () => {
    const { container } = renderPage();
    const values = Array.from(container.querySelectorAll('dd')).map((node) => node.className);
    expect(values.length).toBeGreaterThan(0);
    for (const className of values) {
      expect(className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
    }
  });

  it('公式值必须能在任意位置断行，且允许收缩到 0（min-w-0 + overflow-wrap:anywhere）', () => {
    const { container } = renderPage();
    const bmrDd = Array.from(container.querySelectorAll('dd')).find((node) =>
      (node.textContent ?? '').includes('− 161'),
    );
    expect(bmrDd).toBeDefined();
    // `min-w-0`：flex 子项默认 `min-width:auto`，不加它则按 max-content 定宽、拒绝收缩。
    expect(bmrDd?.className).toMatch(/(^|\s)min-w-0(\s|$)/);
    // `overflow-wrap:anywhere`：仅 `break-word` 在超长无空格串（如本公式）上不生效，
    // 少了它，长公式在窄屏仍会撑破容器。
    expect(bmrDd?.className).toContain('overflow-wrap:anywhere');
  });

  it('定义行父容器必须允许换行（flex-wrap），且术语要有宽度下限（min-w-*[5.5rem]）', () => {
    const { container } = renderPage();
    const bmrDd = Array.from(container.querySelectorAll('dd')).find((node) =>
      (node.textContent ?? '').includes('− 161'),
    );
    const row = bmrDd?.parentElement;
    expect(row).not.toBeNull();
    // 没有 flex-wrap，放不下的值就只能溢出，不能换到下一行。
    expect(row?.className).toMatch(/flex-wrap/);
    // 没有术语宽度下限，窄屏下术语会被压成「一字一行」的竖排。
    expect(row?.querySelector('dt')?.className).toMatch(/min-w-\[5\.5rem\]/);
  });
});

// ---------------------------------------------------------------------------
// ② 26 条编号连续且唯一
// ---------------------------------------------------------------------------

describe('26 条解释条目编号', () => {
  it('编号连续且唯一，无重复（本项目历史上出过重复编号的坑）', () => {
    expect(checkNumbering()).toEqual([]);
  });

  it('恰好 26 条，编号覆盖 ①…㉖ 且顺序正确', () => {
    expect(WHY_SECTIONS).toHaveLength(26);
    expect(WHY_SECTIONS.map((section) => sectionMarker(section.title))).toEqual(
      CIRCLED_NUMERALS.split(''),
    );
  });

  it('锚点 id 唯一', () => {
    const ids = WHY_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('短标题 = 去掉编号首字符（含其后空白）', () => {
    // 编号与标题之间有的有空格、有的没有（如 `⑬「这段时间」…`），trimStart 两种都要吃掉。
    expect(sectionLabel('① 热量预算怎么算')).toBe('热量预算怎么算');
    expect(sectionLabel('⑬「这段时间」里的六个数字怎么来')).toBe('「这段时间」里的六个数字怎么来');
  });

  it('checkNumbering 能真的抓出重复编号（否则它就是「永远为真」的假断言）', () => {
    const broken = [
      { id: 'a', title: '① 甲' },
      { id: 'b', title: '① 乙' },
    ];
    const problems = checkNumbering(broken as never);
    expect(problems.length).toBeGreaterThan(0);
    // 断言的是「当前条目数」（随元数据扩到 26 而变），故不写死字面量，避免又一处硬编码漂移。
    expect(problems.join('；')).toContain(`条目数应为 ${WHY_SECTIONS.length}`);
    // 条目数不对 + 编号重复 + 第 2 条编号错位，都应被报出来。
    expect(problems.join('；')).toContain('重复');
  });
});

// ---------------------------------------------------------------------------
// ③ 目录与正文逐条对拍
// ---------------------------------------------------------------------------

describe('目录元数据与页面实际渲染一致', () => {
  it('页面渲染出 26 个 h2，id / 全文 / 顺序与 WHY_SECTIONS 逐条相同', () => {
    const { container } = renderPage();
    const headings = renderedHeadings(container);
    expect(headings).toHaveLength(26);
    headings.forEach((heading, index) => {
      const section = WHY_SECTIONS[index];
      expect(section).toBeDefined();
      expect(heading.id).toBe(section?.id);
      // 全文比对（含编号字符）：防止有人改了正文标题而目录还停在旧文案。
      expect(heading.text).toBe(section?.title);
    });
  });
});

// ---------------------------------------------------------------------------
// ④ 目录可用性
// ---------------------------------------------------------------------------

describe('目录导航', () => {
  it('渲染 26 个链接，href 指向页面上真实存在的锚点', () => {
    const toc = renderToc();
    const links = Array.from(toc.container.querySelectorAll('nav a'));
    expect(links).toHaveLength(26);
    links.forEach((link, index) => {
      const href = link.getAttribute('href') ?? '';
      expect(href).toBe(`#${WHY_SECTIONS[index]?.id}`);
    });
    // 锚点在真实页面里必须存在（对拍已在上一节做过，这里再确认目录不指向不存在的 id）。
    const page = renderPage();
    for (const section of WHY_SECTIONS) {
      expect(page.container.querySelector(`#${section.id}`)).not.toBeNull();
    }
  });

  it('初始高亮第 1 条并带 aria-current（读屏可播报「当前」）', () => {
    renderToc();
    const current = document.querySelectorAll('nav a[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute('href')).toBe('#why-budget-title');
  });

  it('编号字符本身对读屏隐藏，另给完整语义（含序号 + 标题）', () => {
    const toc = renderToc();
    const first = toc.container.querySelector('nav a');
    // 可见文本只有编号（390px 下一行放得下 26 个编号的前提）。
    expect((first?.textContent ?? '').replace(/\s+/g, ' ').trim()).toContain('①');
    // 完整语义在 sr-only 里，序号用阿拉伯数字而非带圈数字（读屏念「①」体验差）。
    expect(first?.textContent ?? '').toContain('第 1 条 · 热量预算怎么算');
  });

  it('每个目录项都是 44×44 的触控目标（WCAG 2.5.5，a11y.css 的 .qsh-touch-target）', () => {
    const toc = renderToc();
    for (const link of Array.from(toc.container.querySelectorAll('nav a'))) {
      expect(link.className).toContain('qsh-touch-target');
    }
  });

  it('目录区有自己的 nav 无障碍名（读屏能定位）', () => {
    renderToc();
    const nav = screen.getByRole('navigation');
    expect(nav.getAttribute('aria-label')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ⑤ 高亮推进规则（pickActiveIndex 纯函数，无浏览器可测）
// ---------------------------------------------------------------------------

describe('当前条目判定（阅读线规则）', () => {
  it('未越过任何条目时停在第 1 条', () => {
    expect(pickActiveIndex([500, 900, 1400], 200)).toBe(0);
  });

  it('越过了第 3 条的标题就高亮第 3 条（0-based 下标 2）', () => {
    expect(pickActiveIndex([-2000, -900, 120, 800, 1500], 200)).toBe(2);
  });

  it('恰好压线算已越过（<=）', () => {
    expect(pickActiveIndex([100, 300], 100)).toBe(0);
    expect(pickActiveIndex([-10, 100], 100)).toBe(1);
  });

  it('空数组不会崩', () => {
    expect(pickActiveIndex([], 200)).toBe(0);
  });

  it('「文档顺序」被破坏时不会选出靠后的条目（越线即停）', () => {
    // 真实数据里 tops 单调不减；若某条为 +Infinity（锚点缺失/已卸载）也应停在更早的条目。
    expect(pickActiveIndex([-500, 100, Number.POSITIVE_INFINITY, 900], 200)).toBe(1);
  });
});
