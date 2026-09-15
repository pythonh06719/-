/**
 * `apps/api` 端到端测试（vitest + supertest，真实启动 Nest 应用 + 真实 SQLite）。
 *
 * 覆盖（对应 ARCHITECTURE §6 T03 的 DoD）：
 * 1. 鉴权链路：`send-code` → `verify-code` → 取令牌 → `/auth/me` 200；
 * 2. 引导问卷：服务端重算并落库（TC-12 前置）；
 * 3. 重算（TC-12）：`PATCH /profile` 改体重 → `budget` 变化且与 `@qsh/core` 直算一致；
 * 4. 食物库：搜索 / 分类 / 收藏；
 * 5. 记录链路：`POST /meals` → `GET /meals?date=` 命中且 `totals` 正确；快速加卡 + 删除；
 * 6. 套餐模板：创建 + 一键应用；
 * 7. 体重：同日覆盖 + 7 日移动平均；
 * 8. 看板聚合 + 鼓励语文案规范（PRD §7）；
 * 9. 越权防护（TC-42/43）：他人资源 404、body 中 `userId` 被忽略、无 / 伪造令牌 401。
 *
 * ⚠️ 测试对 `apps/api/prisma/dev.db` 写入真实数据，但在前后置钩子中按测试邮箱清理（级联删除）。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppModule as AppModuleClass } from '../src/app.module';
import type { PrismaService as PrismaServiceClass } from '../src/prisma/prisma.service';

/**
 * ⚠️ 运行时依赖一律通过 Node 原生 `require` 加载 **`tsc` 编译产物（`dist/**`）**。
 *
 * 原因（T03 关键取舍）：NestJS 依赖注入依赖装饰器元数据 `design:paramtypes`，
 * 而 vitest 内置的 esbuild 转换器**不生成**该元数据（esbuild 至今不支持 `emitDecoratorMetadata`），
 * 若在 vitest 中直接 import `src/**` 的 TS，所有 provider 都会解析为 `undefined`（DI 崩溃）。
 * `tsc`（`nest build`）会**正确生成**元数据，因此端到端测试针对 `dist` 产物运行 —— 与生产运行的是同一份代码。
 *
 * 同时 `Test` / `supertest` / `Logger` 也必须走同一份 `require` 缓存，避免 `@nestjs/core`
 * 被 vitest 与 Node 各加载一次而出现「双实例」导致令牌（如 `APP_PIPE`）不匹配。
 *
 * 类型仍从 `src` 源码 `import type` 获取（编译期擦除，零运行时开销）。
 */
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

const { ageFromBirthDate, calcCalorieBudget, deriveWeeklyLossKg, toLocalDateKey } = core;

const API = '/api';
const USER_A = 'e2e-user-a@qinglife.test';
const USER_B = 'e2e-user-b@qinglife.test';
const BIRTH = '1995-01-01';

/** 捕获 `Logger.log` 输出（验证码在开发/测试环境打印到服务端日志，D4）。 */
const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenA = '';
let tokenB = '';
let userAId = 0;
let userBId = 0;
let onboardBmr = 0;
let mealIdA = 0;

const today = toLocalDateKey(new Date());

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

/** 认证头。 */
function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 清理测试用户及其关联数据（`users` 级联删除；验证码表无外键需单独清理）。 */
async function cleanup(): Promise<void> {
  const emails = [USER_A, USER_B];
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: emails } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

/** 发码并返回验证码（不返回给客户端，仅打印到日志）。 */
async function sendCodeAndGet(email: string): Promise<string> {
  const res = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  expect(res.body.error).toBeNull();
  return findCode(email);
}

/** 验证码登录，返回令牌与用户。 */
async function verifyCode(email: string, code: string): Promise<{ accessToken: string; user: { id: number } }> {
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  expect(res.body.error).toBeNull();
  return res.body.data as { accessToken: string; user: { id: number } };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('轻生活 API（T03 一期 MVP）', () => {
  it('健康检查无需鉴权且响应统一包装', async () => {
    const res = await request(server as never).get(`${API}/health`).expect(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.status).toBe('ok');
  });

  it('未携带令牌访问受保护接口 → 401（TC-43）', async () => {
    const res = await request(server as never).get(`${API}/dashboard`).expect(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toMatch(/^E_AUTH_/);
  });

  it('伪造令牌 → 401（TC-43）', async () => {
    await request(server as never)
      .get(`${API}/dashboard`)
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('鉴权链路：send-code → verify-code → /auth/me（TC-1）', async () => {
    const code = await sendCodeAndGet(USER_A);
    const authResult = await verifyCode(USER_A, code);
    tokenA = authResult.accessToken;
    userAId = authResult.user.id;

    expect(typeof tokenA).toBe('string');
    expect(tokenA.length).toBeGreaterThan(20);

    const me = await request(server as never)
      .get(`${API}/auth/me`)
      .set(auth(tokenA))
      .expect(200);

    expect(me.body.data.user.email).toBe(USER_A);
    expect(me.body.data.profile).toBeNull();
    expect(me.body.data.settings.waterGoalMl).toBeGreaterThan(0);
  });

  it('错误验证码被拒绝（E_AUTH_CODE_INVALID）', async () => {
    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_A, code: '000000' })
      .expect(400);
    expect(res.body.error.code).toBe('E_AUTH_CODE_INVALID');
  });

  it('引导问卷：服务端重算并落库', async () => {
    const res = await request(server as never)
      .post(`${API}/onboarding`)
      .set(auth(tokenA))
      .send({
        gender: 'female',
        birthDate: BIRTH,
        heightCm: 165,
        currentWeightKg: 60,
        targetWeightKg: 55,
        targetWeeks: 10,
        activityLevel: 'sedentary',
        dietaryPreference: ['少油'],
        conditions: [],
        disclaimerAccepted: true,
      })
      .expect(200);

    const data = res.body.data as {
      budget: { bmr: number; tdee: number; intakeRecommended: number };
      goal: { startWeightKg: number };
      profile: { onboardingCompletedAt: string | null; dietaryPreference: string[] };
      warnings: unknown[];
    };

    const age = ageFromBirthDate(BIRTH, new Date());
    const expected = calcCalorieBudget({
      gender: 'female',
      age,
      heightCm: 165,
      weightKg: 60,
      targetWeightKg: 55,
      targetWeeks: 10,
      activityLevel: 'sedentary',
      macroRatio: { protein: 25, fat: 25, carb: 50 },
      weeklyLossKg: deriveWeeklyLossKg(60, 55, 10),
    });

    expect(data.budget.bmr).toBe(expected.bmr);
    expect(data.budget.tdee).toBe(expected.tdee);
    expect(data.budget.intakeRecommended).toBe(expected.intakeRecommended);
    expect(data.goal.startWeightKg).toBe(60);
    expect(data.profile.onboardingCompletedAt).not.toBeNull();
    expect(data.profile.dietaryPreference).toEqual(['少油']);

    onboardBmr = data.budget.bmr;
  });

  it('TC-12：修改体重触发重算且与 @qsh/core 直算一致', async () => {
    const res = await request(server as never)
      .patch(`${API}/profile`)
      .set(auth(tokenA))
      .send({ currentWeightKg: 70 })
      .expect(200);

    const budget = res.body.data.budget as {
      bmr: number;
      tdee: number;
      intakeRecommended: number;
      floorApplied: boolean;
      isDeficitCapped: boolean;
    };

    const age = ageFromBirthDate(BIRTH, new Date());
    const expected = calcCalorieBudget({
      gender: 'female',
      age,
      heightCm: 165,
      weightKg: 70,
      targetWeightKg: 55,
      targetWeeks: 10,
      activityLevel: 'sedentary',
      macroRatio: { protein: 25, fat: 25, carb: 50 },
      weeklyLossKg: deriveWeeklyLossKg(70, 55, 10),
    });

    expect(budget.bmr).toBe(expected.bmr);
    expect(budget.tdee).toBe(expected.tdee);
    expect(budget.intakeRecommended).toBe(expected.intakeRecommended);
    expect(budget.floorApplied).toBe(expected.floorApplied);
    expect(budget.isDeficitCapped).toBe(expected.isDeficitCapped);
    expect(budget.bmr).not.toBe(onboardBmr); // 体重变化 → BMR 必须随之变化
    expect(res.body.data.goal.startWeightKg).toBe(70);
  });

  it('食物库：搜索 / 分类 / 收藏', async () => {
    const search = await request(server as never)
      .get(`${API}/foods`)
      .query({ q: '番茄', limit: 5 })
      .set(auth(tokenA))
      .expect(200);
    expect(search.body.data.total).toBeGreaterThan(0);
    const foodId = search.body.data.items[0].id as number;
    expect(typeof foodId).toBe('number');

    const fav = await request(server as never)
      .post(`${API}/foods/${foodId}/favorite`)
      .set(auth(tokenA))
      .expect(200);
    expect(fav.body.data.favorited).toBe(true);

    const favs = await request(server as never)
      .get(`${API}/foods/favorites`)
      .set(auth(tokenA))
      .expect(200);
    expect((favs.body.data as Array<{ id: number }>).map((item) => item.id)).toContain(foodId);

    const categories = await request(server as never)
      .get(`${API}/foods/categories`)
      .set(auth(tokenA))
      .expect(200);
    expect(Array.isArray(categories.body.data)).toBe(true);

    const categories2 = await request(server as never)
      .get(`${API}/foods/categories`)
      .set(auth(tokenA))
      .expect(200);
    expect(categories2.body.data.length).toBeGreaterThan(0);
  });

  it('记录一餐并按日查询（totals 正确）', async () => {
    const foodRes = await request(server as never)
      .get(`${API}/foods`)
      .query({ q: '番茄', limit: 1 })
      .set(auth(tokenA))
      .expect(200);
    const food = foodRes.body.data.items[0] as { id: number; kcalPer100g: number };

    const create = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenA))
      .send({ foodId: food.id, amountG: 300, mealType: 'lunch', loggedDate: today })
      .expect(200);

    const entry = create.body.data.entry as { id: number; userId: number; kcal: number; grams: number };
    mealIdA = entry.id;
    expect(entry.userId).toBe(userAId);
    expect(entry.grams).toBe(300);
    const expectedKcal = Math.round(food.kcalPer100g * 3 * 10) / 10;
    expect(entry.kcal).toBeCloseTo(expectedKcal, 5);

    const list = await request(server as never)
      .get(`${API}/meals`)
      .query({ date: today })
      .set(auth(tokenA))
      .expect(200);

    expect(list.body.data.date).toBe(today);

    // QA BUG-01 回归：响应必须逐字段符合契约 `ListMealsResponse` ——
    // `groups` 是**数组**且固定含四个餐次（空餐次也要返回），`totalKcal` 等于各餐之和。
    // （此前返回 `{ meals: {...}, totals }` 对象形状，导致前端 `/diary` 恒显示无记录。）
    const groups = list.body.data.groups as Array<{
      mealType: string;
      logs: unknown[];
      totalKcal: number;
    }>;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.map((g) => g.mealType)).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
    const lunch = groups.find((g) => g.mealType === 'lunch');
    expect(lunch?.logs).toHaveLength(1);
    expect(lunch?.totalKcal).toBeCloseTo(entry.kcal, 5);
    expect(list.body.data.totalKcal).toBeCloseTo(
      groups.reduce((sum, g) => sum + g.totalKcal, 0),
      5,
    );
  });

  it('快速加卡（TC-19）与删除', async () => {
    const res = await request(server as never)
      .post(`${API}/meals/quick-add`)
      .set(auth(tokenA))
      .send({ name: '测试加卡', kcal: 250, mealType: 'snack', loggedDate: today })
      .expect(200);

    const entry = res.body.data.entry as { id: number; kcal: number; foodItemId: number | null };
    expect(entry.kcal).toBe(250);
    expect(entry.foodItemId).toBeNull();

    const del = await request(server as never)
      .delete(`${API}/meals/${entry.id}`)
      .set(auth(tokenA))
      .expect(200);
    expect(del.body.data.deleted).toBe(true);
  });

  it('套餐模板：创建 + 一键应用（TC-26）', async () => {
    const create = await request(server as never)
      .post(`${API}/meal-combos`)
      .set(auth(tokenA))
      .send({
        name: `测试套餐-${Date.now()}`,
        mealType: 'breakfast',
        items: [{ name: '自定义包子', amountG: 100, kcal: 230 }],
      })
      .expect(200);

    const comboId = create.body.data.id as number;
    expect(create.body.data.items).toHaveLength(1);

    const apply = await request(server as never)
      .post(`${API}/meal-combos/${comboId}/apply`)
      .set(auth(tokenA))
      .send({ mealType: 'breakfast', loggedDate: today })
      .expect(200);

    expect(apply.body.data.entries).toHaveLength(1);
    expect(apply.body.data.entries[0].kcal).toBe(230);
    expect(apply.body.data.dayTotals.kcal).toBeGreaterThanOrEqual(230);
  });

  it('体重：同日覆盖 + 7 日移动平均（TC-34）', async () => {
    await request(server as never)
      .post(`${API}/weights`)
      .set(auth(tokenA))
      .send({ weightKg: 69.5, loggedAt: today })
      .expect(200);

    const second = await request(server as never)
      .post(`${API}/weights`)
      .set(auth(tokenA))
      .send({ weightKg: 69.2, loggedAt: today })
      .expect(200);
    expect(second.body.data.weightKg).toBe(69.2);

    const list = await request(server as never)
      .get(`${API}/weights`)
      .query({ days: 30 })
      .set(auth(tokenA))
      .expect(200);

    const logs = (list.body.data.logs as Array<{ loggedAt: string; weightKg: number }>).filter(
      (log) => log.loggedAt === today,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.weightKg).toBe(69.2);

    // QA BUG-02 回归：字段名统一为契约的 `movingAverage7`（不再是 `movingAverage7d`），
    // 且 `/api/weights` 与 `/api/weights/trend` 两个端点用同一套命名。
    expect(list.body.data.movingAverage7).toBeDefined();
    expect(list.body.data.movingAverage7d).toBeUndefined();
    expect(list.body.data.movingAverage7.length).toBe(list.body.data.logs.length);

    const trend = await request(server as never)
      .get(`${API}/weights/trend`)
      .query({ days: 30 })
      .set(auth(tokenA))
      .expect(200);
    expect(Array.isArray(trend.body.data.movingAverage7)).toBe(true);
    expect(trend.body.data.movingAverage7.length).toBe(trend.body.data.points.length);
  });

  it('看板聚合 + 鼓励语文案规范（PRD §7）', async () => {
    const res = await request(server as never)
      .get(`${API}/dashboard`)
      .query({ date: today })
      .set(auth(tokenA))
      .expect(200);

    const data = res.body.data as {
      date: string;
      budget: { intakeRecommended: number } | null;
      intakeKcal: number;
      remainingKcal: number;
      progressRatio: number;
      waterGoalMl: number;
      miniTrend: unknown[];
      encouragement: string;
    };

    expect(data.date).toBe(today);
    expect(data.budget).not.toBeNull();
    expect(data.budget?.intakeRecommended).toBeGreaterThan(0);
    expect(data.intakeKcal).toBeGreaterThan(0);
    expect(data.remainingKcal).toBe((data.budget?.intakeRecommended ?? 0) - data.intakeKcal);
    expect(data.waterGoalMl).toBeGreaterThan(0);
    expect(Array.isArray(data.miniTrend)).toBe(true);
    expect(data.miniTrend).toHaveLength(7);

    for (const banned of ['失败', '超标', '请反思', '坚持就是胜利']) {
      expect(data.encouragement).not.toContain(banned);
    }
  });

  it('越权防护：他人资源 404 / body userId 被忽略（TC-42/43）', async () => {
    const codeB = await sendCodeAndGet(USER_B);
    const authResult = await verifyCode(USER_B, codeB);
    tokenB = authResult.accessToken;
    userBId = authResult.user.id;
    expect(userBId).not.toBe(userAId);

    // B 删除 A 的记录 → 404（不泄露存在性）
    const del = await request(server as never)
      .delete(`${API}/meals/${mealIdA}`)
      .set(auth(tokenB))
      .expect(404);
    expect(del.body.error.code).toBe('E_NOTFOUND_MEAL');

    // B 的日记看不到 A 的数据（契约形状：`totalKcal` 顶层为 0，四组 logs 全空）
    const listB = await request(server as never)
      .get(`${API}/meals`)
      .query({ date: today })
      .set(auth(tokenB))
      .expect(200);
    expect(listB.body.data.totalKcal).toBe(0);
    for (const group of listB.body.data.groups as Array<{ logs: unknown[] }>) {
      expect(group.logs).toHaveLength(0);
    }

    // body 里塞 userId 指向他人 → 必须被忽略，仍以 JWT 为准
    const foodRes = await request(server as never)
      .get(`${API}/foods`)
      .query({ q: '番茄', limit: 1 })
      .set(auth(tokenB))
      .expect(200);
    const food = foodRes.body.data.items[0] as { id: number };

    const created = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenB))
      .send({ userId: userAId, foodId: food.id, amountG: 100, mealType: 'lunch', loggedDate: today })
      .expect(200);

    expect(created.body.data.entry.userId).toBe(userBId);

    // 参数校验错误统一包装
    const invalid = await request(server as never)
      .post(`${API}/meals`)
      .set(auth(tokenB))
      .send({ mealType: 'brunch' })
      .expect(400);
    expect(invalid.body.error.code).toBe('E_VALID_INPUT');
    expect(invalid.body.error.fields).toBeTruthy();
  });
});
