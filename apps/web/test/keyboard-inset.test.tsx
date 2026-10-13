/**
 * 软键盘遮挡修复（iOS Safari 真机缺陷）的两层钉子。
 *
 * ## 背景
 *
 * iOS Safari 的布局视口不随软键盘收缩，三个底部抽屉（存套餐 / 改食物 /
 * 改份量）的面板下半截会落在键盘底下。修法见 `src/lib/keyboard-inset.ts：
 * visualViewport 差值 → CSS 变量 → 抽屉容器 padding-bottom + 面板 max-h。
 *
 * ## 本文件测什么、不测什么（jsdom 硬边界）
 *
 * **测**：
 * ① 纯函数 `resolveKeyboardInset` 的阈值/边界（含 Safari 平移与双指缩放）；
 * ② 三个抽屉的渲染 DOM **确实消费** `--qsh-keyboard-inset`；
 * ③ `main.tsx` 启动路径**确实调用** `initKeyboardInset()`。
 *    —— ②③ 是接线守卫：「模块写了没人用」是本仓库最大技术债，
 *    必须有测试兜住，否则将来重构把类名删了没人发现。
 *
 * **不测**（jsdom 无布局、无 visualViewport，mock 几何必然假绿）：
 * 键盘弹起时面板是否真的抬到键盘之上。几何效果只能在真机验证。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initKeyboardInset, KEYBOARD_INSET_THRESHOLD_PX, resolveKeyboardInset } from '@/lib/keyboard-inset';
import EditFoodDialog from '@/pages/foods/EditFoodDialog';
import MealPortionEditor from '@/pages/diary/MealPortionEditor';
import SaveComboDialog from '@/pages/diary/SaveComboDialog';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('① resolveKeyboardInset 纯函数（阈值与边界）', () => {
  it('键盘弹起：布局视口不动、可视视口收缩 → 差值即遮挡高度', () => {
    // iPhone 390×844：键盘弹起后可视高约 500
    expect(resolveKeyboardInset(844, 500, 0)).toBe(344);
  });

  it('Safari 把页面往上推时 offsetTop 参与计算（不少算被平移的量）', () => {
    // 同一把键盘，可视视口被推高 20px：offsetTop 不减会少算 20
    expect(resolveKeyboardInset(844, 480, 20)).toBe(344);
  });

  it('无键盘：差值为 0 → 0', () => {
    expect(resolveKeyboardInset(844, 844, 0)).toBe(0);
  });

  it('地址栏显隐的几十 px 收缩不误判成键盘（阈值滤除）', () => {
    // Safari 地址栏收起约 60~90px，必须滤掉，否则抽屉被无故抬高
    expect(resolveKeyboardInset(844, 790, 0)).toBe(0);
  });

  it('阈值边界：恰好达到算键盘，差 1px 不算', () => {
    const belowThreshold = KEYBOARD_INSET_THRESHOLD_PX - 1;
    expect(resolveKeyboardInset(844, 844 - KEYBOARD_INSET_THRESHOLD_PX, 0)).toBe(
      KEYBOARD_INSET_THRESHOLD_PX,
    );
    expect(resolveKeyboardInset(844, 844 - belowThreshold, 0)).toBe(0);
  });

  it('双指缩小（可视视口高于布局视口）不为负 → 0', () => {
    expect(resolveKeyboardInset(844, 900, 0)).toBe(0);
  });

  it('收缩全部由平移解释（可视底边=布局底边）→ 无遮挡', () => {
    // 可视视口被平移 344px：底部并没有被吃掉，差值必须回到 0
    expect(resolveKeyboardInset(844, 500, 344)).toBe(0);
  });

  it('initKeyboardInset 在无 visualViewport 的环境（jsdom）静默跳过', () => {
    expect(typeof window.visualViewport).toBe('undefined');
    expect(() => initKeyboardInset()).not.toThrow();
    // 不设变量 → CSS 侧 var(…, 0px) 兜底为 0，行为与修复前一致
    expect(document.documentElement.style.getPropertyValue('--qsh-keyboard-inset')).toBe('');
  });
});

describe('② 三个底部抽屉消费 --qsh-keyboard-inset（DOM 级接线断言）', () => {
  /** 抽屉容器：键盘高度进 padding-bottom（桌面端被 sm:p-4 覆盖，零视觉变化）。 */
  const CONTAINER_INSET_CLASS = 'pb-[var(--qsh-keyboard-inset,0px)]';

  function renderComboDialog(): void {
    render(
      <SaveComboDialog
        mealType="breakfast"
        itemNames={['燕麦', '鸡蛋']}
        defaultName="早餐"
        busy={false}
        errorText={null}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
  }

  function renderEditDialog(): void {
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

  function renderPortionEditor(): void {
    // 快加条目（foodItemId: null）→ 食物库查询禁用，渲染不依赖网络
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MealPortionEditor
          log={{ id: 1, foodItemId: null, foodName: null, customName: '燕麦', grams: 100, kcal: 130 } as never}
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />
      </QueryClientProvider>,
    );
  }

  /** 容器与面板（第一个子元素）都必须引用键盘变量。 */
  function expectDialogWired(dialog: HTMLElement, label: string): void {
    expect(dialog.className, `${label}：容器应含 ${CONTAINER_INSET_CLASS}`).toContain(
      CONTAINER_INSET_CLASS,
    );
    const panel = dialog.firstElementChild;
    expect(panel, `${label}：面板应为容器第一个子元素`).not.toBeNull();
    // 面板 max-h 减去键盘高度；变量为 0px 时等于原 88vh
    expect(panel?.className, `${label}：面板 max-h 应含 calc(88vh …)`).toContain('calc(88vh');
    expect(panel?.className, `${label}：面板应引用 --qsh-keyboard-inset`).toContain(
      '--qsh-keyboard-inset',
    );
  }

  it('SaveComboDialog（/diary 存成套餐）', () => {
    renderComboDialog();
    expectDialogWired(screen.getByRole('dialog'), 'SaveComboDialog');
  });

  it('EditFoodDialog（/settings/foods 改一下）', () => {
    renderEditDialog();
    expectDialogWired(screen.getByRole('dialog'), 'EditFoodDialog');
  });

  it('MealPortionEditor（/diary 改份量）', () => {
    renderPortionEditor();
    expectDialogWired(screen.getByRole('dialog'), 'MealPortionEditor');
  });
});

describe('③ main.tsx 启动路径接线', () => {
  it('调用了 initKeyboardInset()', () => {
    // 路径以 cwd 为基准（vitest 从 apps/web 跑）；不用 import.meta.url ——
    // 本项目 vitest 下它会解析成盘符根，拼不出 src/（同 color-consistency-guard）
    const mainTsx = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    // 接线缺口守卫：模块存在 ≠ 被调用。这一条钉住启动路径。
    expect(mainTsx.length, 'main.tsx 应非空').toBeGreaterThan(0);
    expect(mainTsx, 'main.tsx 应调用 initKeyboardInset()').toContain('initKeyboardInset()');
  });
});
