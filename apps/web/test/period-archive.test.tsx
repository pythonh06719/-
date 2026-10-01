/**
 * C-5「我的这段时光」可存档报告测试。
 *
 * 覆盖：保存动作、下载前敏感提示、要求区块、R11.3 同源数字、自包含/打印样式、
 * 以及评分叙事 / 极端体重叙事 / 红色恐吓样式红线。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PeriodReport, TopFoodItem, WeightTrendPoint, WinLog } from '@qsh/shared-types';
import ReportPage from '@/pages/report/ReportPage';
import { COPY, periodLoggedDaysLine, periodWeightDownLine } from '@/lib/copy';
import { downloadTextFile } from '@/lib/download';
import {
  buildPeriodArchiveHtml,
  PERIOD_ARCHIVE_SENSITIVE_NOTICE,
  type PeriodArchiveInput,
} from '@/lib/period-archive';

vi.mock('@/lib/download', () => ({
  downloadTextFile: vi.fn(),
}));

const weeklyPayload = {
  from: '2026-09-17',
  to: '2026-09-23',
  days: [],
  avgIntakeKcal: 0,
  totalExerciseKcal: 0,
  weightChangeKg: null,
  micronutrients: [],
  referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
  distinctFoodCount: 0,
  distinctFoods: [],
  distinctFoodsTruncated: false,
};

const periodPayload: PeriodReport = {
  from: '2025-09-25',
  to: '2026-09-24',
  days: 365,
  hasAnyData: true,
  loggedDays: 128,
  distinctFoodCount: 76,
  mealEntryCount: 462,
  topHabits: [{ habitId: 1, name: '散步', count: 82 }],
  exercise: { sessions: 34, totalMinutes: 1090 },
  weight: { startKg: 70, endKg: 67.7, deltaKg: -2.3 },
  winCount: 2,
};

const topFoods: TopFoodItem[] = [
  { name: '燕麦', dayCount: 31, foodItemId: null, food: null, lastLoggedDate: '2026-09-20' },
  { name: '番茄炒蛋', dayCount: 24, foodItemId: null, food: null, lastLoggedDate: '2026-09-18' },
];

const weightPoints: WeightTrendPoint[] = [
  { date: '2025-09-26', weightKg: 70 },
  { date: '2026-01-12', weightKg: 69.2 },
  { date: '2026-05-18', weightKg: 68.6 },
  { date: '2026-09-22', weightKg: 67.7 },
];

const wins: WinLog[] = [
  {
    id: 1,
    userId: 7,
    loggedDate: '2026-05-01',
    text: '现在爬楼没有以前那么喘了',
    createdAt: '2026-05-01T08:00:00.000Z',
    updatedAt: '2026-05-01T08:00:00.000Z',
  },
  {
    id: 2,
    userId: 7,
    loggedDate: '2026-08-20',
    text: '晚饭后散步成了舒服的小习惯',
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
  },
];

/** 按路径返回 R11.3 页面和存档明细数据。 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let payload: unknown;
      if (url.includes('/api/report/weekly')) {
        payload = weeklyPayload;
      } else if (url.includes('/api/report/period')) {
        payload = periodPayload;
      } else if (url.includes('/api/foods/top')) {
        payload = { days: 365, items: topFoods };
      } else if (url.includes('/api/weights/trend')) {
        payload = { points: weightPoints };
      } else if (url.includes('/api/wins')) {
        payload = wins;
      } else {
        throw new Error(`测试桩未覆盖的请求：${url}`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: payload, error: null }),
      } as Response;
    }),
  );
}

/** 渲染回顾页并进入「这段时间」年度档。 */
async function renderPeriodReport(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: COPY.reportTabPeriod }));
  await screen.findByTestId('period-metrics');
  fireEvent.click(screen.getByRole('tab', { name: '近 365 天' }));
  await waitFor(() => {
    expect(screen.getByText(periodLoggedDaysLine(128))).toBeInTheDocument();
    expect(screen.getByText('燕麦')).toBeInTheDocument();
  });
  return view.container;
}

function archiveInput(): PeriodArchiveInput {
  return {
    report: periodPayload,
    topFoods,
    weightPoints,
    wins,
    weightUnit: 'kg',
    generatedAt: new Date('2026-09-24T12:00:00.000Z'),
  };
}

describe('C-5 阶段回顾本地存档', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    stubFetch();
  });

  it('点「保存这一份」先显示敏感提示，明确确认后才下载自包含 HTML', async () => {
    await renderPeriodReport();

    fireEvent.click(screen.getByRole('button', { name: '保存这一份' }));
    expect(screen.getByRole('dialog', { name: '保存前请留意' })).toBeInTheDocument();
    expect(screen.getByText(PERIOD_ARCHIVE_SENSITIVE_NOTICE)).toBeInTheDocument();
    expect(downloadTextFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '保存到设备' }));
    await waitFor(() => {
      expect(downloadTextFile).toHaveBeenCalledTimes(1);
    });

    const file = vi.mocked(downloadTextFile).mock.calls[0]?.[0];
    expect(file?.fileName).toBe('qingshenghuo-period-2025-09-25_2026-09-24.html');
    expect(file?.mimeType).toBe('text/html;charset=utf-8');
    expect(file?.content).toContain('<!doctype html>');
    expect(file?.content).toContain('@media print');
    expect(file?.content).toContain('onclick="window.print()"');
    expect(file?.content).not.toMatch(/<link\b|<script\b[^>]*\bsrc=/i);
  });

  it('存档包含要求区块，并与页面当前 R11.3 快照使用相同数字', async () => {
    await renderPeriodReport();
    const pageMetrics = screen.getByTestId('period-metrics').textContent ?? '';
    const pageWeight = screen.getByTestId('period-weight').textContent ?? '';
    expect(pageMetrics).toContain('128');
    expect(pageMetrics).toContain('76');
    expect(pageWeight).toBe(periodWeightDownLine(-2.3));

    fireEvent.click(screen.getByRole('button', { name: '保存这一份' }));
    fireEvent.click(screen.getByRole('button', { name: '保存到设备' }));
    await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(1));

    const html = vi.mocked(downloadTextFile).mock.calls[0]?.[0]?.content ?? '';
    expect(html).toContain('<strong>128 天</strong>');
    expect(html).toContain('<strong>76 种</strong>');
    expect(html).toContain('70.0 kg');
    expect(html).toContain('67.7 kg');
    expect(html).toContain('-2.3 kg');
    expect(html).toContain('<polyline points=');
    expect(html).toContain('燕麦');
    expect(html).toContain('在 31 天里记过');
    expect(html).toContain('现在爬楼没有以前那么喘了');
    expect(html).toContain('晚饭后散步成了舒服的小习惯');
    expect(html).toContain('来源：');
    expect(html).toContain(PERIOD_ARCHIVE_SENSITIVE_NOTICE);
  });

  it('红线：存档无评分、等级、印章、极端体重叙事、负面词与红色恐吓样式', () => {
    const html = buildPeriodArchiveHtml(archiveInput());
    for (const banned of ['评分', '等级', '印章', '战胜自己', '失败', '停滞', '退步']) {
      expect(html).not.toContain(banned);
    }
    expect(html).not.toMatch(/text-red|bg-red|border-red|ring-red/);
    expect(html).not.toMatch(/\bred\b|#f00(?:000)?\b/i);
  });

  it('用户文字和食物名按 HTML 文本转义，离线文件不执行记录内容', () => {
    const input = archiveInput();
    input.topFoods = [
      { name: '<img src=x onerror=alert(1)>', dayCount: 3, foodItemId: null, food: null, lastLoggedDate: '2026-09-01' },
    ];
    input.wins = [
      {
        ...wins[0]!,
        text: '<script>alert("private")</script>',
      },
    ];
    const html = buildPeriodArchiveHtml(input);

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;private&quot;)&lt;/script&gt;');
  });
});
