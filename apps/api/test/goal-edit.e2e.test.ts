/**
 * `PATCH /api/goals` 端到端测试 —— 「引导后仍可改目标」的接线与语义（AC-11.2.7）。
 *
 * ## 背景（这是一条**真缺口**的回归保护）
 *
 * 目标体重 / 目标期限此前**只在首次引导问卷能设**：后端 `PATCH /goals` 早已存在且完整，
 * 但前端零调用。达成目标进入「维持模式」后，用户没有任何入口设新目标 ——
 * 对一个减重产品这很反直觉。本次补上前端入口，本文件把后端契约钉死。
 *
 * ## 本文件覆盖（含一条最有价值的实证）
 *
 * 1. `PATCH /goals { targetWeightKg }` → 200 且目标**真的**变更（`GET /profile` 复核）；
 * 2. **部分更新**：只传 `targetWeightKg` 时 `targetWeeks` / `macroRatio` / `startWeightKg` 原样保留；
 * 3. ★ **AC-11.2.7 实证**：先造出「已达成目标」状态 → `GET /weights/trend` 的
 *    `goalProgress.maintenance === true` → `PATCH /goals` 把目标改低 → `maintenance` 变 `false`
 *    （证明「修改目标后自动退出维持模式」真的成立 —— 它是**派生值**，无需专门写退出逻辑）；
 * 4. 越界值 → 400（体重 <20 / >400、期限 <1 / >260）；
 * 5. 无 token → 401；
 * 6. 未完成引导的账号 → 404（`E_NOTFOUND_PROFILE`）；
 * 7. `weight_goal_history` 追加语义：仅当 `goalChanged`（target 类字段变更）为真时 +1。
 *
 * ## 机制
 *
 * 与既有 e2e 同机制：通过 Node 原生 `require` 加载 `nest build` 产出的 `dist/**`。
 * 运行前必须 `npm run build -w @qsh/api`。
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
const USER_A = 'e2e-goal-edit-a@qinglife.test';
const USER_B = 'e2e-goal-edit-b@qinglife.test';
const USER_C = 'e2e-goal-edit-c@qinglife.test';
const EMAILS = [USER_A, USER_B, USER_C];

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let userAId = 0;
let tokenB = '';
let tokenC = '';
let userCId = 0;

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 验证码登录，返回令牌与用户 id。 */
async function login(email: string): Promise<{ token: string; userId: number }> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') throw new Error(`未取到 ${email} 的验证码回显`);
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  const data = verified.body.data as { accessToken: string; user: { id: number } };
  return { token: data.accessToken, userId: data.user.id };
}

/** 提交引导问卷（每次开户时种下一条当日体重 + 一条目标历史）。 */
async function onboard(
  token: string,
  body: {
    currentWeightKg: number;
    targetWeightKg: number;
    targetWeeks: number;
  },
): Promise<void> {
  await request(server as never)
    .post(`${API}/onboarding`)
    .set(auth(token))
    .send({
      gender: 'female',
      birthDate: '1995-01-01',
      heightCm: 165,
      activityLevel: 'sedentary',
      dietaryPreference: [],
      conditions: [],
      disclaimerAccepted: true,
      ...body,
    })
    .expect(200);
}

/** `GET /profile` 的 `goal` 子对象。 */
async function getGoal(token: string): Promise<Record<string, any>> {
  const res = await request(server as never).get(`${API}/profile`).set(auth(token)).expect(200);
  return res.body.data.goal as Record<string, any>;
}

/** `GET /weights/trend` 的 `goalProgress`（无生效目标 → null）。 */
async function getGoalProgress(token: string): Promise<Record<string, any> | null> {
  const res = await request(server as never).get(`${API}/weights/trend`).set(auth(token)).expect(200);
  return res.body.data.goalProgress as Record<string, any> | null;
}

/** 直接 `PATCH /goals`，不 assert，便于断言各种状态码。 */
function patchGoal(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return request(server as never)
    .patch(`${API}/goals`)
    .set(auth(token))
    .send(body)
    .then((res) => ({ status: res.status, body: res.body }));
}

/** 某用户的目标历史条数。 */
function historyCount(userId: number): Promise<number> {
  return prisma.weightGoalHistory.count({ where: { userId } });
}

/** 记录一条体重（同日覆盖）—— 用于把用户「带到」目标附近。 */
async function recordWeight(token: string, weightKg: number): Promise<void> {
  await request(server as never)
    .post(`${API}/weights`)
    .set(auth(token))
    .send({ weightKg })
    .expect(200);
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

  const a = await login(USER_A);
  tokenA = a.token;
  userAId = a.userId;
  const b = await login(USER_B);
  tokenB = b.token;
  const c = await login(USER_C);
  tokenC = c.token;
  userCId = c.userId;

  // A：普通减重目标（60 → 55，12 周）
  await onboard(tokenA, { currentWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
  // C：减重目标（60 → 55，12 周）—— 具体「已达成」状态由下面那条用例自己造出来
  await onboard(tokenC, { currentWeightKg: 60, targetWeightKg: 55, targetWeeks: 12 });
  // B：不引导（未完成问卷）
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: EMAILS } } });
    await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  }
  if (app !== undefined) await app.close();
});

// ---------------------------------------------------------------------------
// 1 · 目标真的能改（AC-11.2.7 的前半句：引导后仍可修改目标）
// ---------------------------------------------------------------------------

describe('PATCH /goals · 目标真的能改', () => {
  it('PATCH { targetWeightKg } → 200，且 GET /profile 复核目标已变更', async () => {
    const res = await patchGoal(tokenA, { targetWeightKg: 52 });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect((res.body.data.goal as { targetWeightKg: number }).targetWeightKg).toBe(52);

    const goal = await getGoal(tokenA);
    expect(goal.targetWeightKg).toBe(52);
  });

  it('PATCH { targetWeeks } → 200，期限落库', async () => {
    const res = await patchGoal(tokenA, { targetWeeks: 20 });
    expect(res.status).toBe(200);
    expect((res.body.data.goal as { targetWeeks: number }).targetWeeks).toBe(20);
    expect((await getGoal(tokenA)).targetWeeks).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// 2 · 部分更新语义（只传改动字段，其余原样保留）
// ---------------------------------------------------------------------------

describe('PATCH /goals · 部分更新', () => {
  it('★ 只传 targetWeightKg 时，targetWeeks / macroRatio / startWeightKg 均保持不变', async () => {
    // 先把已知状态做成确定的：期限 12 周、起始体重 60、目标 55
    await patchGoal(tokenA, { targetWeightKg: 55, targetWeeks: 12, currentWeightKg: 60 });
    const before = await getGoal(tokenA);
    expect(before.targetWeightKg).toBe(55);
    expect(before.targetWeeks).toBe(12);
    expect(before.startWeightKg).toBe(60);

    const res = await patchGoal(tokenA, { targetWeightKg: 51 });
    expect(res.status).toBe(200);

    const after = await getGoal(tokenA);
    expect(after.targetWeightKg).toBe(51); // 改了的：变了
    expect(after.targetWeeks).toBe(before.targetWeeks); // 没传的：原样保留
    expect(after.startWeightKg).toBe(before.startWeightKg); // 没传的：原样保留
    expect(after.macroRatio).toEqual(before.macroRatio); // 没传的：原样保留
  });
});

// ---------------------------------------------------------------------------
// 3 · ★ 核心实证：改目标 → 自动退出维持模式（AC-11.2.7）
// ---------------------------------------------------------------------------

describe('PATCH /goals · ★ 改目标自动退出维持模式（AC-11.2.7 实证）', () => {
  it('已达成（maintenance=true）→ 把目标改低 → maintenance 变 false', async () => {
    // ① 造出「已达成」状态：把今天的体重记成 55（= 目标 55）→ 当前体重 ≤ 目标体重
    //    （引擎硬校验要求 targetWeightKg ≤ 当前体重，故不能反过来把目标设到当前体重之上，
    //     只能把**当前体重**记到目标值 —— 这也正是「达成目标」在真实使用里的样子）
    await recordWeight(tokenC, 55);

    const before = await getGoalProgress(tokenC);
    expect(before, '有生效目标时应返回 goalProgress').not.toBeNull();
    expect(before?.latestKg).toBe(55);
    expect(before?.reached).toBe(true);
    expect(before?.maintenance).toBe(true);
    // 维持模式下不下发「还需几周」
    expect(before?.etaWeeks).toBeNull();

    // ② 把目标改到当前体重之下 → 重新构成「还没到」
    const res = await patchGoal(tokenC, { targetWeightKg: 50 });
    expect(res.status).toBe(200);

    const after = await getGoalProgress(tokenC);
    expect(after).not.toBeNull();
    expect(after?.targetWeightKg).toBe(50);
    expect(after?.maintenance).toBe(false);
    expect(after?.reached).toBe(false);
    // 维持热量随之撤下（非维持模式为 null）
    expect(after?.maintenanceKcal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4 · 越界值 → 400（与 DTO 的 @Min / @Max 对齐）
// ---------------------------------------------------------------------------

describe('PATCH /goals · 越界值 400（对齐 UpdateGoalDto 范围）', () => {
  it('当前体重 < 20 → 400', async () => {
    const res = await patchGoal(tokenA, { currentWeightKg: 19 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.fields.currentWeightKg).toBeDefined();
  });

  it('当前体重 > 400 → 400', async () => {
    const res = await patchGoal(tokenA, { currentWeightKg: 401 });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.currentWeightKg).toBeDefined();
  });

  it('目标期限 < 1 → 400', async () => {
    const res = await patchGoal(tokenA, { targetWeeks: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.targetWeeks).toBeDefined();
  });

  it('目标期限 > 260 → 400', async () => {
    const res = await patchGoal(tokenA, { targetWeeks: 261 });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.targetWeeks).toBeDefined();
  });

  it('目标期限非整数 → 400', async () => {
    const res = await patchGoal(tokenA, { targetWeeks: 12.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.targetWeeks).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5 · 鉴权 / 引导前置
// ---------------------------------------------------------------------------

describe('PATCH /goals · 鉴权与前置校验', () => {
  it('无 token → 401', async () => {
    const res = await request(server as never)
      .patch(`${API}/goals`)
      .send({ targetWeightKg: 50 })
      .then((r) => ({ status: r.status, body: r.body }));
    expect(res.status).toBe(401);
  });

  it('未完成引导的账号 → 404 E_NOTFOUND_PROFILE', async () => {
    const res = await patchGoal(tokenB, { targetWeightKg: 50 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_PROFILE');
  });
});

// ---------------------------------------------------------------------------
// 6 · weight_goal_history 追加语义（goalChanged 为真才追加）
// ---------------------------------------------------------------------------

describe('PATCH /goals · weight_goal_history 追加', () => {
  it('★ target 类字段变更（goalChanged=true）→ 历史 +1', async () => {
    const before = await historyCount(userAId);
    await patchGoal(tokenA, { targetWeightKg: 54 });
    const after = await historyCount(userAId);
    expect(after).toBe(before + 1);
  });

  it('仅改当前体重（goalChanged=false）→ 不追加目标历史', async () => {
    const before = await historyCount(userAId);
    const res = await patchGoal(tokenA, { currentWeightKg: 61 });
    expect(res.status).toBe(200);
    const after = await historyCount(userAId);
    expect(after).toBe(before);
  });

  it('追加的历史记录内容与当时的目标一致', async () => {
    await patchGoal(tokenA, { targetWeightKg: 53, targetWeeks: 16 });
    const latest = await prisma.weightGoalHistory.findFirst({
      where: { userId: userAId },
      orderBy: [{ id: 'desc' }],
    });
    expect(latest).not.toBeNull();
    expect(latest?.targetWeightKg).toBe(53);
    expect(latest?.targetWeeks).toBe(16);
  });
});
