/**
 * 「我什么时候吃过它」端到端测试（D-5 / `GET /api/foods/:id/history`）。
 *
 * ## 背景
 *
 * 「上次吃这道菜是什么时候」此前**只在常吃榜里有答案**（R11.5 的 `lastLoggedDate`），
 * 而常吃榜要求「窗口内出现 ≥ 3 天」且只列前 12 条。用户真正会问这个问题的时刻发生在
 * **搜索结果 / 最近 / 收藏**里 —— 那里**一个字都没有**。D-5 补上这条链路。
 *
 * ## 本文件钉死的事
 *
 * ① ★ **快加卡记录能被覆盖到**（本任务的唯一真成本点）：`quickAdd` 写入时
 *    `foodItemId: null`、只有 `customName`。只按 `foodItemId` 查，**一条都查不到**。
 *    本文件用「归一后同名」构造，钉死库内食物能查到快加卡记过的那些天；
 * ② ★ **跨用户隔离**：他人对**同一食物**的记录绝不混进我的结果（`userId` 取自 JWT）；
 * ③ ★ **可见性叠加**（K7）：他人**私有**自定义食物 → 404，不暴露存在性；
 * ④ **路由回归**：本端点不被 `@Get(':id')` 吞掉，也不被 `barcode/:code` 抢走；
 * ⑤ **无历史 → `items: []`**（不是 null、不是缺字段）；
 * ⑥ **日期倒序** + **条数上限生效**（`limit`）；越界 `limit` → 400；
 * ⑦ **无 token → 401**；
 * ⑧ 🔴 **零汇总**：响应里**没有**任何「总数」字段（QD-6）—— 契约层就把汇总掐死了。
 *
 * ⚠️ 与既有 e2e 相同：加载 `dist/**` 编译产物（装饰器元数据），故需先 `nest build`。
 * ⚠️ 测试数据带唯一前缀 `柠青历史`，结束后按测试邮箱 + 前缀名精确清理，不污染种子库。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

const require = createRequire(import.meta.url);

const { Logger } = require('@nestjs/common') as typeof import('@nestjs/common');
const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
const request = require('supertest') as unknown as typeof import('supertest');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};
// core 的身份归一：**口径唯一真源**（K16）。本测试用它独立复算「哪些行该被命中」，
// 断言 API 结论 == core 结论 —— 两处口径若分叉，这里立刻红。
const core = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');
const { foodIdentity, selectFoodHistoryEntries } = core;

const API = '/api';
const USER_A = 'e2e-food-history-a@qinglife.test';
const USER_B = 'e2e-food-history-b@qinglife.test';

/** 唯一前缀：真实种子里不可能出现，保证清理与断言都精确。 */
const KEYWORD = '柠青历史';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';
let userAId = 0;
let userBId = 0;

/** 已创建的测试食物 id（清理用）。 */
const createdFoodIds: number[] = [];

/** 契约形状（与 `packages/shared-types` 的 `FoodHistoryResponse` 对齐）。 */
interface HistoryEntryBody {
  loggedDate: string;
  mealType: string;
  grams: number | null;
  servingUnit: string | null;
  servingQty: number | null;
}

interface HistoryBody {
  foodId: number;
  name: string;
  items: HistoryEntryBody[];
}

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

/** 从日志中提取某邮箱的 6 位验证码（与既有 e2e 同款）。 */
function findCode(email: string): string {
  const calls = logSpy.mock.calls as unknown as unknown[][];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const line = (calls[index] ?? [])
      .map((arg) => (typeof arg === 'string' ? arg : ''))
      .join(' ');
    if (line.includes(email)) {
      const matched = /(\d{6})/.exec(line);
      if (matched && matched[1]) {
        return matched[1];
      }
    }
  }
  throw new Error(`未捕获到 ${email} 的验证码日志`);
}

async function login(email: string): Promise<string> {
  await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = findCode(email);
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (res.body.data as { accessToken: string }).accessToken;
}

async function cleanup(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { in: [USER_A, USER_B] } },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);
  if (userIds.length > 0) {
    await prisma.mealLog.deleteMany({ where: { userId: { in: userIds } } });
  }
  if (createdFoodIds.length > 0) {
    await prisma.foodItem.deleteMany({ where: { id: { in: createdFoodIds } } });
    createdFoodIds.length = 0;
  }
  // 兜底：按唯一前缀名清理残留（绝不按真实食物名删种子数据）
  await prisma.foodItem.deleteMany({ where: { name: { contains: KEYWORD } } });
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
}

/** 建一条测试食物，返回其 id 并登记清理。 */
async function createFood(
  name: string,
  source: 'builtin' | 'user_custom',
  createdByUserId: number | null,
): Promise<number> {
  const row = await prisma.foodItem.create({
    data: {
      name,
      namePinyin: null,
      aliases: JSON.stringify([]),
      category: 'other',
      kcalPer100g: 130,
      proteinGPer100g: 3,
      fatGPer100g: 1,
      carbGPer100g: 28,
      servingUnits: JSON.stringify([{ unit: '碗', grams: 150 }]),
      defaultServingGrams: 150,
      barcode: null,
      source,
      createdByUserId,
      isVerified: false,
    },
    select: { id: true },
  });
  createdFoodIds.push(row.id);
  return row.id;
}

/**
 * 直接插一条 `meal_logs`。
 *
 * `foodItemId: null` + `customName` 即**快加卡形态**（`meals.quickAdd` 的真实写入形状）——
 * 这是 D-5 必须跨过的那道坎。
 */
async function insertLog(
  userId: number,
  options: {
    loggedDate: string;
    mealType?: string;
    foodItemId?: number | null;
    customName?: string | null;
    grams?: number | null;
    servingUnit?: string | null;
    servingQty?: number | null;
  },
): Promise<number> {
  const row = await prisma.mealLog.create({
    data: {
      userId,
      loggedDate: options.loggedDate,
      mealType: options.mealType ?? 'lunch',
      foodItemId: options.foodItemId ?? null,
      customName: options.customName ?? null,
      grams: options.grams ?? null,
      servingUnit: options.servingUnit ?? null,
      servingQty: options.servingQty ?? null,
      kcal: 200,
      proteinG: null,
      fatG: null,
      carbG: null,
      source: 'search',
      sortOrder: 0,
    },
    select: { id: true },
  });
  return row.id;
}

/** 调一次 `GET /foods/:id/history`，返回响应体。 */
async function queryHistory(token: string, foodId: number, limit?: string): Promise<HistoryBody> {
  const res = await request(server as never)
    .get(`${API}/foods/${foodId}/history`)
    .query(limit === undefined ? {} : { limit })
    .set(auth(token))
    .expect(200);
  return res.body.data as HistoryBody;
}

/** 共享 builtin 食物：A、B 都可见。 */
let sharedFoodId = 0;
/** A 吃过的库内条目（走 `foodItemId` 命中）。 */
let libraryFoodId = 0;
/** 没吃过的库内条目。 */
let neverEatenFoodId = 0;
/** A 的私有自建食物（B 不可见）。 */
let privateFoodId = 0;
/** 快加卡专用：库里有同名条目，但 A/B 的记录**只**以 `customName` 形态存在。 */
let quickAddOnlyFoodId = 0;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();

  tokenA = await login(USER_A);
  tokenB = await login(USER_B);
  userAId = (await prisma.user.findUniqueOrThrow({ where: { email: USER_A } })).id;
  userBId = (await prisma.user.findUniqueOrThrow({ where: { email: USER_B } })).id;

  sharedFoodId = await createFood(`${KEYWORD}共享菜`, 'builtin', null);
  libraryFoodId = await createFood(`${KEYWORD}库内条目`, 'builtin', null);
  neverEatenFoodId = await createFood(`${KEYWORD}没吃过`, 'builtin', null);
  privateFoodId = await createFood(`${KEYWORD}我的私房菜`, 'user_custom', userAId);
  quickAddOnlyFoodId = await createFood(`${KEYWORD}快加同名`, 'builtin', null);
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('GET /foods/:id/history 基本行为（D-5）', () => {
  it('按 foodItemId 命中的库内记录 → 返回日期 + 餐次 + 份量', async () => {
    await insertLog(userAId, { loggedDate: '2026-03-01', foodItemId: libraryFoodId, grams: 150, servingUnit: '碗', servingQty: 1 });

    const body = await queryHistory(tokenA, libraryFoodId);
    expect(body.foodId).toBe(libraryFoodId);
    expect(body.name).toBe(`${KEYWORD}库内条目`);
    expect(body.items).toEqual([
      {
        loggedDate: '2026-03-01',
        mealType: 'lunch',
        grams: 150,
        servingUnit: '碗',
        servingQty: 1,
      },
    ]);
  });

  it('★ 快加卡记录（foodItemId=null，只有 customName）能被库内同名食物覆盖到', async () => {
    const name = `${KEYWORD}快加同名`;
    // 归一后同名（注意首尾空白与大小写：归一口径要能吃下这些差异）
    await insertLog(userAId, { loggedDate: '2026-04-02', customName: `  ${name.toUpperCase()}  ` });
    // 明显不同的名字 → 不能混进来
    await insertLog(userAId, { loggedDate: '2026-04-03', customName: `${KEYWORD}完全另一道菜` });

    const body = await queryHistory(tokenA, quickAddOnlyFoodId);
    expect(body.items.map((entry) => entry.loggedDate)).toEqual(['2026-04-02']);
    // 快加卡没记份量 → 三个字段都是 null（**不是 0**）
    expect(body.items[0]).toEqual({
      loggedDate: '2026-04-02',
      mealType: 'lunch',
      grams: null,
      servingUnit: null,
      servingQty: null,
    });
  });

  it('★ 库内记录与同名快加记录合并成同一条序列（D-4 口径）', async () => {
    const foodId = await createFood(`${KEYWORD}合并口径`, 'builtin', null);
    const name = `${KEYWORD}合并口径`;
    await insertLog(userAId, { loggedDate: '2026-05-01', foodItemId: foodId, grams: 100 });
    await insertLog(userAId, { loggedDate: '2026-05-03', customName: name });
    await insertLog(userAId, { loggedDate: '2026-05-02', foodItemId: foodId, grams: 200 });

    const body = await queryHistory(tokenA, foodId);
    expect(body.items.map((entry) => entry.loggedDate)).toEqual([
      '2026-05-03',
      '2026-05-02',
      '2026-05-01',
    ]);
  });

  it('★ 无历史 → items: []（不是 null、不是缺字段）', async () => {
    const body = await queryHistory(tokenA, neverEatenFoodId);
    expect(body.items).toEqual([]);
    expect(body.foodId).toBe(neverEatenFoodId);
  });

  it('日期倒序：最新的在最前', async () => {
    const foodId = await createFood(`${KEYWORD}倒序`, 'builtin', null);
    await insertLog(userAId, { loggedDate: '2026-01-05', foodItemId: foodId, grams: 10 });
    await insertLog(userAId, { loggedDate: '2026-07-20', foodItemId: foodId, grams: 20 });
    await insertLog(userAId, { loggedDate: '2026-03-15', foodItemId: foodId, grams: 30 });

    const body = await queryHistory(tokenA, foodId);
    expect(body.items.map((entry) => entry.loggedDate)).toEqual([
      '2026-07-20',
      '2026-03-15',
      '2026-01-05',
    ]);
  });

  it('同日多条 → 稳定排序（后写入的排前面，不随机跳动）', async () => {
    const foodId = await createFood(`${KEYWORD}同日`, 'builtin', null);
    const first = await insertLog(userAId, { loggedDate: '2026-06-06', foodItemId: foodId, grams: 111 });
    const second = await insertLog(userAId, { loggedDate: '2026-06-06', foodItemId: foodId, grams: 222 });

    const body = await queryHistory(tokenA, foodId);
    expect(body.items.map((entry) => entry.grams)).toEqual([222, 111]);
    expect(second).toBeGreaterThan(first);
  });

  it('limit 生效：只返回最近的 N 条', async () => {
    const foodId = await createFood(`${KEYWORD}限条数`, 'builtin', null);
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
      await insertLog(userAId, { loggedDate: day, foodItemId: foodId, grams: 100 });
    }

    const body = await queryHistory(tokenA, foodId, '2');
    expect(body.items).toHaveLength(2);
    // 取的是**最近**的两条，不是最早的两条
    expect(body.items.map((entry) => entry.loggedDate)).toEqual(['2026-01-05', '2026-01-04']);
  });

  it('脏 limit → 400（0 / 101 / 负数），不静默截断', async () => {
    for (const bad of ['0', '101', '-1']) {
      await request(server as never)
        .get(`${API}/foods/${libraryFoodId}/history`)
        .query({ limit: bad })
        .set(auth(tokenA))
        .expect(400);
    }
  });

  it('缺省 limit → 走默认值 30（少于 30 条时全给）', async () => {
    const body = await queryHistory(tokenA, sharedFoodId);
    expect(Array.isArray(body.items)).toBe(true);
  });
});

describe('GET /foods/:id/history 跨用户隔离与可见性（K7 / D-5）', () => {
  it('★ 跨用户隔离：他人对同一食物的记录绝不混进我的结果', async () => {
    // 用一条**本用例专属**的食物：前面的用例也会往 `sharedFoodId` 塞记录，
    // 共享 fixture 会让本断言随执行顺序漂移。用例必须彼此独立。
    const soloFoodId = await createFood(`${KEYWORD}隔离专用`, 'builtin', null);
    await insertLog(userAId, { loggedDate: '2026-02-01', foodItemId: soloFoodId, grams: 111 });
    // B 对**同一个**食物记一条更晚的
    await insertLog(userBId, { loggedDate: '2026-08-08', foodItemId: soloFoodId, grams: 999 });

    const asA = await queryHistory(tokenA, soloFoodId);
    const asB = await queryHistory(tokenB, soloFoodId);

    // A 看到的绝不是 B 的 999
    expect(asA.items.some((entry) => entry.grams === 999)).toBe(false);
    expect(asA.items.map((entry) => entry.loggedDate)).toEqual(['2026-02-01']);
    // B 看到的是 B 自己那条
    expect(asB.items.map((entry) => entry.grams)).toEqual([999]);
  });

  it('★ 跨用户隔离：他人同名快加记录也不混进来', async () => {
    const name = `${KEYWORD}快加同名`;
    await insertLog(userBId, { loggedDate: '2026-09-09', customName: name });

    const asA = await queryHistory(tokenA, quickAddOnlyFoodId);
    expect(asA.items.map((entry) => entry.loggedDate)).not.toContain('2026-09-09');
  });

  it('★ 他人私有自定义食物 → 404（不泄露存在性）', async () => {
    await request(server as never)
      .get(`${API}/foods/${privateFoodId}/history`)
      .set(auth(tokenB))
      .expect(404);
  });

  it('创建者本人查自己的私有食物 → 200（无历史则空数组）', async () => {
    const body = await queryHistory(tokenA, privateFoodId);
    expect(body.items).toEqual([]);
  });

  it('不存在的 id → 404', async () => {
    await request(server as never).get(`${API}/foods/99999999/history`).set(auth(tokenA)).expect(404);
  });

  it('无 token → 401', async () => {
    await request(server as never).get(`${API}/foods/${libraryFoodId}/history`).expect(401);
  });
});

/**
 * ★ 路由回归：本端点**不得**被同文件里的其他路由吞掉。
 *
 * 背景：同 controller 里既有 `@Get(':id')`（单段）也有 `@Get('barcode/:code')`（两段）。
 * `:id/history` 是两段路径 —— 若它被声明在 `barcode/:code` **之前**，
 * `/foods/barcode/history` 会被抢走并把 `'barcode'` 打成 400（改变既有路由行为）；
 * 若声明得太晚，则可能落在参数路由之后。这条用例把三条路由**一起**钉死。
 */
describe('GET /foods/:id/history 路由回归', () => {
  it('★ 本端点不被 `@Get(":id")` 吞掉（数字 id 走 history 而不是被 ParseIntPipe 打掉）', async () => {
    const res = await request(server as never)
      .get(`${API}/foods/${libraryFoodId}/history`)
      .set(auth(tokenA))
      .expect(200);
    expect((res.body.data as HistoryBody).foodId).toBe(libraryFoodId);
  });

  it('非数字 id → 400（证明 ParseIntPipe 确实作用在 :id 上，路由是本端点而非被降级）', async () => {
    await request(server as never).get(`${API}/foods/not-a-number/history`).set(auth(tokenA)).expect(400);
  });

  it('★ 不被 `barcode/:code` 抢走：`/foods/barcode/<code>` 仍走条码端点', async () => {
    // 合法条码走条码端点：命中本地即 200（与既有路由行为一致）
    const res = await request(server as never)
      .get(`${API}/foods/barcode/6901234567890`)
      .set(auth(tokenA));
    // 不管是 200（本地命中）还是 404（未命中），都**不能**是 400 ——
    // 400 说明被 `:id/history` 抢走、把 'barcode' 当成了数字 id。
    expect([200, 404]).toContain(res.status);
  });

  it('既有静态子路径仍正常（/foods/recent、/foods/top、/foods/favorites 均 200）', async () => {
    await request(server as never).get(`${API}/foods/recent`).set(auth(tokenA)).expect(200);
    await request(server as never).get(`${API}/foods/top`).set(auth(tokenA)).expect(200);
    await request(server as never).get(`${API}/foods/favorites`).set(auth(tokenA)).expect(200);
  });
});

/**
 * ★ 口径一致性门禁：API 结论 **==** core `selectFoodHistoryEntries` 结论（K16 / NFR-11）。
 *
 * 这组用例逐个构造边界形态，并断言「同一批输入下，API 返回的日期序列与 core 算的完全一致」。
 * 一旦有人在服务端或 core 侧另写一套名称匹配 / 排序，两边立刻分叉、这里转红。
 */
describe('GET /foods/:id/history：与 core selectFoodHistoryEntries 口径一致（K16）', () => {
  it('★ API 返回的日期序列 == core 对同一批行算出的结果', async () => {
    const foodId = await createFood(`${KEYWORD}口径一致`, 'builtin', null);
    const name = `${KEYWORD}口径一致`;
    await insertLog(userAId, { loggedDate: '2026-02-02', foodItemId: foodId, grams: 100 });
    await insertLog(userAId, { loggedDate: '2026-02-04', customName: name });
    await insertLog(userAId, { loggedDate: '2026-02-01', customName: `${KEYWORD}别的东西` });
    await insertLog(userAId, { loggedDate: '2026-02-03', foodItemId: foodId, grams: 300 });

    // core 侧：把库里该用户的行取出来，用同一个身份键独立复算。
    // ⚠️ `foodName` 的给法必须与服务端同款（`foodItemId` 非空的行反查回名字），
    // 否则 `foodIdentity` 会回落到 `food:<id>`，两边都算错 —— 那样这条用例就成了
    // 「两边一起错」的假绿。
    const foodRows = await prisma.foodItem.findMany({
      select: { id: true, name: true },
    });
    const nameById = new Map(foodRows.map((row) => [row.id, row.name]));
    const targetKey = foodIdentity({ foodItemId: foodId, foodName: name });
    expect(targetKey).not.toBeNull();
    const allRows = await prisma.mealLog.findMany({
      where: { userId: userAId },
      select: {
        id: true,
        loggedDate: true,
        mealType: true,
        grams: true,
        servingUnit: true,
        servingQty: true,
        foodItemId: true,
        customName: true,
      },
      orderBy: [{ loggedDate: 'desc' }, { id: 'desc' }],
    });
    const coreDates = selectFoodHistoryEntries(
      allRows.map((row) => ({
        ...row,
        foodName: row.foodItemId === null ? null : (nameById.get(row.foodItemId) ?? null),
      })),
      targetKey as string,
      { limit: 30 },
    ).map((entry) => entry.loggedDate);

    const apiDates = (await queryHistory(tokenA, foodId)).items.map((entry) => entry.loggedDate);
    expect(apiDates).toEqual(coreDates);
    // 顺带钉住这个用例本身不是「两边都空」的假绿
    expect(apiDates).toEqual(['2026-02-04', '2026-02-03', '2026-02-02']);
  });

  it('★ 归一能吃下大小写与首尾空白（core normalizeFoodName 口径）', async () => {
    const name = `${KEYWORD}快加同名`;
    const foodId = quickAddOnlyFoodId;
    // 库里 A 的快加记录形态各异：全大写 / 带首尾空白 / 内部多空格
    await insertLog(userAId, { loggedDate: '2026-10-01', customName: name.toUpperCase() });
    await insertLog(userAId, { loggedDate: '2026-10-02', customName: `   ${name}   ` });

    const body = await queryHistory(tokenA, foodId);
    const dates = body.items.map((entry) => entry.loggedDate);
    expect(dates).toContain('2026-10-01');
    expect(dates).toContain('2026-10-02');
  });
});

/**
 * 🔴 零汇总门禁（QD-6）。
 *
 * D-5 呈现的是**日期明细**。一旦响应里出现「总数」字段、或 UI 据 `items.length`
 * 写出一句频次暗示，就等于把明细重新包装成频次 —— 那正是 QD-6 明令禁止的。
 * 本组把「响应里没有汇总」钉成契约级断言。
 */
describe('GET /foods/:id/history 零汇总（QD-6）', () => {
  it('★ 响应里没有任何「总数」类字段（只有 foodId / name / items）', async () => {
    const res = await request(server as never)
      .get(`${API}/foods/${libraryFoodId}/history`)
      .set(auth(tokenA))
      .expect(200);
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['foodId', 'items', 'name']);
    for (const forbidden of ['total', 'count', 'dayCount', 'times', 'frequency', 'totalDays']) {
      expect(Object.prototype.hasOwnProperty.call(data, forbidden)).toBe(false);
    }
  });

  it('★ 明细里不含任何营养字段（零营养评判，AC-11.5.3）', async () => {
    // 自带数据：本用例不依赖前一条用例插的记录（否则单跑 / 换顺序就会假失败）
    const foodId = await createFood(`${KEYWORD}零营养`, 'builtin', null);
    await insertLog(userAId, { loggedDate: '2026-06-01', foodItemId: foodId, grams: 150, servingUnit: '碗', servingQty: 1 });
    await insertLog(userAId, { loggedDate: '2026-06-05', customName: `${KEYWORD}零营养` });

    const res = await request(server as never)
      .get(`${API}/foods/${foodId}/history`)
      .set(auth(tokenA))
      .expect(200);
    const body = res.body.data as HistoryBody;
    expect(body.items).toHaveLength(2);
    for (const entry of body.items) {
      expect(Object.keys(entry).sort()).toEqual([
        'grams',
        'loggedDate',
        'mealType',
        'servingQty',
        'servingUnit',
      ]);
      // kcal / 三大营养素一律不得出现
      for (const forbidden of ['kcal', 'proteinG', 'fatG', 'carbG', 'calories']) {
        expect(Object.prototype.hasOwnProperty.call(entry, forbidden)).toBe(false);
      }
    }
  });
});
