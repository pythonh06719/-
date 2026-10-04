/**
 * `GET /api/dashboard` 的**载荷形状**端到端测试 —— 前端「未引导」判据的事实基础。
 *
 * ## 为什么需要这条真实 HTTP 测试
 *
 * 前端 `DashboardPage` 曾用 `data === null` 判定「未完成引导问卷」，于是
 * **500 / 断网也被说成「你还没建过档案」**。修这个缺陷的前提是回答一个问题：
 * **服务端到底用什么表示「这个用户没引导」？**
 *
 * 答案只能靠真实 HTTP 拿 —— 这正是本项目的历史教训（`PATCH /api/users/settings`
 * 长期 404，因为 `UsersController` 是 `@Controller()` 无前缀，而所有测试都 mock fetch，
 * 测试与实现共享同一个错误假设，于是永远测不出它不存在）。
 *
 * ## 本文件钉死的三条契约（前端判据直接依赖它们）
 *
 * 1. ★ **未引导 ≠ `data: null`**：`GET /api/dashboard` 对未引导账号返回
 *    **200 + 完整对象**，其中 `goal === null` 且 `budget === null`。
 *    → 故前端**不能**用 `data === null` 判未引导，那只会捕获「本次没取到数据」。
 * 2. **已引导 → `goal` 非空**且 `budget` 非空。
 * 3. **两者不会混淆**：`goal`/`budget` 同时为空 ⟺ 未引导；
 *    「有 budget 但 goal 为 null」不是服务端会产生的状态（`users.service.ts:212`
 *    在 `!profile || !goal` 时两个一起给 `null`）—— 这条断言是为了让前端的
 *    「`goal === null && budget === null`」判据在服务端侧有明确对应物。
 *
 * 另附一条**误导性内容**的核实：未引导时 `remainingKcal` 为 0、`progressRatio` 为 0，
 * 前端若照画「还能吃 0 kcal」就是把「没预算」说成「 budget 是 0」——
 * 前端已用 `data.budget == null` 分流到 `COPY.noBudgetSummary`，此处钉住服务端侧
 * `budget` 确为 `null`（而非 0 值对象），确保那个分流有真实依据。
 *
 * ## 机制
 *
 * 与既有 e2e 同机制：`createRequire` 加载 `nest build` 产出的 `dist/**`
 * （esbuild 不生成 NestJS 依赖注入所需的装饰器元数据）。
 * ⚠️ 运行前必须先 `npm run build -w @qsh/api`。
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
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const API = '/api';
const FRESH = 'e2e-dash-shape-fresh@qinglife.test';
const ONBOARDED = 'e2e-dash-shape-onboarded@qinglife.test';
const EMAILS = [FRESH, ONBOARDED];

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let freshToken = '';
let onboardedToken = '';

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

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

/** 提交引导问卷。 */
async function onboard(token: string): Promise<void> {
  await request(server as never)
    .post(`${API}/onboarding`)
    .set(auth(token))
    .send({
      gender: 'female',
      birthDate: '1995-01-01',
      heightCm: 165,
      currentWeightKg: 60,
      targetWeightKg: 55,
      targetWeeks: 12,
      activityLevel: 'sedentary',
      dietaryPreference: [],
      conditions: [],
      disclaimerAccepted: true,
    })
    .expect(200);
}

/** 真实 `GET /api/dashboard` 的完整响应体（不做任何形状假设）。 */
async function getDashboard(token: string): Promise<{ status: number; body: any }> {
  return request(server as never)
    .get(`${API}/dashboard`)
    .set(auth(token))
    .then((r) => ({ status: r.status, body: r.body }));
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });

  freshToken = await login(FRESH);
  onboardedToken = await login(ONBOARDED);
  await onboard(onboardedToken);
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: EMAILS } } });
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  }
  if (app !== undefined) await app.close();
});

// ---------------------------------------------------------------------------
// 1 · ★ 核心契约：未引导时服务端返回的是「完整对象 + goal/budget 为 null」，
//      而**不是** `data: null`。前端若用 `data === null` 判未引导，必然出错。
// ---------------------------------------------------------------------------

describe('GET /dashboard · 未引导的载荷形状（前端判据的事实基础）', () => {
  it('★ 未引导 → 200，且 data 是完整对象（不是 null）', async () => {
    const { status, body } = await getDashboard(freshToken);

    expect(status).toBe(200);
    expect(body.error).toBeNull();
    // 关键：data 绝不为 null —— 它是一个对象
    expect(body.data).not.toBeNull();
    expect(typeof body.data).toBe('object');
    // 且带有完整字段（前端会直接读它们）
    for (const key of [
      'date',
      'goal',
      'budget',
      'intakeKcal',
      'remainingKcal',
      'progressRatio',
      'waterMl',
      'waterGoalMl',
      'miniTrend',
      'encouragement',
      'warnings',
    ]) {
      expect(body.data, `未引导载荷应含字段 ${key}`).toHaveProperty(key);
    }
  });

  it('★ 未引导 → goal 与 budget 同时为 null（这才是「未引导」的判据）', async () => {
    const { body } = await getDashboard(freshToken);
    expect(body.data.goal).toBeNull();
    expect(body.data.budget).toBeNull();
  });

  it('未引导时 budget 是 null 而非 0 值对象（前端「无预算」分流有真实依据）', async () => {
    const { body } = await getDashboard(freshToken);
    // 若这里是 { intakeRecommended: 0, ... }，前端会把「没预算」显示成「还能吃 0 kcal」
    expect(body.data.budget).toBeNull();
    expect(body.data.remainingKcal).toBe(0);
    expect(body.data.progressRatio).toBe(0);
  });

  it('未引导时 miniTrend 仍是 7 天数组（不是缺字段）', async () => {
    const { body } = await getDashboard(freshToken);
    expect(Array.isArray(body.data.miniTrend)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 · 已引导 → goal / budget 非空（与未引导可区分）
// ---------------------------------------------------------------------------

describe('GET /dashboard · 已引导的载荷形状', () => {
  it('已引导 → goal 与 budget 都非空', async () => {
    const { status, body } = await getDashboard(onboardedToken);
    expect(status).toBe(200);
    expect(body.data.goal).not.toBeNull();
    expect(body.data.goal.targetWeightKg).toBe(55);
    expect(body.data.budget).not.toBeNull();
    expect(body.data.budget.intakeRecommended).toBeGreaterThan(0);
  });

  it('★ 两个账号的判据互斥：恰好一方 goal===null && budget===null', async () => {
    const fresh = (await getDashboard(freshToken)).body.data;
    const done = (await getDashboard(onboardedToken)).body.data;

    const isUnguided = (d: any): boolean => d.goal === null && d.budget === null;
    expect(isUnguided(fresh), '未引导账号应被该判据识别').toBe(true);
    expect(isUnguided(done), '已引导账号不应被该判据识别').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 · 鉴权
// ---------------------------------------------------------------------------

describe('GET /dashboard · 鉴权', () => {
  it('无 token → 401', async () => {
    await request(server as never).get(`${API}/dashboard`).expect(401);
  });
});
