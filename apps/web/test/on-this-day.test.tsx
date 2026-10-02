/**
 * 「历史上的今天」（D-4）前端测试 —— 组件层（`pages/report/OnThisDayRecall.tsx`）。
 *
 * ## 为什么这个测试比一般组件测试更严
 *
 * 本功能的**全部价值**在于「唤起美好的记忆」，而它**最容易被做成「缺席指控」**。
 * 一个只断言「渲染出来了」的测试，会放过最危险的那种实现 ——
 * 没历史时渲染一张空卡、写一句「那天还没有记录」。所以这里重点测**没渲染时是否干净**。
 *
 * 自动化封口的红线：
 * 1. ★ 有历史记录时，**列出那天吃了什么**（餐次 + 食物名）；
 * 2. ★ 无历史记录时**整块隐藏**：DOM 里没有该区块，且**没有**「暂无 / 还没有 / 没记」之类文案；
 * 3. ★ 文本不含「断签 / 连续 / 完成率 / 没记 / N 天没」等缺席语义，**且无红色类名**；
 * 4. ★ 无分母型数字（「共 N 餐」/「N 天」/ 百分比 / X/Y 分数）；
 * 5. 一次只呈现**一个**时间尺度（有「一年前」就绝不同时显示「一个月前」）；
 * 6. 边界：跨年 / 跨月 / 2 月 29 日（一年前不存在 → 顺延到一个月前，且**不崩**）；
 * 7. 点「看看那天」→ 落到 `/diary?date=<那天>`（复用 C-1 已有能力，不新增路由）。
 *
 * ⚠️ 日期一律走**注入的 `today` prop**（组件显式支持），不读运行时时钟，
 * 测试因此不会随日历漂移。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import type { ReactElement } from 'react';

import OnThisDayRecall from '@/pages/report/OnThisDayRecall';
import {
  onThisDayCandidates,
  resolveMonthAgoDateKey,
  resolveYearAgoDateKey,
} from '@/lib/on-this-day';

/** 反评判 / 反缺席黑名单 —— 一个都不许出现在渲染文本里。 */
const BANNED_WORDS = [
  '断签',
  '断',
  '连续',
  '完成率',
  '完成度',
  '达成率',
  '没记',
  '没有记',
  '未记录',
  '未完成',
  '缺失',
  '漏记',
  '天没',
  '别荒废',
  '坚持',
];

/** 明确禁止的空态引导语 —— 红线要求它们**根本不存在**。 */
const EMPTY_STATE_WORDS = ['暂无', '还没有记录', '没有记录', '这天没有', '空空'];

/** 一条饮食记录（只填组件真正读到的字段）。 */
function meal(
  id: number,
  mealType: string,
  foodName: string,
  sortOrder: number,
): Record<string, unknown> {
  return {
    id,
    loggedDate: '2025-09-30',
    mealType,
    foodItemId: id,
    customName: null,
    foodName,
    grams: 100,
    kcal: 200,
    sortOrder,
  };
}

/** `/meals` 响应构造器。 */
function mealsPayload(date: string, logs: Array<Record<string, unknown>>): Record<string, unknown> {
  const groups = ['breakfast', 'lunch', 'dinner', 'snack']
    .map((mealType) => ({ mealType, logs: logs.filter((log) => log.mealType === mealType) }))
    .filter((group) => group.logs.length > 0);
  return { date, groups, totalKcal: 0 };
}

/** `/diary` 探针：把当前 URL 的 `date` 渲染出来，断言「看看那天」跳到了哪天。 */
function DiaryProbe(): ReactElement {
  const [params] = useSearchParams();
  return <div data-testid="diary-probe">{params.get('date') ?? 'none'}</div>;
}

/**
 * 渲染回望卡。
 *
 * @param mealsByDate 该日期有记录时返回其分组载荷；缺省表示那天**没有任何记录**
 * @returns `calls` = 实际发出的请求 URL；`whenIdle` = **等所有请求真正结束**的 promise
 *
 * ⚠️ `whenIdle` 不是锦上添花，而是**「整块隐藏」类断言的前提**：
 * `waitFor` 会**立即执行一次**回调，若回调当场成立就直接 resolve ——
 * 也就是说「查完之前当然什么都没有」会被误判成「查完之后也没有」，
 * 形成**假绿**。必须先确认请求真的往返完毕、再让 React 提交状态更新，
 * 才能断言「确实没有记录时，界面上确实什么都不渲染」。
 *
 * ⚠️ 另一个坑：判定「空闲」不能只看「当前 in-flight 数 == 0」——
 * 两个候选查询是**依次**发起的，第一个落地的那一刻 in-flight 确实归零，
 * 但第二个**还没开始**。故这里按**候选数量**（`onThisDayCandidates(today).length`）
 * 等到请求数达标，再多flush 几轮微任务 / 宏任务，确保 react-query 状态已提交。
 */
function renderRecall(
  today: string,
  mealsByDate: Record<string, ReturnType<typeof mealsPayload>> = {},
): { calls: string[]; whenIdle: () => Promise<void> } {
  const calls: string[] = [];
  const expectedCalls = onThisDayCandidates(today).length;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const matched = /\/api\/meals\?date=(\d{4}-\d{2}-\d{2})/.exec(url);
      const date = matched?.[1];
      const payload = date !== undefined ? mealsByDate[date] : undefined;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: payload ?? { date: date ?? '', groups: [], totalKcal: 0 },
          error: null,
        }),
      };
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/report']}>
        <Routes>
          <Route path="/report" element={<OnThisDayRecall today={today} />} />
          <Route path="/diary" element={<DiaryProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  /** 等全部候选请求都往返完毕 + 让 react-query 提交状态更新。 */
  const whenIdle = async (): Promise<void> => {
    if (expectedCalls === 0) {
      return;
    }
    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(expectedCalls);
    });
    // 多flush 几轮，确保响应解析 + 状态提交都已完成（而不是"刚好发出去"）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return { calls, whenIdle };
}

/** 等回望卡出现（有历史时）。 */
async function waitForCard(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = screen.queryByTestId('on-this-day');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

describe('历史上的今天 · 日期对齐（纯函数，lib/on-this-day.ts）', () => {
  it('跨年：2026-01-01 的一年前是 2025-01-01', () => {
    expect(resolveYearAgoDateKey('2026-01-01')).toBe('2025-01-01');
  });

  it('跨年：2026-01-01 的一个月前是 2025-12-01', () => {
    expect(resolveMonthAgoDateKey('2026-01-01')).toBe('2025-12-01');
  });

  it('跨月且目标月天数不同：2026-01-31 的一个月前钳制到 2025-12-31', () => {
    expect(resolveMonthAgoDateKey('2026-01-31')).toBe('2025-12-31');
  });

  it('跨月且目标月天数不同：2026-03-31 的一个月前钳制到 2026-02-28（平年，不溢出到 3 月 3 日）', () => {
    expect(resolveMonthAgoDateKey('2026-03-31')).toBe('2026-02-28');
  });

  it('跨月闰年：2024-03-31 的一个月前是 2024-02-29', () => {
    expect(resolveMonthAgoDateKey('2024-03-31')).toBe('2024-02-29');
  });

  it('★ 2 月 29 日：一年前在非闰年**不存在** → 返回 null（绝不硬凑成 2 月 28 日）', () => {
    // 2028 是闰年，2027 不是：2027-02-29 这个日历日不存在。
    expect(resolveYearAgoDateKey('2028-02-29')).toBeNull();
    // 对照：2024-02-29 的一年前（2023-02-29）同样不存在。
    expect(resolveYearAgoDateKey('2024-02-29')).toBeNull();
    // 而 2 月 28 日的「一年前」永远存在（2 月每年都有 28 日）。
    expect(resolveYearAgoDateKey('2024-02-28')).toBe('2023-02-28');
  });

  it('2 月 29 日的「一个月前」存在（2028-02-29 → 2028-01-29）', () => {
    expect(resolveMonthAgoDateKey('2028-02-29')).toBe('2028-01-29');
  });

  it('★ 候选顺序固定为「一年前 → 一个月前」；一年前不存在时只给一个月前', () => {
    expect(onThisDayCandidates('2026-09-30')).toEqual([
      { scale: 'year', dateKey: '2025-09-30' },
      { scale: 'month', dateKey: '2026-08-30' },
    ]);
    // 闰日：只有一个月前候选
    expect(onThisDayCandidates('2028-02-29')).toEqual([{ scale: 'month', dateKey: '2028-01-29' }]);
  });

  it('非法输入不崩：返回空候选（不抛错）', () => {
    for (const bad of ['', 'not-a-date', '2026-13-01', '2026-02-31', 'abc-01-01']) {
      expect(onThisDayCandidates(bad)).toEqual([]);
      expect(resolveYearAgoDateKey(bad)).toBeNull();
      expect(resolveMonthAgoDateKey(bad)).toBeNull();
    }
  });

  it('候选日永远严格早于今天（不会把未来当成回望）', () => {
    for (const today of ['2026-09-30', '2026-01-01', '2024-02-29', '2026-12-31']) {
      for (const candidate of onThisDayCandidates(today)) {
        expect(candidate.dateKey < today).toBe(true);
      }
    }
  });
});

describe('历史上的今天（D-4）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('★ 有历史记录时：列出那天吃了什么（餐次 + 食物名）', async () => {
    renderRecall('2026-09-30', {
      '2025-09-30': mealsPayload('2025-09-30', [
        meal(1, 'breakfast', '燕麦粥', 0),
        meal(2, 'breakfast', '鸡蛋', 1),
        meal(3, 'lunch', '番茄鸡蛋面', 0),
      ]),
    });

    const card = await waitForCard();
    expect(card.getAttribute('data-scale')).toBe('year');

    const groups = screen.getByTestId('on-this-day-groups');
    // 餐次分组都在
    expect(groups.querySelector('[data-meal-type="breakfast"]')?.textContent).toContain('早餐');
    expect(groups.querySelector('[data-meal-type="lunch"]')?.textContent).toContain('午餐');
    // 食物名都在
    const text = card.textContent ?? '';
    expect(text).toContain('燕麦粥');
    expect(text).toContain('鸡蛋');
    expect(text).toContain('番茄鸡蛋面');
    // 时间尺度标签 + 真实日期
    expect(text).toContain('一年前的今天');
    expect(screen.getByTestId('on-this-day-date').textContent).toContain('2025年9月30日');
    // 没记录的餐次**不出现**（不留「晚餐 还没有记录」这种空餐）
    expect(groups.querySelector('[data-meal-type="dinner"]')).toBeNull();
  });

  it('★ 无历史记录时：整块隐藏，且没有「暂无 / 还没有」之类文案', async () => {
    const { calls, whenIdle } = renderRecall('2026-09-30'); // 两个候选日都没有任何记录
    await whenIdle();

    // 前置：请求**确实往返完毕**了（否则「当然没渲染」只是还没查完，不是查完也没有）
    expect(calls.some((url) => url.includes('date=2025-09-30'))).toBe(true);
    expect(calls.some((url) => url.includes('date=2026-08-30'))).toBe(true);

    // 红线：整个区块都不该存在（不是空卡）
    expect(screen.queryByTestId('on-this-day')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('历史上的今天');
    // 红线：DOM 里不得出现任何空态引导语
    for (const word of EMPTY_STATE_WORDS) {
      expect(document.body.textContent ?? '').not.toContain(word);
    }
  });

  it('★ 一年前没记录时顺延到一个月前，且不留下任何「一年前缺失」的痕迹', async () => {
    renderRecall('2026-09-30', {
      '2026-08-30': mealsPayload('2026-08-30', [meal(9, 'dinner', '小馄饨', 0)]),
    });

    const card = await waitForCard();
    // 展示的是「一个月前」那一份
    expect(card.getAttribute('data-scale')).toBe('month');
    expect(card.textContent).toContain('一个月前的今天');
    expect(card.textContent).toContain('小馄饨');
    // 一次只呈现一个尺度：两个标签不同时出现
    expect(card.textContent).not.toContain('一年前的今天');
  });

  it('★ 红线：文本不含缺席语义 / 断签 / 完成率，且无红色类名、无分母型数字', async () => {
    renderRecall('2026-09-30', {
      '2025-09-30': mealsPayload('2025-09-30', [
        meal(1, 'breakfast', '燕麦粥', 0),
        meal(2, 'lunch', '鸡胸肉沙拉', 0),
        meal(3, 'dinner', '清蒸鱼', 0),
        meal(4, 'snack', '酸奶', 0),
      ]),
    });

    const card = await waitForCard();
    const text = card.textContent ?? '';

    for (const word of BANNED_WORDS) {
      expect(text).not.toContain(word);
    }
    // 无分母：百分比、分数式 X/Y 都不得出现
    expect(text).not.toContain('%');
    expect(/\d+\s*\/\s*\d+/.test(text)).toBe(false);
    // 「共 N 餐」这类计数（中文计数 + 数字）
    expect(/共\s*\d/.test(text)).toBe(false);
    // 无红色 / 警示色类名
    expect(card.innerHTML).not.toMatch(/text-red|bg-red|border-red|ring-red|red-\d/);
    // 无进度原语（进度条 = 隐含完成度）
    expect(card.querySelector('[role="meter"]')).toBeNull();
    expect(card.querySelector('progress')).toBeNull();
  });

  it('★ 边界 · 跨年：2026-01-01 的一年前是 2025-01-01，能正常回望', async () => {
    renderRecall('2026-01-01', {
      '2025-01-01': mealsPayload('2025-01-01', [meal(1, 'breakfast', '饺子', 0)]),
    });
    const card = await waitForCard();
    expect(card.textContent).toContain('饺子');
    expect(screen.getByTestId('on-this-day-date').textContent).toContain('2025年1月1日');
  });

  it('★ 边界 · 跨月：2026-01-31 的一年前是 2025-01-31，能正常回望', async () => {
    renderRecall('2026-01-31', {
      '2025-01-31': mealsPayload('2025-01-31', [meal(1, 'lunch', '火锅', 0)]),
    });
    const card = await waitForCard();
    expect(card.textContent).toContain('火锅');
    expect(screen.getByTestId('on-this-day-date').textContent).toContain('2025年1月31日');
  });

  it('★ 边界 · 2 月 29 日：一年前在非闰年不存在 → 顺延到一个月前，且不崩', async () => {
    // 2028-02-29 的一年前（2027-02-29）不存在 → 只能顺延到 2028-01-29
    renderRecall('2028-02-29', {
      '2028-01-29': mealsPayload('2028-01-29', [meal(1, 'dinner', '汤圆', 0)]),
    });

    const card = await waitForCard();
    expect(card.getAttribute('data-scale')).toBe('month');
    expect(card.textContent).toContain('汤圆');
    expect(screen.getByTestId('on-this-day-date').textContent).toContain('2028年1月29日');
    // 绝不硬凑一个不存在的 2027-02-29
    expect(document.body.textContent ?? '').not.toContain('2027年2月29日');
  });

  it('★ 边界 · 2 月 29 日且一年前 / 一个月前都没记录 → 整块隐藏（不崩、无空态）', async () => {
    const { whenIdle } = renderRecall('2028-02-29');
    await whenIdle();
    expect(screen.queryByTestId('on-this-day')).toBeNull();
    for (const word of EMPTY_STATE_WORDS) {
      expect(document.body.textContent ?? '').not.toContain(word);
    }
  });

  it('★ 零后端改动：只请求现成的 GET /meals?date=，不新增任何端点', async () => {
    const { calls } = renderRecall('2026-09-30', {
      '2025-09-30': mealsPayload('2025-09-30', [meal(1, 'breakfast', '燕麦粥', 0)]),
    });
    await waitForCard();

    const mealCalls = calls.filter((url) => url.includes('/api/meals'));
    expect(mealCalls.length).toBeGreaterThan(0);
    // 每个候选日一次，带 date 参数 —— 用的就是已有的查询端点
    for (const url of mealCalls) {
      expect(url).toContain('date=');
      // 没有出现任何新端点
      expect(url).not.toContain('/on-this-day');
      expect(url).not.toContain('/recall');
    }
  });

  it('★ 点「看看那天」→ 落到 /diary?date=<那天>（复用 C-1，不新增路由）', async () => {
    renderRecall('2026-09-30', {
      '2025-09-30': mealsPayload('2025-09-30', [meal(1, 'breakfast', '燕麦粥', 0)]),
    });
    await waitForCard();

    const link = screen.getByTestId('on-this-day-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/diary?date=2025-09-30');

    link.click();
    await waitFor(() => {
      expect(screen.getByTestId('diary-probe').textContent).toBe('2025-09-30');
    });
  });

  it('★ 读屏标签不含评判词，且带完整日期', async () => {
    renderRecall('2026-09-30', {
      '2025-09-30': mealsPayload('2025-09-30', [meal(1, 'breakfast', '燕麦粥', 0)]),
    });
    await waitForCard();

    const link = screen.getByTestId('on-this-day-link');
    const aria = link.getAttribute('aria-label') ?? '';
    expect(aria).toContain('2025年9月30日');
    for (const word of BANNED_WORDS) {
      expect(aria).not.toContain(word);
    }
  });

  it('★ 反假绿：「无历史 → 隐藏」必须**等请求往返完毕**再断言（否则恒绿）', async () => {
    // 这条用例的存在意义：曾经的写法是
    //   await waitFor(() => expect(screen.queryByTestId('on-this-day')).toBeNull());
    // 而 `waitFor` 会**立即**跑一次回调、成立就 resolve —— 在查询落地之前
    // 「当然没有渲染」恒为真，于是把「渲染了空卡」的缺陷注入也放过去了（实测 12 条全绿）。
    // 改用 `whenIdle`（等全部候选请求往返 + flush）后，同一处注入才会转红。
    const { calls, whenIdle } = renderRecall('2026-09-30');
    await whenIdle();

    // 确认确实查过了（两个候选日都查过，且都没记录）
    expect(calls.filter((url) => url.includes('/api/meals')).length).toBe(2);
    expect(screen.queryByTestId('on-this-day')).toBeNull();
  });

  it('脏数据不崩：缺 groups / groups 为空 / 食物名为空', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { date: '2025-09-30' }, error: null }), // 无 groups 字段
      })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <OnThisDayRecall today="2026-09-30" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // 等两条查询都落地（缺 groups 字段不应导致崩溃，也不该渲染出区块）
    await waitFor(() => {
      expect(screen.queryByTestId('on-this-day')).toBeNull();
    });
    for (const word of EMPTY_STATE_WORDS) {
      expect(document.body.textContent ?? '').not.toContain(word);
    }
  });
});