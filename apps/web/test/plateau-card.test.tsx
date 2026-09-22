/**
 * 平台期说明卡测试（pages/weight/PlateauCard.tsx，R2.7）。
 *
 * 钉死三条：
 * - 触发时把「判定依据」摊开讲（停滞天数 + 阈值），并给「4 周斜率」这个新视角；
 * - 斜率算不出来时**不展示**那一行（不编造数字）；
 * - **语气硬约束（PRD §7）**：不得出现失败 / 超标 / 前功尽弃等指责或恐吓词，
 *   且不得使用红色语义类（`text-red-*` / `bg-red-*`）。
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import PlateauCard from '@/pages/weight/PlateauCard';

describe('PlateauCard（R2.7 平台期说明卡）', () => {
  it('触发时解释「为什么」，并把视角拉到 4 周斜率', () => {
    render(<PlateauCard stalledDays={30} slope4wKgPerWeek={0} />);

    expect(screen.getByRole('region', { name: '这几周体重没怎么动' })).toBeDefined();
    // 判定依据：停滞天数 + 阈值（可解释性，不藏着）
    expect(screen.getByText('最近 30 天，7 日均线的变化不到 0.3 kg')).toBeDefined();
    expect(screen.getByText('把时间拉到 4 周看，平均每周 0.00 kg')).toBeDefined();
    expect(screen.getByText('拉长看，这几周基本持平。')).toBeDefined();
    // 明确不因此建议加大缺口
    expect(screen.getByText(/不会.*建议.*加大缺口/)).toBeDefined();
  });

  it('斜率算不出来时不展示那一行，也不编造数字', () => {
    render(<PlateauCard stalledDays={30} slope4wKgPerWeek={null} />);

    expect(screen.getByText('最近 30 天，7 日均线的变化不到 0.3 kg')).toBeDefined();
    expect(screen.queryByText(/把时间拉到 4 周看/)).toBeNull();
    expect(screen.queryByText(/拉长看/)).toBeNull();
  });

  it('语气硬约束：无指责 / 恐吓词，也不用红色语义类', () => {
    const { container } = render(<PlateauCard stalledDays={25} slope4wKgPerWeek={-0.4} />);
    const text = container.textContent ?? '';
    const html = container.innerHTML;

    for (const banned of ['失败', '超标', '前功尽弃', '反弹', '你不够努力', '白费']) {
      expect(text).not.toContain(banned);
    }
    // 绝不使用红色警示语义（PRD §7）
    expect(html).not.toMatch(/text-red-/);
    expect(html).not.toMatch(/bg-red-/);
  });

  it('斜率向下时给出「趋势还在往下走」的中性解读（不夸大成停滞）', () => {
    render(<PlateauCard stalledDays={22} slope4wKgPerWeek={-0.38} />);

    expect(screen.getByText('把时间拉到 4 周看，平均每周 -0.38 kg')).toBeDefined();
    expect(screen.getByText('拉长看，趋势其实还在往下走。')).toBeDefined();
  });
});
