/**
 * 周报趋势增强测试（C2：摄入 vs 运动柱状对比 / 习惯达成率 / 体重变化中性解读）。
 *
 * 覆盖三种数据形态：
 * - **正常**：7 天都有数据 → 14 根柱、汇总 aria、达成率百分比、体重解读；
 * - **全 0**：摄入/运动/打卡全为 0 → 不崩、不出现 NaN、达成率如实显示 0%；
 * - **缺数据**：`days` 为空 / 无习惯 → 走中性空态文案；`weightChangeKg` 为 null → 「记录不足」。
 *
 * 语气硬约束（PRD §7）：不使用红色 / 惩罚性语义；体重上浮用中性说法。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ReportPage from '@/pages/report/ReportPage';
import { COPY, reportHabitRateLabel, reportTrendAria, weeklyWeightReading } from '@/lib/copy';

interface TestDay {
  date: string;
  intakeKcal: number;
  exerciseKcal: number;
  waterMl: number;
  habitsDone: number;
  habitsTotal: number;
}

interface TestReport {
  from: string;
  to: string;
  days: TestDay[];
  avgIntakeKcal: number;
  totalExerciseKcal: number;
  weightChangeKg: number | null;
  micronutrients: Array<{
    key: string;
    name: string;
    unit: string;
    dailyAvg: number;
    reference: number;
    direction: string;
  }>;
  referenceNote: string;
}

function makeReport(days: TestDay[], weightChangeKg: number | null): TestReport {
  return {
    from: '2026-09-17',
    to: '2026-09-23',
    days,
    avgIntakeKcal: 1300,
    totalExerciseKcal: days.reduce((sum, day) => sum + day.exerciseKcal, 0),
    weightChangeKg,
    micronutrients: [],
    referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
  };
}

/** 造 7 天数据：摄入 1000..1600、运动 100..160、每日习惯 1/3。 */
function sevenDays(): TestDay[] {
  return Array.from({ length: 7 }, (_, index) => ({
    date: `2026-09-${String(17 + index).padStart(2, '0')}`,
    intakeKcal: 1000 + index * 100,
    exerciseKcal: 100 + index * 10,
    waterMl: 1500,
    habitsDone: 1,
    habitsTotal: 3,
  }));
}

function renderReport(report: TestReport): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: report, error: null }),
    })),
  );
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container;
}

describe('copy 纯函数（C2）', () => {
  it('weeklyWeightReading：null / 持平 / 下降 / 上浮 各有中性说法', () => {
    expect(weeklyWeightReading(null)).toBe(COPY.reportWeightMissing);
    expect(weeklyWeightReading(0)).toBe(COPY.reportWeightFlat);
    expect(weeklyWeightReading(0.05)).toBe(COPY.reportWeightFlat);
    expect(weeklyWeightReading(-0.8)).toBe(COPY.reportWeightDown);
    expect(weeklyWeightReading(0.9)).toBe(COPY.reportWeightUp);
  });

  it('reportHabitRateLabel：次数与百分比钳制到合理范围', () => {
    expect(reportHabitRateLabel(7, 33.33)).toBe('本周共打卡 7 次，达成率 33%');
    expect(reportHabitRateLabel(0, 0)).toBe('本周共打卡 0 次，达成率 0%');
    expect(reportHabitRateLabel(-5, 250)).toBe('本周共打卡 0 次，达成率 100%');
  });

  it('reportTrendAria：包含两组合计', () => {
    expect(reportTrendAria(9100, 910)).toBe('近 7 天摄入与运动消耗对比，共摄入 9100 千卡，运动消耗 910 千卡');
  });
});

describe('ReportPage 摄入 vs 运动 + 达成率（C2）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('正常数据：14 根柱、汇总 aria、达成率 33%、体重上浮中性解读', async () => {
    const container = renderReport(makeReport(sevenDays(), 0.6));

    await waitFor(() => {
      expect(screen.getByText(COPY.reportTrendTitle)).toBeDefined();
    });

    // 7 天 × 2 系列 = 14 根柱
    expect(container.querySelectorAll('rect')).toHaveLength(14);

    // 汇总无障碍标签（摄入合计 9100 / 运动合计 910）
    const chart = container.querySelector('svg[role="img"]');
    expect(chart?.getAttribute('aria-label')).toBe(reportTrendAria(9100, 910));

    // 习惯达成率：7 / 21 = 33%
    expect(screen.getByText(reportHabitRateLabel(7, 33))).toBeDefined();

    // 体重上浮 → 中性解读（不指责）
    expect(screen.getByText(COPY.reportWeightUp)).toBeDefined();
  });

  it('全 0 数据：不崩、无 NaN，达成率如实显示 0%', async () => {
    const zeros: TestDay[] = sevenDays().map((day) => ({
      ...day,
      intakeKcal: 0,
      exerciseKcal: 0,
      habitsDone: 0,
    }));
    const container = renderReport(makeReport(zeros, 0));

    await waitFor(() => {
      expect(screen.getByText(COPY.reportTrendTitle)).toBeDefined();
    });

    // 柱仍在（height=0 也渲染）
    expect(container.querySelectorAll('rect')).toHaveLength(14);
    expect(container.innerHTML).not.toContain('NaN');

    expect(screen.getByText(reportHabitRateLabel(0, 0))).toBeDefined();
    expect(screen.getByText(COPY.reportWeightFlat)).toBeDefined();
  });

  it('缺数据：days 为空 / 无习惯 → 中性空态；体重记录不足 → 「记录不够」', async () => {
    const noHabits = sevenDays().map((day) => ({ ...day, habitsTotal: 0, habitsDone: 0 }));
    renderReport(makeReport(noHabits, null));

    await waitFor(() => {
      expect(screen.getByText(COPY.reportTrendTitle)).toBeDefined();
    });

    // days 非空 → 图仍有柱；习惯槽位为 0 → 中性引导而非 0%
    expect(screen.getByText(COPY.reportHabitEmpty)).toBeDefined();
    expect(screen.getByText(COPY.reportWeightMissing)).toBeDefined();
    // 不得出现惩罚性 / 红色语义
    for (const banned of ['已断', '断签', 'bg-red', 'text-red', 'border-red', '没有达标']) {
      expect(document.body.innerHTML).not.toContain(banned);
    }
  });

  it('days 为空数组 → 图表与达成率都走空态文案', async () => {
    renderReport(makeReport([], null));

    await waitFor(() => {
      expect(screen.getByText(COPY.reportTrendEmpty)).toBeDefined();
    });
    expect(screen.getByText(COPY.reportHabitEmpty)).toBeDefined();
  });
});
