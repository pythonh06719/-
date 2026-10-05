/**
 * 运动 / 饮水页三处状态缺陷的护栏测试（pages/exercise/ExercisePage.tsx）。
 *
 * 三处缺陷（都由「静默兜底」造成，症状都不是报错，而是**数字不可信**）：
 *  ① `POST /exercises` 返回单条记录，却被断言成整日汇总塞进缓存 → 记完运动列表变空、合计变 0；
 *  ② `dayQuery` / `waterQuery` 零错误态 → 失败时显示「0 / 2000 ml（0%）」「今天还没有记录」；
 *  ③ 离线删除入队（重放失败会静默丢弃），UI 却宣告「已经删掉了」。
 *
 * ## 测试局限（jsdom 做不到，本文件**测不出**的部分）
 *
 * - **布局与几何**：jsdom 不做排版，故「提示条是否遮挡数字」「是否溢出卡片」「两个提示条
 *   在窄屏的实际间距」都测不出来 —— 本文件只能断言**类名**（`bg-slate-100` / `text-slate-600`）
 *   与**文本**，配色与位置需人眼在浏览器确认。
 * - **颜色对比度**：`bg-slate-100` + `text-slate-600` 的对比度是沿用 `WeightPage` /
 *   `DiaryPage` 已实测过的同一组类名，本文件不复测（jsdom 无 `getComputedStyle` 的真实配色）。
 * - **离线队列重放失败后静默丢弃**：jsdom 无 IndexedDB，`enqueueRequest` 走内存队列；
 *   缺陷 ③ 的**后果**（重放 3 次失败 → 那条删除永远没发生）无法在 jsdom 里端到端复现，
 *   本文件只能守住「文案不得是完成态」这一半。
 * - **真实断网**：用 `fetch` 抛 `TypeError('Failed to fetch')` 模拟，这与 `lib/api.ts`
 *   归为 `E_NETWORK` 的路径一致，但不覆盖 `navigator.onLine === false` 的分支。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import ExercisePage, {
  EXERCISE_DELETE_QUEUED,
  EXERCISE_STALE_NOTICE,
  WATER_STALE_NOTICE,
} from '@/pages/exercise/ExercisePage';
import { COPY } from '@/lib/copy';
import { api } from '@/lib/api';
import { cacheSet } from '@/lib/local-cache';
import { todayKey } from '@/lib/format';
import { queryKeys } from '@/lib/queryClient';
import { WATER_QUICK_ADD_ML } from '@/theme/tokens';
import { __resetMemoryQueueForTest, listQueuedRequests } from '@/pwa/offline-queue';

/** 一条运动记录（`GET /exercises` 的 `logs` 元素）。 */
interface ExLog {
  id: number;
  activityName: string;
  minutes: number;
  kcalBurned: number;
}

/** `GET /exercises` 的整日汇总响应。 */
interface DayPayload {
  date: string;
  logs: ExLog[];
  totalKcal: number;
}

/** `GET /water` 的响应。 */
interface WaterPayload {
  date: string;
  totalMl: number;
  goalMl: number;
  logs: Array<{ id: number; amountMl: number }>;
}

/**
 * 一次请求的桩行为。
 *
 * `ok` 的 `body` 即**后端真实返回的那份 JSON** —— 尤其是 POST /exercises 那里，
 * 刻意用「单条记录」而不是整日汇总，好让用例钉死后端契约。
 */
type Step =
  | { kind: 'ok'; body: unknown }
  | { kind: 'network' }
  | { kind: 'business'; status: number; code: string; message: string };

/** 造一份 `GET /exercises` 响应（totalKcal 与后端同口径：逐条求和保留 1 位小数）。 */
function makeDay(logs: ExLog[], date: string): DayPayload {
  return { date, logs, totalKcal: Math.round(logs.reduce((s, l) => s + l.kcalBurned, 0) * 10) / 10 };
}

/**
 * `POST /exercises` 的**真实返回形态**（后端 `ExerciseService.create()` → `ExerciseLogDto`）。
 * ⚠️ 只有单条记录的字段，**没有 `logs`、没有 `totalKcal`** —— 缺陷 ① 的根源就在这里。
 */
function singleLogDto(id: number, kcalBurned: number): Record<string, unknown> {
  return {
    id,
    loggedDate: todayKey(),
    activityCode: 'walking_brisk',
    activityName: '快走',
    met: 4.3,
    minutes: 30,
    kcalBurned,
    note: null,
  };
}

interface StubConfig {
  /** GET /exercises 的响应序列（第 N 次调用取第 N 项，越界沿用最后一项） */
  exerciseSteps?: Step[];
  /** GET /water 的响应序列 */
  waterSteps?: Step[];
  /** POST /exercises 的响应 */
  postStep?: Step;
  /** DELETE /exercises/:id 的响应 */
  deleteStep?: Step;
}

interface Stub {
  /** 每次 GET /exercises 的请求序号（用于断言「记完后真的重新取了」） */
  exerciseGetCalls: number;
  /** 每次 GET /report/* 的请求序号（用于断言报表被一同失效） */
  reportGetCalls: number;
  waterGetCalls: number;
}

/** 取序列中第 `index` 项（越界沿用最后一项）。 */
function stepAt(steps: Step[], index: number): Step {
  return steps[Math.min(index, steps.length - 1)] ?? { kind: 'ok', body: {} };
}

/** 把 `Step` 变成 fetch 的返回值（`network` 直接抛，模拟 `lib/api.ts` 的 `E_NETWORK` 路径）。 */
function respond(step: Step): Promise<Response> {
  if (step.kind === 'network') {
    throw new TypeError('Failed to fetch');
  }
  if (step.kind === 'business') {
    return Promise.resolve({
      ok: false,
      status: step.status,
      json: async () => ({ data: null, error: { code: step.code, message: step.message } }),
    } as Response);
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ data: step.body, error: null }),
  } as Response);
}

function stubFetch(config: StubConfig): Stub {
  const stub: Stub = { exerciseGetCalls: 0, reportGetCalls: 0, waterGetCalls: 0 };
  const exerciseSteps = config.exerciseSteps ?? [{ kind: 'ok' as const, body: makeDay([], todayKey()) }];
  const waterSteps = config.waterSteps ?? [
    { kind: 'ok' as const, body: { date: todayKey(), totalMl: 0, goalMl: 2000, logs: [] } satisfies WaterPayload },
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (method === 'GET' && url.includes('/api/report/')) {
        const index = stub.reportGetCalls;
        stub.reportGetCalls += 1;
        return respond(stepAt([{ kind: 'ok', body: { days: [] } }], index));
      }
      if (method === 'GET' && url.includes('/api/exercises')) {
        const index = stub.exerciseGetCalls;
        stub.exerciseGetCalls += 1;
        return respond(stepAt(exerciseSteps, index));
      }
      if (method === 'GET' && url.includes('/api/water')) {
        const index = stub.waterGetCalls;
        stub.waterGetCalls += 1;
        return respond(stepAt(waterSteps, index));
      }
      if (method === 'POST' && url.includes('/api/exercises')) {
        return respond(config.postStep ?? { kind: 'ok', body: singleLogDto(12, 120) });
      }
      if (method === 'DELETE' && url.includes('/api/exercises/')) {
        return respond(config.deleteStep ?? { kind: 'ok', body: { deleted: true } });
      }
      throw new Error(`测试桩未覆盖的请求：${method} ${url}`);
    }),
  );
  return stub;
}

/**
 * 报表探针：只为了验证 `invalidateQueries(reportQueryFilter())` 真的重跑了报表查询。
 *
 * 为什么挂一个真组件而不是查 `queryClient`：只有**活跃的**查询才会在 `invalidateQueries`
 * 时被自动重取，用 `useQuery` 挂一个探针才等价于用户正停在报表页的情形。
 */
function ReportProbe(): ReactElement {
  const query = useQuery({
    queryKey: queryKeys.weeklyReport(todayKey()),
    queryFn: () => api.get<{ days: unknown[] }>('/report/weekly', { endDate: todayKey() }),
    retry: false,
  });
  return <div data-testid="report-probe">{query.isFetching ? '取数中' : '已就绪'}</div>;
}

/** 渲染本页（可附带报表探针）；`seed` 用于预先塞入「上次成功的数据」。 */
function renderPage(options: { withReportProbe?: boolean; seed?: QueryClient } = {}): QueryClient {
  const client = options.seed ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/exercise']}>
        {options.withReportProbe === true ? <ReportProbe /> : null}
        <ExercisePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** 预先塞入「上次成功的结果」—— 模拟 react-query 失败时**原样保留**旧 data 的行为。 */
function seedExerciseDay(logs: ExLog[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.exerciseDay(todayKey()), makeDay(logs, todayKey()));
  return client;
}

function seedWaterDay(totalMl: number): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.waterDay(todayKey()), {
    date: todayKey(),
    totalMl,
    goalMl: 2000,
    logs: [],
  } satisfies WaterPayload);
  return client;
}

/** 写本机饮水缓存（离线点 +250ml 时页面自己写的那份）。 */
function writeLocalWater(totalMl: number): void {
  cacheSet(`qsh:cache:water:${todayKey()}`, { totalMl, history: [Date.now()] });
}

/**
 * 等到某个查询**确实已落到错误态**。
 *
 * ⚠️ 「不该出现标记」这类**反断言**必须等这一步：请求还没回来时 `isError` 为假，
 * 断言会「因为还没失败而通过」—— 撤掉判据里的 `isNetworkError` / 兜底值这两半也照样全绿，
 * 等于没有护栏（本文件首轮就踩过这个坑，靠缺陷注入才发现）。
 *
 * 判据直接读 react-query 的查询状态（`status === 'error'`），而不是等某个 DOM 变化 ——
 * DOM 上此刻唯一可能变化的就是那条标记本身，等它等于循环论证。
 */
async function waitForQueryError(client: QueryClient, key: readonly unknown[]): Promise<void> {
  await waitFor(() => {
    expect(client.getQueryState(key)?.status).toBe('error');
  });
  // 再让 React 把这次状态变更刷到 DOM（标记若该出现，此刻必已渲染）
  await act(async () => {
    await Promise.resolve();
  });
}

describe('① POST /exercises 的返回形态（记完运动不能让列表变空）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetMemoryQueueForTest();
    window.localStorage.clear();
  });

  it('★ 记下运动后：新记录出现在列表、合计来自真查询，不退回「今天还没有记录」', async () => {
    // 第一次 GET 返回「今天还没有」，第二次（记完之后重新取的）返回 1 条
    const stub = stubFetch({
      exerciseSteps: [
        { kind: 'ok', body: makeDay([], todayKey()) },
        { kind: 'ok', body: makeDay([{ id: 12, activityName: '快走', minutes: 30, kcalBurned: 120 }], todayKey()) },
      ],
      postStep: { kind: 'ok', body: singleLogDto(12, 120) },
    });
    renderPage();

    // 记之前：空态
    await waitFor(() => {
      expect(screen.getByText('今天还没有记录，散散步也算数')).toBeDefined();
    });

    fireEvent.click(screen.getByText('记下这次运动'));

    // 记之后：新记录 + 合计 120（缺陷① 时这里会仍是空态、合计 0）
    await waitFor(() => {
      expect(screen.getByTestId('exercise-delete-12')).toBeDefined();
    });
    expect(screen.queryByText('今天还没有记录，散散步也算数')).toBeNull();
    expect(screen.getByText('120')).toBeDefined();
    // 「记完之后确实重新取了一次」—— 治根（让真查询自己去取）而不是就地伪造缓存
    expect(stub.exerciseGetCalls).toBeGreaterThanOrEqual(2);
  });

  it('★ 后端 POST 返回的是单条记录，前端不得把它当整日汇总（契约形态断言）', async () => {
    const dto = singleLogDto(12, 120);
    // 后端契约：只有单条字段，没有 logs / totalKcal
    expect(Object.keys(dto).sort()).toEqual([
      'activityCode',
      'activityName',
      'id',
      'kcalBurned',
      'loggedDate',
      'met',
      'minutes',
      'note',
    ]);
    expect(dto).not.toHaveProperty('logs');
    expect(dto).not.toHaveProperty('totalKcal');

    stubFetch({
      exerciseSteps: [{ kind: 'ok', body: makeDay([], todayKey()) }],
      postStep: { kind: 'ok', body: dto },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('今天还没有记录，散散步也算数')).toBeDefined();
    });
  });

  it('★ 记下运动后报表查询也一起失效（周报 / 足迹日历不会停在旧数字）', async () => {
    const stub = stubFetch({
      exerciseSteps: [{ kind: 'ok', body: makeDay([], todayKey()) }],
      postStep: { kind: 'ok', body: singleLogDto(12, 120) },
    });
    renderPage({ withReportProbe: true });

    await waitFor(() => {
      expect(screen.getByTestId('report-probe')).toBeDefined();
    });
    // 探针挂载时取过一次
    await waitFor(() => {
      expect(stub.reportGetCalls).toBeGreaterThanOrEqual(1);
    });
    const before = stub.reportGetCalls;

    fireEvent.click(screen.getByText('记下这次运动'));
    await waitFor(() => {
      expect(stub.reportGetCalls).toBeGreaterThan(before);
    });
  });
});

describe('② 两个查询的「这是上次同步的数据」标记', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetMemoryQueueForTest();
    window.localStorage.clear();
  });

  it('★ 运动查询断网 + 有旧数据 → 出现运动标记，且列表仍在、删除按钮未被禁用', async () => {
    stubFetch({ exerciseSteps: [{ kind: 'network' }] });
    renderPage({ seed: seedExerciseDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }]) });

    await waitFor(() => {
      expect(screen.getByTestId('exercise-stale-notice')).toBeDefined();
    });
    expect(screen.getByText(EXERCISE_STALE_NOTICE)).toBeDefined();
    // 不遮挡、不禁用：旧记录照常可见可删
    expect(screen.getByTestId('exercise-delete-11')).toBeDefined();
    expect((screen.getByTestId('exercise-delete-11') as HTMLButtonElement).disabled).toBe(false);
  });

  it('★ 点「重新试试」重跑该查询，恢复后标记自动消失', async () => {
    stubFetch({
      exerciseSteps: [
        { kind: 'network' },
        { kind: 'ok', body: makeDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }], todayKey()) },
      ],
    });
    renderPage({ seed: seedExerciseDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }]) });

    await waitFor(() => {
      expect(screen.getByTestId('exercise-stale-notice')).toBeDefined();
    });

    fireEvent.click(screen.getByLabelText(`${COPY.staleDataRetry}同步运动记录`));

    await waitFor(() => {
      expect(screen.queryByTestId('exercise-stale-notice')).toBeNull();
    });
  });

  it('★ 业务错误（500）不挂「上次同步」标记（不把服务端问题说成网络问题）', async () => {
    stubFetch({
      exerciseSteps: [{ kind: 'business', status: 500, code: 'E_SERVER', message: '服务端在开小差，稍后我们再来一次' }],
    });
    const client = renderPage({
      seed: seedExerciseDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }]),
    });
    await waitForQueryError(client, queryKeys.exerciseDay(todayKey()));

    // 旧数据确实还在渲染（说明「有兜底值」这一半判据是满足的，只是不该归因成网络问题）
    expect(screen.getByTestId('exercise-delete-11')).toBeDefined();
    expect(screen.queryByTestId('exercise-stale-notice')).toBeNull();
  });

  it('★ 运动查询断网但本机没有旧数据 → 不挂标记（不指控一个不存在的展示）', async () => {
    stubFetch({ exerciseSteps: [{ kind: 'network' }] });
    const client = renderPage();
    await waitForQueryError(client, queryKeys.exerciseDay(todayKey()));

    expect(screen.getByText('今天还没有记录，散散步也算数')).toBeDefined();
    expect(screen.queryByTestId('exercise-stale-notice')).toBeNull();
  });

  it('★ 饮水查询断网 + 本机缓存有值 → 出现饮水标记，「+250ml」仍可点', async () => {
    writeLocalWater(1000);
    stubFetch({ waterSteps: [{ kind: 'network' }] });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('water-stale-notice')).toBeDefined();
    });
    expect(screen.getByText(WATER_STALE_NOTICE)).toBeDefined();
    // 数字确实来自兜底（1000），且操作未被禁用
    expect(screen.getByText(/1000/)).toBeDefined();
    const addButton = screen.getByText(`+${WATER_QUICK_ADD_ML}ml`) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
  });

  it('★ 饮水查询断网 + react-query 留存的上次结果 → 也出现饮水标记', async () => {
    stubFetch({ waterSteps: [{ kind: 'network' }] });
    renderPage({ seed: seedWaterDay(1500) });

    await waitFor(() => {
      expect(screen.getByTestId('water-stale-notice')).toBeDefined();
    });
    expect(screen.getByText(/1500/)).toBeDefined();
  });

  it('★ 饮水业务错误（500）不挂标记', async () => {
    writeLocalWater(1000);
    stubFetch({
      waterSteps: [{ kind: 'business', status: 500, code: 'E_SERVER', message: '服务端在开小差，稍后我们再来一次' }],
    });
    const client = renderPage();
    await waitForQueryError(client, queryKeys.waterDay(todayKey()));

    expect(screen.getByText(/1000/)).toBeDefined();
    expect(screen.queryByTestId('water-stale-notice')).toBeNull();
  });

  it('★ 饮水断网且无任何兜底值 → 不挂标记', async () => {
    stubFetch({ waterSteps: [{ kind: 'network' }] });
    const client = renderPage();
    await waitForQueryError(client, queryKeys.waterDay(todayKey()));

    expect(screen.getByText(/0 \/ 2000 ml/)).toBeDefined();
    expect(screen.queryByTestId('water-stale-notice')).toBeNull();
  });

  it('★ 两个查询各自失效：只有运动断网时，只出现运动那条（不互相串味）', async () => {
    stubFetch({
      // 运动断网、饮水正常 —— 两条标记的判据必须是两个独立查询
      exerciseSteps: [{ kind: 'network' }],
      waterSteps: [{ kind: 'ok', body: { date: todayKey(), totalMl: 500, goalMl: 2000, logs: [] } }],
    });
    renderPage({ seed: seedExerciseDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }]) });

    await waitFor(() => {
      expect(screen.getByTestId('exercise-stale-notice')).toBeDefined();
    });
    expect(screen.queryByTestId('water-stale-notice')).toBeNull();
  });

  it('★ 两条文案不得一字不差（同屏重复会被读成渲染重复、读屏指代不明）', async () => {
    stubFetch({
      exerciseSteps: [{ kind: 'network' }],
      waterSteps: [{ kind: 'network' }],
    });
    const client = seedExerciseDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }]);
    writeLocalWater(1000);
    renderPage({ seed: client });

    await waitFor(() => {
      expect(screen.getByTestId('exercise-stale-notice')).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.getByTestId('water-stale-notice')).toBeDefined();
    });
    expect(EXERCISE_STALE_NOTICE).not.toBe(WATER_STALE_NOTICE);
    // 各自的「重新试试」按钮可及名也要能区分（WCAG 2.5.3：以可见文案开头）
    expect(screen.getByLabelText(`${COPY.staleDataRetry}同步运动记录`)).toBeDefined();
    expect(screen.getByLabelText(`${COPY.staleDataRetry}同步饮水记录`)).toBeDefined();
  });

  it('★ 标记用中性配色（灰底灰字），不用红 / 不用警示色', async () => {
    stubFetch({
      exerciseSteps: [{ kind: 'network' }],
      waterSteps: [{ kind: 'network' }],
    });
    const client = seedExerciseDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }]);
    writeLocalWater(1000);
    renderPage({ seed: client });

    await waitFor(() => {
      expect(screen.getByTestId('exercise-stale-notice')).toBeDefined();
    });
    for (const testId of ['exercise-stale-notice', 'water-stale-notice']) {
      const node = screen.getByTestId(testId);
      expect(node.className).toContain('bg-slate-100');
      expect(node.className).toContain('text-slate-600');
      expect(node.className).not.toContain('red');
      expect(node.className).not.toContain('coral');
      expect(node.className).not.toContain('amber');
      // 不弹窗、不遮挡
      expect(node.getAttribute('role')).toBe('status');
      expect(node.getAttribute('aria-live')).toBe('polite');
    }
  });

  it('★ 文案红线：不指责、无新数字（NFR-11）', () => {
    for (const text of [EXERCISE_STALE_NOTICE, WATER_STALE_NOTICE]) {
      for (const banned of ['失败', '错误', '警告', '请重试', '注意']) {
        expect(text).not.toContain(banned);
      }
      // 不含任何数字（「3 分钟前的数据」这类相对时间是需要进 /why-numbers 的新数字）
      expect(/\d/.test(text)).toBe(false);
    }
  });
});

describe('③ 离线删除：入队不等于删除成功，文案必须是排队态', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetMemoryQueueForTest();
    window.localStorage.clear();
  });

  it('★ 离线删除 → 排队态措辞（不是「已经删掉了」），但仍乐观移除并入队', async () => {
    stubFetch({
      exerciseSteps: [
        {
          kind: 'ok',
          body: makeDay(
            [
              { id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 },
              { id: 12, activityName: '慢跑', minutes: 20, kcalBurned: 140 },
            ],
            todayKey(),
          ),
        },
      ],
      deleteStep: { kind: 'network' },
    });
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByTestId('exercise-delete-11')));

    await waitFor(() => {
      expect(screen.getByText(EXERCISE_DELETE_QUEUED)).toBeDefined();
    });
    // 关键：不得再出现完成态措辞
    expect(screen.queryByText(COPY.exerciseDeleted)).toBeNull();
    expect(EXERCISE_DELETE_QUEUED).not.toContain('已经删掉');

    // 乐观移除保留（用户体验需要）
    expect(screen.queryByTestId('exercise-delete-11')).toBeNull();
    expect(screen.getByText('140')).toBeDefined();

    const queued = await listQueuedRequests();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.path).toBe('/exercises/11');
    expect(queued[0]?.method).toBe('DELETE');
  });

  it('★ 排队态文案不承诺结果（无「一定 / 保证 / 成功」），也不指责', () => {
    for (const banned of ['一定', '保证', '成功', '已经删掉', '失败', '错误']) {
      expect(EXERCISE_DELETE_QUEUED).not.toContain(banned);
    }
  });

  it('在线删除成功仍是完成态（防止改过头，把真成功也说成待同步）', async () => {
    stubFetch({
      exerciseSteps: [
        {
          kind: 'ok',
          body: makeDay([{ id: 11, activityName: '快走', minutes: 30, kcalBurned: 90 }], todayKey()),
        },
      ],
      deleteStep: { kind: 'ok', body: { deleted: true } },
    });
    renderPage();

    fireEvent.click(await waitFor(() => screen.getByTestId('exercise-delete-11')));

    await waitFor(() => {
      expect(screen.getByText(COPY.exerciseDeleted)).toBeDefined();
    });
    expect(screen.queryByText(EXERCISE_DELETE_QUEUED)).toBeNull();
  });
});
