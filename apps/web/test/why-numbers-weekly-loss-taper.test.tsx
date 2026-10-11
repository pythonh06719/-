/**
 * `/why-numbers` 页「每周目标减重」取值口径的成对回归保护（`pages/why-numbers/WhyNumbersPage.tsx`）。
 *
 * ## 缺陷（P0）：同一张推导表里两个相邻数字乘不出彼此
 *
 * 分解表第 6、7 行是紧挨着的因果链 —— 上一行是「每周目标减重(kg)」，下一行「原始缺口」按
 * `每周目标减重 × 7700 ÷ 7` 得出。但页面这一行用的是**本地重算**的
 * `deriveWeeklyLossKg(startWeightKg, targetWeightKg, targetWeeks)`，它是 **taper 前**的 base 速度；
 * 而下一行 `budget.targetDeficitRaw` 来自 `@qsh/core`，是 **taper 后**的结果（`formulas.ts:104-111`：
 * 剩余量 ≤ `TAPER_REMAINING_KG` 时速度按 `剩余量 ÷ 2` 线性收窄）。
 *
 * 于是收尾阶段页面上出现自相矛盾：70 → 68.5（剩 1.5kg）、10 周时
 *
 * | 页面显示 | 值 | 来源 |
 * |---|---|---|
 * | 每周目标减重 | **0.15** kg/周 | 本地 `deriveWeeklyLossKg`（taper 前） |
 * | 原始缺口 | **123.7** kcal/日 | core（taper 后：0.1125 × 7700 ÷ 7） |
 *
 * 用户照着页面自己验算：0.15 × 7700 ÷ 7 = **165 ≠ 123.7**，对不上。而这一页是全站解释
 * 「我的数字从哪来」的门面（NFR-11），门面自己算不平，其它数字的可信度一起塌。
 *
 * `7ce2cad` 已让 core 暴露 taper 后的 `CalorieResult.weeklyLossKg`（唯一口径真源），
 * 页面只需不再自己重算。
 *
 * ## 本文件钉死的行为
 *
 * ① taper 命中（剩 1.5kg）→ 显示 core 的 **0.11**，**不**显示推导值 0.15；
 * ② 该行与紧邻的「原始缺口」自洽 —— 按行取值反推：`每周目标减重 × 7700 ÷ 7` 的区间必须
 *    罩住页面上那个缺口（用 taper 前的 0.15 只算得出 [159.5, 170.5]，罩不住 123.7）；
 * ③ taper 命中 → 行内给出放缓说明，且措辞不含 PRD §7 禁用词（不指责、不焦虑）；
 * ④ **成对钉**：taper 未命中（剩 3kg）→ 显示值 == `deriveWeeklyLossKg` 的推导值（0.3），
 *    且**没有**放缓说明 —— 只钉①不钉④的话，「一律显示 0.11」这类过度修正会全绿蒙混过关。
 *
 * ## 返工时的检查清单
 *
 * - 把显示处改回 `deriveWeeklyLossKg`（本地重算）→ ①②必须同时转红；
 * - 把① 的断言删掉只留④ → 「永远显示推导值」的实现会全绿（成对钉的意义）；
 * - 删掉 `hint` 的条件判断（无条件显示）→ ④ 必须转红；
 * - hint 里出现「失败 / 错误 / 警告 / 崩溃 / 必须 / 一定 / 坚持 / 赶紧」→ ③ 必须转红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { KCAL_PER_KG_FAT, deriveWeeklyLossKg, round1 } from '@qsh/core';
import WhyNumbersPage from '@/pages/why-numbers/WhyNumbersPage';
import { useAuthStore } from '@/lib/auth.store';

/** PRD §7 无负罪感红线：这些词不出现在放缓说明里（会变成指责 / 焦虑表达）。 */
const BANNED = ['失败', '错误', '警告', '崩溃', '必须', '一定', '坚持', '赶紧'];

/**
 * taper 命中算例：当前 70 → 目标 68.5（剩 1.5kg ≤ 2kg）、10 周。
 * base = 1.5 / 10 = 0.15 → taper 后 0.15 × (1.5 / 2) = 0.1125 → `round2` = 0.11。
 */
const TAPER_GOAL = { startWeightKg: 70, targetWeightKg: 68.5, targetWeeks: 10 };

/** 与上面同一套推导值（taper 前），即**不该**被显示出来的那个数。 */
const TAPER_BASE_LOSS = '0.15 kg/周';

/** taper 后的值，即**应该**显示出来的那个数（core 真源）。 */
const TAPER_LOSS = '0.11 kg/周';

/**
 * 与「每周目标减重」紧邻的「原始缺口」：taper 后 0.1125 × 7700 ÷ 7 = 123.75 → `round1` = 123.7。
 * （同一张表里「有效缺口」也是 123.7 —— 未被 30% 上限截断，故取行时要按术语定位，不能按文本。）
 */
const TAPER_DEFICIT = '123.7 kcal/日';

/**
 * taper **未**命中算例：当前 70 → 目标 67（剩 3kg > 2kg）、10 周 → base = 0.3，不收窄。
 */
const PLAIN_GOAL = { startWeightKg: 70, targetWeightKg: 67, targetWeeks: 10 };

/** 未命中时显示值应与 `deriveWeeklyLossKg` 的推导值一致。 */
const PLAIN_LOSS = `${deriveWeeklyLossKg(PLAIN_GOAL.startWeightKg, PLAIN_GOAL.targetWeightKg, PLAIN_GOAL.targetWeeks)} kg/周`;

const PROFILE = {
  gender: 'female',
  birthDate: '1995-06-15',
  heightCm: 165,
  activityLevel: 'light',
};

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

/**
 * 渲染本页：已登录 + `/profile` 返回给定目标（预算由页面自己用 core 实时算，不 mock）。
 *
 * @param goal 目标三件套（起始体重 / 目标体重 / 周数）
 */
function renderPageWithGoal(goal: {
  startWeightKg: number;
  targetWeightKg: number;
  targetWeeks: number;
}): void {
  useAuthStore.setState({ accessToken: 'test-token' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok({ profile: PROFILE, goal: { ...goal, weeklyLossKg: null }, budget: null })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WhyNumbersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * 按术语取该推导行的值（`DerivationRow` 是 `<div><dt>术语</dt><dd>值</dd></div>`）。
 *
 * 必须按术语定位而不是按文本：`原始缺口` 与 `有效缺口` 在本算例里同为 `123.7 kcal/日`，
 * 直接 `getByText` 会撞上两个元素。
 *
 * @param term 行术语（如「原始缺口」）
 * @returns `<dd>` 的文本，如 `123.7 kcal/日`
 */
function rowValue(term: string): string {
  const row = screen.getByText(term).closest('div');
  return row?.querySelector('dd')?.textContent ?? '';
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  useAuthStore.setState({ accessToken: null });
});

describe('why-numbers 页 · 「每周目标减重」取 taper 后的值', () => {
  it('★ taper 命中 → 显示 core 的 0.11，不显示推导值 0.15', async () => {
    renderPageWithGoal(TAPER_GOAL);

    await screen.findByText('每周目标减重');
    expect(screen.getByText(TAPER_LOSS)).toBeInTheDocument();
    expect(screen.queryByText(TAPER_BASE_LOSS)).not.toBeInTheDocument();
  });

  it('★ taper 命中 → 与紧邻的「原始缺口」乘得出彼此（不再是 0.15 配 123.7）', async () => {
    renderPageWithGoal(TAPER_GOAL);

    await screen.findByText('每周目标减重');
    expect(rowValue('原始缺口')).toBe(TAPER_DEFICIT);

    // 显示值经 `round2`（±0.005 kg）后反推的缺口区间，必须罩住页面上那个缺口：
    // 换成 taper 前的 0.15 只算得出 [159.5, 170.5]，罩不住 123.7 → 转红
    const lossKg = Number.parseFloat(rowValue('每周目标减重'));
    const deficit = Number.parseFloat(rowValue('原始缺口'));
    expect(deficit).toBeGreaterThanOrEqual(round1(((lossKg - 0.005) * KCAL_PER_KG_FAT) / 7));
    expect(deficit).toBeLessThanOrEqual(round1(((lossKg + 0.005) * KCAL_PER_KG_FAT) / 7));
  });

  it('★ taper 命中 → 行内说明已自动放缓，且不含禁用词', async () => {
    renderPageWithGoal(TAPER_GOAL);

    const hint = await screen.findByText(/自动放缓/);
    for (const banned of BANNED) {
      expect(hint).not.toHaveTextContent(banned);
    }
  });

  it('★ taper 未命中（剩 3kg）→ 显示值等于推导值 0.3，且没有放缓说明（成对钉）', async () => {
    renderPageWithGoal(PLAIN_GOAL);

    await screen.findByText('每周目标减重');
    expect(screen.getByText(PLAIN_LOSS)).toBeInTheDocument();
    expect(screen.queryByText(/自动放缓/)).not.toBeInTheDocument();
  });
});
