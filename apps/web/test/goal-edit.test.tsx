/**
 * 「我的目标」编辑卡（前端接线测试，AC-11.2.7）。
 *
 * ## 背景
 *
 * 目标体重 / 期限此前只在首次引导能设，此后再无入口。本卡补上「随时能改」这条路。
 *
 * ## 本文件钉死的行为
 *
 * ① 卡片渲染**当前目标值**（当前体重 / 目标体重 / 期限）；
 * ② 改目标 → 调 `PATCH /goals`，且**请求体只含改动过的字段**（部分更新语义）；
 * ③ 成功后的反馈文案是**中性的**（不含「失败 / 错误 / 崩溃」）；
 * ④ 越界输入被**前端拦下、不发请求**（范围与后端 DTO 对齐）；
 * ⑤ 没有任何改动就提交 → 中性提示且不发请求；
 * ⑥ 服务端 400 → 展示中性提示，不用「失败 / 错误」作标题；
 * ⑦ 文案红线 + 无红色类名。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import GoalSettingsCard from '@/pages/profile/GoalSettingsCard';
import {
  COPY,
  goalTargetWeightInvalidFor,
  goalWeightInvalidFor,
  goalWeeksInvalidFor,
} from '@/lib/copy';

interface Goal {
  startWeightKg: number;
  targetWeightKg: number;
  targetWeeks: number;
}

const BANNED = ['失败', '错误', '崩溃', '出错'];

function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  calls: () => Call[];
  patchCalls: () => Call[];
}

/** 桩：`/profile` 返回当前目标；`PATCH /goals` 影响它（模拟服务端部分更新）。 */
function stubFetch(initial: Goal): Stub {
  const calls: Call[] = [];
  let current: Goal = { ...initial };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });

    if (url.includes('/profile')) {
      return ok({ profile: null, goal: current, budget: null, warnings: [] });
    }
    if (method === 'PATCH' && url.includes('/goals')) {
      current = { ...current, ...(body ?? {}) };
      return ok({ goal: current, budget: { intakeRecommended: 1500 }, warnings: [] });
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls: () => calls,
    patchCalls: () => calls.filter((call) => call.method === 'PATCH'),
  };
}

/** 桩：`PATCH /goals` 返回 400（业务错误）—— 验证前端的中性提示。 */
function stubFetchReject(): Stub {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    if (url.includes('/profile')) {
      return ok({ profile: null, goal: { startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 }, budget: null, warnings: [] });
    }
    if (method === 'PATCH' && url.includes('/goals')) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          data: null,
          error: { code: 'E_VALID_INPUT', message: '这些信息还差一点点，请检查后重试' },
        }),
      };
    }
    return ok(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls: () => calls,
    patchCalls: () => calls.filter((call) => call.method === 'PATCH'),
  };
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GoalSettingsCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('「我的目标」卡片 · 渲染现值', () => {
  it('渲染当前目标值（当前体重 / 目标体重 / 期限）', async () => {
    stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();

    const summary = await screen.findByTestId('goal-current');
    // 体重统一按 1 位小数展示（与全站 formatWeight 口径一致；D-3 起走统一格式化）
    expect(summary).toHaveTextContent('60.0 kg');
    expect(summary).toHaveTextContent('55.0 kg');
    expect(summary).toHaveTextContent('12 周');
  });

  it('输入框与现值一致，且可访问名正确', async () => {
    stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();

    const current = (await screen.findByTestId('goal-input-current')) as HTMLInputElement;
    const target = screen.getByTestId('goal-input-target') as HTMLInputElement;
    const weeks = screen.getByTestId('goal-input-weeks') as HTMLInputElement;
    expect(current.value).toBe('60');
    expect(target.value).toBe('55');
    expect(weeks.value).toBe('12');
    // 表单控件都有标签（可访问名 = 字段标签）
    expect(current).toHaveAccessibleName(COPY.goalCurrentWeightLabel);
    expect(target).toHaveAccessibleName(COPY.goalTargetWeightLabel);
    expect(weeks).toHaveAccessibleName(COPY.goalTargetWeeksLabel);
  });

  it('无生效目标（未完成引导）→ 显示中性说明，不渲染表单', async () => {
    // 直接在 /profile 返回 goal:null
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ profile: null, goal: null, budget: null, warnings: [] })),
    );
    renderCard();
    await screen.findByText(COPY.goalCardEmpty);
    expect(screen.queryByTestId('goal-form')).not.toBeInTheDocument();
  });
});

describe('「我的目标」卡片 · 提交（部分更新）', () => {
  it('★ 只改目标体重 → PATCH /goals 且 body 只含 targetWeightKg', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-target');
    const target = screen.getByTestId('goal-input-target');
    await user.clear(target);
    await user.type(target, '50');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() => expect(stub.patchCalls()).toHaveLength(1));
    const patch = stub.patchCalls()[0];
    expect(patch?.url).toContain('/goals');
    // 部分更新：未改动的当前体重 / 期限必须**不在** body 里
    expect(patch?.body).toEqual({ targetWeightKg: 50 });
  });

  it('★ 同时改当前体重与期限 → body 只含这两个字段', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-current');
    const current = screen.getByTestId('goal-input-current');
    await user.clear(current);
    await user.type(current, '58');
    const weeks = screen.getByTestId('goal-input-weeks');
    await user.clear(weeks);
    await user.type(weeks, '20');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() => expect(stub.patchCalls()).toHaveLength(1));
    expect(stub.patchCalls()[0]?.body).toEqual({ currentWeightKg: 58, targetWeeks: 20 });
  });

  it('成功后反馈文案中性（COPY.goalSaved）', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-target');
    const target = screen.getByTestId('goal-input-target');
    await user.clear(target);
    await user.type(target, '50');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe(COPY.goalSaved),
    );
    expect(stub.patchCalls()).toHaveLength(1);
    for (const banned of BANNED) {
      expect(COPY.goalSaved).not.toContain(banned);
    }
  });

  it('没有任何改动就提交 → 中性提示且**不发请求**', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-form');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe(COPY.goalNoChange),
    );
    expect(stub.patchCalls()).toHaveLength(0);
  });
});

describe('「我的目标」卡片 · 越界输入被前端拦下（不发请求）', () => {
  it('当前体重 500（> 400）→ 中性提示，不发请求', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-current');
    const current = screen.getByTestId('goal-input-current');
    await user.clear(current);
    await user.type(current, '500');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe(goalWeightInvalidFor(20, 400)),
    );
    expect(stub.patchCalls()).toHaveLength(0);
  });

  it('目标体重 0（< 1）→ 中性提示，不发请求', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-target');
    const target = screen.getByTestId('goal-input-target');
    await user.clear(target);
    await user.type(target, '0');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe(
        goalTargetWeightInvalidFor(1, 400),
      ),
    );
    expect(stub.patchCalls()).toHaveLength(0);
  });

  it('期限 0 与非整数 12.5 → 均被拦下，不发请求', async () => {
    const stub = stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-weeks');
    const weeks = screen.getByTestId('goal-input-weeks');

    await user.clear(weeks);
    await user.type(weeks, '0');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));
    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe(goalWeeksInvalidFor(1, 260)),
    );

    await user.clear(weeks);
    await user.type(weeks, '12.5');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));
    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe(goalWeeksInvalidFor(1, 260)),
    );

    expect(stub.patchCalls()).toHaveLength(0);
  });
});

describe('「我的目标」卡片 · 服务端 400', () => {
  it('PATCH 返回 400 → 展示服务端中性提示，不以「失败 / 错误」作标题', async () => {
    stubFetchReject();
    renderCard();
    const user = userEvent.setup();

    await screen.findByTestId('goal-input-target');
    const target = screen.getByTestId('goal-input-target');
    await user.clear(target);
    await user.type(target, '50');
    await user.click(screen.getByRole('button', { name: COPY.goalSaveButton }));

    await waitFor(() =>
      expect(screen.getByTestId('goal-notice').textContent).toBe('这些信息还差一点点，请检查后重试'),
    );
  });
});

describe('「我的目标」卡片 · 文案红线（PRD §7 无负罪感）', () => {
  it('新增固定文案不含「失败 / 错误 / 崩溃」，且无红色恐吓类名', async () => {
    const newCopyTexts = [
      COPY.goalCardTitle,
      COPY.goalCardDesc,
      COPY.goalCurrentTitle,
      COPY.goalCurrentWeightLabel,
      COPY.goalTargetWeightLabel,
      COPY.goalTargetWeeksLabel,
      COPY.goalEditHint,
      COPY.goalSaveButton,
      COPY.goalSaving,
      COPY.goalSaved,
      COPY.goalSaveMissed,
      COPY.goalNoChange,
      COPY.goalCardEmpty,
    ];
    for (const text of newCopyTexts) {
      for (const banned of BANNED) {
        expect(text).not.toContain(banned);
      }
    }

    // 越界提示也不含禁用词（含数字，走函数生成）
    for (const text of [
      goalWeightInvalidFor(20, 400),
      goalTargetWeightInvalidFor(1, 400),
      goalWeeksInvalidFor(1, 260),
    ]) {
      for (const banned of BANNED) {
        expect(text).not.toContain(banned);
      }
    }

    stubFetch({ startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
    renderCard();
    await screen.findByTestId('goal-form');

    expect(document.body.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });
});
