/**
 * GAP-11（习惯停用）+ GAP-3（饮水目标范围收口）端到端测试。
 *
 * ## 为什么不测「删除」而有「停用」
 *
 * `HabitCheckin.habitId` 的外键是 `onDelete: Cascade`。真删除一个习惯会**级联清空它的
 * 全部历史打卡**，导致历史周报的 `habitsDone` / `habitsTotal` 数字被改写，并违背
 * 「无负罪感」原则。因此接口语义是**停用**（`isActive=false`），历史打卡原样保留。
 * 本文件用两条断言把这个设计**钉死**：
 * 1. 停用后 `GET /report/weekly` 不再计入该习惯（`habitsTotal` 减少）；
 * 2. 停用后该习惯的历史 `HabitCheckin` 仍在库里（未被级联删除）。
 *
 * ## 机制
 *
 * 与既有 e2e 同机制：通过 Node 原生 `require` 加载 `nest build` 产出的 `dist/**`
 * （tsc 产物带装饰器元数据）。运行前必须 `npm run build -w @qsh/api`。
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
const core = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const { toLocalDateKey } = core;

const API = '/api';
const USER_A = 'e2e-habits-goal-a@qinglife.test';
const USER_B = 'e2e-habits-goal-b@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let tokenA = '';
let tokenB = '';
let userIdA = 0;
let userIdB = 0;

const today = toLocalDateKey(new Date());

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

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

/** 直接经接口创建一个自定义习惯，返回其 id。 */
async function createHabit(token: string, code: string, name: string): Promise<number> {
  const res = await request(server as never)
    .post(`${API}/habits`)
    .set(auth(token))
    .send({ code, name })
    .expect(200);
  expect(res.body.error).toBeNull();
  return (res.body.data as { id: number }).id;
}

/** 停用调用（不 assert，便于断言各种状态码）。 */
function deactivate(token: string, id: number): Promise<{ status: number; body: any }> {
  return request(server as never)
    .patch(`${API}/habits/${id}`)
    .set(auth(token))
    .then((res) => ({ status: res.status, body: res.body }));
}

/** 读取周报，返回 `{ habitTotalByDay, ... }`。 */
async function weekly(token: string): Promise<{
  habitTotals: number[];
  habitDones: number[];
}> {
  const res = await request(server as never)
    .get(`${API}/report/weekly`)
    .query({ endDate: today })
    .set(auth(token))
    .expect(200);
  const days = (res.body.data as { days: Array<{ habitsTotal: number; habitsDone: number }> }).days;
  return {
    habitTotals: days.map((day) => day.habitsTotal),
    habitDones: days.map((day) => day.habitsDone),
  };
}

beforeAll(async () => {
  process.env.AUTH_LOG_CODE = 'true';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });

  // 隔离：复位全局内置习惯模板（`userId=null`）的 isActive ——
  // 本测试会「尝试」停用内置模板，且历史中断的运行可能留下 isActive=false 的残留，
  // 故每次开跑前先恢复到种子初始态，保证 `habitsTotal` 基数可预测、内置保护断言稳定。
  await prisma.habitDefinition.updateMany({ where: { userId: null }, data: { isActive: true } });

  const a = await login(USER_A);
  const b = await login(USER_B);
  tokenA = a.token;
  userIdA = a.userId;
  tokenB = b.token;
  userIdB = b.userId;
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  }
  if (app !== undefined) await app.close();
});

// ---------------------------------------------------------------------------
// GAP-11 · 习惯停用
// ---------------------------------------------------------------------------

describe('GAP-11 · 停用自己的习惯', () => {
  it('PATCH /habits/:id → 200 且 isActive 变为 false', async () => {
    const habitId = await createHabit(tokenA, `act_${Date.now()}`, '测试习惯');
    const res = await deactivate(tokenA, habitId);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect((res.body.data as { isActive: boolean }).isActive).toBe(false);

    // 落库确认
    const row = await prisma.habitDefinition.findUnique({ where: { id: habitId } });
    expect(row?.isActive).toBe(false);
  });

  it('重复停用（幂等）→ 仍返回成功', async () => {
    const habitId = await createHabit(tokenA, `idem_${Date.now()}`, '幂等习惯');
    const first = await deactivate(tokenA, habitId);
    const second = await deactivate(tokenA, habitId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.error).toBeNull();
    expect((second.body.data as { isActive: boolean }).isActive).toBe(false);
  });
});

describe('GAP-11 · 越权与内置保护（最重要）', () => {
  it('停用**他人**的习惯 → 404（且不泄露存在性）', async () => {
    const habitId = await createHabit(tokenA, `foreign_${Date.now()}`, '他人习惯');
    const res = await deactivate(tokenB, habitId);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_HABIT');

    // 证明 token B 的确没能改动 token A 的习惯
    const row = await prisma.habitDefinition.findUnique({ where: { id: habitId } });
    expect(row?.isActive).toBe(true);
    expect(row?.userId).toBe(userIdA);
  });

  it('停用**内置模板**（userId=null）→ 404（防止改全局模板）', async () => {
    const builtin = await prisma.habitDefinition.findFirst({ where: { userId: null } });
    expect(builtin, '种子应包含 userId=null 的内置习惯模板').not.toBeNull();

    // 隔离：先前中断的运行可能留下 isActive=false 的内置模板，先复位再断言「本次调用未改动它」
    await prisma.habitDefinition.update({ where: { id: builtin!.id }, data: { isActive: true } });

    const res = await deactivate(tokenA, builtin!.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_HABIT');

    // 内置模板的 isActive 必须原样保留（且真正是 null 归属）
    const after = await prisma.habitDefinition.findUnique({ where: { id: builtin!.id } });
    expect(after?.isActive).toBe(true);
    expect(after?.userId).toBeNull();
  });

  it('停用不存在的 id → 404', async () => {
    const res = await deactivate(tokenA, 987654321);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_HABIT');
  });

  it('无 token → 401', async () => {
    const habitId = await createHabit(tokenA, `noauth_${Date.now()}`, '无鉴权习惯');
    const res = await request(server as never)
      .patch(`${API}/habits/${habitId}`)
      .send({})
      .then((r) => ({ status: r.status, body: r.body }));
    expect(res.status).toBe(401);
  });
});

describe('GAP-11 · 停用 ≠ 删除（设计核心保证）', () => {
  it('停用后 GET /report/weekly 不再计入该习惯（habitsTotal 减少）', async () => {
    // 先记录停用前某天的 habitsTotal（取周报首日）
    const before = await weekly(tokenA);
    const beforeTotal = before.habitTotals[0]!;

    const habitId = await createHabit(tokenA, `weekly_${Date.now()}`, '周报习惯');
    const withHabit = await weekly(tokenA);
    expect(withHabit.habitTotals[0]).toBe(beforeTotal + 1);

    await deactivate(tokenA, habitId);
    const after = await weekly(tokenA);
    expect(after.habitTotals[0]).toBe(beforeTotal);
    // 停用项不再出现在统计里
    expect(after.habitTotals[0]).toBe(withHabit.habitTotals[0]! - 1);
  });

  it('停用后该习惯的历史 HabitCheckin 仍在库中（未被级联删除）', async () => {
    const habitId = await createHabit(tokenA, `keep_${Date.now()}`, '历史打卡习惯');

    // 打两次卡（今天 + 昨天）
    const yesterday = toLocalDateKey(new Date(Date.now() - 86400000));
    await request(server as never)
      .post(`${API}/habits/${habitId}/check`)
      .set(auth(tokenA))
      .send({ done: true })
      .expect(200);
    await request(server as never)
      .post(`${API}/habits/${habitId}/check`)
      .set(auth(tokenA))
      .send({ done: true, loggedDate: yesterday })
      .expect(200);

    const beforeCount = await prisma.habitCheckin.count({ where: { userId: userIdA, habitId } });
    expect(beforeCount).toBe(2);

    await deactivate(tokenA, habitId);

    const afterCount = await prisma.habitCheckin.count({ where: { userId: userIdA, habitId } });
    expect(afterCount).toBe(2); // 历史打卡一条不少
    const habitStillExists = await prisma.habitDefinition.findUnique({ where: { id: habitId } });
    expect(habitStillExists).not.toBeNull(); // 习惯本体也还在（只是停用）
  });
});

// ---------------------------------------------------------------------------
// GAP-3 · 饮水目标范围收口
// ---------------------------------------------------------------------------

/** 经设置通道改饮水目标（前端实际使用的 `/users/settings` 路径）。 */
function patchSettings(token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return request(server as never)
    .patch(`${API}/users/settings`)
    .set(auth(token))
    .send(body)
    .then((res) => ({ status: res.status, body: res.body }));
}

/** 经饮水通道改饮水目标。 */
function patchWaterGoal(token: string, waterGoalMl: number): Promise<{ status: number; body: any }> {
  return request(server as never)
    .patch(`${API}/water/goal`)
    .set(auth(token))
    .send({ waterGoalMl })
    .then((res) => ({ status: res.status, body: res.body }));
}

describe('GAP-3 · PATCH /users/settings 的 waterGoalMl 范围', () => {
  it('8001 → 400（超上限 8000，恰在上界之外）', async () => {
    const res = await patchSettings(tokenA, { waterGoalMl: 8001 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.fields.waterGoalMl).toBeDefined();
  });

  it('300 → 400（低于下限 500）', async () => {
    const res = await patchSettings(tokenA, { waterGoalMl: 300 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.fields.waterGoalMl).toBeDefined();
  });

  it('2000 → 200 且落库', async () => {
    const res = await patchSettings(tokenA, { waterGoalMl: 2000 });
    expect(res.status).toBe(200);
    expect((res.body.data as { waterGoalMl: number }).waterGoalMl).toBe(2000);
    const row = await prisma.userSettings.findUnique({ where: { userId: userIdA } });
    expect(row?.waterGoalMl).toBe(2000);
  });

  it('边界 500 与 8000 → 200（可过）', async () => {
    expect((await patchSettings(tokenA, { waterGoalMl: 500 })).status).toBe(200);
    expect((await patchSettings(tokenA, { waterGoalMl: 8000 })).status).toBe(200);
  });

  it('不传 waterGoalMl 时其他字段仍可单独更新（保留部分更新语义）', async () => {
    const res = await patchSettings(tokenA, { unit: 'kj', darkMode: true, fastingEnabled: true });
    expect(res.status).toBe(200);
    const data = res.body.data as { unit: string; darkMode: boolean; fastingEnabled: boolean; waterGoalMl: number };
    expect(data.unit).toBe('kj');
    expect(data.darkMode).toBe(true);
    expect(data.fastingEnabled).toBe(true);
    // 未传的 waterGoalMl 保持上一次的值（8000），不应被重置
    expect(data.waterGoalMl).toBe(8000);
  });
});

describe('GAP-3 · 设置通道路径一致性（/settings 与 /users/settings 同源）', () => {
  it('/settings 与 /users/settings 对同一 body 给出相同 status 与落库值', async () => {
    const legacy = await request(server as never)
      .patch(`${API}/settings`)
      .set(auth(tokenA))
      .send({ waterGoalMl: 2500 });
    const canonical = await request(server as never)
      .patch(`${API}/users/settings`)
      .set(auth(tokenA))
      .send({ waterGoalMl: 2500 });
    expect(legacy.status).toBe(200);
    expect(canonical.status).toBe(200);
    expect((canonical.body.data as { waterGoalMl: number }).waterGoalMl).toBe(2500);
  });

  it('/settings 越界值同样 400（别名不绕过校验）', async () => {
    const res = await request(server as never)
      .patch(`${API}/settings`)
      .set(auth(tokenA))
      .send({ waterGoalMl: 300 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
  });
});

describe('GAP-3 · 两条通道对同一值行为一致（防再次跑偏）', () => {
  it('300 → 设置通道与饮水通道都 400', async () => {
    const viaSettings = await patchSettings(tokenB, { waterGoalMl: 300 });
    const viaWater = await patchWaterGoal(tokenB, 300);
    expect(viaSettings.status).toBe(400);
    expect(viaWater.status).toBe(400);
    expect(viaSettings.status).toBe(viaWater.status);
  });

  it('9000 → 两条通道都 400', async () => {
    const viaSettings = await patchSettings(tokenB, { waterGoalMl: 9000 });
    const viaWater = await patchWaterGoal(tokenB, 9000);
    expect(viaSettings.status).toBe(400);
    expect(viaWater.status).toBe(400);
  });

  it('2000 → 两条通道都 200', async () => {
    const viaSettings = await patchSettings(tokenB, { waterGoalMl: 2000 });
    const viaWater = await patchWaterGoal(tokenB, 2000);
    expect(viaSettings.status).toBe(200);
    expect(viaWater.status).toBe(200);
  });

  it('边界 500 与 8000 → 两条通道都 200', async () => {
    for (const value of [500, 8000]) {
      expect((await patchSettings(tokenB, { waterGoalMl: value })).status, `settings ${value}`).toBe(200);
      expect((await patchWaterGoal(tokenB, value)).status, `water ${value}`).toBe(200);
    }
  });
});
