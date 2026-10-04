/**
 * 记录面板窄屏布局护栏（P0 裁切 + 弹层定位 + 勾选框形态）。
 *
 * 钉死三件事（均为 390×844 实测复现过的缺陷）：
 * ① **tab 不被裁**：6 个记录方式 tab 合计宽度 ≤ 容器净宽，且容器右侧留有安全内边距
 *    （`pr-*`）——「常吃」出现变 7 项时，末项仍能被完整横滑出来；
 * ② **弹层挂到 body**：`<main>` 带 `animate-fade-in`（keyframes 含 `transform`），
 *    祖先有 transform 时会成为 `position: fixed` 后代的**包含块**，
 *    `fixed inset-0` 于是相对 `<main>`（高 1156px）而非视口（844px）定位 ——
 *    实测面板被推到 `t=863`，**整块落在折线以下**，顶部 93px 还可点击穿透。
 *    故弹层必须 `createPortal` 到 `document.body`，不能留在 React 树原位；
 * ③ **勾选框是圆不是方**：`appearance-none` + `rounded-full`，
 *    选中态叠加白色对勾（内联 style，见 `CHECK_MARK_STYLE` 注释里的 URL 转义坑）。
 *
 * ⚠️ 为什么用 `getBoundingClientRect` 之外的断言：jsdom **不做布局**，
 * `getBoundingClientRect` 恒返回 0。故此处断言**结构与类名**（能在 jsdom 里真实区分
 * 修与不修），像素级裁切由 `qingshenghuo/probe-mealcomposer.mjs` 在真浏览器里量。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MealComposer from '@/pages/diary/MealComposer';

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/foods/last-portions')) return ok({ portions: {} });
      if (url.includes('/foods/top')) return ok({ days: 90, items: [] });
      if (url.includes('/foods/live-search')) {
        return ok({ items: [], found: 0, skipped: 0, degraded: false, source: 'openfoodlights', license: 'ODbL 1.0' });
      }
      if (url.includes('/foods/favorites')) return ok([]);
      if (url.includes('/foods/search')) return ok({ items: [], total: 0, page: 1, pageSize: 20 });
      return ok([]);
    }),
  );
}

function renderComposer(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MealComposer date="2026-09-12" mealType="lunch" onClose={vi.fn()} onSubmit={vi.fn()} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('① 记录方式 tab：窄屏不被裁', () => {
  it('tablist 右侧留安全内边距（末项横滑到底时不贴裁剪边缘）', () => {
    stubFetch();
    renderComposer();
    const tablist = screen.getByRole('tablist', { name: '记录方式' });
    // `pr-2` = 8px。改动前是 `mt-4 flex gap-1.5 overflow-x-auto`，无右侧内边距。
    expect(tablist.className).toContain('pr-2');
    expect(tablist.className).toContain('overflow-x-auto');
  });

  it('tab 横向内边距用 px-3（6 项合计 342px ≤ 容器净宽 350px），不是 px-4（合计 390px 溢出）', () => {
    stubFetch();
    renderComposer();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThanOrEqual(6);
    for (const tab of tabs) {
      expect(tab.className).toContain('px-3');
      // px-3(12px×2) + 2 个汉字(text-sm 14px×2=28px) = 52px；px-4 时是 60px，6 项 = 360px + gap 溢出
      expect(tab.className).not.toContain('px-4');
    }
  });

  it('每个 tab 都 shrink-0（不参与压缩变形），容器才是横滑的那一层', () => {
    stubFetch();
    renderComposer();
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('shrink-0');
    }
  });
});

describe('② 弹层定位：脱离 main 的 transform 包含块', () => {
  it('role=dialog 挂在 document.body 上，而不是 React 容器的子树里', () => {
    stubFetch();
    renderComposer();
    const dialog = screen.getByRole('dialog');
    // createPortal 的直接后果：dialog 的父节点是 body。
    // 不 portal 时它会留在 render 容器内 → fixed 相对 main 定位 → 整块落到折线以下。
    expect(dialog.parentElement).toBe(document.body);
  });

  it('弹层自身仍是 fixed inset-0 全屏遮罩 + 底部贴边布局', () => {
    stubFetch();
    renderComposer();
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('inset-0');
    expect(cls).toContain('items-end');
  });

  it('遮罩深浅两套都非透明（浅色更亮、深色更深），且都不是警示色', () => {
    stubFetch();
    renderComposer();
    const cls = screen.getByRole('dialog').className;
    // 浅色 slate-900/50；深色必须另给一套（深色底本身很暗，用浅色那套压不出浮起感）
    expect(cls).toContain('bg-slate-900/50');
    expect(cls).toContain('dark:bg-slate-950/65');
    // 产品红线：遮罩不得用红/黄等警示色
    expect(cls).not.toMatch(/red|amber|yellow|orange|rose/);
  });
});

describe('③ 多选勾选框：圆形而非灰色方块', () => {
  it('未选中态是描边圆（appearance-none 去掉原生方块绘制 + rounded-full）', () => {
    stubFetch();
    renderComposer();
    const cb = screen.getByLabelText('多选记录') as HTMLInputElement;
    expect(cb.type).toBe('checkbox');
    // `appearance-none` 是关键：浏览器原生 checkbox 会无视 rounded-*/bg-*，
    // 这正是此前「className 写了 rounded 仍显示灰方块」的原因。
    expect(cb.className).toContain('appearance-none');
    expect(cb.className).toContain('rounded-full');
  });

  it('选中态是品牌色实心圆（对勾本身由真浏览器探针验，见文件头说明）', () => {
    stubFetch();
    renderComposer();
    const cb = screen.getByLabelText('多选记录') as HTMLInputElement;
    expect(cb.className).toContain('checked:border-brand-600');
    expect(cb.className).toContain('checked:bg-brand-600');
    // ⚠️ 不能断言 `style.backgroundImage`：jsdom 的 CSS 解析器**静默丢弃** data URI
    // （实测设进去再读回来是 `''`，连 style 属性都不落）。
    // 对勾是否真的画出来由 `probe-mealcomposer.mjs` 在真浏览器里读计算样式 +
    // 截图确认（`fix-cb-<scheme>-on.png`）。
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
  });

  it('两处勾选框共用同一套形态类（多选开关 / 存进食物库）', () => {
    stubFetch();
    renderComposer();
    const all = Array.from(
      document.querySelectorAll('[role="dialog"] input[type="checkbox"]'),
    ) as HTMLInputElement[];
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const cb of all) {
      expect(cb.className).toContain('appearance-none');
      expect(cb.className).toContain('rounded-full');
    }
  });
});
