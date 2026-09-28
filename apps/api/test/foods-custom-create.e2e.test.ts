/**
 * `POST /api/foods` 端到端测试（C-4 第一步 / R3.6）——「快加卡的食物可以存进食物库」。
 *
 * ## 本功能要解决的问题
 *
 * 快速加卡（`POST /api/meals/quick-add`）此前**只写 `meal_logs`**（`foodItemId: null`），
 * 于是这条食物下次**搜不到、无法复用**，用户只能重填一遍。本次补上「让它可复用」：
 * 新端点把用户手填的食物落一条 `source=user_custom` 的 `food_items` 行。
 *
 * ## 本文件钉死的行为（每条都对应一个真实风险）
 *
 * 1. **核心价值**：新建后的条目能被 `GET /foods/search?q=...` **搜到**（否则功能等于没做）；
 * 2. **跨用户不可见**（最重要）：用户 A 自建的食物，用户 B 搜不到 ——
 *    直接验证 `visibleFoodWhere` 的 `createdByUserId` 分支真的在生效；
 * 3. **`source` 服务端写死 `'user_custom'`**：客户端提交 `source: 'builtin'` 被**忽略**
 *    （DB 无 CHECK 约束，若不在这里拦，客户端可自造"内置食物"污染全站可见口径）；
 * 4. **`createdByUserId` 服务端取自 JWT**：客户端提交他人 id 被**忽略**（防越权归属）；
 * 5. **分类白名单**：`'beverages'` / `'zh'` 这类脏值被 400 拒绝（防污染分类浏览）；
 * 6. **数值校验**：`kcalPer100g` 缺失 / 负数 / 超上限 → 400；
 * 7. **鉴权**：无 token → 401。
 *
 * ⚠️ 与既有 e2e 相同的机制：加载 `dist/**` 编译产物（装饰器元数据），因此需先 `nest build`。
 * ⚠️ 测试数据全部带唯一前缀 `柠青自建`，结束后按 id 精确清理 + 按前缀名兜底清理，不污染种子库。
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
const USER_A = 'e2e-custom-a@qinglife.test';
const USER_B = 'e2e-custom-b@qinglife.test';

/** 唯一关键词：真实种子里不可能出现，保证搜索结果可精确断言。 */
const KEYWORD = '柠青自建';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';
let userAId = 0;
let userBId = 0;

/** 已创建条目的 id（清理用）。 */
const createdIds: number[] = [];

/** 登录验证码经 `Logger.log` 输出，spy 住以便从日志里取码（与既有 e2e 同款）。 */
const logSpy = vi.spyOn(Logger.prototype, 'log');

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

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

/** 走一遍「发码 → 验证码登录」，返回 accessToken。 */
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
  if (createdIds.length > 0) {
    await prisma.foodItem.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
  // 兜底：万一中途崩溃，按唯一前缀名清理残留（**绝不**按真实食物名删种子数据）
  await prisma.foodItem.deleteMany({ where: { name: { contains: KEYWORD } } });
  const emails = [USER_A, USER_B];
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: emails } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

interface FoodBody {
  id: number;
  name: string;
  category: string;
  kcalPer100g: number;
  proteinGPer100g: number;
  source: string;
  createdByUserId: number | null;
  isVerified: boolean;
  aliases: string[];
  servingUnits: Array<{ unit: string; grams: number }>;
}

interface SearchBody {
  items: Array<{ id: number; name: string }>;
  total: number;
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
  userAId = (await prisma.user.findUniqueOrThrow({ where: { email: USER_A } })).id;
  userBId = (await prisma.user.findUniqueOrThrow({ where: { email: USER_B } })).id;
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('POST /foods 新建用户自定义食物（C-4 第一步）', () => {
  it('创建成功：source=user_custom、归属当前用户、isVerified=false', async () => {
    const res = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}楼下麻辣烫`, kcalPer100g: 620, category: '外卖' })
      .expect(201);

    expect(res.body.error).toBeNull();
    const food = res.body.data as FoodBody;
    createdIds.push(food.id);

    expect(food.name).toBe(`${KEYWORD}楼下麻辣烫`);
    expect(food.source).toBe('user_custom');
    expect(food.createdByUserId).toBe(userAId);
    expect(food.isVerified).toBe(false);
    expect(food.category).toBe('外卖');
    expect(food.kcalPer100g).toBe(620);
    // 未传的宏量落 0（不编造）
    expect(food.proteinGPer100g).toBe(0);
  });

  it('★ 核心价值：新建的食物能被 GET /foods/search 搜到', async () => {
    const name = `${KEYWORD}自选沙拉碗`;
    const created = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name, kcalPer100g: 210, category: '蔬菜' })
      .expect(201);
    createdIds.push((created.body.data as FoodBody).id);

    const res = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: name, pageSize: 20 })
      .set(auth(tokenA))
      .expect(200);

    const data = res.body.data as SearchBody;
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.items.some((item) => item.name === name)).toBe(true);

    // 旧端点 `GET /foods` 也要能搜到（前端部分路径仍走它）
    const legacy = await request(server as never)
      .get(`${API}/foods`)
      .query({ q: name, pageSize: 20 })
      .set(auth(tokenA))
      .expect(200);
    const legacyData = legacy.body.data as SearchBody;
    expect(legacyData.items.some((item) => item.name === name)).toBe(true);
  });

  it('★ 跨用户不可见：A 自建的食物，B 搜不到', async () => {
    const name = `${KEYWORD}私房牛肉面`;
    const created = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name, kcalPer100g: 480, category: '主食' })
      .expect(201);
    const foodId = (created.body.data as FoodBody).id;
    createdIds.push(foodId);

    // A 自己搜得到
    const asA = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: name, pageSize: 20 })
      .set(auth(tokenA))
      .expect(200);
    expect((asA.body.data as SearchBody).items.some((item) => item.id === foodId)).toBe(true);

    // B 搜同一个词 → 一条都不该有（这是 `visibleFoodWhere` 的 createdByUserId 分支在生效）
    const asB = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: name, pageSize: 20 })
      .set(auth(tokenB))
      .expect(200);
    expect((asB.body.data as SearchBody).items.some((item) => item.id === foodId)).toBe(false);

    // B 直接按 id 取 → 404（不暴露存在性）
    await request(server as never).get(`${API}/foods/${foodId}`).set(auth(tokenB)).expect(404);
  });

  it('★ 客户端传 source="builtin" 被忽略（不能伪装成内置食物）', async () => {
    const name = `${KEYWORD}伪装款`;
    const res = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name, kcalPer100g: 100, source: 'builtin' })
      .expect(201);
    const food = res.body.data as FoodBody;
    createdIds.push(food.id);

    expect(food.source).toBe('user_custom');
    // 若伪装成功，这条会变成**全局可见**；用 B 搜一次作为行为侧证
    const asB = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: name, pageSize: 20 })
      .set(auth(tokenB))
      .expect(200);
    expect((asB.body.data as SearchBody).items.some((item) => item.id === food.id)).toBe(false);
  });

  it('★ 客户端传 createdByUserId=<他人 id> 被忽略（归属必须是当前用户）', async () => {
    const name = `${KEYWORD}越权归属款`;
    const res = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name, kcalPer100g: 150, createdByUserId: userBId })
      .expect(201);
    const food = res.body.data as FoodBody;
    createdIds.push(food.id);

    expect(food.createdByUserId).toBe(userAId);
    expect(food.createdByUserId).not.toBe(userBId);
  });

  it('category 传非法脏值（beverages / zh）被 400 拒绝', async () => {
    for (const category of ['beverages', 'zh', 'Cold', '主食; DROP']) {
      const res = await request(server as never)
        .post(`${API}/foods`)
        .set(auth(tokenA))
        .send({ name: `${KEYWORD}脏分类`, kcalPer100g: 100, category })
        .expect(400);
      expect(res.body.error).not.toBeNull();
    }
  });

  it('kcalPer100g 缺失 / 负数 / 超上限 → 400', async () => {
    // 缺失
    await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}无热量` })
      .expect(400);
    // 负数（class-validator @Min(0) 拒绝）
    await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}负热量`, kcalPer100g: -5 })
      .expect(400);
    // 超上限（@Max(1000)）
    await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}超热量`, kcalPer100g: 5000 })
      .expect(400);
  });

  it('名称为空（纯空白）/ 过长 → 400', async () => {
    await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name: '   ', kcalPer100g: 100 })
      .expect(400);
    await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name: 'x'.repeat(41), kcalPer100g: 100 })
      .expect(400);
  });

  it('无 token → 401', async () => {
    await request(server as never)
      .post(`${API}/foods`)
      .send({ name: `${KEYWORD}匿名`, kcalPer100g: 100 })
      .expect(401);
  });

  it('允许同名重复：重复创建不报错、不覆盖，两条都在', async () => {
    const name = `${KEYWORD}重名款`;
    const first = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name, kcalPer100g: 300 })
      .expect(201);
    const second = await request(server as never)
      .post(`${API}/foods`)
      .set(auth(tokenA))
      .send({ name, kcalPer100g: 350 })
      .expect(201);
    const firstId = (first.body.data as FoodBody).id;
    const secondId = (second.body.data as FoodBody).id;
    createdIds.push(firstId, secondId);

    expect(firstId).not.toBe(secondId);
    // 两条热量各自保留（没有静默覆盖）
    const rows = await prisma.foodItem.findMany({
      where: { id: { in: [firstId, secondId] } },
      select: { id: true, kcalPer100g: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.kcalPer100g]));
    expect(byId.get(firstId)).toBe(300);
    expect(byId.get(secondId)).toBe(350);
  });
});
