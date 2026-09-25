/**
 * 周报多样性行测试（R11.7，pages/report/WeeklyDiversityRow.tsx）。
 *
 * 覆盖：
 * - 一行计数 + 整行可点展开/收起（AC-11.7.1，aria-expanded 状态正确）；
 * - `distinctFoodCount === 0` 或字段缺失（老响应向后兼容，AC-11.7.6）→ **整行隐藏**（AC-11.7.5）；
 * - 截断说明（`distinctFoodsTruncated === true` → 「已经很多啦，先显示这些」）；
 * - 红线（AC-11.7.3）：行内无进度条 / meter / 百分比 —— 只计数，不打分。
 */

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WeeklyReport } from '@qsh/shared-types';
import WeeklyDiversityRow from '@/pages/report/WeeklyDiversityRow';
import { COPY, diversityAria, diversityCountLine } from '@/lib/copy';

/** 周报最小可用响应（多样性行只关心三个扩展字段）。 */
function makeReport(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    from: '2026-09-17',
    to: '2026-09-23',
    days: [],
    avgIntakeKcal: 0,
    totalExerciseKcal: 0,
    weightChangeKg: null,
    micronutrients: [],
    referenceNote: '',
    distinctFoodCount: 23,
    distinctFoods: ['燕麦', '鸡胸肉', '西兰花'],
    distinctFoodsTruncated: false,
    ...overrides,
  } as WeeklyReport;
}

describe('WeeklyDiversityRow（R11.7）', () => {
  it('显示「这周吃到了 23 种不同的食物」，整行按钮可展开清单（AC-11.7.1）', () => {
    const { container, getByRole } = render(<WeeklyDiversityRow report={makeReport()} />);

    expect(screen.getByTestId('weekly-diversity')).toBeDefined();
    expect(screen.getByText(diversityCountLine(23))).toBeDefined();

    const toggle = getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe(diversityAria(23, false));

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe(diversityAria(23, true));
    expect(screen.getByTestId('weekly-diversity-list')).toBeDefined();
    expect(screen.getByText(COPY.diversityListTitle)).toBeDefined();
    expect(screen.getByText('燕麦')).toBeDefined();
    expect(screen.getByText('鸡胸肉')).toBeDefined();
    expect(screen.getByText('西兰花')).toBeDefined();

    // 再点一次收起
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('weekly-diversity-list')).toBeNull();

    // 红线：无进度原语、无百分比（AC-11.7.3）
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(container.querySelector('progress')).toBeNull();
    expect(container.innerHTML).not.toContain('%');
  });

  it('count = 0 → 整行隐藏（不显示「0 种」，AC-11.7.5）', () => {
    const { container } = render(<WeeklyDiversityRow report={makeReport({ distinctFoodCount: 0 })} />);
    expect(container.querySelector('[data-testid="weekly-diversity"]')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('扩展字段缺失（老响应）→ 整行隐藏，不报错（AC-11.7.6 向后兼容）', () => {
    const legacy = makeReport();
    const partial = legacy as Partial<WeeklyReport>;
    delete partial.distinctFoodCount;
    delete partial.distinctFoods;
    delete partial.distinctFoodsTruncated;
    const { container } = render(<WeeklyDiversityRow report={legacy} />);
    expect(container.innerHTML).toBe('');
  });

  it('清单被 200 上限截断 → 展开后给中性说明（AC-11.7.2）', () => {
    render(
      <WeeklyDiversityRow
        report={makeReport({ distinctFoodsTruncated: true, distinctFoods: ['燕麦', '鸡胸肉'] })}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(COPY.diversityTruncated)).toBeDefined();
  });

  it('未截断 → 不出现截断说明', () => {
    render(<WeeklyDiversityRow report={makeReport({ distinctFoodsTruncated: false })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(COPY.diversityTruncated)).toBeNull();
  });
});
