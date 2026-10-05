/**
 * 「数字是怎么来的」页（`/why-numbers`）缺陷收尾测试。
 *
 * 覆盖两项：
 * - **项 3（JSX 泄漏 Markdown）**：页面**渲染出的文本**里不得出现 `**` ——
 *   `**` 写在 JSX 文本 / 属性里不会被 Markdown 解析，会原样显示给用户（排版垃圾）。
 *   本页是「透明度」这个差异化卖点的门面，必须干净；
 * - **项 5 / C-1（NFR-11）**：周报「日均」同分母（㉒）与「足迹日历深浅口径」（㉓）都必须在页内有条目。
 *
 * ## 本用例与 `why-numbers-toc.test.tsx` 的分工
 *
 * 这里核对的是**第 1~㉓ 条的编号序列本身连续唯一**（即既有 23 条的编号顺序没有被后来新增的
 * ㉔㉕㉖ 打乱），以及第 ㉓ 条排在「相关页面」导航之前。
 * **总条数**与「目录元数据 vs 正文 h2 条条对拍」由 `why-numbers-toc.test.tsx` 负责
 * —— 那边的 `WHY_SECTIONS`（26 条）与页面渲染结果严格相等，新增条目后必须同步改那里，不必在这里重复。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import WhyNumbersPage from '@/pages/why-numbers/WhyNumbersPage';

/** 前 23 条的编号（顺序即展示顺序，硬编码，无注册表）；总数与目录对拍不在本用例内。 */
const CIRCLED = [
  '①',
  '②',
  '③',
  '④',
  '⑤',
  '⑥',
  '⑦',
  '⑧',
  '⑨',
  '⑩',
  '⑪',
  '⑫',
  '⑬',
  '⑭',
  '⑮',
  '⑯',
  '⑰',
  '⑱',
  '⑲',
  '⑳',
  '㉑',
  '㉒',
  '㉓',
] as const;

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 未登录时本页不发 `/profile`（enabled:false）；这里仍兜一层桩，避免任何意外请求抛错。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: null, error: null }) })),
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WhyNumbersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('why-numbers 页 · 缺陷收尾', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('项 3：渲染文本不含 Markdown 加粗字面量 `**`', () => {
    renderPage();
    expect(document.body.textContent ?? '').not.toContain('**');
  });

  it('项 5 / C-1：第 ㉓ 条存在、插在「相关页面」导航之前，且 ①~㉓ 的顺序未被后面的新条目打乱', () => {
    renderPage();

    // 本页新增了顶部目录导航，其编号项的可见文本也是「㉓」等带圈数字。
    // 因此这里必须把查询**限定在正文的 h2** 上：断言的对象是「第 ㉓ 条**条目**」，
    // 而不是页面上任何以 ㉓ 开头的元素（否则目录一加进来就会「Found multiple elements」）。
    const headingsInOrder = Array.from(document.querySelectorAll('h2'));
    const headingStartsWith = (marker: string): HTMLElement | undefined =>
      headingsInOrder.find((node) => (node.textContent ?? '').trim().startsWith(marker));

    // 第 ㉓ 条存在（标题以 ㉓ 开头）
    const twentyThree = headingStartsWith('㉓');
    expect(twentyThree).toBeDefined();
    expect(twentyThree).toBeInTheDocument();

    // 第 ㉒ 条仍在（回归保护：不得为加 ㉓ 而删掉既有条目）
    expect(headingStartsWith('㉒')).toBeInTheDocument();

    // ㉓ 必须排在「相关页面」导航**之前**（nav 跟随 ㉓）
    const nav = screen.getByRole('navigation', { name: '相关页面' });
    const followsNav = (twentyThree as HTMLElement).compareDocumentPosition(nav);
    expect(followsNav & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 前 23 个编号恰好是 ①~㉓：顺序正确、无重复、无缺号（断言原文未改，只取前 23 个）。
    // ㉔㉕㉖ 落在 ㉓ 之后，不参与本次比对（它们的存在由 toc 用例按 26 条总数对拍）。
    const numbers = headingsInOrder
      .map((node) => (node.textContent ?? '').trim().charAt(0))
      .filter((char) => (CIRCLED as readonly string[]).includes(char));
    expect(numbers.slice(0, CIRCLED.length)).toEqual([...CIRCLED]);
  });
});
