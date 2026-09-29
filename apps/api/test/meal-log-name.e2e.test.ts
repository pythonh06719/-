/**
 * 饮食记录「展示名」端到端测试 —— 修「食物 #45」显示缺陷（foodName 派生字段）。
 *
 * ## 缺陷
 *
 * 选了食物库条目的记录（普通记录）只写 `meal_logs.food_item_id`，`custom_name` 恒为 `null`；
 * 契约 `MealLog` 也**没有**名字字段 → 前端列表只能退化成「食物 #45」。
 * 对照组：改份量弹窗额外查了 `GET /foods/:id`，那里名字是对的 —— 列表里是错的。
 *
 * ## 本次修复
 *
 * 服务端在返回 `MealLog` 时 join 食物表，补一个**可选派生字段** `foodName`
 * （= `food_items.name`，仅 `foodItemId` 非空时填充）。`custom_name` 语义不变（不写名字进去）。
 *
 * 本文件钉死：
 * ① `POST /meals { foodId }` → `GET /meals` 的 log：`foodName` = 食物名、`customName` 仍为 null；
 * ② `POST /meals` 与 `PATCH /meals/:id` 的**即时响应** entry 也带 `foodName`；
 * ③ 快速加卡（`/meals/quick-add`）：`foodName` 为 null、`customName` 有值（两种来源区分清楚）；
 * ④ `foodItemId` 为空的普通自定义记录：`foodName` 为 null；
 * ⑤ 契约仍**无** `name` 字段（不得把名字塞进 `name` 键）。
 *
 * ⚠️ 与既有 e2e 相同：加载 `dist/**` 编译产物，因此先 `nest build`。
 * ⚠️ 测试数据带唯一前缀 `柠青记录名`，结束后按邮箱精确清理，不污染种子库。
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
const USER = 'e2e-mealname@qinglife.test';

/** 唯一前缀：真实种子里不可能出现，保证清理与断言都精确。 */
const KEYWORD = '柠青记录名';

/** 登录验证码经 `Logger.log` 输出，spy 住以便从日志里取码（与既有 e2e 同款）。 */
const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';

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
  const user = await prisma.user.findUnique({ where: { email: USER } });
  if (user) {
    await prisma.mealLog.deleteMany({ where: { userId: user.id } });
  }
  if (createdFoodIds.length > 0) {
    await prisma.foodItem.deleteMany({ where: { id: { in: createdFoodIds } } });
    createdFoodIds.length = 0;
  }
  // 兜底：按唯一前缀名清理残留（**绝不**按真实食物名删种子数据）
  await prisma.foodItem.deleteMany({ where: { name: { contains: KEYWORD } } });
  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });
}

/** 建一条测试食物（固定每 100g 值，便于精确断言），返回其 id。 */
async function createFood(name: string, kcalPer100g = 116): Promise<number> {
  const row = await prisma.foodItem.create({
    data: {
      name,
      namePinyin: null,
      aliases: JSON.stringify([]),
      category: '主食',
      kcalPer100g,
      proteinGPer100g: 2.6,
      fatGPer100g: 0.3,
      carbGPer100g: 25.9,
      servingUnits: JSON.stringify([{ unit: '碗', grams: 150 }]),
      defaultServingGrams: 150,
      source: 'builtin',
      createdByUserId: null,
      isVerified: true,
    },
    select: { id: true },
  });
  createdFoodIds.push(row.id);
  return row.id;
}

interface LogBody {
  id: number;
  foodItemId: number | null;
  customName: string | null;
  foodName?: string | null;
  kcal: number;
  grams: number | null;
  [key: string]: unknown;
}

/** 取当日所有记录（展平四个餐次）。 */
async function listTodayLogs(): Promise<LogBody[]> {
  const res = await request(server as never).get(`${API}/meals`).set(auth(token)).expect(200);
  const groups = (res.body.data as { groups: Array<{ logs: LogBody[] }> }).groups;
  return groups.flatMap((group) => group.logs);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();
  token = await login(USER);
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('饮食记录展示名 · 食物库条目（★ 核心缺陷）', () => {
  it('POST /meals { foodId } → GET /meals：foodName = 食物名，customName 仍为 null', async () => {
    const foodName = `${KEYWORD}米饭（白，蒸）`;
    const foodId = await createFood(foodName, 116);

    await request(server as never)
      .post(`${API}/meals`)
      .set(auth(token))
      .send({ mealType: 'lunch', foodId, grams: 150 })
      .expect(200);

    const log = (await listTodayLogs()).find((row) => row.foodItemId === foodId);
    expect(log).toBeDefined();
    // ★ 派生名取到真名（缺陷修复点）
    expect(log?.foodName).toBe(foodName);
    // customName 语义不变：普通记录仍是 null（不得把名字塞进 DB 字段）
    expect(log?.customName).toBeNull();
    // 契约仍无 `name` 键（字段名必须是 foodName）
    expect('name' in (log ?? {})).toBe(false);
  });

  it('POST /meals 即时响应的 entry 也带 foodName', async () => {
    const foodName = `${KEYWORD}西兰花炒虾仁`;
    const foodId = await createFood(foodName, 130);

    const res = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(token))
      .send({ mealType: 'dinner', foodId, grams: 200 })
      .expect(200);
    const entry = res.body.data.entry as LogBody;
    expect(entry.foodName).toBe(foodName);
    expect(entry.customName).toBeNull();
  });

  it('PATCH /meals/:id 即时响应的 entry 也带 foodName', async () => {
    const foodName = `${KEYWORD}番茄炒蛋`;
    const foodId = await createFood(foodName, 120);

    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(token))
      .send({ mealType: 'lunch', foodId, grams: 100 })
      .expect(200);
    const entryId = (created.body.data.entry as LogBody).id;

    const res = await request(server as never)
      .patch(`${API}/meals/${entryId}`)
      .set(auth(token))
      .send({ grams: 250 })
      .expect(200);
    const after = res.body.data.entry as LogBody;
    expect(after.foodName).toBe(foodName);
    expect(after.grams).toBe(250);
  });
});

describe('饮食记录展示名 · 快速加卡 / 自定义条目（区分来源）', () => {
  it('快速加卡：foodName 为 null、customName 有值', async () => {
    const name = `${KEYWORD}楼下麻辣烫`;
    const created = await request(server as never)
      .post(`${API}/meals/quick-add`)
      .set(auth(token))
      .send({ name, kcal: 600, mealType: 'snack' })
      .expect(200);
    const entry = created.body.data.entry as LogBody;
    expect(entry.foodItemId).toBeNull();
    expect(entry.foodName).toBeNull();
    expect(entry.customName).toBe(name);

    // 列表里同样如此
    const log = (await listTodayLogs()).find((row) => row.id === entry.id);
    expect(log?.foodName).toBeNull();
    expect(log?.customName).toBe(name);
  });

  it('普通自定义记录（foodItemId 为空）：foodName 为 null', async () => {
    const name = `${KEYWORD}手抓饼`;
    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(token))
      .send({ mealType: 'snack', customName: name, customKcal: 300 })
      .expect(200);
    const entry = created.body.data.entry as LogBody;
    expect(entry.foodItemId).toBeNull();
    expect(entry.foodName).toBeNull();
    expect(entry.customName).toBe(name);

    const log = (await listTodayLogs()).find((row) => row.id === entry.id);
    expect(log?.foodName).toBeNull();
  });
});
