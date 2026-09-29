/**
 * 「我的食物库」端到端测试（C-4 第二步）—— 管理本人自建食物（列 / 改 / 删）。
 *
 * ## 背景
 *
 * C-4 第一步（`a69ad51`）让「快加卡」记下的食物能**存进**食物库（`POST /foods`，
 * 服务端强制 `source='user_custom'`）。但**存了不能管**：用户把「红烧肉」打成「红烧内」存进库，
 * 错的那条永远留在库里，每次搜索都出现。本文件钉死「能管」的三条路由行为。
 *
 * ## 🔴 最重要的一条：越权判定**不能**复用 `visibleFoodWhere`
 *
 * `visibleFoodWhere` 是 **OR** 语义（公开来源 **或** 本人创建）。若改 / 删复用
 * `requireVisibleFood`，用户就能**删掉内置食物**（全库共用的 1773 条种子数据）。
 * 故改 / 删必须用严格三条件（`id` + `source='user_custom'` + `createdByUserId=当前用户`），
 * 否则 404。本文件用「改 builtin 404 / 删 builtin 404 / 改他人 404 / 删他人 404」四个用例钉死。
 *
 * ## 第二重要：删除前**必须**写名字快照
 *
 * `MealLog.foodItem` / `MealComboItem.foodItem` 是 `onDelete: SetNull` → 删食物后
 * `food_item_id` 变 null；而普通记录的 `custom_name` **本来就是 null** → 历史记录会退化成
 * 无名条目。故删除前须在同一事务里把食物名填进这些行（**只补 null、不覆盖已有值**）。
 *
 * ⚠️ 与既有 e2e 相同：加载 `dist/**` 编译产物，因此先 `nest build`。
 * ⚠️ 测试数据带唯一前缀 `柠青我的库`，结束后按 id + 前缀名兜底清理，不污染种子库。
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
const USER_A = 'e2e-manage-a@qinglife.test';
const USER_B = 'e2e-manage-b@qinglife.test';

/** 唯一关键词：真实种子里不可能出现，保证结果可精确断言。 */
const KEYWORD = '柠青我的库';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';
let userAId = 0;
let userBId = 0;

/** 已创建的自定义食物 id（清理用）。 */
const createdIds: number[] = [];
/** 走完「记录一餐」流程产生的 meal_log id（清理用）。 */
const createdMealIds: number[] = [];

const logSpy = vi.spyOn(Logger.prototype, 'log');

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
  if (createdMealIds.length > 0) {
    await prisma.mealLog.deleteMany({ where: { id: { in: createdMealIds } } });
    createdMealIds.length = 0;
  }
  if (createdIds.length > 0) {
    await prisma.foodItem.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
  // 兜底：按唯一前缀名清理残留（**绝不**按真实食物名删种子数据）
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
  source: string;
  createdByUserId: number | null;
  isVerified: boolean;
  aliases: string[];
}

/** 新建一条自定义食物，返回其 id 并登记清理。 */
async function createFood(token: string, name: string, kcalPer100g = 500): Promise<FoodBody> {
  const res = await request(server as never)
    .post(`${API}/foods`)
    .set(auth(token))
    .send({ name, kcalPer100g, category: '外卖' })
    .expect(201);
  const food = res.body.data as FoodBody;
  createdIds.push(food.id);
  return food;
}

/** 取一条内置食物（种子数据）的 id，用于越权用例。 */
let builtinFoodId = 0;

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

  builtinFoodId = (
    await prisma.foodItem.findFirstOrThrow({ where: { source: 'builtin' }, select: { id: true } })
  ).id;
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('GET /foods/mine 列出本人自建食物（C-4 第二步）', () => {
  it('只返回本人 user_custom：不含 builtin 等公开来源、不含他人自建', async () => {
    const mineA = await createFood(tokenA, `${KEYWORD}我的凉皮`);
    const mineA2 = await createFood(tokenA, `${KEYWORD}我的豆花`);
    await createFood(tokenB, `${KEYWORD}别人的烤串`);

    const res = await request(server as never).get(`${API}/foods/mine`).set(auth(tokenA)).expect(200);
    const items = res.body.data as FoodBody[];
    const ids = items.map((item) => item.id);

    // 本人的两条都在
    expect(ids).toContain(mineA.id);
    expect(ids).toContain(mineA2.id);
    // ★ 不含 builtin 等公开来源（否则「我的食物库」会混进 1773 条种子）
    expect(items.every((item) => item.source === 'user_custom')).toBe(true);
    expect(items.every((item) => item.createdByUserId === userAId)).toBe(true);
    expect(ids).not.toContain(builtinFoodId);

    // ★ 不含他人自建
    const asB = await request(server as never).get(`${API}/foods/mine`).set(auth(tokenB)).expect(200);
    const idsB = (asB.body.data as FoodBody[]).map((item) => item.id);
    expect(idsB).not.toContain(mineA.id);
    expect(idsB).not.toContain(mineA2.id);
  });

  it('无 token → 401', async () => {
    await request(server as never).get(`${API}/foods/mine`).expect(401);
  });
});

describe('PATCH /foods/:id 修改本人自建食物（C-4 第二步）', () => {
  it('改自己的成功：字段真的落库、返回更新后的对象', async () => {
    const food = await createFood(tokenA, `${KEYWORD}红烧内`, 620);

    const res = await request(server as never)
      .patch(`${API}/foods/${food.id}`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}红烧肉`, kcalPer100g: 680, category: '家常菜' })
      .expect(200);

    const updated = res.body.data as FoodBody;
    expect(updated.id).toBe(food.id);
    expect(updated.name).toBe(`${KEYWORD}红烧肉`);
    expect(updated.kcalPer100g).toBe(680);
    expect(updated.category).toBe('家常菜');

    // 真的落库（不是只在响应里改了）
    const row = await prisma.foodItem.findUniqueOrThrow({ where: { id: food.id } });
    expect(row.name).toBe(`${KEYWORD}红烧肉`);
    expect(row.kcalPer100g).toBe(680);
    // 不可改字段保持不变
    expect(row.source).toBe('user_custom');
    expect(row.createdByUserId).toBe(userAId);
    expect(row.isVerified).toBe(false);
  });

  it('部分更新：只传 name 时其它字段保持原值', async () => {
    const food = await createFood(tokenA, `${KEYWORD}部分改前`, 320);
    await request(server as never)
      .patch(`${API}/foods/${food.id}`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}部分改后` })
      .expect(200);

    const row = await prisma.foodItem.findUniqueOrThrow({ where: { id: food.id } });
    expect(row.name).toBe(`${KEYWORD}部分改后`);
    expect(row.kcalPer100g).toBe(320); // 未传 → 不变
    expect(row.category).toBe('外卖'); // 未传 → 不变
  });

  it('★ 改 builtin 食物 → 404（最危险的越权，绝不能改到内置库）', async () => {
    const before = await prisma.foodItem.findUniqueOrThrow({ where: { id: builtinFoodId } });
    await request(server as never)
      .patch(`${API}/foods/${builtinFoodId}`)
      .set(auth(tokenA))
      .send({ name: '被篡改的名字', kcalPer100g: 1 })
      .expect(404);
    // 内置食物纹丝不动
    const after = await prisma.foodItem.findUniqueOrThrow({ where: { id: builtinFoodId } });
    expect(after.name).toBe(before.name);
    expect(after.kcalPer100g).toBe(before.kcalPer100g);
  });

  it('★ 改他人自建 → 404', async () => {
    const others = await createFood(tokenB, `${KEYWORD}别人的卤味`, 400);
    await request(server as never)
      .patch(`${API}/foods/${others.id}`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}越权改名` })
      .expect(404);
    const row = await prisma.foodItem.findUniqueOrThrow({ where: { id: others.id } });
    expect(row.name).toBe(`${KEYWORD}别人的卤味`);
  });

  it('改不存在的 id → 404；无 token → 401', async () => {
    await request(server as never)
      .patch(`${API}/foods/99999999`)
      .set(auth(tokenA))
      .send({ name: `${KEYWORD}幽灵` })
      .expect(404);
    await request(server as never)
      .patch(`${API}/foods/${builtinFoodId}`)
      .send({ name: 'x' })
      .expect(401);
  });

  it('★ 客户端传 source / createdByUserId / isVerified 被忽略（whitelist 剥离）', async () => {
    const food = await createFood(tokenA, `${KEYWORD}防伪装`, 200);

    const res = await request(server as never)
      .patch(`${API}/foods/${food.id}`)
      .set(auth(tokenA))
      .send({
        name: `${KEYWORD}防伪装改`,
        source: 'builtin',
        createdByUserId: userBId,
        isVerified: true,
      })
      .expect(200);

    const updated = res.body.data as FoodBody;
    expect(updated.source).toBe('user_custom');
    expect(updated.createdByUserId).toBe(userAId);
    expect(updated.isVerified).toBe(false);

    const row = await prisma.foodItem.findUniqueOrThrow({ where: { id: food.id } });
    expect(row.source).toBe('user_custom');
    expect(row.createdByUserId).toBe(userAId);
    expect(row.isVerified).toBe(false);
  });

  it('category 传非法脏值 → 400（与 Create 同一白名单）', async () => {
    const food = await createFood(tokenA, `${KEYWORD}脏分类`, 100);
    for (const category of ['beverages', 'zh', '主食; DROP']) {
      const res = await request(server as never)
        .patch(`${API}/foods/${food.id}`)
        .set(auth(tokenA))
        .send({ category })
        .expect(400);
      expect(res.body.error).not.toBeNull();
    }
  });

  it('name 传纯空白 → 400（trim 后为空，同 Create 防御）', async () => {
    const food = await createFood(tokenA, `${KEYWORD}空白名`, 100);
    await request(server as never)
      .patch(`${API}/foods/${food.id}`)
      .set(auth(tokenA))
      .send({ name: '   ' })
      .expect(400);
  });
});

describe('DELETE /foods/:id 删除本人自建食物（C-4 第二步）', () => {
  it('★ 删 builtin 食物 → 404（绝不能删内置库）', async () => {
    const before = await prisma.foodItem.count({ where: { id: builtinFoodId } });
    await request(server as never).delete(`${API}/foods/${builtinFoodId}`).set(auth(tokenA)).expect(404);
    const after = await prisma.foodItem.findUnique({ where: { id: builtinFoodId } });
    expect(before).toBe(1);
    expect(after).not.toBeNull();
  });

  it('★ 删他人自建 → 404', async () => {
    const others = await createFood(tokenB, `${KEYWORD}别人的酱牛肉`, 300);
    await request(server as never).delete(`${API}/foods/${others.id}`).set(auth(tokenA)).expect(404);
    expect(await prisma.foodItem.findUnique({ where: { id: others.id } })).not.toBeNull();
  });

  it('删不存在的 id → 404；无 token → 401', async () => {
    await request(server as never).delete(`${API}/foods/99999999`).set(auth(tokenA)).expect(404);
    await request(server as never).delete(`${API}/foods/${builtinFoodId}`).expect(401);
  });

  it('删自己的成功：返回 { deleted: true }，且不再出现在 search / mine', async () => {
    const food = await createFood(tokenA, `${KEYWORD}待删的凉拌菜`, 150);

    // 删除前：search 与 mine 都能看到
    const searchBefore = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: `${KEYWORD}待删的凉拌菜`, pageSize: 20 })
      .set(auth(tokenA))
      .expect(200);
    expect(
      (searchBefore.body.data as { items: Array<{ id: number }> }).items.some((item) => item.id === food.id),
    ).toBe(true);

    const res = await request(server as never)
      .delete(`${API}/foods/${food.id}`)
      .set(auth(tokenA))
      .expect(200);
    expect((res.body.data as { deleted: boolean }).deleted).toBe(true);

    // 删除后：search 与 mine 都看不到
    const searchAfter = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: `${KEYWORD}待删的凉拌菜`, pageSize: 20 })
      .set(auth(tokenA))
      .expect(200);
    expect(
      (searchAfter.body.data as { items: Array<{ id: number }> }).items.some((item) => item.id === food.id),
    ).toBe(false);

    const mineAfter = await request(server as never).get(`${API}/foods/mine`).set(auth(tokenA)).expect(200);
    expect((mineAfter.body.data as FoodBody[]).some((item) => item.id === food.id)).toBe(false);
  });

  it('★ 删除后：历史 meal_logs 仍在，且引用它的那行 customName 被填成食物名字', async () => {
    const food = await createFood(tokenA, `${KEYWORD}会被删的红烧肉`, 520);

    // 走真实「记录一餐」：普通记录（选食物库条目），前端**不传 customName**
    const mealRes = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ mealType: 'lunch', foodId: food.id, grams: 150 })
      .expect(200);
    const mealId = (mealRes.body.data as { entry: { id: number } }).entry.id;
    createdMealIds.push(mealId);

    // 记录时 customName 应为 null（这正是「删除前必须写快照」的根因）
    const beforeRow = await prisma.mealLog.findUniqueOrThrow({ where: { id: mealId } });
    expect(beforeRow.customName).toBeNull();
    expect(beforeRow.foodItemId).toBe(food.id);

    const countBefore = await prisma.mealLog.count({ where: { userId: userAId } });

    await request(server as never).delete(`${API}/foods/${food.id}`).set(auth(tokenA)).expect(200);

    // ① 历史记录**仍在**（数量不变，没被级联删）
    const countAfter = await prisma.mealLog.count({ where: { userId: userAId } });
    expect(countAfter).toBe(countBefore);

    // ② 该行 foodItemId 变 null（SetNull），但 customName 被填成食物名（名字快照）
    const afterRow = await prisma.mealLog.findUniqueOrThrow({ where: { id: mealId } });
    expect(afterRow.foodItemId).toBeNull();
    expect(afterRow.customName).toBe(`${KEYWORD}会被删的红烧肉`);
  });

  it('★ 删除不覆盖已有 customName（用户改过显示名的行保持原样）', async () => {
    const food = await createFood(tokenA, `${KEYWORD}改过名的蒸蛋`, 90);

    // 记录时**显式传** customName（模拟用户把显示名改成自己的说法）
    const mealRes = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ mealType: 'breakfast', foodId: food.id, grams: 100, customName: '我的减脂蒸蛋' })
      .expect(200);
    const mealId = (mealRes.body.data as { entry: { id: number } }).entry.id;
    createdMealIds.push(mealId);

    await request(server as never).delete(`${API}/foods/${food.id}`).set(auth(tokenA)).expect(200);

    const afterRow = await prisma.mealLog.findUniqueOrThrow({ where: { id: mealId } });
    // 已有 customName **不被覆盖**（不是食物名，而是用户改过的显示名）
    expect(afterRow.customName).toBe('我的减脂蒸蛋');
  });
});

describe('核实：普通记录的 customName 到底是 null 还是有值（DiaryPage 显示问题）', () => {
  it('记录一条食物库条目 → GET /meals 返回的 customName 为 null（且餐次里也没有名称字段）', async () => {
    const food = await createFood(tokenA, `${KEYWORD}核实显示名西兰花炒虾仁`, 130);

    const mealRes = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ mealType: 'dinner', foodId: food.id, grams: 200 })
      .expect(200);
    const mealId = (mealRes.body.data as { entry: { id: number } }).entry.id;
    createdMealIds.push(mealId);

    const list = await request(server as never)
      .get(`${API}/meals`)
      .query({ date: new Date().toISOString().slice(0, 10) })
      .set(auth(tokenA))
      .expect(200);

    const groups = (list.body.data as { groups: Array<{ mealType: string; logs: Array<Record<string, unknown>> }> })
      .groups;
    const log = groups
      .flatMap((group) => group.logs)
      .find((entry) => entry.id === mealId);

    expect(log).toBeDefined();
    // 结论：普通记录的 customName 就是 null —— 且 MealLog 契约没有 name 字段
    expect(log?.customName).toBeNull();
    expect('name' in (log ?? {})).toBe(false);
    // 记录里只有 foodItemId 可反查名字
    expect(log?.foodItemId).toBe(food.id);
  });
});
