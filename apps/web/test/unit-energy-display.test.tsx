/**
 * 全局热量单位（kcal ↔ kJ）**显示口径**回归测试。
 *
 * ## 为什么单独钉这一组
 *
 * 产品承诺「顶栏可切换 kcal / kJ，换算只影响显示」（`WhyNumbersPage` §⑤）。
 * 切换按钮套在所有 `withShell()` 页面上，故这些页面都必须跟随单位 —— 但历史上
 * 有 6+ 处把单位写死成 `kcal`，导致**同一份数据在同一屏、同一秒出现两个单位**
 * （最典型：日记食物列表「每 100g 116 kcal」vs 同一弹窗「用库里的（485 kJ/100g）」）。
 *
 * ## 本文件钉死的行为
 * ① 切到 kJ：ExercisePage / WeeklyReportView / ToolsPage / MyFoodsPage / AiPage / ShareCard
 *    的热量文字**全部显示 kJ**；
 * ② 切回 kcal：**全部显示 kcal**（双向都测 —— 防止「反向写死成 kJ」这个镜像 bug）；
 * ③ 数值正确：换算走 `@qsh/core`（1 kcal = 4.184 kJ），116 kcal → 485 kJ；
 * ④ 运动预览用**真实档案体重**（不是写死 60），且与服务端「同公式同体重」的结果一致
 *    （预览值 == 落库值，杜绝「记下前后两个数字」）；
 * ⑤ ShareCard 是 Canvas 绘制，`unit` 必须**传进 draw 函数**才能生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  MET_ACTIVITY_LIBRARY,
  calcExerciseKcal,
  estimateDrink,
  estimateFeast,
  estimateTakeout,
  findMetActivity,
  snackRedemption,
} from '@qsh/core';
import type { UnitSystem } from '@qsh/shared-types';
import { energyLabel, toDisplayEnergy, useUnitStore } from '@/lib/units';
import { useAuthStore } from '@/lib/auth.store';
import { cacheClearAll } from '@/lib/local-cache';
import ExercisePage from '@/pages/exercise/ExercisePage';
import WeeklyReportView from '@/pages/report/WeeklyReportView';
import ToolsPage from '@/pages/tools/ToolsPage';
import MyFoodsPage from '@/pages/foods/MyFoodsPage';
import AiPage from '@/pages/ai/AiPage';
import { drawShareCard } from '@/components/feedback/ShareCard';
import type { ShareCardProps } from '@/components/feedback/ShareCard';

/** 一条运动记录（`GET /exercises` 的 logs 元素）。 */
interface ExLog {
  id: number;
  activityName: string;
  minutes: number;
  kcalBurned: number;
}

/** 造一份 `{ data, error: null }` 成功响应（K2 解包）。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/** 造一份 ExercisePage 涉及的 fetch 桩（/profile、/exercises、/water）。 */
function stubExerciseFetch(options: { startWeightKg?: number; logs?: ExLog[] }): void {
  const logs = options.logs ?? [];
  const date = '2026-09-23';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.includes('/profile')) {
        return ok({
          profile: null,
          goal: options.startWeightKg === undefined ? null : { startWeightKg: options.startWeightKg },
          budget: null,
        });
      }
      if (url.includes('/water')) {
        return ok({ date, totalMl: 0, goalMl: 2000, logs: [] });
      }
      if (url.includes('/exercises')) {
        const totalKcal = Math.round(logs.reduce((sum, log) => sum + log.kcalBurned, 0) * 10) / 10;
        return ok({ date, logs, totalKcal });
      }
      return ok(null);
    }),
  );
}

/** 以给定单位渲染 ExercisePage（含登录 token，使 /profile 生效）。 */
function renderExercise(unit: UnitSystem): void {
  useUnitStore.setState({ unit });
  useAuthStore.setState({ accessToken: 'test-token' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/exercise']}>
        <ExercisePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BODY = (): string => document.body.textContent ?? '';

beforeEach(() => {
  window.localStorage.clear();
  cacheClearAll();
  useUnitStore.setState({ unit: 'kcal' });
  useAuthStore.setState({ accessToken: null });
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useUnitStore.setState({ unit: 'kcal' });
  useAuthStore.setState({ accessToken: null });
});

describe('ExercisePage 热量显示随单位切换', () => {
  const walking = MET_ACTIVITY_LIBRARY.find((item) => item.code === 'walking_brisk') ?? MET_ACTIVITY_LIBRARY[0]!;
  const logs: ExLog[] = [{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }];

  it('切到 kJ：预览 / 合计 / 单条记录都显示 kJ（不再出现 kcal）', async () => {
    stubExerciseFetch({ logs });
    renderExercise('kj');

    const previewKcal = calcExerciseKcal(walking.met, 60, 30);
    // 等「合计 + 单条记录」都到位（dayQuery 异步返回后才渲染）
    await waitFor(() => expect(BODY()).toContain(`今日运动消耗合计 ${toDisplayEnergy(90, 'kj')} kJ`));
    expect(BODY()).toContain(`大约消耗 ${toDisplayEnergy(previewKcal, 'kj')} kJ`);
    expect(BODY()).toContain(`快走 · 30 分钟 · 约 ${toDisplayEnergy(90, 'kj')} kJ`);
    expect(BODY()).not.toContain('kcal');
  });

  it('切回 kcal：同样三处显示 kcal（防止反向写死成 kJ）', async () => {
    stubExerciseFetch({ logs });
    renderExercise('kcal');

    const previewKcal = calcExerciseKcal(walking.met, 60, 30);
    await waitFor(() => expect(BODY()).toContain(`今日运动消耗合计 ${toDisplayEnergy(90, 'kcal')} kcal`));
    expect(BODY()).toContain(`大约消耗 ${toDisplayEnergy(previewKcal, 'kcal')} kcal`);
    expect(BODY()).toContain(`快走 · 30 分钟 · 约 ${toDisplayEnergy(90, 'kcal')} kcal`);
    expect(energyLabel('kcal')).toBe('kcal');
  });

  it('数值口径：换算走 core（1 kcal = 4.184 kJ），90 kcal → 377 kJ', () => {
    expect(toDisplayEnergy(90, 'kj')).toBe(377);
    expect(toDisplayEnergy(116, 'kj')).toBe(485);
    expect(toDisplayEnergy(90, 'kcal')).toBe(90);
  });

  it('★ 运动预览用真实档案体重（不是写死 60），与服务端同公式同体重一致', async () => {
    stubExerciseFetch({ startWeightKg: 80, logs: [] });
    renderExercise('kcal');

    const previewKcal80 = calcExerciseKcal(walking.met, 80, 30);
    const previewKcal60 = calcExerciseKcal(walking.met, 60, 30);
    // 80kg 与 60kg 的估算必须不同，否则本用例无区分力
    expect(previewKcal80).not.toBe(previewKcal60);

    // 服务端 create 用 calcExerciseKcal(met, currentWeight=goal.startWeightKg=80, minutes)
    // → 预览显示同一个数（预览值 == 落库值）；等 /profile 异步返回后更新
    await waitFor(() =>
      expect(BODY()).toContain(`大约消耗 ${toDisplayEnergy(previewKcal80, 'kcal')} kcal`),
    );
    // 绝不能是写死 60kg 的那个数
    expect(BODY()).not.toContain(`大约消耗 ${toDisplayEnergy(previewKcal60, 'kcal')} kcal`);
  });
});

describe('WeeklyReportView 日均摄入 / 运动消耗随单位切换', () => {
  interface TestDay {
    date: string;
    intakeKcal: number;
    exerciseKcal: number;
    habitsDone: number;
    habitsTotal: number;
  }
  const days: TestDay[] = [
    { date: '2026-09-22', intakeKcal: 1300, exerciseKcal: 300, habitsDone: 1, habitsTotal: 3 },
    { date: '2026-09-23', intakeKcal: 1400, exerciseKcal: 320, habitsDone: 1, habitsTotal: 3 },
  ];
  const report = {
    from: '2026-09-17',
    to: '2026-09-23',
    days,
    avgIntakeKcal: 1350,
    totalExerciseKcal: 620,
    weightChangeKg: -0.5,
    micronutrients: [],
    referenceNote: '参考《中国居民膳食营养素参考摄入量》。',
  };

  function renderWeekly(unit: UnitSystem): void {
    useUnitStore.setState({ unit });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => ok(report)));
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <WeeklyReportView />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('切到 kJ：日均摄入 / 运动消耗 / 逐日行都显示 kJ', async () => {
    renderWeekly('kj');
    await waitFor(() => expect(BODY()).toContain('日均摄入'));
    expect(BODY()).toContain(String(toDisplayEnergy(1350, 'kj')));
    expect(BODY()).toContain(String(toDisplayEnergy(620, 'kj')));
    expect(BODY()).toContain(`摄入 ${toDisplayEnergy(1300, 'kj')} · 运动 ${toDisplayEnergy(300, 'kj')} kJ`);
    expect(BODY()).toContain('kJ');
    expect(BODY()).not.toContain('kcal');
  });

  it('切回 kcal：显示 kcal', async () => {
    renderWeekly('kcal');
    await waitFor(() => expect(BODY()).toContain('日均摄入'));
    expect(BODY()).toContain('1350');
    expect(BODY()).toContain(`摄入 1300 · 运动 300 kcal`);
    expect(BODY()).toContain('kcal');
  });
});

describe('ToolsPage 四个工具热量随单位切换', () => {
  function renderTools(unit: UnitSystem): void {
    useUnitStore.setState({ unit });
    render(
      <MemoryRouter>
        <ToolsPage />
      </MemoryRouter>,
    );
  }
  const openTab = (label: string): void => {
    fireEvent.click(screen.getByRole('tab', { name: label }));
  };

  it('切到 kJ：外卖 / 零食 / 聚餐 / 饮品四个工具都显示 kJ', () => {
    renderTools('kj');

    const takeout = estimateTakeout('malatang')!;
    expect(BODY()).toContain(
      `${toDisplayEnergy(takeout.range.min, 'kj')}–${toDisplayEnergy(takeout.range.max, 'kj')}`,
    );

    openTab('零食救赎');
    const snack = snackRedemption('薯片（一包）', 550, 60, (code) => {
      const found = findMetActivity(code);
      return found ? { name: found.name, met: found.met } : undefined;
    });
    expect(BODY()).toContain(`「${snack.name}」约 ${toDisplayEnergy(snack.kcal, 'kj')} kJ`);

    openTab('聚餐模式');
    const feast = estimateFeast('hotpot')!;
    expect(BODY()).toContain(
      `${toDisplayEnergy(feast.perPerson.min, 'kj')}–${toDisplayEnergy(feast.perPerson.max, 'kj')} kJ（不含酒水）`,
    );

    openTab('饮品计算');
    const drink = estimateDrink('milk_tea', 500, 'regular');
    expect(BODY()).toContain(
      `${toDisplayEnergy(drink.range.min, 'kj')}–${toDisplayEnergy(drink.range.max, 'kj')}`,
    );

    expect(BODY()).not.toContain('kcal');
  });

  it('切回 kcal：四个工具都显示 kcal', () => {
    renderTools('kcal');
    const takeout = estimateTakeout('malatang')!;
    expect(BODY()).toContain(`${takeout.range.min}–${takeout.range.max}`);

    openTab('零食救赎');
    const snack = snackRedemption('薯片（一包）', 550, 60, (code) => {
      const found = findMetActivity(code);
      return found ? { name: found.name, met: found.met } : undefined;
    });
    expect(BODY()).toContain(`「${snack.name}」约 ${snack.kcal} kcal`);

    openTab('聚餐模式');
    expect(BODY()).toContain('kcal（不含酒水）');

    openTab('饮品计算');
    expect(BODY()).toContain('kcal');
  });
});

describe('MyFoodsPage 每 100g 热量随单位切换', () => {
  function makeFood(id: number, name: string, kcalPer100g: number): Record<string, unknown> {
    return {
      id,
      name,
      namePinyin: null,
      aliases: [],
      category: 'other',
      kcalPer100g,
      proteinGPer100g: 1,
      fatGPer100g: 1,
      carbGPer100g: 1,
      fiberGPer100g: null,
      sodiumMgPer100g: null,
      saturatedFatGPer100g: null,
      sugarGPer100g: null,
      calciumMgPer100g: null,
      ironMgPer100g: null,
      potassiumMgPer100g: null,
      vitaminDUgPer100g: null,
      b12UgPer100g: null,
      magnesiumMgPer100g: null,
      servingUnits: [{ unit: '克', grams: 100 }],
      defaultServingGrams: 100,
      barcode: null,
      source: 'user_custom',
      createdByUserId: 1,
      isVerified: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
  }

  function renderMyFoods(unit: UnitSystem): void {
    useUnitStore.setState({ unit });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => ok([makeFood(11, '红烧肉', 116)])));
    render(
      <QueryClientProvider client={client}>
        <MyFoodsPage />
      </QueryClientProvider>,
    );
  }

  it('切到 kJ：每 100g 116 kcal → 485 kJ', async () => {
    renderMyFoods('kj');
    await waitFor(() => expect(screen.getByText('红烧肉')).toBeInTheDocument());
    expect(screen.getByText(/每 100g 485 kJ/)).toBeInTheDocument();
    expect(screen.queryByText(/kcal/)).toBeNull();
  });

  it('切回 kcal：每 100g 116 kcal', async () => {
    renderMyFoods('kcal');
    await waitFor(() => expect(screen.getByText('红烧肉')).toBeInTheDocument());
    expect(screen.getByText(/每 100g 116 kcal/)).toBeInTheDocument();
  });
});

describe('AiPage 食物识别候选热量随单位切换', () => {
  function renderAi(unit: UnitSystem): void {
    useUnitStore.setState({ unit });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/ai/usage')) {
          return ok({ date: '2026-09-23', used: 1, limit: 50, remaining: 49 });
        }
        if (url.includes('/ai/recognize-food')) {
          return ok({
            description: '米饭',
            candidates: [
              {
                foodId: 7,
                name: '米饭',
                category: '主食',
                kcalPer100g: 116,
                matchedText: '米饭',
                defaultServingGrams: 150,
                servingUnitLabel: '碗',
                servingKcal: 174,
              },
            ],
          });
        }
        return ok(null);
      }),
    );
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AiPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('切到 kJ：候选每 100g / 一份都显示 kJ', async () => {
    renderAi('kj');
    fireEvent.change(screen.getByPlaceholderText('比如：一个包子、一杯豆浆'), {
      target: { value: '米饭' },
    });
    fireEvent.click(screen.getByRole('button', { name: '找一找' }));

    await waitFor(() => expect(BODY()).toContain('米饭'));
    expect(BODY()).toContain(`每 100g 约 ${toDisplayEnergy(116, 'kj')} kJ`);
    expect(BODY()).toContain(`一份（碗）约 ${toDisplayEnergy(174, 'kj')} kJ`);
    expect(BODY()).not.toContain('kcal');
  });

  it('切回 kcal：候选显示 kcal', async () => {
    renderAi('kcal');
    fireEvent.change(screen.getByPlaceholderText('比如：一个包子、一杯豆浆'), {
      target: { value: '米饭' },
    });
    fireEvent.click(screen.getByRole('button', { name: '找一找' }));

    await waitFor(() => expect(BODY()).toContain('米饭'));
    expect(BODY()).toContain('每 100g 约 116 kcal');
    expect(BODY()).toContain('一份（碗）约 174 kcal');
  });
});

describe('ShareCard（Canvas 绘制）单位口径', () => {
  /** 极简 2D 上下文桩：只记录 fillText 的文本，足以断言单位与换算后的数值。 */
  function makeCtx(): { ctx: CanvasRenderingContext2D; texts: string[] } {
    const texts: string[] = [];
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textBaseline: '',
      textAlign: '',
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      fillText: (text: string) => {
        texts.push(text);
      },
      measureText: (text: string) => ({ width: text.length * 10 }),
      beginPath: () => undefined,
      moveTo: () => undefined,
      arcTo: () => undefined,
      closePath: () => undefined,
      fill: () => undefined,
      stroke: () => undefined,
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
  }

  function draw(unit: UnitSystem): string[] {
    const canvas = document.createElement('canvas');
    const { ctx, texts } = makeCtx();
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,stub');
    const data: ShareCardProps = {
      weekLabel: '09-17 ~ 09-23',
      avgIntakeKcal: 1350,
      totalExerciseKcal: 620,
      weightChangeKg: -0.5,
      unit,
      encouragement: '这一周都好好吃饭了',
    };
    expect(drawShareCard(canvas, data)).toBe('data:image/png;base64,stub');
    return texts;
  }

  it('unit = kj：卡片热量文字为 kJ + 换算后的数值（unit 确实传进了 draw）', () => {
    const texts = draw('kj');
    expect(texts).toContain('kJ');
    expect(texts).toContain(String(toDisplayEnergy(1350, 'kj')));
    expect(texts).toContain(String(toDisplayEnergy(620, 'kj')));
    expect(texts).not.toContain('kcal');
  });

  it('unit = kcal：卡片热量文字为 kcal + 原始数值', () => {
    const texts = draw('kcal');
    expect(texts).toContain('kcal');
    expect(texts).toContain('1350');
    expect(texts).toContain('620');
  });
});
