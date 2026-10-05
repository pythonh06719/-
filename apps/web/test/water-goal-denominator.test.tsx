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
 * → 联网前 `GET /water` 仍返回服务端的旧值（2200）→ 进度条分母按旧值算，而**同一屏**的
 * `WaterGoalCard` 输入框（走 helper）显示 2600 —— 两个数字自己打架，
 * `/why-numbers` ㉖ 的解释也变成「一句骗人的说明」。
 *
 * ## 本文件钉住的行为（**行为断言，不是文案断言**）
 *
 * 1. ★ 运动页：本机 2600 / 服务端 2200 → 分母按 **2600** 算（`ml（%）` 那一行 + 进度条
 *    的 `aria-valuenow` 同时对上）；
 * 2. ★ 看板：同一组数据 → 分母按 **2600** 算（毫升行 + 「目标 N 杯」都跟着变）；
 * 3. ★ 同屏一致：进度条分母 **等于** 输入框回显值（「同一屏两个数字打架」是缺陷正身，
 *    这里把两者绑成一条断言，改一处不绑另一处就红）；
 * 4. 反向对照 ①：本机**没有**值时**服务端层**胜出（防「永远读本机」的过度实现）；
 * 5. 反向对照 ②：本机与服务端**都没有**值时落到**默认兜底层** 2000（让三层各有专属断言）；
 * 6. 反向对照 ③：本机是**坏值**（超出 500–8000）时不生效，服务端层胜出。
 *
 * ## 断言强度自查
 *
 * 每条断言都锚在**由分母算出来的数字**上（`Math.round(1000 / 2600 * 100)` = 38%、
 * `/ 2200` = 45%、`/ 2000` = 50%；杯数 10 / 9 / 8），撤掉接法后这些值会同时变 ——
 * 断言随即转红。**没有**「页面上有某段文字」这种恒真断言。
 *
 * ## 三层取值必须两两不同（独立 QA 证伪的 P1，详见下方常量注释）
 *
 * 服务端层与默认兜底层的取值一旦相同，「这一层生效」就与「下一层兜底」产出同一个数，
 * 断言看着在区分、实际没区分。故本文件开头另有一组 `describe` 把
 * **取值 / 百分比 / 杯数三组都必须两两不同**这件事本身钉住 ——
 * 防止本文件将来再次退化成假绿。
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
// 护栏要比的是**生产实现自己算出来的数**，所以直接引入 `cupProgress` ——
// 它是 `Math.round(goal / ML_PER_CUP)` 的唯一真源。护栏自带一份公式副本的话，
// 哪天 `cupProgress` 改了取整方式，护栏会跟着一起错，就又变成假绿了。
import { cupProgress } from '@/lib/copy';
// 兜底层的真源。刻意从 `theme/tokens` 导入而不是写死 2000 ——
// 写死的话，改了默认值这条断言不会跟着动，就又变成一个「看着在断言、实际没断言」的值。
// 同时它天然保证「服务端取值 ≠ 兜底取值」这个前提被显式表达出来。
import { DEFAULT_WATER_GOAL_ML, WATER_ML_PER_CUP } from '@/theme/tokens';

/**
 * 三层取值必须**两两不同**，否则断言区分不了它们（QA 证伪的 P1）。
 *
 * `resolveWaterGoalMl()` 有三层：本机值 > 服务端 `goalMl` > `DEFAULT_WATER_GOAL_ML`。
 * 兜底层是**字面量 2000**（`src/theme/tokens.ts`），所以服务端值**绝不能也取 2000** ——
 * 两者字面相同，「服务端层胜出」与「默认层兜底」会产出同一个数，断言看着在区分、实际没区分。
 * 独立 QA 实测：把 helper 的服务端层删成 `return DEFAULT_WATER_GOAL_ML;`（helper 完全
 * 不再读服务端），在这种取值下**全部用例照样绿** —— 服务端层零覆盖。
 *
 * ## 为什么取 2200 而不是 2400
 *
 * 除了要躲开 2000（默认层），还必须与本机层 2600 在**两个派生维度**上都分得开：
 *
 * | 层 | 目标 | 百分比 `round(1000/g*100)` | 杯数 `round(g/250)` |
 * |---|---|---|---|
 * | 本机 | 2600 | 38% | 10 杯 |
 * | 服务端 | **2200** | **45%** | **9 杯** |
 * | 默认 | 2000 | 50% | 8 杯 |
 *
 * 取 2400 会在杯数上与 2600 撞车（`round(2600/250)` 与 `round(2400/250)` 都是 10），
 * 看板那条「目标 N 杯」的断言就又瞎了。2200 让百分比与杯数**两组都两两不同**。
 */
const TOTAL_ML = 1000;

/** 离线改过、尚未推送成功的本机目标。 */
const LOCAL_GOAL_ML = 2600;

/**
 * 服务端仍然是旧值（本机改动被标 dirty、还没推成功）。
 *
 * ⚠️ **刻意不等于 2000**（默认兜底层），也不等于 2600（本机层）—— 见上方三层取值表。
 */
const SERVER_GOAL_ML = 2200;

/** 按 LOCAL_GOAL_ML 算出的百分比（`Math.round(1000 / 2600 * 100)`）。 */
const PERCENT_BY_LOCAL = 38;

/** 按 SERVER_GOAL_ML 算出的百分比（`Math.round(1000 / 2200 * 100)`）—— 服务端层被忽略后就是这个值。 */
const PERCENT_BY_SERVER = 45;

/** 按默认兜底层（`DEFAULT_WATER_GOAL_ML` = 2000）算出的百分比 —— 两层都失效后落到这里。 */
const PERCENT_BY_DEFAULT = 50;

/** `Math.round(2600 / 250)` 杯 —— 「目标 10 杯」。 */
const GOAL_CUPS_BY_LOCAL = 10;

/** `Math.round(2200 / 250)` 杯 —— 「目标 9 杯」。 */
const GOAL_CUPS_BY_SERVER = 9;

/** `Math.round(2000 / 250)` 杯 —— 「目标 8 杯」。 */
const GOAL_CUPS_BY_DEFAULT = 8;

/**
 * 一杯 = 250 ml。**不写死**：从 `theme/tokens` 的 `WATER_ML_PER_CUP` 导入 ——
 * 它是 `lib/copy.ts` 里 `ML_PER_CUP` 的同一份真源（`copy.ts:1544` 直接引用它）。
 * 写死 250 的话，哪天改了一杯的容量，护栏会拿旧容量算出一个仍然「两两不同」的假结论。
 */
const ML_PER_CUP = WATER_ML_PER_CUP;

/**
 * 三层的取值与派生值必须两两不同 —— 否则断言会「看着在区分、实际没区分」。
 *
 * 这条断言本身就是为了**防止本文件再次退化成假绿**：将来谁把 `SERVER_GOAL_ML` 改回
 * 2000（= `DEFAULT_WATER_GOAL_ML`），或挑了个在杯数上与本机层撞车的值，这里立刻转红，
 * 而不是等到「helper 不读服务端了也没人发现」。
 *
 * ⚠️ `percent` / `cups` 两个字段是给**渲染断言**当期望值用的，以及给下面那条
 * 「派生值与常量一致」当被检查对象用的。**可区分性护栏一律不读它们** ——
 * 一律从 `goal` 现算。理由见 `assertDistinct` 上方的说明。
 */
const LAYERS = [
  { name: '本机层', goal: LOCAL_GOAL_ML, percent: PERCENT_BY_LOCAL, cups: GOAL_CUPS_BY_LOCAL },
  { name: '服务端层', goal: SERVER_GOAL_ML, percent: PERCENT_BY_SERVER, cups: GOAL_CUPS_BY_SERVER },
  { name: '默认兜底层', goal: DEFAULT_WATER_GOAL_ML, percent: PERCENT_BY_DEFAULT, cups: GOAL_CUPS_BY_DEFAULT },
] as const;

/** 派生值 + 它是哪一层的，供 `assertDistinct` 出错时点名。 */
interface Derived {
  /** 层的名字（出错信息里点名用）。 */
  name: string;
  /** 现算出来的数值。 */
  value: number;
  /** 给人看的写法，如 `10 杯`。 */
  text: string;
}

/**
 * 断言某个维度上三层**两两不同**，且出错时指名**是哪个维度、哪两层撞了**。
 *
 * ## 为什么不直接比 `LAYERS[i].cups`（独立 QA 证伪的 P1）
 *
 * 原来那两条护栏比的是 `LAYERS` 里**写死的常量**（`GOAL_CUPS_BY_DEFAULT = 8` 这种）。
 * 常量是上一轮人肉算好抄进去的，它跟 `goal` 之间没有任何因果关系 ——
 * 于是「常量两两不同」压根不能推出「派生值两两不同」。QA 实测的盲区窗口：
 *
 * | 注入 | 真实派生杯数 | 旧护栏读的常量 | 旧护栏 | 真相 |
 * |---|---|---|---|---|
 * | `DEFAULT_WATER_GOAL_ML` → 2500 | `2600→10` / `2200→9` / `2500→10` | `10 / 9 / 8` | **绿** | 10 与 10 已撞车 |
 *
 * 「三层的杯数两两不同」那条没红（它比的是三个写死常量，`Set.size === 3`），
 * 只有另一条「派生值与常量一致」误打误撞兜住了。
 *
 * 而那个兜底**不是防线**：将来有人改默认值时，最自然的动作就是顺手把常量也对齐
 * （`8 → 10`，这正是「派生值与常量不符」这条报错的建议修法）→ 两条一起转绿，
 * 而此时真撞车已经发生了。**两条护栏同时绿 ≠ 安全**，因为它们读的是同一个不变量。
 *
 * 所以这里改成从 `goal` 现算：撞了就一定红，与有没有人同步改常量无关。
 */
function assertDistinct(dimension: string, derived: readonly Derived[]): void {
  // 同一数值都出现在哪些层 —— 用来在失败信息里点名「哪两层撞了」。
  const namesByValue = new Map<number, string[]>();
  for (const item of derived) {
    namesByValue.set(item.value, [...(namesByValue.get(item.value) ?? []), item.name]);
  }
  const collisions = [...namesByValue.entries()].filter(([, names]) => names.length > 1);

  const all = derived.map((item) => `${item.name} ${item.text}`).join(' / ');
  const detail = collisions
    .map(([value, names]) => `${names.join(' 与 ')} 都算出「${value}」`)
    .join('；');

  expect(collisions.length, `${dimension}出现重复：${detail}。三层取值与派生值：${all}`).toBe(0);
}

describe('三层取值的可区分性（本文件自身的护栏）', () => {
  it('三层的目标值两两不同（否则「服务端层」与「默认层」无法区分）', () => {
    const goals = LAYERS.map((layer) => layer.goal);
    expect(new Set(goals).size, `目标值出现重复：${goals.join(' / ')}`).toBe(LAYERS.length);
  });

  it('三层的百分比两两不同（现算，不读写死常量）', () => {
    assertDistinct(
      '百分比',
      LAYERS.map((layer) => {
        const value = Math.round((TOTAL_ML / layer.goal) * 100);
        return { name: layer.name, value, text: `${value}%` };
      }),
    );
  });

  it('三层的杯数两两不同（现算，不读写死常量；2400 就会在这里撞上 2600）', () => {
    assertDistinct(
      '杯数',
      LAYERS.map((layer) => {
        // 取整口径与生产实现同源：`cupProgress` 的 `goalCups` 就是
        // `Math.round(goalMl / ML_PER_CUP)`（`copy.ts:1666`）。直接调它而不是
        // 在测试里重抄一遍公式 —— 公式改一处，两边一起动，不会各算各的。
        const value = cupProgress(layer.goal, layer.goal).goalCups;
        return { name: layer.name, value, text: `${value} 杯` };
      }),
    );
  });

  /**
   * `Math.floor` 维度：**证明它不适用**，而不是补一条永远绿的断言。
   *
   * 杯数在生产实现里有两个**互不相干**的维度，只有一个是「按目标算」的：
   *
   * | 字段 | 公式（`copy.ts:1661`） | 输入 | 会随三层变化吗 |
   * |---|---|---|---|
   * | `cups`（已喝） | `Math.floor(currentMl / 250)` | `currentMl` | ❌ 与 `goalMl` 无关 |
   * | `goalCups`（目标） | `Math.round(goalMl / 250)` | `goalMl` | ✅ 就是上面那条护栏 |
   *
   * `Math.floor` 只出现在 `cups` 上，输入是**已喝量**而不是 `goalMl`。QA 算出的
   * `floor(2200/250) === floor(2000/250) === 8` 确实是撞车，但**这个撞车当前没有任何
   * 消费者**：没有任何代码对 `goalMl` 取 floor，所以用户永远看不到这个数。
   *
   * 那要不要为它加一条护栏？**不加**。给一个生产代码里不存在的派生值写「两两不同」
   * 断言，等于把一条恒真断言钉进文件 —— 那正是本文件注释里一直在反感的「看着在断言、
   * 实际没断言」。真正该防的不是「floor 撞车」，而是**将来有人把目标杯数改成 floor**：
   * 那一刻 `floor(2200/250) === floor(2000/250) === 8` 才会真的咬到「目标 N 杯」那两条
   * 渲染断言。下一条就是防这个的。
   *
   * 这条断言顺带把上表的「与 `goalMl` 无关」**变成可执行的**：若哪天有人把 `goalMl`
   * 误接进 `cups`，本条立刻转红，注释与代码就不会各说各话。
   */
  it('已喝杯数走 floor，且只由 currentMl 决定（故不参与三层可区分性）', () => {
    const byLayer = LAYERS.map((layer) => cupProgress(TOTAL_ML, layer.goal).cups);
    expect(
      new Set(byLayer).size,
      `已喝杯数不该随目标层变化（它只吃 currentMl）：${LAYERS.map((l, i) => `${l.name} ${byLayer[i]} 杯`).join(' / ')}`,
    ).toBe(1);
    // floor 口径本身也钉住：已喝 1000ml = 4 整杯（`floor(1000/250)`，不足一整杯不算）。
    expect(byLayer[0]).toBe(Math.floor(TOTAL_ML / ML_PER_CUP));
  });

  it('目标杯数走 round 而非 floor（若哪天改成 floor，2200 与 2000 会撞成 8 杯）', () => {
    for (const layer of LAYERS) {
      const { goalCups } = cupProgress(layer.goal, layer.goal);
      expect(
        goalCups,
        `${layer.name} 目标杯数应等于 round(${layer.goal}/${ML_PER_CUP})；` +
          `若实现改成了 floor，${LAYERS.map((l) => `floor(${l.goal}/${ML_PER_CUP})=${Math.floor(l.goal / ML_PER_CUP)}`).join(' / ')} 会撞车`,
      ).toBe(Math.round(layer.goal / ML_PER_CUP));
    }
  });

  it('派生值与常量一致（改 TOTAL_ML / ML_PER_CUP 时不会留下过期的硬编码期望）', () => {
    for (const layer of LAYERS) {
      expect(layer.percent, `${layer.name} 百分比常量与实际算的不符`).toBe(
        Math.round((TOTAL_ML / layer.goal) * 100),
      );
      expect(layer.cups, `${layer.name} 杯数常量与实际算的不符`).toBe(Math.round(layer.goal / ML_PER_CUP));
    }
  });
});

function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) } as unknown as Response;
}

/** 看板载荷：服务端仍报旧目标（本机改动未推送成功）。 */
function dashboardPayload(serverGoalMl: number | undefined): DashboardResponse {
  return {
    date: todayKey(),
    goal: null,
    budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
    intakeKcal: 0,
    burnedKcal: 0,
    remainingKcal: 1500,
    progressRatio: 0,
    waterMl: TOTAL_ML,
    waterGoalMl: serverGoalMl as number,
    miniTrend: [],
    encouragement: '今天也照顾好自己',
    warnings: [],
  };
}

/**
 * fetch 桩。
 *
 * `online` 恒为真 —— 目的是**只留「该由哪一层胜出」这一个变量**：请求成功、拿到的就是旧目标，
 * 于是「分母仍按服务端旧值算」不能被「请求失败 /没加载」解释掉。
 *
 * @param serverGoalMl 服务端返回的目标；传 `undefined` 模拟「服务端没给」（未加载 / 缺字段），
 *                     用来让**默认兜底层**也能被单独钉住。
 */
function stubFetch(serverGoalMl: number | undefined = SERVER_GOAL_ML): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/water')) {
        return ok({ date: todayKey(), totalMl: TOTAL_ML, goalMl: serverGoalMl, logs: [] });
      }
      if (url.includes('/api/exercises')) {
        return ok({ date: todayKey(), logs: [], totalKcal: 0 });
      }
      if (url.includes('/api/dashboard')) {
        return ok(dashboardPayload(serverGoalMl));
      }
      if (url.includes('/api/profile')) {
        return ok({
          profile: null,
          goal: { startWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 },
          budget: { intakeRecommended: 1500, bmr: 1320, tdee: 1584 },
        });
      }
      if (url.includes('/api/users/settings')) {
        return ok({ waterGoalMl: serverGoalMl });
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
  it('★ 运动页：本机存 2600 / 服务端返回 2200 → 进度按 2600 算（不是 2200、也不是默认的 2000）', async () => {
    seedLocalGoal(LOCAL_GOAL_ML);
    stubFetch();

    const { container } = renderWithClient(<ExercisePage />);

    // 等服务端旧目标真的到货（否则「按本机算」可能只是因为还没加载）
    await waitFor(() => {
      expect(exerciseWaterLine(container)).toContain(String(LOCAL_GOAL_ML));
    });

    // 分母：本机 2600，不是服务端的 2200、也不是默认兜底的 2000
    expect(exerciseWaterLine(container)).toBe(`${TOTAL_ML} / ${LOCAL_GOAL_ML} ml（${PERCENT_BY_LOCAL}%）`);
    expect(exerciseWaterLine(container)).not.toContain(String(SERVER_GOAL_ML));

    // 进度条本身（`role="progressbar"` 的 aria-valuenow）也按同一个分母算 ——
    // 只看文字不看得条，两处可能各算各的。
    const bar = screen.getByLabelText('今日饮水进度');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(PERCENT_BY_LOCAL);
    expect(Number(bar.getAttribute('aria-valuenow'))).not.toBe(PERCENT_BY_SERVER);
    expect(Number(bar.getAttribute('aria-valuenow'))).not.toBe(PERCENT_BY_DEFAULT);
  });

  it('★ 看板：同一组数据 → 毫升行与「目标 N 杯」都按 2600 算', async () => {
    seedLocalGoal(LOCAL_GOAL_ML);
    stubFetch();

    const { container } = renderWithClient(<DashboardPage />);

    await waitFor(() => {
      expect(dashboardWaterLine(container)).toBe(`${TOTAL_ML} / ${LOCAL_GOAL_ML} ml`);
    });

    // 杯数是同一个分母的派生显示（250ml = 1 杯）。三层给出三个不同的杯数：
    // 2600 → 10 杯 / 2200 → 9 杯 / 2000 → 8 杯。逐个排除，缺哪层都红。
    expect(screen.getByText(`第 ${TOTAL_ML / 250} 杯 / 目标 ${GOAL_CUPS_BY_LOCAL} 杯`)).toBeInTheDocument();
    expect(screen.queryByText(`目标 ${GOAL_CUPS_BY_SERVER} 杯`)).toBeNull();
    expect(screen.queryByText(`目标 ${GOAL_CUPS_BY_DEFAULT} 杯`)).toBeNull();
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
    // 不 seed 本机值 → helper 必须落到服务端层。
    // 这一条同时是**服务端层的护栏**：把 helper 的服务端层删成
    // `return DEFAULT_WATER_GOAL_ML;`（helper 完全不读服务端）时，它会转红。
    stubFetch();

    const { container } = renderWithClient(<ExercisePage />);

    await waitFor(() => {
      expect(exerciseWaterLine(container)).toContain(String(SERVER_GOAL_ML));
    });
    expect(exerciseWaterLine(container)).toBe(`${TOTAL_ML} / ${SERVER_GOAL_ML} ml（${PERCENT_BY_SERVER}%）`);
    expect(exerciseWaterLine(container)).not.toContain(String(LOCAL_GOAL_ML));
    // 关键：必须**不是**默认兜底的值 —— 否则「服务端层」与「默认层」根本没被区分开。
    expect(exerciseWaterLine(container)).not.toContain(String(DEFAULT_WATER_GOAL_ML));
  });

  it('反向对照：服务端也没给目标时，落到默认兜底 2000（第三层单独钉住）', async () => {
    // 本机无值 + 服务端无值 → 只能是 `DEFAULT_WATER_GOAL_ML`。
    // 补这一条是为了让**三层各自都有专属断言**：缺了它，默认层就只是「前两条的反面」，
    // 没人真正验证过「两层都无效时确实落到 2000」。
    stubFetch(undefined);

    const { container } = renderWithClient(<ExercisePage />);

    await waitFor(() => {
      expect(exerciseWaterLine(container)).toBe(
        `${TOTAL_ML} / ${DEFAULT_WATER_GOAL_ML} ml（${PERCENT_BY_DEFAULT}%）`,
      );
    });
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
