/**
 * `POST /api/meals/batch`（C-3 一餐多品项批量记录）端到端测试。
 *
 * 钉死六件事：
 * ① **一次写入多条**：三条食物一次提交 → 全部落库、返回正确、每条 `sortOrder` **互不相同**；
 * ② **单事务 / 全有或全无**：清单里夹一条 `foodId` 对本人不可见的食物 → **整体不写入**
 *    （前面那条合法的也不该落库）；
 * ③ **跨用户隔离**：他人自定义（`user_custom`）食物对本人不可见 → 404 `E_NOTFOUND_FOOD`；
 * ④ **空数组 → 400**（`E_VALID_INPUT`）；
 * ⑤ **无 token → 401**；
 * ⑥ 🔴 **无负罪感**：响应用户可见部分**不含**任何「超标 / 超出 / 预算 / 目标」字段（PRD §7）。
 *
 * ⚠️ 与既有 e2e 相同的机制：加载 `dist/**` 编译产物（装饰器元数据），因此需先 `nest build`。
 * ⚠️ 测试数据全部带唯一前缀 `柠青实验`，结束后按测试邮箱精确清理，不污染食物库。
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
const core = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const { toLocalDateKey } = core;

const API = '/api';
const USER_A = 'e2e-batch-a@qinglife.test';
const USER_B = 'e2e-batch-b@qinglife.test';

/** 唯一前缀：真实种子里不可能出现，保证清理与断言都精确。 */
const KEYWORD = '柠青实验';

/** 登录验证码经 `Logger.log` 输出，spy 住以便从日志里取码（与既有 e2e 同款）。 */
const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';

const today = toLocalDateKey(new Date());

/** 已创建的测试食物 id（清理用）。 */
const createdFoodIds: number[] = [];

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

/** 从日志中提取某邮箱的 6 位验证码。 */
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
  if (createdFoodIds.length > 0) {
    await prisma.foodItem.deleteMany({ where: { id: { in: createdFoodIds } } });
    createdFoodIds.length = 0;
  }
  // 兜底：万一某次运行中崩溃，按唯一前缀名清理残留（绝不按真实食物名删种子数据）
  await prisma.foodItem.deleteMany({ where: { name: { contains: KEYWORD } } });
  const emails = [USER_A, USER_B];
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: emails } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

/** 建一条**公共**测试食物（固定每 100g 值，便于精确断言）。 */
async function createFood(name: string, kcalPer100g: number): Promise<number> {
  const row = await prisma.foodItem.create({
    data: {
      name,
      namePinyin: null,
      aliases: JSON.stringify([]),
      category: 'other',
      kcalPer100g,
      proteinGPer100g: 10,
      fatGPer100g: 5,
      carbGPer100g: 20,
      servingUnits: JSON.stringify([{ unit: '克', grams: 100 }]),
      defaultServingGrams: 100,
      source: 'builtin',
      createdByUserId: null,
      isVerified: false,
    },
    select: { id: true },
  });
  createdFoodIds.push(row.id);
  return row.id;
}

/** 建一条**仅 owner 可见**的自定义食物（`createdByUserId` 非空）。 */
async function createOwnedFood(
  ownerId: number,
  name: string,
  kcalPer100g: number,
): Promise<number> {
  const row = await prisma.foodItem.create({
    data: {
      name,
      namePinyin: null,
      aliases: JSON.stringify([]),
      category: 'other',
      kcalPer100g,
      proteinGPer100g: 1,
      fatGPer100g: 1,
      carbGPer100g: 1,
      servingUnits: JSON.stringify([{ unit: '克', grams: 100 }]),
      defaultServingGrams: 100,
      source: 'user_custom',
      createdByUserId: ownerId,
      isVerified: false,
    },
    select: { id: true },
  });
  createdFoodIds.push(row.id);
  return row.id;
}

interface EntryBody {
  id: number;
  foodItemId: number | null;
  kcal: number;
  grams: number | null;
  servingUnit: string | null;
  sortOrder: number;
}

/** 取本人当日全部记录（拍平四餐）。 */
async function logsOf(token: string): Promise<EntryBody[]> {
  const res = await request(server as never)
    .get(`${API}/meals`)
    .query({ date: today })
    .set(auth(token))
    .expect(200);
  return (res.body.data.groups as Array<{ logs: EntryBody[] }>).flatMap((group) => group.logs);
}

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
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('C-3 批量入账：一次写入多条', () => {
  it('三条食物一次提交 → 全部落库、热量正确、sortOrder 互不相同', async () => {
    const f1 = await createFood(`${KEYWORD}宽粉`, 150);
    const f2 = await createFood(`${KEYWORD}豆腐皮`, 200);
    const f3 = await createFood(`${KEYWORD}青菜`, 30);

    const res = await request(server as never)
      .post(`${API}/meals/batch`)
      .set(auth(tokenA))
      .send({
        mealType: 'lunch',
        loggedDate: today,
        items: [
          { foodId: f1, grams: 100 },
          { foodId: f2, grams: 50 },
          { foodId: f3, grams: 200 },
        ],
      })
      .expect(200);

    const entries = res.body.data.entries as EntryBody[];
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.foodItemId)).toEqual([f1, f2, f3]);
    // 热量 = 每 100g × 克数 ÷ 100
    expect(entries.map((entry) => entry.kcal)).toEqual([150, 100, 60]);

    // 全部落库（不是只写了第一条）
    const persisted = (await logsOf(tokenA)).filter((log) =>
      [f1, f2, f3].includes(log.foodItemId ?? -1),
    );
    expect(persisted).toHaveLength(3);

    // ★ sortOrder **互不相同**（批量写入最容易漏的一处：并发/循环里读同一个值）
    const orders = persisted.map((log) => log.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    // 与响应里返回的 sortOrder 一致
    expect(new Set(entries.map((entry) => entry.sortOrder)).size).toBe(3);

    // 响应带当日合计（与单条写入同口径）
    expect(res.body.data.dayTotals.kcal).toBeGreaterThanOrEqual(310);
  });

  it('跨用户：他人自定义食物对本人不可见 → 404 E_NOTFOUND_FOOD', async () => {
    const bRow = await prisma.user.findUnique({ where: { email: USER_B }, select: { id: true } });
    expect(bRow).not.toBeNull();
    const onlyB = await createOwnedFood(bRow?.id as number, `${KEYWORD}他人的菜`, 100);

    const res = await request(server as never)
      .post(`${API}/meals/batch`)
      .set(auth(tokenA))
      .send({
        mealType: 'lunch',
        loggedDate: today,
        items: [{ foodId: onlyB, grams: 100 }],
      })
      .expect(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_FOOD');
  });
});

describe('C-3 批量入账：单事务 / 全有或全无', () => {
  it('清单里夹一条不可见食物 → 整体不写入（前面合法的也不落库）', async () => {
    const valid = await createFood(`${KEYWORD}合法宽粉`, 150);
    const bRow = await prisma.user.findUnique({ where: { email: USER_B }, select: { id: true } });
    const invisible = await createOwnedFood(bRow?.id as number, `${KEYWORD}不可见`, 100);

    const before = (await logsOf(tokenA)).filter((log) => log.foodItemId === valid).length;
    expect(before).toBe(0);

    const res = await request(server as never)
      .post(`${API}/meals/batch`)
      .set(auth(tokenA))
      .send({
        mealType: 'dinner',
        loggedDate: today,
        items: [
          { foodId: valid, grams: 100 }, // 第一条合法
          { foodId: invisible, grams: 100 }, // 第二条不可见 → 整批失败
        ],
      })
      .expect(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_FOOD');

    // ★ 合法的那条也**没有被写入** —— 不是「写一半」
    const after = (await logsOf(tokenA)).filter((log) => log.foodItemId === valid).length;
    expect(after).toBe(0);
  });
});

describe('C-3 批量入账：入参边界', () => {
  it('空数组 → 400 E_VALID_INPUT', async () => {
    const res = await request(server as never)
      .post(`${API}/meals/batch`)
      .set(auth(tokenA))
      .send({ mealType: 'lunch', loggedDate: today, items: [] })
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
  });

  it('缺 items → 400；无 token → 401', async () => {
    await request(server as never)
      .post(`${API}/meals/batch`)
      .set(auth(tokenA))
      .send({ mealType: 'lunch', loggedDate: today })
      .expect(400);

    const f1 = await createFood(`${KEYWORD}认证测试`, 100);
    await request(server as never)
      .post(`${API}/meals/batch`)
      .send({ mealType: 'lunch', loggedDate: today, items: [{ foodId: f1, grams: 100 }] })
      .expect(401);
  });
});

describe('C-3 批量入账：无负罪感（PRD §7）', () => {
  it('响应不含任何「超标 / 超出 / 预算 / 目标」字段', async () => {
    const f1 = await createFood(`${KEYWORD}无评判宽粉`, 500);
    const f2 = await createFood(`${KEYWORD}无评判油炸`, 600);

    const res = await request(server as never)
      .post(`${API}/meals/batch`)
      .set(auth(tokenA))
      .send({
        mealType: 'dinner',
        loggedDate: today,
        items: [
          { foodId: f1, grams: 200 },
          { foodId: f2, grams: 200 },
        ],
      })
      .expect(200);

    expect(Object.keys(res.body.data).sort()).toEqual(['dayTotals', 'entries']);
    const raw = JSON.stringify(res.body.data);
    for (const banned of ['超出', '超标', '预算', '警告', '超额', 'target', 'exceed', 'over']) {
      expect(raw.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
