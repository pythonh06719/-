/**
 * `GET /api/ai/usage` 端到端测试（B6：AI 页面显示剩余次数）。
 *
 * 覆盖：
 * 1. 未登录 → 401；
 * 2. 新用户 → 已用 0 / 上限 50 / 剩余 50；
 * 3. **计数正确**：以 `ai_usage` 当日各功能行 `request_count` 合计为准 ——
 *    调两次 daily-summary → 已用 2、剩余 48；再调一次食物识别 → 已用 3、剩余 47；
 * 4. 医疗安全闸的回答**不消耗次数**（R9.6 原有口径，本用例钉死它不被 B6 改动破坏）；
 * 5. 用满 50 → 下一次请求 429 `E_LIMIT_AI`，且 usage 仍为「已用 50 / 剩余 0」（回退后不留脏计数）；
 * 6. **AI 未配置时降级不报错**：全程 `AI_ENABLED=false`，usage 一律 200，
 *    daily-summary 也照旧 200 + 规则兜底（不得 500 / 不得因取不到 usage 而崩）。
 *
 * ⚠️ 与 `ai.e2e.test.ts` 同机制：加载 `dist/**` 编译产物（装饰器元数据），
 * 并在自身内部固定 `AI_ENABLED=false`，绝不发起真实 LLM 请求。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

// 必须在创建应用之前设置：AI 开关在每次调用时读取环境变量（见 app-config.ts）
process.env.AI_ENABLED = 'false';

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
const { toLocalDateKey } = require('../dist/packages/core/src/index.js') as typeof import('@qsh/core');

const API = '/api';
const USER_USAGE = 'e2e-ai-usage@qinglife.test';
const USER_LIMIT = 'e2e-ai-usage-limit@qinglife.test';
const USER_FALLBACK = 'e2e-ai-usage-fallback@qinglife.test';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

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

/** 注册并返回令牌与用户 id。 */
async function register(email: string): Promise<{ token: string; userId: number }> {
  await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = findCode(email);
  const res = await request(server as never).post(`${API}/auth/verify-code`).send({ email, code }).expect(200);
  const body = res.body.data as { accessToken: string; user: { id: number } };
  return { token: body.accessToken, userId: body.user.id };
}

/** 读一次用量（统一解包 `{ data, error }`）。 */
async function readUsage(token: string): Promise<{ date: string; used: number; limit: number; remaining: number }> {
  const res = await request(server as never).get(`${API}/ai/usage`).set(auth(token)).expect(200);
  expect(res.body.error).toBeNull();
  return res.body.data as { date: string; used: number; limit: number; remaining: number };
}

/** 把某用户当日用量直接置成 n（模拟「今天已经用了很多次」，避免真跑 50 次请求）。 */
async function seedUsage(userId: number, count: number): Promise<void> {
  await prisma.aiUsage.deleteMany({ where: { userId, usageDate: today } });
  await prisma.aiUsage.create({
    data: { userId, usageDate: today, feature: 'daily_summary', requestCount: count },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [USER_USAGE, USER_LIMIT, USER_FALLBACK] } },
  });
  await app?.close();
});

describe('GET /api/ai/usage（B6 剩余次数）', () => {
  it('未携带令牌 → 401', async () => {
    await request(server as never).get(`${API}/ai/usage`).expect(401);
  });

  it('新用户：已用 0 / 上限 50 / 剩余 50，且查用量本身不计数', async () => {
    const { token } = await register(USER_USAGE);

    const first = await readUsage(token);
    expect(first.date).toBe(today);
    expect(first.used).toBe(0);
    expect(first.limit).toBe(50);
    expect(first.remaining).toBe(50);

    // 纯读：连查两次，已用依然是 0
    const second = await readUsage(token);
    expect(second.used).toBe(0);
    expect(second.remaining).toBe(50);
  });

  it('计数正确：两次 daily-summary + 一次食物识别 → 已用 3 / 剩余 47', async () => {
    const { token, userId } = await register(USER_USAGE);
    // 复用同一账号时先清零，断言才稳定
    await prisma.aiUsage.deleteMany({ where: { userId, usageDate: today } });

    expect((await readUsage(token)).used).toBe(0);

    // AI 未配置：daily-summary 仍返回 200（规则兜底），且不报错
    await request(server as never).post(`${API}/ai/daily-summary`).set(auth(token)).send({}).expect(200);
    await request(server as never).post(`${API}/ai/daily-summary`).set(auth(token)).send({}).expect(200);
    const afterTwo = await readUsage(token);
    expect(afterTwo.used).toBe(2);
    expect(afterTwo.remaining).toBe(48);

    await request(server as never)
      .post(`${API}/ai/recognize-food`)
      .set(auth(token))
      .send({ description: '一杯豆浆' })
      .expect(200);
    const afterThree = await readUsage(token);
    expect(afterThree.used).toBe(3);
    expect(afterThree.remaining).toBe(47);
    expect(afterThree.limit).toBe(50);
  });

  it('医疗安全闸的回答不消耗次数（R9.6 口径不被 B6 破坏）', async () => {
    const { token, userId } = await register(USER_USAGE);

    const before = await readUsage(token);
    const res = await request(server as never)
      .post(`${API}/ai/free-ask`)
      .set(auth(token))
      .send({ question: '我今天有点头晕，怎么办' })
      .expect(200);
    expect(res.body.data.safetyFlag).toBe(true);

    const after = await readUsage(token);
    expect(after.used).toBe(before.used);
    expect(userId).toBeGreaterThan(0);
  });

  it('用满 50 → 下一次请求 429 E_LIMIT_AI，usage 仍为已用 50 / 剩余 0', async () => {
    const { token, userId } = await register(USER_LIMIT);
    await seedUsage(userId, 50);

    const usage = await readUsage(token);
    expect(usage.used).toBe(50);
    expect(usage.remaining).toBe(0);

    const res = await request(server as never)
      .post(`${API}/ai/daily-summary`)
      .set(auth(token))
      .send({})
      .expect(429);
    expect(res.body.error.code).toBe('E_LIMIT_AI');

    // 超限请求会把计数回退，故仍是 50（不会留下 51 这种脏数据）
    const after = await readUsage(token);
    expect(after.used).toBe(50);
    expect(after.remaining).toBe(0);
  });

  it('AI 未配置（无 key）：usage 仍 200，daily-summary 走规则兜底不报错', async () => {
    const { token } = await register(USER_FALLBACK);

    const usage = await readUsage(token);
    expect(usage.limit).toBe(50);
    expect(Number.isInteger(usage.remaining)).toBe(true);

    const res = await request(server as never)
      .post(`${API}/ai/daily-summary`)
      .set(auth(token))
      .send({})
      .expect(200);
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.reason).toBe('ai_not_configured');
  });
});
