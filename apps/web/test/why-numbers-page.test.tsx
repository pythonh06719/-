/**
 * 「数字是怎么来的」页（`/why-numbers`）缺陷收尾测试。
 *
 * 覆盖两项：
 * - **项 3（JSX 泄漏 Markdown）**：页面**渲染出的文本**里不得出现 `**` ——
 *   `**` 写在 JSX 文本 / 属性里不会被 Markdown 解析，会原样显示给用户（排版垃圾）。
 *   本页是「透明度」这个差异化卖点的门面，必须干净；
 * - **项 5（NFR-11）**：周报两处「日均」同分母必须在页内有可解释条目 —— 第 ㉒ 条存在，
 *   且编号 ①~㉒ 连续、唯一（该页单文件硬编码、无注册表，编号重复是历史坑）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import WhyNumbersPage from '@/pages/why-numbers/WhyNumbersPage';

/** 该页 22 个编号（顺序即展示顺序，硬编码，无注册表）。 */
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

  it('项 5：第 ㉒ 条存在、插在「相关页面」导航之前，且编号 ①~㉒ 连续唯一', () => {
    renderPage();

    // 第 ㉒ 条存在（标题以 ㉒ 开头）
    const twentyTwo = screen.getByText(/^㉒/);
    expect(twentyTwo).toBeInTheDocument();

    // 必须排在「相关页面」导航**之前**（nav 跟随 ㉒）
    const nav = screen.getByRole('navigation', { name: '相关页面' });
    expect(twentyTwo.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 全部 h2 的编号恰好是 ①~㉒：连续、唯一、无重复、无缺号
    const headings = Array.from(document.querySelectorAll('h2')).map((node) => node.textContent ?? '');
    const numbers = headings
      .map((text) => text.trim().charAt(0))
      .filter((char) => (CIRCLED as readonly string[]).includes(char));
    expect(numbers).toEqual([...CIRCLED]);
  });
});
