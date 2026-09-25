/**
 * R11x / R3.8 端到端测试（vitest + supertest，真实启动 Nest 应用 + 真实 SQLite）。
 *
 * 覆盖本轮三项补完：
 * - **R3.8** `PATCH /api/meals/reorder`：餐内反转 / 跨餐移动 / 幂等 / 空数组 /
 *   越权 404 / 不存在 id 400 / 日期不匹配 400；
 *   **★ 核心回归（AC-3.8.5）**：「记 3 条 → 反转顺序 → 再记 1 条 → 断言新的一条排在最后」；
 *   并验证 `create` / `quickAdd` / `applyCombo` **三处**都按服务端 max+1 分配。
 * - **R11.5** `GET /api/foods/top`：出现天数口径（同一天记 3 次只算 1 天）、
 *   < 3 天整块隐藏、参数越界 400、跨用户隔离。
 * - **R11.6** `GET /api/data/overview`：固定 6 行、`wins` 恒 0。
 *
 * ⚠️ 与 `api.e2e.test.ts` 同机制：**加载 `dist/**` 编译产物**（esbuild 不生成
 * NestJS 依赖注入所需的装饰器元数据），详见该文件顶部说明。
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
const USER_A = 'e2e-r11x-a@qinglife.test';
const USER_B = 'e2e-r11x-b@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenA = '';
let tokenB = '';

/** 今天（服务端本地日粒度）。 */
const today = toLocalDateKey(new Date());

/** `YYYY-MM-DD` 加减天数（本地时区）。 */
function shiftDays(from: string, delta: number): string {
  const [year, month, day] = from.slice(0, 10).split('-').map((part) => Number(part));
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + delta);
  return toLocalDateKey(date);
}

/** 认证头。 */
function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 登录（自用模式回显验证码，避免依赖日志抓取）。 */
async function login(email: string): Promise<string> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') {
    throw new Error(`未取到 ${email} 的验证码回显（请确认 AUTH_LOG_CODE=true）`);
  }
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (verified.body.data as { accessToken: string }).accessToken;
}

/** 记一条自定义记录（走 `POST /meals` 的 custom 分支）。 */
async function createMeal(
  token: string,
  input: { loggedDate: string; mealType: string; customName: string; customKcal?: number },
): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/meals`)
    .set(auth(token))
    .send({
      loggedDate: input.loggedDate,
      mealType: input.mealType,
      customName: input.customName,
      customKcal: input.customKcal ?? 100,
    })
    .expect(200);
  expect(res.body.error).toBeNull();
  return (res.body.data.entry as { id: number }).id;
}

/** 快速加卡（走 `POST /meals/quick-add`）。 */
async function quickAdd(
  token: string,
  input: { loggedDate: string; mealType: string; customName: string },
): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/meals/quick-add`)
    .set(auth(token))
    .send({ loggedDate: input.loggedDate, mealType: input.mealType, customName: input.customName, customKcal: 50 })
    .expect(200);
  expect(res.body.error).toBeNull();
  return (res.body.data.entry as { id: number }).id;
}

/** 取某日某餐的条目（按服务端顺序）。 */
async function logsOf(token: string, date: string, mealType: string): Promise<Array<{ id: number; customName: string | null; sortOrder: number; kcal: number; mealType: string }>> {
  const res = await request(server as never)
    .get(`${API}/meals`)
    .query({ date })
    .set(auth(token))
    .expect(200);
  const groups = (res.body.data as { groups: Array<{ mealType: string; logs: Array<{ id: number; customName: string | null; sortOrder: number; kcal: number; mealType: string }> }> }).groups;
  return groups.find((group) => group.mealType === mealType)?.logs ?? [];
}

/** 取该日全部条目。 */
async function allLogs(token: string, date: string): Promise<Array<{ id: number; customName: string | null; sortOrder: number; kcal: number; mealType: string }>> {
  const res = await request(server as never)
    .get(`${API}/meals`)
    .query({ date })
    .set(auth(token))
    .expect(200);
  const groups = (res.body.data as { groups: Array<{ logs: Array<{ id: number; customName: string | null; sortOrder: number; kcal: number; mealType: string }> }> }).groups;
  return groups.flatMap((group) => group.logs);
}

/** 提交一次排序。 */
async function reorder(
  token: string,
  body: { loggedDate: string; mealType: string; orderedIds: number[] },
): Promise<{ status: number; body: Record<string, never> | any }> {
  const res = await request(server as never).patch(`${API}/meals/reorder`).set(auth(token)).send(body);
  return { status: res.status, body: res.body };
}

beforeAll(async () => {
  // 自用模式：让 `/auth/send-code` 回显验证码（不依赖 .env，避免假阴性）
  process.env.AUTH_LOG_CODE = 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // 全局前缀在 `main.ts` 里设置，测试需自己补上（与 `api.e2e.test.ts` 一致）
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });

  tokenA = await login(USER_A);
  tokenB = await login(USER_B);
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

describe('R3.8 · PATCH /api/meals/reorder', () => {
  it('餐内顺序完全反转 → 服务端顺序反转（AC-3.8.3）', async () => {
    const a = await createMeal(tokenA, { loggedDate: today, mealType: 'dinner', customName: 'R38-反转-A' });
    const b = await createMeal(tokenA, { loggedDate: today, mealType: 'dinner', customName: 'R38-反转-B' });
    const c = await createMeal(tokenA, { loggedDate: today, mealType: 'dinner', customName: 'R38-反转-C' });

    // 新增即分配 0 / 1 / 2（服务端 max+1）
    expect((await logsOf(tokenA, today, 'dinner')).map((log) => log.sortOrder)).toEqual([0, 1, 2]);

    const res = await reorder(tokenA, { loggedDate: today, mealType: 'dinner', orderedIds: [c, b, a] });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();

    const logs = await logsOf(tokenA, today, 'dinner');
    expect(logs.filter((log) => [a, b, c].includes(log.id)).map((log) => log.customName)).toEqual([
      'R38-反转-C',
      'R38-反转-B',
      'R38-反转-A',
    ]);
    expect(logs.filter((log) => [a, b, c].includes(log.id)).map((log) => log.sortOrder)).toEqual([0, 1, 2]);
  });

  /**
   * ★ 本轮最容易漏的回归（AC-3.8.5）：
   * 「记 3 条 → 反转顺序 → 再记 1 条 → 断言新的那条排在最后」。
   * 漏掉服务端 `nextSortOrder()` 时，新的一条会拿到 0 而插到最前面 ——
   * 且**只有拖过顺序之后才复现**，全新用户测试完全测不出来。
   */
  it('★ 拖过顺序之后再记 1 条 → 新的那条排在最后（AC-3.8.5 核心回归）', async () => {
    const date = shiftDays(today, -1); // 独立的一天，避免与上面的用例互相干扰
    const a = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-新条-A' });
    const b = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-新条-B' });
    const c = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-新条-C' });

    // 反转
    await reorder(tokenA, { loggedDate: date, mealType: 'lunch', orderedIds: [c, b, a] });
    expect((await logsOf(tokenA, date, 'lunch')).map((log) => log.customName)).toEqual([
      'R38-新条-C',
      'R38-新条-B',
      'R38-新条-A',
    ]);

    // 再记 1 条
    const d = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-新条-D' });

    const logs = await logsOf(tokenA, date, 'lunch');
    // 顺序必须是 C, B, A, D —— D 在**最后**
    expect(logs.map((log) => log.customName)).toEqual([
      'R38-新条-C',
      'R38-新条-B',
      'R38-新条-A',
      'R38-新条-D',
    ]);
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(logs[logs.length - 1]?.id).toBe(d);
  });

  it('快速加卡也走服务端 max+1（quickAdd 接入 nextSortOrder）', async () => {
    const date = shiftDays(today, -2);
    await createMeal(tokenA, { loggedDate: date, mealType: 'snack', customName: 'R38-快加-1' });
    await createMeal(tokenA, { loggedDate: date, mealType: 'snack', customName: 'R38-快加-2' });
    const third = await quickAdd(tokenA, { loggedDate: date, mealType: 'snack', customName: 'R38-快加-3' });

    const logs = await logsOf(tokenA, date, 'snack');
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2]);
    expect(logs[logs.length - 1]?.id).toBe(third);
  });

  it('套餐一键应用从 base+1 起编号（applyCombo 接入 nextSortOrder）', async () => {
    const date = shiftDays(today, -3);
    await createMeal(tokenA, { loggedDate: date, mealType: 'breakfast', customName: 'R38-套餐-已有' });

    const created = await request(server as never)
      .post(`${API}/meal-combos`)
      .set(auth(tokenA))
      .send({
        name: 'R38-套餐-e2e',
        mealType: 'breakfast',
        items: [
          { customName: 'R38-套餐-甲', kcal: 100 },
          { customName: 'R38-套餐-乙', kcal: 120 },
        ],
      })
      .expect(200);
    const comboId = (created.body.data as { id: number }).id;

    await request(server as never)
      .post(`${API}/meal-combos/${comboId}/apply`)
      .set(auth(tokenA))
      .send({ loggedDate: date, mealType: 'breakfast' })
      .expect(200);

    const logs = await logsOf(tokenA, date, 'breakfast');
    // 已有 1 条（sortOrder 0）→ 套餐两条接在 1、2，**不是**用模板序号覆盖成 0、1
    expect(logs.map((log) => log.customName)).toEqual(['R38-套餐-已有', 'R38-套餐-甲', 'R38-套餐-乙']);
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1, 2]);
  });

  it('跨餐移动：mealType 变更，热量与营养一律不变（AC-3.8.2）', async () => {
    const date = shiftDays(today, -4);
    const id = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-跨餐-X' });
    await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-跨餐-Y' });

    const before = (await allLogs(tokenA, date)).find((log) => log.id === id);
    const res = await reorder(tokenA, { loggedDate: date, mealType: 'breakfast', orderedIds: [id] });
    expect(res.status).toBe(200);

    const after = (await allLogs(tokenA, date)).find((log) => log.id === id);
    expect(after?.mealType).toBe('breakfast');
    // 热量不因移动而重算
    expect(after?.kcal).toBe(before?.kcal);
    // 源餐剩余项 compact 为 0..n-1
    expect((await logsOf(tokenA, date, 'lunch')).map((log) => log.sortOrder)).toEqual([0]);
  });

  it('空数组 → 200 no-op', async () => {
    const res = await reorder(tokenA, { loggedDate: today, mealType: 'lunch', orderedIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: [] });
  });

  it('幂等：同一 payload 重复提交结果一致', async () => {
    const date = shiftDays(today, -5);
    const a = await createMeal(tokenA, { loggedDate: date, mealType: 'dinner', customName: 'R38-幂等-A' });
    const b = await createMeal(tokenA, { loggedDate: date, mealType: 'dinner', customName: 'R38-幂等-B' });

    const payload = { loggedDate: date, mealType: 'dinner', orderedIds: [b, a] };
    await reorder(tokenA, payload);
    const first = (await logsOf(tokenA, date, 'dinner')).map((log) => `${log.id}:${log.sortOrder}`);
    const second = await reorder(tokenA, payload);
    expect(second.status).toBe(200);
    const again = (await logsOf(tokenA, date, 'dinner')).map((log) => `${log.id}:${log.sortOrder}`);
    expect(again).toEqual(first);
    // 第二次没有实际变化 → updated 为空（只更新变化的行）
    expect(second.body.data.updated).toEqual([]);
  });

  it('他人记录 → 404（不暴露他人资源存在性）', async () => {
    const date = shiftDays(today, -6);
    const mineId = await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-越权-A' });

    const res = await reorder(tokenB, { loggedDate: date, mealType: 'lunch', orderedIds: [mineId] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_MEAL');
    expect(res.body.error.message).toBe('没有找到这条记录');
  });

  it('不存在的 id → 400，并在 fields.orderedIds 指明是哪几个', async () => {
    const res = await reorder(tokenA, { loggedDate: today, mealType: 'lunch', orderedIds: [999000001, 999000002] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    const field = res.body.error.fields?.orderedIds as string;
    expect(field).toContain('999000001');
    expect(field).toContain('999000002');
  });

  it('属于本人但不在这一天 → 400', async () => {
    const otherDay = shiftDays(today, -7);
    const id = await createMeal(tokenA, { loggedDate: otherDay, mealType: 'lunch', customName: 'R38-跨日-A' });

    const res = await reorder(tokenA, { loggedDate: today, mealType: 'lunch', orderedIds: [id] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(String(res.body.error.fields?.orderedIds)).toContain('不在这一天');
  });

  it('日期格式非法 → 400；无令牌 → 401', async () => {
    const bad = await reorder(tokenA, { loggedDate: '2026/09/12', mealType: 'lunch', orderedIds: [1] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('E_VALID_INPUT');

    const anonymous = await request(server as never)
      .patch(`${API}/meals/reorder`)
      .send({ loggedDate: today, mealType: 'lunch', orderedIds: [1] })
      .expect(401);
    expect(anonymous.body.error).not.toBeNull();
  });

  /**
   * K14：排序值只能由服务端分配。
   *
   * 全局 `ValidationPipe` 是 `whitelist: true` + `forbidNonWhitelisted: false` ——
   * DTO 未声明的 `sortOrder` 会被**静默剥离**（既不入库、也不报错），
   * 因此客户端传什么都不会影响结果：服务端仍然按 max+1 分配。
   */
  it('DTO 不接受 sortOrder：客户端传了也被剥离，排序仍由服务端分配（K14）', async () => {
    const date = shiftDays(today, -8);
    await createMeal(tokenA, { loggedDate: date, mealType: 'lunch', customName: 'R38-DTO-A' });

    const res = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ loggedDate: date, mealType: 'lunch', customName: 'R38-DTO-B', customKcal: 100, sortOrder: 99 })
      .expect(200);
    // 剥离生效：返回的实体里没有 99，而是服务端分配的 1（上一条是 0）
    expect((res.body.data.entry as { sortOrder: number }).sortOrder).toBe(1);

    const logs = await logsOf(tokenA, date, 'lunch');
    expect(logs.map((log) => log.customName)).toEqual(['R38-DTO-A', 'R38-DTO-B']);
    expect(logs.map((log) => log.sortOrder)).toEqual([0, 1]);
  });
});

describe('R11.5 · GET /api/foods/top', () => {
  it('同一天记 3 次同一食物只算 1 天，不足 3 天 → 不进榜（QR-1）', async () => {
    // 先在三天里各记一次「跨 3 天」的食物，保证榜单非空可断言
    const name3 = 'R115-跨三天';
    for (const delta of [-2, -1, 0]) {
      await createMeal(tokenA, { loggedDate: shiftDays(today, delta), mealType: 'lunch', customName: name3 });
    }
    // 同一天记 3 次
    const name1 = 'R115-同一天三次';
    const sameDay = shiftDays(today, -1);
    for (let i = 0; i < 3; i += 1) {
      await createMeal(tokenA, { loggedDate: sameDay, mealType: 'dinner', customName: name1 });
    }

    const res = await request(server as never)
      .get(`${API}/foods/top`)
      .query({ days: 90, limit: 12 })
      .set(auth(tokenA))
      .expect(200);

    const data = res.body.data as { days: number; items: Array<{ name: string; dayCount: number }> };
    expect(data.days).toBe(90);

    const hit = data.items.find((item) => item.name === name3);
    expect(hit).toBeDefined();
    expect(hit?.dayCount).toBe(3);

    // 只出现 1 天 → 低于门槛 3，整块不出现
    expect(data.items.find((item) => item.name === name1)).toBeUndefined();
  });

  it('数据不足 → items 为空数组（不是 null、不是缺字段）', async () => {
    const res = await request(server as never)
      .get(`${API}/foods/top`)
      .set(auth(tokenB))
      .expect(200);
    const data = res.body.data as { days: number; items: unknown[] };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items).toEqual([]);
  });

  it('跨用户隔离：B 看不到 A 的常吃榜', async () => {
    const resA = await request(server as never).get(`${API}/foods/top`).set(auth(tokenA)).expect(200);
    const resB = await request(server as never).get(`${API}/foods/top`).set(auth(tokenB)).expect(200);
    const itemsA = (resA.body.data as { items: Array<{ name: string }> }).items;
    const itemsB = (resB.body.data as { items: Array<{ name: string }> }).items;
    expect(itemsA.length).toBeGreaterThan(0);
    expect(itemsB).toEqual([]);
  });

  it('参数越界 → 400 E_VALID_INPUT', async () => {
    const badDays = await request(server as never)
      .get(`${API}/foods/top`)
      .query({ days: 0 })
      .set(auth(tokenA))
      .expect(400);
    expect(badDays.body.error.code).toBe('E_VALID_INPUT');

    const badLimit = await request(server as never)
      .get(`${API}/foods/top`)
      .query({ limit: 999 })
      .set(auth(tokenA))
      .expect(400);
    expect(badLimit.body.error.code).toBe('E_VALID_INPUT');
  });

  it('榜单条目只有名称 + 天数，没有任何营养字段（AC-11.5.3）', async () => {
    const res = await request(server as never).get(`${API}/foods/top`).set(auth(tokenA)).expect(200);
    const items = (res.body.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['dayCount', 'food', 'foodItemId', 'name']);
    }
  });
});

describe('R11.6 · GET /api/data/overview', () => {
  it('固定 6 行，顺序固定，`wins` 恒 0（Q-6）', async () => {
    const res = await request(server as never).get(`${API}/data/overview`).set(auth(tokenA)).expect(200);
    const rows = (res.body.data as { rows: Array<{ key: string; count: number; firstDate: string | null; lastDate: string | null }> }).rows;

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.key)).toEqual([
      'weights',
      'meals',
      'exercises',
      'habits',
      'water',
      'wins',
    ]);

    const wins = rows.find((row) => row.key === 'wins');
    expect(wins).toEqual({ key: 'wins', count: 0, firstDate: null, lastDate: null });

    const meals = rows.find((row) => row.key === 'meals');
    expect(meals?.count).toBeGreaterThan(0);
    expect(meals?.firstDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meals?.lastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('无令牌 → 401（与其它受保护接口一致）', async () => {
    const res = await request(server as never).get(`${API}/data/overview`).expect(401);
    expect(res.body.error).not.toBeNull();
  });
});
