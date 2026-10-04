/**
 * 三处弹层的定位护栏：存套餐 / 改食物 / 阶段回顾存档。
 *
 * 钉死的是**同一个根因**在三个页面上的表现（390×844 全部实测复现过）：
 *
 * `AppShell` 的 `<main>` 带 `animate-fade-in`，其 keyframes 含 `transform`。CSS 规定：
 * 祖先只要 `transform` 计算值**不为 `none`**（哪怕动画已停在 `translateY(0)`），就成为
 * `position: fixed` 后代的**包含块**，同时造出一个**层叠上下文**。于是留在 React 树原位的
 * `fixed inset-0` 弹层有两重病：
 *
 * ① **几何错**：相对 `<main>`（高 288~1516，随页面内容与滚动而变）而非视口（844）定位。
 *    实测三处改前分别是 `t=-732 h=1496` / `t=89 h=272` / `t=73 h=601` ——
 *    弹层底边分别停在 764/ 361 / 674，视口底部**80 / 483 / 170 px 完全裸露**，
 *    且食物库那处的面板被 `items-end` 推到 `t=-37`（**标题行在视口外**）。
 * ② **点击穿透**：`<main>` 的层叠上下文把弹层的 `z-50` 困在内部，而 `<header>`
 *    （sticky `z-30`）是 `<main>` 的**兄弟** —— 实测 `headerZ=30 < dialogZ=50`，
 *    点 (195,60) 命中的仍是原页面 `<header>`，不是 `role=dialog`。
 *
 * 修法与 `47f59ad`（记录面板 / 份量编辑器）**同一模式**：`createPortal(…, document.body)`，
 * 一次同时脱离包含块与层叠上下文；遮罩补深浅两套。
 *
 * ## ⚠️ 本文件能测什么、不能测什么（jsdom 的硬限制）
 *
 * **能测**（结构与类名，在 jsdom 里真实区分修与不修）：
 * -弹层挂到 `document.body`（`createPortal` 的直接后果，也是两重病的解药）；
 * - 遮罩深浅两套类名都在、且都不是警示色。
 *
 * **测不了**（**几何**，jsdom 不做布局，`getBoundingClientRect` 恒返回 0）：
 * - dialog 的 `top/height` 是否真的等于视口 844；
 * - 面板可见高度是否 > 0；
 * - 点 (195,60) 命中 dialog 还是 header；
 * - 遮罩实际压暗百分比。
 *
 * ⚠️ 所以**不要**用 mock 假装几何正确 —— 那必然假绿。像素级判定由
 * `qingshenghuo/probe-dialogs.mjs` 在真浏览器（Playwright，390×844）里量，
 * 本文件只负责守住「以后有人把 portal 删掉 / 把遮罩改回单套」这两件具体的事。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SaveComboDialog from '@/pages/diary/SaveComboDialog';
import EditFoodDialog from '@/pages/foods/EditFoodDialog';
import PeriodArchiveAction from '@/pages/report/PeriodArchiveAction';
import type { PeriodReport } from '@qsh/shared-types';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 三处共用的遮罩口径（与 `47f59ad` 一致）：浅色一套、深色另给一套且更深。 */
const OVERLAY_CLASS = {
  light: 'bg-slate-900/50',
  dark: 'dark:bg-slate-950/65',
};

describe('① SaveComboDialog（/diary 存成套餐）', () => {
  function renderDialog(): void {
    render(
      <SaveComboDialog
        mealType="breakfast"
        itemNames={['燕麦', '鸡蛋']}
        defaultName="早餐 9月12日"
        busy={false}
        errorText={null}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
  }

  it('弹层挂在 document.body 上，不留在 React 容器子树里', () => {
    renderDialog();
    // createPortal 的直接后果。不 portal 时它留在 render 容器内 →
    // fixed 相对 <main> 定位（实测 t=-732 h=1496，底边 764 以下 80px 裸露）
    // 且 z-50 被 <main> 的层叠上下文困住，点 (195,60) 命中原页面 header（实测穿透）。
    expect(screen.getByRole('dialog').parentElement).toBe(document.body);
  });

  it('遮罩仍是 fixed inset-0 全屏 + 底部贴边（items-end），只是换了挂载点', () => {
    renderDialog();
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('inset-0');
    expect(cls).toContain('items-end');
    expect(cls).toContain('z-50');
  });

  it('遮罩深浅两套都在，且都不是警示色', () => {
    renderDialog();
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain(OVERLAY_CLASS.light);
    expect(cls).toContain(OVERLAY_CLASS.dark);
    // 产品红线：遮罩不得用红/黄等警示色
    expect(cls).not.toMatch(/red|amber|yellow|orange|rose/);
  });

  it('portal 后 Esc 仍能关闭（监听挂在 window 上，不受挂载点影响）', () => {
    const onCancel = vi.fn();
    render(
      <SaveComboDialog
        mealType="breakfast"
        itemNames={[]}
        defaultName="早餐"
        busy={false}
        errorText={null}
        onCancel={onCancel}
        onSubmit={vi.fn()}
      />,
    );
    // wait 锚点用「已渲染的标题」而非被测的 Esc 行为本身
    expect(screen.getByRole('dialog', { name: /给这一餐起个名字/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('② EditFoodDialog（/settings/foods 改一下）', () => {
  function renderDialog(): void {
    render(
      <EditFoodDialog
        food={{ id: 1, name: '燕麦', category: '主食', kcalPer100g: 130 } as never}
        busy={false}
        errorText={null}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
  }

  it('弹层挂在 document.body 上', () => {
    renderDialog();
    // 改前实测：<main> 高仅 288 → 弹层 t=89 h=272，视口 844 里只盖 272px，
    // 底边 361 以下 483px 裸露；面板被推到 t=-37，标题行在视口外。
    expect(screen.getByTestId('edit-food-dialog').parentElement).toBe(document.body);
  });

  it('遮罩深浅两套都在，且都不是警示色', () => {
    renderDialog();
    const cls = screen.getByTestId('edit-food-dialog').className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('inset-0');
    expect(cls).toContain(OVERLAY_CLASS.light);
    expect(cls).toContain(OVERLAY_CLASS.dark);
    expect(cls).not.toMatch(/red|amber|yellow|orange|rose/);
  });
});

describe('③ PeriodArchiveAction（/report 阶段回顾存档）', () => {
  const report = {
    days: 30,
    winCount: 0,
    weight: null,
  } as unknown as PeriodReport;

  function renderAction(): void {
    render(
      <PeriodArchiveAction
        report={report}
        topFoods={[]}
        weightUnit="kg"
        topFoodsLoading={false}
      />,
    );
  }

  it('确认层挂在 document.body 上', () => {
    renderAction();
    // wait 锚点：入口按钮（独立于被测的 portal 行为）
    fireEvent.click(screen.getByRole('button', { name: '保存这一份' }));
    // 改前实测：<main> 高 601 → 弹层 t=73 h=601，底边 674 以下 170px 裸露
    expect(screen.getByRole('dialog', { name: '保存前请留意' }).parentElement).toBe(document.body);
  });

  it('遮罩由单套 slate-950/45 改为深浅两套（深色底本身已暗，需另给且更深）', () => {
    renderAction();
    fireEvent.click(screen.getByRole('button', { name: '保存这一份' }));
    const cls = screen.getByRole('dialog', { name: '保存前请留意' }).className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('inset-0');
    expect(cls).toContain(OVERLAY_CLASS.light);
    expect(cls).toContain(OVERLAY_CLASS.dark);
    // 旧的单套取值应已移除（它让深色压不出浮起感）
    expect(cls).not.toContain('bg-slate-950/45');
    expect(cls).not.toMatch(/red|amber|yellow|orange|rose/);
  });

  it('仍是居中卡片布局（items-center，未被改成底部抽屉）', () => {
    renderAction();
    fireEvent.click(screen.getByRole('button', { name: '保存这一份' }));
    expect(screen.getByRole('dialog', { name: '保存前请留意' }).className).toContain('items-center');
  });
});
