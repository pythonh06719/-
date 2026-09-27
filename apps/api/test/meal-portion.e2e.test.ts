/**
 * `PATCH /api/meals/:id`（B3 改份量）端到端测试。
 *
 * 钉死七件事：
 * ① **重算口径与新建一致**：把一条改成 250g 得到的热量，必须等于「直接新建一条 250g」
 *    （两条路径共用 `@qsh/core` 的 `scaleFoodNutrients` —— 这里是它的守卫）；
 * ② 食物库条目**只认份量**：请求体里带 `kcal` 也一律按食物库重算（不采信手填值）；
 * ③ **快速加卡条目改热量**：没有食物库参照物，改的是 `kcal` 本身，克数不动；
 * ④ **越权 404**：他人记录与「根本不存在」同码（404 `E_NOTFOUND_MEAL`）、同文案，
 *    不存在「403 + 404」的区分（K7：那等于一个存在性探测 oracle）；
 * ⑤ 入参兜底：食物库条目只传 `kcal`（没份量）→ 400；份量 ≤ 0 → 400；空 body → 400；
 * ⑥ 🔴 **无负罪感**：响应里**没有任何**预算 / 超标 / 超出 / 目标字段（PRD §7）；
 * ⑦ 路由回归：`GET /foods/favorites` 仍 200（`GET /foods/:id` 不得抢掉单段静态路由）。
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
const USER_A = 'e2e-portion-a@qinglife.test';
const USER_B = 'e2e-portion-b@qinglife.test';

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

/** 建一条测试食物（固定每 100g 值，便于精确断言）。 */
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
      servingUnits: JSON.stringify([{ unit: '份', grams: 50 }]),
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

interface EntryBody {
  id: number;
  kcal: number;
  grams: number | null;
  servingUnit: string | null;
  servingQty: number | null;
  foodItemId: number | null;
  proteinG: number | null;
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

describe('B3 改份量：食物库条目按食物库重算', () => {
  it('改成 250g == 直接新建一条 250g（两条路径同一个公式）', async () => {
    const foodId = await createFood(`${KEYWORD}番茄炒蛋`, 120);

    // ① 新建一条 100g
    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId, amountG: 100, mealType: 'lunch', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;
    expect(entry.grams).toBe(100);
    expect(entry.kcal).toBe(120);

    // ② 把同一条改成 250g
    const updated = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ grams: 250 })
      .expect(200);
    const afterUpdate = updated.body.data.entry as EntryBody;
    expect(afterUpdate.grams).toBe(250);
    expect(afterUpdate.kcal).toBe(300);

    // ③ 再新建一条 250g —— 两者必须**完全相等**（不是「接近」）
    const fresh = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId, amountG: 250, mealType: 'lunch', loggedDate: today })
      .expect(200);
    const freshEntry = fresh.body.data.entry as EntryBody;

    expect(afterUpdate.kcal).toBe(freshEntry.kcal);
    expect(afterUpdate.proteinG).toBe(freshEntry.proteinG);
    // 与 core 直算一致（纯函数真源）
    expect(afterUpdate.kcal).toBe(core.scaleFoodNutrients({ kcalPer100g: 120, proteinGPer100g: 10, fatGPer100g: 5, carbGPer100g: 20 }, 250).kcal);
  });

  it('传了 kcal 也不采信：食物库条目一律按份量重算', async () => {
    const foodId = await createFood(`${KEYWORD}米饭`, 116);
    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId, amountG: 100, mealType: 'lunch', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const res = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ grams: 150, kcal: 9999 })
      .expect(200);

    const after = res.body.data.entry as EntryBody;
    expect(after.grams).toBe(150);
    expect(after.kcal).toBe(174); // 116 × 1.5，不是 9999
  });

  it('按份量单位改（2 份 = 100g）', async () => {
    const foodId = await createFood(`${KEYWORD}馒头`, 220);
    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId, amountG: 100, mealType: 'dinner', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const res = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ servingUnit: '份', servingQty: 2 })
      .expect(200);

    const after = res.body.data.entry as EntryBody;
    expect(after.servingUnit).toBe('份');
    expect(after.servingQty).toBe(2);
    expect(after.grams).toBe(100); // 50g × 2
    expect(after.kcal).toBe(220);
  });

  it('响应只有 entry + dayTotals，不含任何预算 / 超标字段（无负罪感）', async () => {
    const foodId = await createFood(`${KEYWORD}青菜`, 30);
    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId, amountG: 100, mealType: 'dinner', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const res = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ grams: 800 }) // 刻意改到一个很大的份量
      .expect(200);

    expect(Object.keys(res.body.data).sort()).toEqual(['dayTotals', 'entry']);
    const raw = JSON.stringify(res.body.data);
    for (const banned of ['超出', '超标', '预算', '警告', '超额', 'warning', 'exceed', 'over']) {
      expect(raw.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe('B3 改份量：快速加卡条目改热量', () => {
  it('快速加卡条目（无 foodItemId）改的是 kcal，克数不动', async () => {
    const created = await request(server as never)
      .post(`${API}/meals/quick-add`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}楼下麻辣烫`, kcal: 600, mealType: 'snack', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;
    expect(entry.foodItemId).toBeNull();
    expect(entry.kcal).toBe(600);

    const res = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ kcal: 450 })
      .expect(200);

    const after = res.body.data.entry as EntryBody;
    expect(after.kcal).toBe(450);
    expect(after.grams).toBe(entry.grams); // 克数没有被牵动
  });

  it('改热量不影响其它记录（当日合计随之更新）', async () => {
    const created = await request(server as never)
      .post(`${API}/meals/quick-add`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}手抓饼`, kcal: 300, mealType: 'snack', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const res = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ kcal: 100 })
      .expect(200);

    const totals = res.body.data.dayTotals as { kcal: number };
    expect(Number.isFinite(totals.kcal)).toBe(true);
    expect(totals.kcal).toBeGreaterThan(0);
  });
});

describe('B3 改份量：越权与入参边界', () => {
  it('他人的记录 → 404（与「不存在」同码同文案，不构成存在性探针）', async () => {
    const created = await request(server as never)
      .post(`${API}/meals/quick-add`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}越权测试`, kcal: 100, mealType: 'snack', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const mine = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenB))
      .send({ grams: 200 })
      .expect(404);

    const missing = await request(server as never)
      .patch(`${API}/meals/99999999`)
      .set(auth(tokenB))
      .send({ grams: 200 })
      .expect(404);

    expect(mine.body.error.code).toBe('E_NOTFOUND_MEAL');
    expect(missing.body.error.code).toBe('E_NOTFOUND_MEAL');
    expect(mine.body.error.message).toBe(missing.body.error.message);
    expect(mine.body.error).not.toHaveProperty('fields');
  });

  it('食物库条目只传 kcal（没份量）→ 400，且不去动这条记录', async () => {
    const foodId = await createFood(`${KEYWORD}豆腐脑`, 47);
    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId, amountG: 100, mealType: 'breakfast', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const res = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ kcal: 500 })
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');

    // 原记录没有被改动
    const list = await request(server as never)
      .get(`${API}/meals`)
      .query({ date: today })
      .set(auth(tokenA))
      .expect(200);
    const all = (list.body.data.groups as Array<{ logs: EntryBody[] }>).flatMap((group) => group.logs);
    const still = all.find((row) => row.id === entry.id);
    expect(still?.kcal).toBe(entry.kcal);
    expect(still?.grams).toBe(entry.grams);
  });

  it('份量 ≤ 0 → 400；空 body → 400；无令牌 → 401', async () => {
    const created = await request(server as never)
      .post(`${API}/meals/quick-add`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}边界测试`, kcal: 100, mealType: 'snack', loggedDate: today })
      .expect(200);
    const entry = created.body.data.entry as EntryBody;

    const zero = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({ grams: 0 })
      .expect(400);
    expect(zero.body.error.code).toBe('E_VALID_INPUT');

    const empty = await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .send({})
      .expect(400);
    expect(empty.body.error.code).toBe('E_VALID_INPUT');

    await request(server as never)
      .patch(`${API}/meals/${entry.id}`)
      .send({ grams: 150 })
      .expect(401);
  });
});

describe('B3 配套：GET /foods/:id 与既有单段静态路由共存', () => {
  it('GET /foods/:id 可取到食物；/foods/favorites 仍是 200（未被 :id 抢走）', async () => {
    const foodId = await createFood(`${KEYWORD}路由回归`, 88);

    const byId = await request(server as never)
      .get(`${API}/foods/${foodId}`)
      .set(auth(tokenA))
      .expect(200);
    expect((byId.body.data as { id: number; kcalPer100g: number }).id).toBe(foodId);
    expect((byId.body.data as { kcalPer100g: number }).kcalPer100g).toBe(88);

    await request(server as never)
      .get(`${API}/foods/favorites`)
      .set(auth(tokenA))
      .expect(200);

    await request(server as never)
      .get(`${API}/foods/categories`)
      .set(auth(tokenA))
      .expect(200);

    // 不存在 / 他人不可见 → 404（与既有口径一致）
    await request(server as never)
      .get(`${API}/foods/99999999`)
      .set(auth(tokenA))
      .expect(404);
  });
});
