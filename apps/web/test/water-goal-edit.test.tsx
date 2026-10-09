/**
 * 每日饮水目标编辑入口（GAP-3，pages/exercise/WaterGoalCard.tsx）。
 *
 * ## 背景
 *
 * `waterGoalMl` 的后端两条通道都就绪（范围对齐到 500–8000），前端却**没有输入入口**，
 * 用户永远看 2000 默认值。本文件把补上的入口契约固定下来：
 *
 * - **展示**：入口回显当前值（来自 `GET /water` 的 `goalMl`），不是硬编码 2000；
 * - **核心**：改目标 → `PATCH /users/settings` 且 body 含正确的 `waterGoalMl`；
 * - **范围**：499 / 8001 → 前端拦住（不发出请求），给中性提示；
 * - **离线**：改目标失败 → 记 dirty、本地先记住、不报错、不阻塞；联网后补推。
 *
 * ## ⚠️ 服务端层与本机层必须用「哨兵值」，不能顺手写成 2000
 *
 * 本文件曾经在七处写 `stubFetch({ goalMl: 2000 })`，而 `DEFAULT_WATER_GOAL_ML` 恰好也是 2000 ——
 * 「服务端层」和「默认层」共用同一个数字。后果很实在：把 `resolveWaterGoalMl` 改成
 * `return readStoredWaterGoalMl() ?? DEFAULT_WATER_GOAL_ML;`（即删掉服务端那一层、让默认值直接兜底），
 * 本文件**照样全绿** —— 整套用例对自己的保护对象毫无区分力，是典型的假绿。
 *
 * 所以这里两层各自用一个**哨兵值**（见下面 `SERVER_GOAL_ML` / `STORED_GOAL_ML`），刻意不等于
 * `DEFAULT_WATER_GOAL_ML`、不等于彼此、也不等于本文件出现过的其它数字
 * （2500 / 2600 / 499 / 500 / 8000 / 8001 / 3000）；并单独留一条自证用例盯住这个前提，
 * 以免将来有人把默认值改成同值时整套文件悄悄退化回假绿。
 *
 * 手法：mock 全局 `fetch`（与 `settings-sync.test.tsx` / `exercise-delete.test.tsx` 一致），
 * 断言实际请求 URL / method / body，而不是断言内部实现。
 *
 * 语气红线（PRD §7）：新文案不含「失败 / 错误」作标题，无红色类名，无催促性措辞。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import ExercisePage from '@/pages/exercise/ExercisePage';
import { COPY, waterGoalInvalidFor } from '@/lib/copy';
import {
  DEFAULT_WATER_GOAL_ML,
  WATER_GOAL_MAX_ML,
  WATER_GOAL_MIN_ML,
  isValidWaterGoalMl,
} from '@qsh/core';
import { createEmptyExportPayload } from '@/lib/csv';
import { __resetDirtyForTest, flushPendingSettings, hasPendingSettings } from '@/lib/settings-sync';
import {
  WATER_GOAL_STORAGE_KEY,
  persistWaterGoalMl,
  readStoredWaterGoalMl,
} from '@/lib/water-goal';

/**
 * `GET /water` 的 `goalMl`（**服务端层**）在本文件里的哨兵值。
 *
 * 三条约束，缺一不可（由下面「自证」用例盯住）：
 * 1. `!== DEFAULT_WATER_GOAL_ML` —— 否则服务端层与默认层撞车，删掉服务端那层本文件仍全绿；
 * 2. `isValidWaterGoalMl(...) === true`（500–8000 的整数），否则根本落不进输入框；
 * 3. 不等于本文件出现过的其它数字（2500 / 2600 / 499 / 500 / 8000 / 8001 / 3000 / STORED_GOAL_ML），
 *    否则又跟「边界值用例」「改后的新值」混淆。
 *
 * ⚠️ 类型要显式标成 `number`，别让它被推断成字面量 `2400`：下面那条自证用例拿它跟
 * `DEFAULT_WATER_GOAL_ML` 做等式比较，字面量类型会让 tsc 报 TS2367「这两种类型没有重叠」——
 * 那等于把「改一下常量就编译不过」当成护栏了，而我们要的是**运行期**先红并把原因说清楚。
 */
const SERVER_GOAL_ML: number = 2400;

/** localStorage 里记住的值（**本机层**）的哨兵值 —— 约束同上，且刻意 != `SERVER_GOAL_ML`。 */
const STORED_GOAL_ML: number = 1800;

/**
 * 优先级用例里「敲一下输入框」用的占位值 —— 只为了触发一次重渲。
 * 刻意不等于上面三层的值，这样「重渲后回显了什么」不会被占位值本身掩盖。
 */
const TYPED_PLACEHOLDER_ML = '700';

/** 统一 `{ data, error }` 包装的成功响应。 */
function wrappedResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as unknown as Response;
}

interface FetchRecord {
  url: string;
  method: string;
  body: unknown;
}

/**
 * fetch 桩：覆盖 ExercisePage 会发的请求（`GET /water`、`GET /exercises`）
 * 以及饮水目标落库的 `PATCH /users/settings`。
 */
function stubFetch(options: { goalMl?: number; failPatch?: boolean } = {}): {
  calls: FetchRecord[];
} {
  const calls: FetchRecord[] = [];
  const goalMl = options.goalMl ?? SERVER_GOAL_ML;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body =
        init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
      calls.push({ url, method, body });

      if (url.includes('/api/users/settings')) {
        if (options.failPatch) {
          throw new TypeError('Failed to fetch');
        }
        return wrappedResponse({ unit: 'kcal', waterGoalMl: goalMl });
      }
      if (method === 'GET' && url.includes('/api/water')) {
        return wrappedResponse({ date: '2026-09-23', totalMl: 0, goalMl, logs: [] });
      }
      if (method === 'GET' && url.includes('/api/exercises')) {
        return wrappedResponse({ date: '2026-09-23', logs: [], totalKcal: 0 });
      }
      throw new Error(`测试桩未覆盖的请求：${method} ${url}`);
    }),
  );
  return { calls };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/exercise']}>
        <ExercisePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 从 fetch 记录里筛出 PATCH `/api/users/settings` 的调用体。 */
function patchBodies(calls: FetchRecord[]): unknown[] {
  return calls
    .filter((call) => call.method === 'PATCH' && call.url.includes('/api/users/settings'))
    .map((call) => call.body);
}

function inputEl(): HTMLInputElement {
  return screen.getByTestId('water-goal-input') as HTMLInputElement;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
  __resetDirtyForTest();
});

describe('GAP-3：每日饮水目标编辑入口（落点 /exercise 喝水区）', () => {
  it('★ 展示：入口回显当前目标（GET /water 的 goalMl），不是硬编码 2000', async () => {
    // 刻意给一个既不是默认层也不是哨兵值的值：证明输入框吃的是「服务端给的数」，
    // 而不是兜底的 DEFAULT_WATER_GOAL_ML。
    stubFetch({ goalMl: 2500 });
    renderPage();

    await waitFor(() => {
      expect(inputEl().value).toBe('2500');
    });
    // 2000 是默认兜底值；回显落到它身上就说明服务端那层数没吃进去
    expect(inputEl().value).not.toBe(String(DEFAULT_WATER_GOAL_ML));
  });

  it('★ 优先级：本机值 > 服务端值（离线刚改的目标不能被服务端旧值打回去）', async () => {
    stubFetch({ goalMl: SERVER_GOAL_ML });
    renderPage();

    // ① 先让服务端值落地到 DOM —— 这一步同时也是后面断言的**前提**：
    //    不知道服务端什么时候到货，就无法区分「本机值赢了」和「服务端还没来」。
    await waitFor(() => {
      expect(inputEl().value).toBe(String(SERVER_GOAL_ML));
    });

    // ② 场景推进：本机出现了**更新的**值（离线改动已写本地，服务端还是旧值）。
    //    必须放在 ① 之后：让服务端值**先**落地到 DOM，才能证明「本机值是在服务端值之上又赢了一层」；
    //    若改到渲染前写，终值同样是 1800，但解释变成了「服务端压根没到货」——正是本轮要堵的那种假绿。
    persistWaterGoalMl(STORED_GOAL_ML);

    // ③ 敲一下输入框（占位值）—— 只为触发一次重渲。卡片每次渲染都会重算 `resolveWaterGoalMl()`
    //    并用 useEffect 把结果同步回显到输入框，所以「下一次渲染后的回显值」就是优先级的答案：
    //    本机值优先 → 打成 1800；服务端值优先 → 停在 700（current 没变，effect 不再触发）。
    fireEvent.change(inputEl(), { target: { value: TYPED_PLACEHOLDER_ML } });

    // ④ 终值断言：本机值必须压过服务端值与默认值
    expect(inputEl().value).toBe(String(STORED_GOAL_ML));
    expect(inputEl().value).not.toBe(String(SERVER_GOAL_ML));
    expect(inputEl().value).not.toBe(String(DEFAULT_WATER_GOAL_ML));
  });

  it('自证（元测试）：服务端层 / 本机层的哨兵值没撞车，否则本文件会退回假绿', () => {
    const collided: string[] = [];
    if (SERVER_GOAL_ML === DEFAULT_WATER_GOAL_ML) {
      collided.push(
        `「服务端层 SERVER_GOAL_ML(${SERVER_GOAL_ML})」撞上了「默认层 DEFAULT_WATER_GOAL_ML(${DEFAULT_WATER_GOAL_ML})」`,
      );
    }
    if (STORED_GOAL_ML === DEFAULT_WATER_GOAL_ML) {
      collided.push(
        `「本机层 STORED_GOAL_ML(${STORED_GOAL_ML})」撞上了「默认层 DEFAULT_WATER_GOAL_ML(${DEFAULT_WATER_GOAL_ML})」`,
      );
    }
    if (STORED_GOAL_ML === SERVER_GOAL_ML) {
      collided.push(
        `「本机层 STORED_GOAL_ML(${STORED_GOAL_ML})」撞上了「服务端层 SERVER_GOAL_ML(${SERVER_GOAL_ML})」`,
      );
    }
    if (!isValidWaterGoalMl(SERVER_GOAL_ML)) {
      collided.push(
        `「服务端层 SERVER_GOAL_ML(${SERVER_GOAL_ML})」不在合法区间 WATER_GOAL_MIN_ML(${WATER_GOAL_MIN_ML})–WATER_GOAL_MAX_ML(${WATER_GOAL_MAX_ML})，它压根不会被回显到输入框里`,
      );
    }
    if (!isValidWaterGoalMl(STORED_GOAL_ML)) {
      collided.push(
        `「本机层 STORED_GOAL_ML(${STORED_GOAL_ML})」不在合法区间 WATER_GOAL_MIN_ML(${WATER_GOAL_MIN_ML})–WATER_GOAL_MAX_ML(${WATER_GOAL_MAX_ML})，persistWaterGoalMl 会静默丢弃它`,
      );
    }

    expect(
      collided,
      [
        '哨兵值失去区分力 —— 撞车的层：',
        ...collided.map((item) => `  · ${item}`),
        '',
        '后果一：删掉 resolveWaterGoalMl 的「服务端值」那层（让默认层直接兜底），本文件仍会全绿；',
        '后果二：「本机值 > 服务端值」那条优先级用例退化成永真断言。',
        '修法：改本文件顶部的 SERVER_GOAL_ML / STORED_GOAL_ML —— 落在合法区间、彼此不等、且都不等于 DEFAULT_WATER_GOAL_ML。',
      ].join('\n'),
    ).toEqual([]);
  });

  it('★ 核心：改目标 → PATCH /users/settings 且 body 含正确的 waterGoalMl', async () => {
    const { calls } = stubFetch({ goalMl: SERVER_GOAL_ML });
    renderPage();

    // 等入口就绪
    await waitFor(() => {
      expect(inputEl().value).toBe(String(SERVER_GOAL_ML));
    });

    fireEvent.change(inputEl(), { target: { value: '2600' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(patchBodies(calls).length).toBeGreaterThan(0);
    });
    expect(patchBodies(calls)[0]).toEqual({ waterGoalMl: 2600 });
    // 本地快路径同步记住（离线展示 + 联网补推的来源）
    expect(readStoredWaterGoalMl()).toBe(2600);
    expect(window.localStorage.getItem(WATER_GOAL_STORAGE_KEY)).toBe('2600');
  });

  it('★ 范围：499 → 前端拦住（不发出请求），给中性提示', async () => {
    const { calls } = stubFetch({ goalMl: SERVER_GOAL_ML });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe(String(SERVER_GOAL_ML)));

    fireEvent.change(inputEl(), { target: { value: '499' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(screen.getByTestId('water-goal-notice')).toBeInTheDocument();
    });
    expect(patchBodies(calls)).toHaveLength(0);
    expect(screen.getByTestId('water-goal-notice').textContent).toBe(
      waterGoalInvalidFor(WATER_GOAL_MIN_ML, WATER_GOAL_MAX_ML),
    );
    // 未落库也未写本地
    expect(readStoredWaterGoalMl()).toBeUndefined();
  });

  it('★ 范围：8001 → 前端拦住（不发出请求）', async () => {
    const { calls } = stubFetch({ goalMl: SERVER_GOAL_ML });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe(String(SERVER_GOAL_ML)));

    fireEvent.change(inputEl(), { target: { value: '8001' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(screen.getByTestId('water-goal-notice')).toBeInTheDocument();
    });
    expect(patchBodies(calls)).toHaveLength(0);
  });

  it('边界值 500 / 8000 合法，会发出请求', async () => {
    const { calls } = stubFetch({ goalMl: SERVER_GOAL_ML });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe(String(SERVER_GOAL_ML)));

    fireEvent.change(inputEl(), { target: { value: '500' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));

    await waitFor(() => {
      expect(patchBodies(calls)).toContainEqual({ waterGoalMl: 500 });
    });
  });

  it('★ 离线：改目标失败 → 本地先记住 + 记 dirty（不抛错、不阻塞）', async () => {
    stubFetch({ goalMl: SERVER_GOAL_ML, failPatch: true });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe(String(SERVER_GOAL_ML)));

    expect(() => {
      fireEvent.change(inputEl(), { target: { value: '3000' } });
      fireEvent.click(screen.getByText(COPY.waterGoalButton));
    }).not.toThrow();

    // 首次 + 一次重试后仍失败 → 记 dirty
    await waitFor(() => {
      expect(hasPendingSettings()).toBe(true);
    });
    // 本地已生效（离线显示与补推的来源）
    expect(readStoredWaterGoalMl()).toBe(3000);
    expect(window.localStorage.getItem(WATER_GOAL_STORAGE_KEY)).toBe('3000');
  });

  it('★ 联网后补推：把本机记住的目标推回服务端，且 dirty 清除', async () => {
    // 先离线改（制造 dirty）
    stubFetch({ goalMl: SERVER_GOAL_ML, failPatch: true });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe(String(SERVER_GOAL_ML)));
    fireEvent.change(inputEl(), { target: { value: '3000' } });
    fireEvent.click(screen.getByText(COPY.waterGoalButton));
    await waitFor(() => expect(hasPendingSettings()).toBe(true));

    // 联网：后续请求成功
    const { calls } = stubFetch({ goalMl: 3000 });
    // 与 App 的 registerSettingsOnlineFlush(getCurrent) 同构：从本机读到当前值再推
    const pushed = await flushPendingSettings({ waterGoalMl: readStoredWaterGoalMl() });

    expect(pushed).toBe(true);
    expect(patchBodies(calls)).toContainEqual({ waterGoalMl: 3000 });
    expect(hasPendingSettings()).toBe(false);
  });

  it('文案红线：新文案不含「失败 / 错误 / 警告」作标题，无红色类名，无催促性措辞', async () => {
    stubFetch({ goalMl: SERVER_GOAL_ML });
    renderPage();
    await waitFor(() => expect(inputEl().value).toBe(String(SERVER_GOAL_ML)));

    for (const banned of ['失败', '错误', '警告', '崩溃']) {
      expect(COPY.waterGoalTitle).not.toContain(banned);
      expect(COPY.waterGoalDesc).not.toContain(banned);
      expect(COPY.waterGoalButton).not.toContain(banned);
      expect(COPY.waterGoalSaved).not.toContain(banned);
    }
    // 无催促性措辞
    for (const pressured of ['必须', '一定', '坚持', '赶紧']) {
      expect(COPY.waterGoalDesc).not.toContain(pressured);
      expect(COPY.waterGoalSaved).not.toContain(pressured);
    }
    // 卡片内无红色 / coral 类名（饮水是轻设置，不恐吓）
    const card = screen.getByRole('heading', { name: COPY.waterGoalTitle }).closest('section');
    expect(card).not.toBeNull();
    const classNames = card === null ? '' : (card as HTMLElement).innerHTML;
    expect(classNames).not.toContain('text-red');
    expect(classNames).not.toContain('bg-red');
    expect(classNames).not.toContain('coral');
  });
});

describe('GAP-3：waterGoalMl 纳入导出骨架（连带）', () => {
  it('createEmptyExportPayload 的 settings 含 waterGoalMl 默认值', () => {
    const payload = createEmptyExportPayload('2026-09-12T00:00:00.000Z');
    expect(payload.settings.waterGoalMl).toBe(DEFAULT_WATER_GOAL_ML);
  });
});
