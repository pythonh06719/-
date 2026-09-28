/**
 * 运动记录删除端到端测试（GAP-5，`DELETE /api/exercises/:id`）。
 *
 * 为什么单开一个文件：`DELETE /exercises/:id` 后端早已实现（controller L44-47、
 * service L74-82），但**此前零测试覆盖** —— 越权防护（他人记录 → 404）与
 * 「删除后汇总随之变化」这两条最容易在重构中被改坏，必须有回归网兜住。
 *
 * 覆盖点：
 * 1. 删自己的记录 → `{ deleted: true }`；
 * 2. **删他人记录 → 404 `E_NOTFOUND_EXERCISE`**（越权防护，最重要）；
 * 3. 删不存在的 id → 404；
 * 4. 无 token → 401；
 * 5. 删除后该记录不在 `GET /exercises` 列表里，且 `totalKcal` 相应减少（核心价值）；
 * 6. 跨用户隔离：A 删 B 的记录后，B 的记录仍在（真的没被删掉）。
 *
 * ⚠️ 与 `r11x.e2e.test.ts` 同机制：**加载 `dist/**` 编译产物**（esbuild 不生成
 * NestJS 依赖注入所需的装饰器元数据）。运行前需 `nest build`。
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
const USER_A = 'e2e-exdel-a@qinglife.test';
const USER_B = 'e2e-exdel-b@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

let tokenA = '';
let tokenB = '';

/** 今天（服务端本地日粒度）。 */
const today = toLocalDateKey(new Date());

/** 认证头。 */
function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 登录（自用模式回显验证码，避免依赖日志抓取）。 */
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

/** 记一条运动，返回落库形态。 */
async function createExercise(
  token: string,
  input: { activityCode: string; minutes: number; date?: string },
): Promise<{ id: number; kcalBurned: number; activityName: string }> {
  const res = await request(server as never)
    .post(`${API}/exercises`)
    .set(auth(token))
    .send({ activityCode: input.activityCode, minutes: input.minutes, loggedDate: input.date ?? today })
    .expect(200);
  expect(res.body.error).toBeNull();
  return res.body.data as { id: number; kcalBurned: number; activityName: string };
}

/** 取某日运动列表。 */
async function listExercises(
  token: string,
): Promise<{ logs: Array<{ id: number; kcalBurned: number }>; totalKcal: number }> {
  const res = await request(server as never)
    .get(`${API}/exercises`)
    .query({ date: today })
    .set(auth(token))
    .expect(200);
  return res.body.data as { logs: Array<{ id: number; kcalBurned: number }>; totalKcal: number };
}

beforeAll(async () => {
  // 自用模式：让 `/auth/send-code` 回显验证码（不依赖 .env，避免假阴性）
  process.env.AUTH_LOG_CODE = 'true';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // 全局前缀在 `main.ts` 里设置，测试需自己补上
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
  prisma = moduleRef.get<PrismaServiceClass>(PrismaService);

  await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });

  tokenA = await login(USER_A);
  tokenB = await login(USER_B);
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
    await prisma.user.deleteMany({ where: { email: { in: [USER_A, USER_B] } } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

describe('GAP-5 · DELETE /api/exercises/:id', () => {
  it('删自己的记录 → { deleted: true }', async () => {
    const created = await createExercise(tokenA, { activityCode: 'walking_brisk', minutes: 30 });

    const res = await request(server as never)
      .delete(`${API}/exercises/${created.id}`)
      .set(auth(tokenA))
      .expect(200);

    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual({ deleted: true });
  });

  it('★ 删他人记录 → 404 E_NOTFOUND_EXERCISE（越权防护，且他人的记录仍在）', async () => {
    const ownedByB = await createExercise(tokenB, { activityCode: 'running', minutes: 20 });

    const res = await request(server as never)
      .delete(`${API}/exercises/${ownedByB.id}`)
      .set(auth(tokenA))
      .expect(404);

    expect(res.body.error.code).toBe('E_NOTFOUND_EXERCISE');

    // 关键：越权删除**没有**真的删掉 B 的记录
    const stillThere = await prisma.exerciseLog.findUnique({ where: { id: ownedByB.id } });
    expect(stillThere).not.toBeNull();
  });

  it('删不存在的 id → 404 E_NOTFOUND_EXERCISE', async () => {
    const res = await request(server as never)
      .delete(`${API}/exercises/99999999`)
      .set(auth(tokenA))
      .expect(404);

    expect(res.body.error.code).toBe('E_NOTFOUND_EXERCISE');
  });

  it('无 token → 401', async () => {
    const created = await createExercise(tokenA, { activityCode: 'walking_brisk', minutes: 15 });
    const res = await request(server as never).delete(`${API}/exercises/${created.id}`).expect(401);
    expect(res.body.error).not.toBeNull();
  });

  it('★ 删除后该记录不在列表里，且 totalKcal 相应减少（核心价值）', async () => {
    // 两条独立记录，删除其中一条
    const first = await createExercise(tokenA, { activityCode: 'walking_brisk', minutes: 30 });
    const second = await createExercise(tokenA, { activityCode: 'running', minutes: 40 });

    const before = await listExercises(tokenA);
    const beforeIds = before.logs.map((log) => log.id);
    expect(beforeIds).toContain(first.id);
    expect(beforeIds).toContain(second.id);
    const totalBefore = before.totalKcal;

    await request(server as never)
      .delete(`${API}/exercises/${first.id}`)
      .set(auth(tokenA))
      .expect(200);

    const after = await listExercises(tokenA);
    const afterIds = after.logs.map((log) => log.id);
    // 该记录确实不在了
    expect(afterIds).not.toContain(first.id);
    expect(afterIds).toContain(second.id);
    // totalKcal 相应减少（按 1 位小数口径，与后端一致）
    const expected = Math.round((totalBefore - first.kcalBurned) * 10) / 10;
    expect(after.totalKcal).toBeCloseTo(expected, 5);
    expect(after.totalKcal).toBeLessThan(totalBefore);
  });

  it('重复删除同一条 → 第二次 404（幂等语义即「已不在」）', async () => {
    const created = await createExercise(tokenA, { activityCode: 'cycling_leisure', minutes: 25 });

    await request(server as never)
      .delete(`${API}/exercises/${created.id}`)
      .set(auth(tokenA))
      .expect(200);

    const again = await request(server as never)
      .delete(`${API}/exercises/${created.id}`)
      .set(auth(tokenA))
      .expect(404);
    expect(again.body.error.code).toBe('E_NOTFOUND_EXERCISE');
  });
});
