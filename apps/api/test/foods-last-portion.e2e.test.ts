/**
 * 「上次份量记忆」端到端测试（D-1 / `GET /api/foods/last-portions`）。
 *
 * ## 背景
 *
 * 选中常吃的食物时，默认份量此前**恒定**取 `resolveDefaultServing(food)`（食物库通用默认），
 * 用户每次都得把份量改回自己实际的量 —— 这是最高频的记录摩擦。D-1 让默认份量优先取
 * **你上次记这个食物用的份量**。数据是现成的：`meal_logs.grams / serving_unit / serving_qty`
 * 早已落库，索引 `ix_meal_user_food`（`@@index([userId, foodItemId])`）正是为「按食物查历史」建的。
 *
 * ## 本文件钉死的事
 *
 * ① **取最近一次**：同一食物记过两次不同份量 → 返回 `loggedDate` 更大的那条；
 * ② ★ **跳过无有效份量的记录**：快加卡形态的记录（`grams`/`servingUnit`/`servingQty` 皆空）
 *    不得被当成「上次份量」—— 否则会把用户上次吃的量抹成 0；
 * ③ ★ **跨用户隔离**：他人对**同一食物**的记录不影响我的查询（只查本人，`userId` 取自 JWT）；
 * ④ **无历史 → null**（不是 0、不是空对象）；
 * ⑤ **不可见食物的键不出现**（K7：不泄露存在性）；
 * ⑥ **无 token → 401**；脏 `ids` 静默忽略、不 400。
 *
 * ⚠️ 与既有 e2e 相同：加载 `dist/**` 编译产物（装饰器元数据），故需先 `nest build`。
 * ⚠️ 测试数据带唯一前缀 `柠青份量`，结束后按测试邮箱 + 前缀名精确清理，不污染种子库。
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

const API = '/api';
const USER_A = 'e2e-last-portion-a@qinglife.test';
const USER_B = 'e2e-last-portion-b@qinglife.test';

/** 唯一前缀：真实种子里不可能出现，保证清理与断言都精确。 */
const KEYWORD = '柠青份量';

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

interface LastPortionBody {
  grams: number | null;
  servingUnit: string | null;
  servingQty: number | null;
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

/** 直接插一条 meal_logs（可控 `loggedDate` 与份量字段）。 */
async function insertLog(
  userId: number,
  foodItemId: number,
  options: {
    loggedDate: string;
    grams: number | null;
    servingUnit?: string | null;
    servingQty?: number | null;
  },
): Promise<number> {
  const row = await prisma.mealLog.create({
    data: {
      userId,
      loggedDate: options.loggedDate,
      mealType: 'lunch',
      foodItemId,
      customName: null,
      grams: options.grams,
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

/** 调一次 `GET /foods/last-portions`，返回 `portions` 映射。 */
async function queryPortions(
  token: string,
  ids: string,
): Promise<Record<string, LastPortionBody | null>> {
  const res = await request(server as never)
    .get(`${API}/foods/last-portions`)
    .query({ ids })
    .set(auth(token))
    .expect(200);
  return (res.body.data as { portions: Record<string, LastPortionBody | null> }).portions;
}

/** 共享食物（builtin，双方可见）与「没吃过」食物（builtin，无历史）的 id。 */
let sharedFoodId = 0;
let neverEatenFoodId = 0;
/** A 的私有自建食物（B 不可见）。 */
let privateFoodId = 0;

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

  sharedFoodId = await createFood(`${KEYWORD}共享米饭`, 'builtin', null);
  neverEatenFoodId = await createFood(`${KEYWORD}没吃过`, 'builtin', null);
  privateFoodId = await createFood(`${KEYWORD}我的私房菜`, 'user_custom', userAId);
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('GET /foods/last-portions 上次份量记忆（D-1）', () => {
  it('★ 同一食物记过两次不同份量 → 返回最近一次', async () => {
    await insertLog(userAId, sharedFoodId, { loggedDate: '2026-01-01', grams: 100 });
    await insertLog(userAId, sharedFoodId, { loggedDate: '2026-02-01', grams: 300 });

    const portions = await queryPortions(tokenA, String(sharedFoodId));
    expect(portions[String(sharedFoodId)]).toEqual({
      grams: 300,
      servingUnit: null,
      servingQty: null,
    });
  });

  it('同日两条 → 取 id 更大的那条（最后写入的）', async () => {
    const sameDayFoodId = await createFood(`${KEYWORD}同日晚饭`, 'builtin', null);
    await insertLog(userAId, sameDayFoodId, { loggedDate: '2026-05-05', grams: 120 });
    await insertLog(userAId, sameDayFoodId, { loggedDate: '2026-05-05', grams: 480 });

    const portions = await queryPortions(tokenA, String(sameDayFoodId));
    expect(portions[String(sameDayFoodId)]?.grams).toBe(480);
  });

  it('★ 跳过无有效份量的记录（快加卡形态：三者皆空）', async () => {
    // 更晚的日期，但 grams/servingUnit/servingQty 皆空 → 不能被当成「上次份量」
    await insertLog(userAId, sharedFoodId, {
      loggedDate: '2026-03-01',
      grams: null,
      servingUnit: null,
      servingQty: null,
    });

    const portions = await queryPortions(tokenA, String(sharedFoodId));
    // 仍应是 2026-02-01 那条（300g），而不是被空记录挤掉
    expect(portions[String(sharedFoodId)]).toEqual({
      grams: 300,
      servingUnit: null,
      servingQty: null,
    });
  });

  it('「单位 + 数量」形态（无克数）也能带回', async () => {
    await insertLog(userAId, sharedFoodId, {
      loggedDate: '2026-03-02',
      grams: null,
      servingUnit: '碗',
      servingQty: 2,
    });

    const portions = await queryPortions(tokenA, String(sharedFoodId));
    expect(portions[String(sharedFoodId)]).toEqual({
      grams: null,
      servingUnit: '碗',
      servingQty: 2,
    });
  });

  it('★ 无历史 → null（不是 0、不是空对象）', async () => {
    const portions = await queryPortions(tokenA, String(neverEatenFoodId));
    expect(portions[String(neverEatenFoodId)]).toBeNull();
  });

  it('批量：一次请求多个 id，各返回各自的上次份量 / null', async () => {
    const portions = await queryPortions(tokenA, `${sharedFoodId},${neverEatenFoodId}`);
    expect(portions[String(sharedFoodId)]?.servingUnit).toBe('碗');
    expect(portions[String(neverEatenFoodId)]).toBeNull();
  });

  it('★ 跨用户隔离：他人对同一食物的记录不影响我的查询', async () => {
    // B 对**同一个** builtin 食物记一条更晚、更大的份量
    await insertLog(userBId, sharedFoodId, { loggedDate: '2026-04-01', grams: 999 });

    const asA = await queryPortions(tokenA, String(sharedFoodId));
    const asB = await queryPortions(tokenB, String(sharedFoodId));

    // A 看到的仍是 A 自己最近的一条（单位 + 数量），绝不是 B 的 999
    expect(asA[String(sharedFoodId)]?.grams).not.toBe(999);
    expect(asA[String(sharedFoodId)]).toEqual({ grams: null, servingUnit: '碗', servingQty: 2 });
    // B 看到的是 B 自己的 999
    expect(asB[String(sharedFoodId)]?.grams).toBe(999);
  });

  it('★ 不可见食物（他人自建）的键不出现（K7：不泄露存在性）', async () => {
    const asB = await queryPortions(tokenB, String(privateFoodId));
    expect(Object.prototype.hasOwnProperty.call(asB, String(privateFoodId))).toBe(false);

    // 而创建者本人可见（只是没历史 → null）
    const asA = await queryPortions(tokenA, String(privateFoodId));
    expect(asA[String(privateFoodId)]).toBeNull();
  });

  it('空 / 缺失 / 全是脏值的 ids → { portions: {} }（静默忽略，不 400）', async () => {
    expect(await queryPortions(tokenA, '')).toEqual({});
    const res = await request(server as never)
      .get(`${API}/foods/last-portions`)
      .set(auth(tokenA))
      .expect(200);
    expect((res.body.data as { portions: Record<string, unknown> }).portions).toEqual({});

    const dirty = await queryPortions(tokenA, 'abc,-5,0, ,2.5');
    expect(dirty).toEqual({});
  });

  it('脏值混在合法 id 里 → 只保留合法 id（不因脏值整单失败）', async () => {
    const portions = await queryPortions(tokenA, `abc,${neverEatenFoodId},-1`);
    expect(portions[String(neverEatenFoodId)]).toBeNull();
  });

  it('无 token → 401', async () => {
    await request(server as never).get(`${API}/foods/last-portions`).query({ ids: '1' }).expect(401);
  });

  it('路由回归：静态子路径不被 `GET /foods/:id` 吞掉（/foods/recent 仍 200）', async () => {
    await request(server as never).get(`${API}/foods/recent`).set(auth(tokenA)).expect(200);
  });
});
