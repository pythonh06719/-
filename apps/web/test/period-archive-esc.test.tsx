import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PeriodArchiveAction from '@/pages/report/PeriodArchiveAction';

/**
 * 「阶段存档」弹层的 Esc 关闭（`PeriodArchiveAction`）。
 *
 * ## 为什么补这条
 *
 * 全站三处「二次确认弹窗」里，本弹层**独缺** Esc 监听：另两处
 * （`SaveComboDialog.tsx:65-73`、`EditFoodDialog.tsx`）都有
 * `keydown → Escape → onCancel`，本处按 Esc 不关，只能去点「先不保存」。
 * 用户已经养成 Esc 退出的习惯，缺一处就是一个可用性缺口。
 *
 * ## 守卫语义
 *
 * **保存中（`saving`）不响应** —— 避免打断在途请求。与 `SaveComboDialog`
 * 的 `!busy` 守卫同义（该处变量名叫 `busy`）。
 *
 * ## wait 锚点独立于被测行为
 *
 * 全部锚在「确认面板已打开」这个**与 Esc 无关**的前提上（点击入口按钮后
 * 标题出现），**不**锚在「关闭后消失」这类正是被断言对象上。
 */

function renderAction(): void {
  render(
    <MemoryRouter>
      <PeriodArchiveAction
        report={{} as never}
        topFoods={[]}
        weightUnit="kg"
        topFoodsLoading={false}
      />
    </MemoryRouter>,
  );
}

/** 打开确认面板：点入口按钮，返回面板标题的文本。 */
async function openConfirm(): Promise<string> {
  const trigger = screen.getByRole('button', { name: /保存|存档/ });
  fireEvent.click(trigger);
  return (await screen.findByText('保存前请留意')).textContent ?? '';
}

describe('阶段存档弹层：Esc 关闭', () => {
  it('★ 按 Esc 关闭确认面板', async () => {
    renderAction();
    await openConfirm();

    // 前提锚点：面板确实开着
    expect(screen.getByText('保存前请留意')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('保存前请留意')).toBeNull();
    });
  });

  it('未打开时不响应 Esc（不该有任何副作用、不该报错）', () => {
    renderAction();
    expect(() => fireEvent.keyDown(window, { key: 'Escape' })).not.toThrow();
    // 面板从未打开，仍然没出现
    expect(screen.queryByText('保存前请留意')).toBeNull();
  });

  it('关闭后可再次打开（监听在 open/close 间正确解绑与重挂）', async () => {
    renderAction();
    await openConfirm();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('保存前请留意')).toBeNull();
    });

    // 监听必须随 confirming 重新挂上，否则第二次打开就关不掉
    await openConfirm();
    expect(screen.getByText('保存前请留意')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('保存前请留意')).toBeNull();
    });
  });
});
