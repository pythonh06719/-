/**
 * QA 独立证伪测试（严过关）—— 补完三项 R3.8 / R11.5 / R11.6。
 *
 * ⚠️ 本文件是**验证方**写的，目的不是复跑工程师的 `r11x.e2e.test.ts`，
 * 而是**证伪**它没覆盖到的口径。重点：
 *
 * 1. **A · sortOrder 分配口径（AC-3.8.5）**
 *    工程师只在 `create()` 之后做过「反转 → 再记 1 条」的回归，
 *    `quickAdd` / `applyCombo` 两处的用例**没有前置 reorder** ——
 *    而 `nextSortOrder()` 是「本餐 max + 1」，只有在**拖过顺序之后**才可能暴露漏接。
 *    本文件对**三种写入方式各做一次**完整的「记 → 反转 → 再记」。
 *
 * 2. **B · 常吃榜出现天数口径（QR-1）**
 *    工程师的用例只断言「同一天记 3 次 → 不进榜」（dayCount 1 或 2 都会被门槛挡住），
 *    **无法区分「天数」与「次数」**。本文件让同一个食物「每天记 2 次、连记 3 天」：
 *    按天数应为 **3**，按次数会是 **6** —— 这才真正证伪/证实 QR-1。
 *
 * 3. **C · 越权与幂等**：他人 id → 404；不存在 id → 400 + `fields.orderedIds`；
 *    同一 payload 重复提交两次，DB 终态一致。
 *
 * 运行机制同 `r11x.e2e.test.ts`（加载 `dist/**` 编译产物 + 真实 SQLite）。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

const require = createRequire(import.meta.url);

const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
const request = require('supertest') as unknown as typeof import('supertest');
const core = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const { toLocalDateKey } = core;

const API = '/api';
/** 验证方专用账号（与工程师的 e2e-r11x-* 完全隔离，避免榜单互相污染）。 */
const QA_USER = 'qa-r11x-falsify@qinglife.test';
const QA_USER_2 = 'qa-r11x-falsify-other@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let token = '';
let tokenOther = '';

/** 今天（服务端本地日粒度）。 */
const today = toLocalDateKey(new Date());

/** 取一个远隔离的日期，避免与其它用例的同一天数据互相干扰。 */
function day(offset: number): string {
  const [year, month, date] = today.slice(0, 10).split('-').map((part) => Number(part));
  const base = new Date(year ?? 2026, (month ?? 1) - 1, date ?? 1);
  base.setDate(base.getDate() + offset);
  return toLocalDateKey(base);
}

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

async function login(email: string): Promise<string> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') {
    throw new Error(`未取到 ${email} 的验证码回显`);
  }
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (verified.body.data as { accessToken: string }).accessToken;
}

/** 记一条自定义记录（`POST /meals`）。 */
async function createMeal(date: string, mealType: string, customName: string): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/meals`)
    .set(auth(token))
    .send({ loggedDate: date, mealType, customName, customKcal: 100 })
    .expect(200);
  expect(res.body.error).toBeNull();
  return (res.body.data.entry as { id: number }).id;
}

/** 快速加卡（`POST /meals/quick-add`）。 */
async function quickAdd(date: string, mealType: string, customName: string): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/meals/quick-add`)
    .set(auth(token))
    .send({ loggedDate: date, mealType, customName, customKcal: 50 })
    .expect(200);
  expect(res.body.error).toBeNull();
  return (res.body.data.entry as { id: number }).id;
}

/** 建一个 2 条自定义条目的套餐并应用到指定日/餐，返回新建记录的 id 列表。 */
async function applyCombo(date: string, mealType: string, nameA: string, nameB: string): Promise<number[]> {
  const created = await request(server as never)
    .post(`${API}/meal-combos`)
    .set(auth(token))
    .send({
      name: `QA-套餐-${date}-${mealType}-${nameA}`,
      mealType,
      items: [
        { customName: nameA, kcal: 100 },
        { customName: nameB, kcal: 120 },
      ],
    })
    .expect(200);
  const comboId = (created.body.data as { id: number }).id;

  const applied = await request(server as never)
    .post(`${API}/meal-combos/${comboId}/apply`)
    .set(auth(token))
    .send({ loggedDate: date, mealType })
    .expect(200);
  return (applied.body.data as { entries: Array<{ id: number }> }).entries.map((entry) => entry.id);
}

/** 取某日某餐的条目（按服务端顺序）。 */
async function logsOf(
  date: string,
  mealType: string,
): Promise<Array<{ id: number; customName: string | null; sortOrder: number; kcal: number }>> {
  const res = await request(server as never).get(`${API}/meals`).query({ date }).set(auth(token)).expect(200);
  const groups = (res.body.data as {
    groups: Array<{
      mealType: string;
      logs: Array<{ id: number; customName: string | null; sortOrder: number; kcal: number }>;
    }>;
  }).groups;
  return groups.find((group) => group.mealType === mealType)?.logs ?? [];
}

async function reorder(
  body: { loggedDate: string; mealType: string; orderedIds: number[] },
  useToken = token,
): Promise<{ status: number; body: any }> {
  const res = await request(server as never)
    .patch(`${API}/meals/reorder`)
    .set(auth(useToken))
    .send(body);
  return { status: res.status, body: res.body };
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  for (const email of [QA_USER, QA_USER_2]) {
    await prisma.authVerificationCode.deleteMany({ where: { email } });
    await prisma.user.deleteMany({ where: { email } });
  }

  token = await login(QA_USER);
  tokenOther = await login(QA_USER_2);
});

afterAll(async () => {
  if (prisma !== undefined) {
    for (const email of [QA_USER, QA_USER_2]) {
      await prisma.authVerificationCode.deleteMany({ where: { email } });
      await prisma.user.deleteMany({ where: { email } });
    }
  }
  if (app !== undefined) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// A · sortOrder 服务端分配（AC-3.8.5）—— 三种写入方式 × 「拖过顺序之后再记」
// ---------------------------------------------------------------------------

describe('A · sortOrder 分配口径（QA 独立证伪）', () => {
  it('A1 · 反转后再用 POST /meals 记 1 条 → 新条排最后', async () => {
    const date = day(-40);
    const a = await createMeal(date, 'lunch', 'QA-A1-a');
    const b = await createMeal(date, 'lunch', 'QA-A1-b');
    const c = await createMeal(date, 'lunch', 'QA-A1-c');
    expect((await logsOf(date, 'lunch')).map((log) => log.sortOrder)).toEqual([0, 1, 2]);

    await reorder({ loggedDate: date, mealType: 'lunch', orderedIds: [c, b, a] });
    expect((await logsOf(date, 'lunch')).map((log) => log.customName)).toEqual([
      'QA-A1-c',
      'QA-A1-b',
      'QA-A1-a',
    ]);

    const d = await createMeal(date, 'lunch', 'QA-A1-d');
    const logs = await logsOf(date, 'lunch');
    expect(logs.map((log) => log.customName)).toEqual(['QA-A1-c', 'QA-A1-b', 'QA-A1-a', 'QA-A1-d']);
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(logs[logs.length - 1]?.id).toBe(d);
  });

  /**
   * ★ 工程师没覆盖的一处：`POST /meals/quick-add` **在 reorder 之后**是否仍走 max+1。
   * 若 `quickAdd()` 漏接 `nextSortOrder()`，这里会退化成 0 → 新条插到最前。
   */
  it('A2 · 反转后再用 POST /meals/quick-add 记 1 条 → 新条排最后', async () => {
    const date = day(-41);
    const a = await createMeal(date, 'dinner', 'QA-A2-a');
    const b = await createMeal(date, 'dinner', 'QA-A2-b');
    const c = await createMeal(date, 'dinner', 'QA-A2-c');

    await reorder({ loggedDate: date, mealType: 'dinner', orderedIds: [c, a, b] });
    expect((await logsOf(date, 'dinner')).map((log) => log.customName)).toEqual([
      'QA-A2-c',
      'QA-A2-a',
      'QA-A2-b',
    ]);

    const d = await quickAdd(date, 'dinner', 'QA-A2-d');
    const logs = await logsOf(date, 'dinner');
    expect(logs.map((log) => log.customName)).toEqual(['QA-A2-c', 'QA-A2-a', 'QA-A2-b', 'QA-A2-d']);
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(logs[logs.length - 1]?.id).toBe(d);
  });

  /**
   * ★ 第二处未覆盖：`POST /meal-combos/:id/apply` **在 reorder 之后**是否仍走 max+1。
   * 若 `applyCombo()` 沿用模板 `item.sortOrder`（0、1），两条会插到最前面。
   */
  it('A3 · 反转后再用 POST /meal-combos/:id/apply 记 2 条 → 排在最后', async () => {
    const date = day(-42);
    const a = await createMeal(date, 'breakfast', 'QA-A3-a');
    const b = await createMeal(date, 'breakfast', 'QA-A3-b');
    const c = await createMeal(date, 'breakfast', 'QA-A3-c');

    await reorder({ loggedDate: date, mealType: 'breakfast', orderedIds: [b, c, a] });
    expect((await logsOf(date, 'breakfast')).map((log) => log.customName)).toEqual([
      'QA-A3-b',
      'QA-A3-c',
      'QA-A3-a',
    ]);

    const ids = await applyCombo(date, 'breakfast', 'QA-A3-甲', 'QA-A3-乙');
    expect(ids).toHaveLength(2);

    const logs = await logsOf(date, 'breakfast');
    expect(logs.map((log) => log.customName)).toEqual([
      'QA-A3-b',
      'QA-A3-c',
      'QA-A3-a',
      'QA-A3-甲',
      'QA-A3-乙',
    ]);
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it('A4 · 跨餐移动后，源餐与目标餐各自新增都排最后', async () => {
    const date = day(-43);
    const x = await createMeal(date, 'lunch', 'QA-A4-x');
    await createMeal(date, 'lunch', 'QA-A4-y');
    await createMeal(date, 'lunch', 'QA-A4-z');
    await createMeal(date, 'snack', 'QA-A4-s1');

    // 把 lunch 的第一条移到 snack（追加到目标餐末尾）
    await reorder({ loggedDate: date, mealType: 'snack', orderedIds: [(await logsOf(date, 'snack'))[0]?.id as number, x] });

    // 源餐 compact 为 0..n-1
    expect((await logsOf(date, 'lunch')).map((log) => log.sortOrder)).toEqual([0, 1]);
    const lunchNew = await createMeal(date, 'lunch', 'QA-A4-lunch-new');
    const lunchLogs = await logsOf(date, 'lunch');
    expect(lunchLogs[lunchLogs.length - 1]?.id).toBe(lunchNew);
    expect(lunchLogs.map((log) => log.sortOrder)).toEqual([0, 1, 2]);

    // 目标餐同样：新增排最后
    const snackNew = await createMeal(date, 'snack', 'QA-A4-snack-new');
    const snackLogs = await logsOf(date, 'snack');
    expect(snackLogs[snackLogs.length - 1]?.id).toBe(snackNew);
    expect(snackLogs.map((log) => log.sortOrder)).toEqual([0, 1, 2]);
  });

  it('A5 · 幂等：同一 payload 连续提交两次，DB 终态一致', async () => {
    const date = day(-44);
    const a = await createMeal(date, 'snack', 'QA-A5-a');
    const b = await createMeal(date, 'snack', 'QA-A5-b');
    const c = await createMeal(date, 'snack', 'QA-A5-c');

    const payload = { loggedDate: date, mealType: 'snack', orderedIds: [c, a, b] };
    const first = await reorder(payload);
    expect(first.status).toBe(200);
    const afterFirst = (await logsOf(date, 'snack')).map((log) => `${log.id}:${log.sortOrder}`);

    const second = await reorder(payload);
    expect(second.status).toBe(200);
    const afterSecond = (await logsOf(date, 'snack')).map((log) => `${log.id}:${log.sortOrder}`);
    expect(afterSecond).toEqual(afterFirst);
    // 第二次无实际变化 → updated 为空（只更新变化的行）
    expect(second.body.data.updated).toEqual([]);

    // 再追加一条，仍然排最后（幂等没有把序列搞乱）
    const d = await createMeal(date, 'snack', 'QA-A5-d');
    const logs = await logsOf(date, 'snack');
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(logs[logs.length - 1]?.id).toBe(d);
  });

  it('A6 · 越权：他人的 meal id → 404 E_NOTFOUND_MEAL', async () => {
    const date = day(-45);
    const mine = await createMeal(date, 'lunch', 'QA-A6-mine');
    const res = await reorder({ loggedDate: date, mealType: 'lunch', orderedIds: [mine] }, tokenOther);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_MEAL');
  });

  it('A6b · 混合（自己的 + 他人的）→ 仍为 404，不给部分成功', async () => {
    const date = day(-46);
    const mine = await createMeal(date, 'lunch', 'QA-A6b-mine');
    // 拿一个确实存在、但不属于自己的 id：由另一个账号建一条
    const otherRes = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenOther))
      .send({ loggedDate: date, mealType: 'lunch', customName: 'QA-A6b-other', customKcal: 10 })
      .expect(200);
    const foreign = (otherRes.body.data.entry as { id: number }).id;

    const res = await reorder({ loggedDate: date, mealType: 'lunch', orderedIds: [mine, foreign] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_MEAL');
  });

  it('A7 · 不存在的 id → 400 E_VALID_INPUT，fields.orderedIds 指明是哪几个', async () => {
    const res = await reorder({ loggedDate: day(-47), mealType: 'lunch', orderedIds: [987000001, 987000002] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    const field = String(res.body.error.fields?.orderedIds);
    expect(field).toContain('987000001');
    expect(field).toContain('987000002');
  });

  it('A8 · 空数组 → 200 no-op', async () => {
    const res = await reorder({ loggedDate: day(-48), mealType: 'lunch', orderedIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: [] });
  });

  it('A9 · 重复 id 去重 → 结果确定且不报错', async () => {
    const date = day(-49);
    const a = await createMeal(date, 'dinner', 'QA-A9-a');
    const b = await createMeal(date, 'dinner', 'QA-A9-b');
    const res = await reorder({ loggedDate: date, mealType: 'dinner', orderedIds: [b, b, a, a] });
    expect(res.status).toBe(200);
    expect((await logsOf(date, 'dinner')).map((log) => log.customName)).toEqual(['QA-A9-b', 'QA-A9-a']);
    expect((await logsOf(date, 'dinner')).map((log) => log.sortOrder)).toEqual([0, 1]);
  });

  /** K14：DTO 不接受 sortOrder，客户端传了也被静默剥离。 */
  it('A10 · reorder DTO 不接受 sortOrder：传入不影响服务端分配', async () => {
    const date = day(-50);
    const a = await createMeal(date, 'lunch', 'QA-A10-a');
    const b = await createMeal(date, 'lunch', 'QA-A10-b');
    const res = await request(server as never)
      .patch(`${API}/meals/reorder`)
      .set(auth(token))
      .send({ loggedDate: date, mealType: 'lunch', orderedIds: [b, a], sortOrder: 42 })
      .expect(200);
    // 剥离生效：结果仍是按 orderedIds 下标赋 0 / 1
    expect((await logsOf(date, 'lunch')).map((log) => log.sortOrder)).toEqual([0, 1]);
    expect((res.body.data as { updated: unknown[] }).updated).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B · 常吃榜「出现天数」口径（QR-1）
// ---------------------------------------------------------------------------

describe('B · 常吃榜出现天数口径（QA 独立证伪）', () => {
  /**
   * ★ 核心证伪点：同一个食物「每天记 2 次、连记 3 天」。
   * - 按**出现天数** → dayCount = 3 ✅
   * - 按**出现次数** → dayCount = 6 ❌
   * 工程师的用例只做到「同一天记 3 次 → 不进榜」，1 与 2 都会被门槛挡住，区分不出来。
   */
  it('B1 · 每天记 2 次、连记 3 天 → dayCount 为 3（不是 6）', async () => {
    const name = 'QA-B1-每天两次';
    for (const delta of [-2, -1, 0]) {
      await createMeal(day(delta), 'lunch', name);
      await createMeal(day(delta), 'dinner', name);
    }

    const res = await request(server as never)
      .get(`${API}/foods/top`)
      .query({ days: 90, limit: 12 })
      .set(auth(token))
      .expect(200);
    const data = res.body.data as { days: number; items: Array<{ name: string; dayCount: number }> };

    const hit = data.items.find((item) => item.name === name);
    expect(hit).toBeDefined();
    expect(hit?.dayCount).toBe(3);
  });

  it('B2 · 只出现 2 天 → 不进榜（门槛 3 天，整块隐藏）', async () => {
    const name = 'QA-B2-只有两天';
    for (const delta of [-1, 0]) {
      await createMeal(day(delta), 'snack', name);
    }
    const res = await request(server as never).get(`${API}/foods/top`).set(auth(token)).expect(200);
    const items = (res.body.data as { items: Array<{ name: string }> }).items;
    expect(items.find((item) => item.name === name)).toBeUndefined();
  });

  it('B3 · 默认窗口 90 天、上限 12 条，且窗口外的记录不计入', async () => {
    const res = await request(server as never).get(`${API}/foods/top`).set(auth(token)).expect(200);
    const data = res.body.data as { days: number; items: Array<{ name: string; dayCount: number }> };
    expect(data.days).toBe(90);
    expect(data.items.length).toBeLessThanOrEqual(12);
    // 降序
    const counts = data.items.map((item) => item.dayCount);
    expect([...counts].sort((left, right) => right - left)).toEqual(counts);

    // 窗口外（-120 天）记满 3 天也不应进榜
    const outside = 'QA-B3-窗口外';
    for (const delta of [-122, -121, -120]) {
      await createMeal(day(delta), 'lunch', outside);
    }
    const again = await request(server as never).get(`${API}/foods/top`).set(auth(token)).expect(200);
    const items2 = (again.body.data as { items: Array<{ name: string }> }).items;
    expect(items2.find((item) => item.name === outside)).toBeUndefined();
  });

  it('B4 · 榜单条目不含任何营养字段（只给频次，AC-11.5.3）', async () => {
    const res = await request(server as never).get(`${API}/foods/top`).set(auth(token)).expect(200);
    const items = (res.body.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['dayCount', 'food', 'foodItemId', 'name']);
    }
  });

  it('B5 · 数据不足 → items 为空数组（不是 null / 不是缺字段）', async () => {
    const res = await request(server as never).get(`${API}/foods/top`).set(auth(tokenOther)).expect(200);
    const data = res.body.data as { days: number; items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D · 记录概览（R11.6）
// ---------------------------------------------------------------------------

describe('D · GET /api/data/overview（QA 独立证伪）', () => {
  it('固定 6 行、顺序固定、wins 恒 0', async () => {
    const res = await request(server as never).get(`${API}/data/overview`).set(auth(token)).expect(200);
    const rows = (res.body.data as {
      rows: Array<{ key: string; count: number; firstDate: string | null; lastDate: string | null }>;
    }).rows;
    expect(rows.map((row) => row.key)).toEqual([
      'weights',
      'meals',
      'exercises',
      'habits',
      'water',
      'wins',
    ]);
    expect(rows.find((row) => row.key === 'wins')).toEqual({
      key: 'wins',
      count: 0,
      firstDate: null,
      lastDate: null,
    });
  });

  it('日期一律 YYYY-MM-DD（体重走 loggedAt 也须截断）', async () => {
    const res = await request(server as never).get(`${API}/data/overview`).set(auth(token)).expect(200);
    const rows = (res.body.data as {
      rows: Array<{ key: string; firstDate: string | null; lastDate: string | null }>;
    }).rows;
    for (const row of rows) {
      for (const value of [row.firstDate, row.lastDate]) {
        if (value !== null) {
          expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
    }
  });
});
