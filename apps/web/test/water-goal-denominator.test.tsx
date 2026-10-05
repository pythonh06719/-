/**
 * 饮水进度的**分母**必须走 `resolveWaterGoalMl()`（本机值优先）—— 两处渲染护栏。
 *
 * ## 缺陷本身（P0）
 *
 * `lib/water-goal.ts` 明文写下「本机值优先是刻意的（与 settings-sync 的 P0-2 不变量一致）」，
 * `/why-numbers` ㉖ 也照这个口径向用户解释（"本机有效偏好 > 服务端 goalMl > 默认 2000 ml"，
 * 附注「本机值优先，是为了保留尚未同步成功的最新修改」）。**但这个 helper 根本没接到进度条上**：
 *
 * | 位置 | 改前 | 后果 |
 * |---|---|---|
 * | `pages/exercise/ExercisePage.tsx` | `waterQuery.data?.goalMl ?? 2000` | 百分比按错的基数算 |
 * | `pages/dashboard/DashboardPage.tsx` | `data.waterGoalMl > 0 ? … : DEFAULT` | 杯数与毫升都按错的基数算 |
 *
 * 用户能撞到的具体路径：**离线**把目标改成 2600 ml → `pushSettings` 失败 → 该字段被标 dirty
 * → 联网前 `GET /water` 仍返回服务端的 2000 → 进度条分母是 2000，而**同一屏**的
 * `WaterGoalCard` 输入框（走 helper）显示 2600 —— 两个数字自己打架，
 * `/why-numbers` ㉖ 的解释也变成「一句骗人的说明」。
 *
 * ## 本文件钉住的行为（**行为断言，不是文案断言**）
 *
 * 1. ★ 运动页：本机 2600 / 服务端 2000 → 分母按 **2600** 算（`ml（%）` 那一行 + 进度条
 *    的 `aria-valuenow` 同时对上）；
 * 2. ★ 看板：同一组数据 → 分母按 **2600** 算（毫升行 + 「目标 N 杯」都跟着变）；
 * 3. ★ 同屏一致：进度条分母 **等于** 输入框回显值（「同一屏两个数字打架」是缺陷正身，
 *    这里把两者绑成一条断言，改一处不绑另一处就红）；
 * 4. 反向对照：本机**没有**值时服务端值照旧胜出（防止把 helper 写成「永远读本机」的
 *    过度实现，也证明上面几条不是被某个写死的 2600 骗过去的）。
 *
 * ## 断言强度自查
 *
 * 每条断言都锚在**由分母算出来的数字**上（`Math.round(1000 / 2600 * 100)` = 38，
 * `Math.round(1000 / 2000 * 100)` = 50；`Math.round(2600 / 250)` = 10 杯 vs 8 杯），
 * 撤掉接法后这些值会同时变 —— 断言随即转红。**没有**「页面上有某段文字」这种恒真断言。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardResponse } from '@qsh/shared-types';

import ExercisePage from '@/pages/exercise/ExercisePage';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import { cacheClearAll, cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import { WATER_GOAL_STORAGE_KEY } from '@/lib/water-goal';

/** 今日已记录 1000 ml —— 让「按 2600 算」与「按 2000 算」必然分出两个不同的数。 */
const TOTAL_ML = 1000;

/** 离线改过、尚未推送成功的本机目标。 */
const LOCAL_GOAL_ML = 2600;

/** 服务端仍然是旧值（本机改动被标 dirty、还没推成功）。 */
const SERVER_GOAL_ML = 2000;

/** 按 LOCAL_GOAL_ML 算出的百分比（`Math.round(1000 / 2600 * 100)`）。 */
const PERCENT_BY_LOCAL = 38;

/** 按 SERVER_GOAL_ML 算出的百分比（`Math.round(1000 / 2000 * 100)`）—— 撤掉接法后就是这个值。 */
const PERCENT_BY_SERVER = 50;

/** `Math.round(2600 / 250)` 杯 —— 「目标 10 杯」。 */
const GOAL_CUPS_BY_LOCAL = 10;

/** `Math.round(2000 / 250)` 杯 —— 「目标 8 杯」。 */
const GOAL_CUPS_BY_SERVER = 8;

function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as unknown as Response;
}

/** 看板载荷：服务端仍报旧目标 2000（本机改动未推送成功）。 */
function dashboardPayload(): DashboardResponse {
  return {
    date: todayKey(),
    goal: null,
    budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
    intakeKcal: 0,
    burnedKcal: 0,
    remainingKcal: 1500,
    progressRatio: 0,
    waterMl: TOTAL_ML,
    waterGoalMl: SERVER_GOAL_ML,
    miniTrend: [],
    encouragement: '今天也照顾好自己',
    warnings: [],
  };
}

/**
 * fetch 桩。
 *
 * `online` 恒为真 —— 目的是**只留「本机值优先」这一个变量**：请求成功、拿到的就是旧目标，
 * 于是「分母仍按服务端旧值算」不能被「请求失败 / 没加载」解释掉。
 */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/water')) {
        return ok({ date: todayKey(), totalMl: TOTAL_ML, goalMl: SERVER_GOAL_ML, logs: [] });
      }
      if (url.includes('/api/exercises')) {
        return ok({ date: todayKey(), logs: [], totalKcal: 0 });
      }
      if (url.includes('/api/dashboard')) {
        return ok(dashboardPayload());
      }
      if (url.includes('/api/profile')) {
        return ok({
          profile: null,
          goal: { startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 },
          budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
        });
      }
      if (url.includes('/api/users/settings')) {
        return ok({ waterGoalMl: SERVER_GOAL_ML });
      }
      return ok({});
    }),
  );
}

function renderWithClient(node: React.ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 写入本机记住的目标（模拟「离线改过、尚未推送成功」）。 */
function seedLocalGoal(ml: number): void {
  window.localStorage.setItem(WATER_GOAL_STORAGE_KEY, String(ml));
}

/** 运动页的「已记录 / 目标 ml（百分比）」那一行的纯文本。 */
function exerciseWaterLine(container: HTMLElement): string {
  const lines = Array.from(container.querySelectorAll('p'))
    .map((node) => (node.textContent ?? '').trim())
    .filter((text) => /\d+\s*\/\s*\d+\s*ml（\d+%）$/.test(text));
  expect(lines, '运动页没找到「已记录 / 目标 ml（百分比）」那一行').toHaveLength(1);
  return lines[0]!;
}

/** 看板喝水卡的「已记录 / 目标 ml」那一行的纯文本。 */
function dashboardWaterLine(container: HTMLElement): string {
  const lines = Array.from(container.querySelectorAll('p'))
    .map((node) => (node.textContent ?? '').trim())
    .filter((text) => /^\d+\s*\/\s*\d+\s*ml$/.test(text));
  expect(lines, '看板没找到「已记录 / 目标 ml」那一行').toHaveLength(1);
  return lines[0]!;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  cacheClearAll();
  // 看板的饮水量来自本机缓存（`readWater`，页面挂载时读一次）。
  cacheSet(`qsh:cache:water:${todayKey()}`, { totalMl: TOTAL_ML, history: [] });
});

describe('饮水进度分母 · 本机值优先（/why-numbers ㉖ 的代码兑现）', () => {
  it('★ 运动页：本机存 2600 / 服务端返回 2000 → 进度按 2600 算（不是 2000）', async () => {
    seedLocalGoal(LOCAL_GOAL_ML);
    stubFetch();

    const { container } = renderWithClient(<ExercisePage />);

    // 等服务端旧目标真的到货（否则「按本机算」可能只是因为还没加载）
    await waitFor(() => {
      expect(exerciseWaterLine(container)).toContain(String(LOCAL_GOAL_ML));
    });

    // 分母：本机 2600，不是服务端的 2000
    expect(exerciseWaterLine(container)).toBe(`${TOTAL_ML} / ${LOCAL_GOAL_ML} ml（${PERCENT_BY_LOCAL}%）`);
    expect(exerciseWaterLine(container)).not.toContain(String(SERVER_GOAL_ML));

    // 进度条本身（`role="progressbar"` 的 aria-valuenow）也按同一个分母算 ——
    // 只看文字不看得条，两处可能各算各的。
    const bar = screen.getByLabelText('今日饮水进度');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(PERCENT_BY_LOCAL);
    expect(Number(bar.getAttribute('aria-valuenow'))).not.toBe(PERCENT_BY_SERVER);
  });

  it('★ 看板：同一组数据 → 毫升行与「目标 N 杯」都按 2600 算', async () => {
    seedLocalGoal(LOCAL_GOAL_ML);
    stubFetch();

    const { container } = renderWithClient(<DashboardPage />);

    await waitFor(() => {
      expect(dashboardWaterLine(container)).toBe(`${TOTAL_ML} / ${LOCAL_GOAL_ML} ml`);
    });

    // 杯数是同一个分母的派生显示（250ml = 1 杯）：2600 → 10 杯，服务端 2000 → 8 杯
    expect(screen.getByText(`第 ${TOTAL_ML / 250} 杯 / 目标 ${GOAL_CUPS_BY_LOCAL} 杯`)).toBeInTheDocument();
    expect(screen.queryByText(`目标 ${GOAL_CUPS_BY_SERVER} 杯`)).toBeNull();
  });

  it('★ 同屏一致：进度分母 === 饮水目标输入框的回显值（缺陷正身是「同一屏两个数字打架」）', async () => {
    seedLocalGoal(LOCAL_GOAL_ML);
    stubFetch();

    const { container } = renderWithClient(<ExercisePage />);

    await waitFor(() => {
      expect(exerciseWaterLine(container)).toContain(String(LOCAL_GOAL_ML));
    });

    // 输入框走 helper、进度条现在也走 helper —— 两者必须逐字相等。
    const input = screen.getByTestId('water-goal-input') as HTMLInputElement;
    const fromInput = input.value;
    const fromBar = exerciseWaterLine(container).split(' / ')[1]?.split(' ')[0] ?? '';

    expect(fromInput).toBe(String(LOCAL_GOAL_ML));
    expect(fromBar).toBe(fromInput);
  });

  it('反向对照：本机没有值时，服务端值照旧胜出（不是「永远读本机」）', async () => {
    // 不 seed 本机值 → helper 必须落到服务端层
    stubFetch();

    const { container } = renderWithClient(<ExercisePage />);

    await waitFor(() => {
      expect(exerciseWaterLine(container)).toContain(String(SERVER_GOAL_ML));
    });
    expect(exerciseWaterLine(container)).toBe(`${TOTAL_ML} / ${SERVER_GOAL_ML} ml（${PERCENT_BY_SERVER}%）`);
    expect(exerciseWaterLine(container)).not.toContain(String(LOCAL_GOAL_ML));
  });

  it('反向对照：本机是坏值（超出 500–8000）时不生效，服务端值照旧胜出', async () => {
    // 「本机值优先」不等于「本机值永远赢」：不合规的值视为未设置（`/why-numbers` ㉖
    // 「什么是有效目标」条），否则一个坏 localStorage 就能把分母带偏。
    window.localStorage.setItem(WATER_GOAL_STORAGE_KEY, '99999');
    stubFetch();

    const { container } = renderWithClient(<ExercisePage />);

    await waitFor(() => {
      expect(exerciseWaterLine(container)).toBe(`${TOTAL_ML} / ${SERVER_GOAL_ML} ml（${PERCENT_BY_SERVER}%）`);
    });
  });
});
