/**
 * 鉴权限流与防爆破端到端测试（上线前全检 F-002 / F-003 修复的验收轨）。
 *
 * 为什么单开一份文件：限流计数挂在**路由 + 邮箱 + IP 复合键**上，与 `auth.e2e.test.ts`
 * 共享 Nest 实例会互相占用配额（那文件已用掉 3 次发码 + 6 次校验）；
 * 独立文件可拿到独立的 Nest 实例与独立的限流计数，不留 flaky 隐患。
 *
 * 覆盖（验收清单逐条对应）：
 * 1. verify-code 同 email+IP 第 6 次 → 429 `E_LIMIT_THROTTLE`（前 5 次正常 400）；
 * 2. login 同 email+IP 第 6 次错误密码 → 429；
 * 3. 复合键的 email 维度：同 IP 下不同邮箱互不占用配额（NAT 不互踩）；
 * 4. 失败作废：同一码连续失败达上限即作废（正确码也 400），但**新取的码不受影响**；
 * 5. 正常流不受影响：正确码 / 正确密码一次通过；
 * 6. 登录不枚举：邮箱不存在与密码错误返回同一条 401（修限流不引入用户枚举）。
 *
 * ⚠️ 与既有 e2e 相同机制：加载 `dist/**` 编译产物（装饰器元数据）——改 src 后必须先重建。
 * ⚠️ 配额纪律：`send-code` 是 IP 键 5 次 / 分钟，本文件刻意只发 4 次（第 4 条用例发 2 次），
 *    第 5 条用例的码直接写库（hash 已知明文），不占用发码配额。
 * ⚠️ 第 4 条用「DB 预置 failedAttempts=4 + 1 次 HTTP 失败」触发作废：同一邮箱的校验配额
 *    是 5 次 / 分钟，若真的打满 5 次失败，第 6 次（正确码）会被限流挡在 429，
 *    反而无法断言「码已死」——预置计数让两次 HTTP 调用都留在配额内，确定性达成。
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
const { hash } = require('bcryptjs') as typeof import('bcryptjs');
const { AppModule } = require('../dist/apps/api/src/app.module.js') as {
  AppModule: typeof AppModuleClass;
};
const { PrismaService } = require('../dist/apps/api/src/prisma/prisma.service.js') as {
  PrismaService: typeof PrismaServiceClass;
};

const API = '/api';

// 每条用例一个独立邮箱：限流键是 email+IP 复合，换邮箱即换配额桶，用例间互不干扰。
const USER_VERIFY_LIMIT = 'e2e-throttle-verify@qinglife.test';
const USER_LOGIN_LIMIT = 'e2e-throttle-login@qinglife.test';
const USER_COMPOSITE_A = 'e2e-throttle-composite-a@qinglife.test';
const USER_COMPOSITE_B = 'e2e-throttle-composite-b@qinglife.test';
const USER_INVALIDATE = 'e2e-throttle-invalidate@qinglife.test';
const USER_NORMAL = 'e2e-throttle-normal@qinglife.test';
const USER_PASSWORD = 'e2e-throttle-password@qinglife.test';
const USER_ENUM = 'e2e-throttle-enum@qinglife.test';

const PASSWORD = 'correct-horse-battery-staple';
const WRONG_CODE = '000000';
const KNOWN_CODE = '424242';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

/** 从日志中提取某邮箱的最新 6 位验证码（与 auth.e2e.test.ts 同机制）。 */
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

/** 发码并返回验证码。 */
async function sendCode(email: string): Promise<string> {
  const res = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  expect(res.body.error).toBeNull();
  return findCode(email);
}

/** 提交一次错误验证码，期望 400 `E_AUTH_CODE_INVALID`。 */
async function wrongVerify(email: string): Promise<void> {
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code: WRONG_CODE })
    .expect(400);
  expect(res.body.error.code).toBe('E_AUTH_CODE_INVALID');
}

const ALL_EMAILS = [
  USER_VERIFY_LIMIT,
  USER_LOGIN_LIMIT,
  USER_COMPOSITE_A,
  USER_COMPOSITE_B,
  USER_INVALIDATE,
  USER_NORMAL,
  USER_PASSWORD,
  USER_ENUM,
];

async function cleanup(): Promise<void> {
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { email: { in: ALL_EMAILS } } });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();
  // 密码登录用例的用户（直接建库，绕开发码流程）
  await prisma.user.create({
    data: {
      email: USER_PASSWORD,
      emailVerifiedAt: new Date().toISOString(),
      passwordHash: await hash(PASSWORD, 12),
    },
  });
  // 正常流用例的验证码：直写已知明文的 hash，不占用 send-code 配额（见文件头配额纪律）
  await prisma.authVerificationCode.create({
    data: {
      email: USER_NORMAL,
      codeHash: await hash(KNOWN_CODE, 10),
      purpose: 'login',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  });
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('鉴权限流（F-002 / F-003）', () => {
  it('verify-code 同 email+IP 第 6 次 → 429 E_LIMIT_THROTTLE', async () => {
    await sendCode(USER_VERIFY_LIMIT);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await wrongVerify(USER_VERIFY_LIMIT);
    }

    const limited = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_VERIFY_LIMIT, code: WRONG_CODE })
      .expect(429);
    expect(limited.body.data).toBeNull();
    expect(limited.body.error.code).toBe('E_LIMIT_THROTTLE');
  });

  it('login 同 email+IP 第 6 次错误密码 → 429 E_LIMIT_THROTTLE', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(server as never)
        .post(`${API}/auth/login`)
        .send({ email: USER_LOGIN_LIMIT, password: 'wrong-password' })
        .expect(401);
      expect(res.body.error.code).toBe('E_AUTH_UNAUTHORIZED');
    }

    const limited = await request(server as never)
      .post(`${API}/auth/login`)
      .send({ email: USER_LOGIN_LIMIT, password: 'wrong-password' })
      .expect(429);
    expect(limited.body.error.code).toBe('E_LIMIT_THROTTLE');
  });

  it('复合键 email 维度：同 IP 下不同邮箱互不占用配额（NAT 不互踩）', async () => {
    await sendCode(USER_COMPOSITE_A);

    // A 打满 5 次配额，第 6 次被 429
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await wrongVerify(USER_COMPOSITE_A);
    }
    const aLimited = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_COMPOSITE_A, code: WRONG_CODE })
      .expect(429);
    expect(aLimited.body.error.code).toBe('E_LIMIT_THROTTLE');

    // B 与 A 同 IP，但必须仍是 400（无码记录 → invalid）而不是 429：
    // 证明配额桶按 email 维度隔离，A 的打满不波及 B。
    const b = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_COMPOSITE_B, code: WRONG_CODE })
      .expect(400);
    expect(b.body.error.code).toBe('E_AUTH_CODE_INVALID');
  });
});

describe('验证码失败作废（F-002 第二层）', () => {
  it('连续失败达上限即作废当期码；新取的码不受影响', async () => {
    const code = await sendCode(USER_INVALIDATE);

    // 预置 failedAttempts=4：再错 1 次即达上限（5）→ 码被作废。
    // 不真的打满 5 次 HTTP 失败，是为了把随后两次调用留在限流配额内（见文件头说明）。
    await prisma.authVerificationCode.updateMany({
      where: { email: USER_INVALIDATE, consumedAt: null },
      data: { failedAttempts: 4 },
    });

    await wrongVerify(USER_INVALIDATE);

    // 该码已被作废：正确码也必须是 400 invalid（爆破者猜中也进不来）
    const dead = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_INVALIDATE, code })
      .expect(400);
    expect(dead.body.error.code).toBe('E_AUTH_CODE_INVALID');

    // 库里确认 consumedAt 已置位
    const record = await prisma.authVerificationCode.findFirst({
      where: { email: USER_INVALIDATE },
      orderBy: { id: 'desc' },
    });
    expect(record?.consumedAt).not.toBeNull();

    // 重新取码 → 新码照常可用（作废只作用于当期那一条）
    const freshCode = await sendCode(USER_INVALIDATE);
    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_INVALIDATE, code: freshCode })
      .expect(200);
    expect(res.body.error).toBeNull();
    expect((res.body.data as { user: { email: string } }).user.email).toBe(USER_INVALIDATE);
  });
});

describe('正常流不受限流影响', () => {
  it('正确验证码一次通过（200 + 令牌）', async () => {
    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_NORMAL, code: KNOWN_CODE })
      .expect(200);
    expect(typeof (res.body.data as { accessToken: string }).accessToken).toBe('string');
  });

  it('正确密码一次通过（200 + 令牌）', async () => {
    const res = await request(server as never)
      .post(`${API}/auth/login`)
      .send({ email: USER_PASSWORD, password: PASSWORD })
      .expect(200);
    expect(typeof (res.body.data as { accessToken: string }).accessToken).toBe('string');
  });

  it('登录不枚举：邮箱不存在与密码错误返回同一条 401', async () => {
    const unknown = await request(server as never)
      .post(`${API}/auth/login`)
      .send({ email: USER_ENUM, password: 'whatever' })
      .expect(401);
    const wrong = await request(server as never)
      .post(`${API}/auth/login`)
      .send({ email: USER_PASSWORD, password: 'whatever' })
      .expect(401);
    expect(unknown.body.error.code).toBe('E_AUTH_UNAUTHORIZED');
    expect(wrong.body.error.code).toBe('E_AUTH_UNAUTHORIZED');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });
});
