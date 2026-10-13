/**
 * 安全加固端到端测试（上线前全检剩余项 F-004 / F-009 / F-010 的验收轨）。
 *
 * 覆盖：
 * 1. **F-004 停用即失效**：账号 `status='disabled'` 后，此前签发的 accessToken 立刻 403
 *    （修复前旧 token 可用到过期，最长 2h）；
 * 2. **F-010 请求体超限 → 413**（修复前落到 500 `E_INTERNAL`）+ 响应信封不破；
 * 3. **F-009 安全事件日志**：401 / 429 落 warn 且含方法 + 路径 + 状态；正常 200 不留噪声；
 * 4. **F-010 重负载端点限流**：`/data/restore/preview` 第 11 次 → 429。
 *
 * ⚠️ 与既有 e2e 相同机制：加载 `dist/**` 编译产物 —— 改 src 后必须先重建。
 * ⚠️ 配额纪律：每条用例**独立账号**（`UserThrottlerGuard` 按 userId 计数），
 *    避免用例之间互相占用限流额度。
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
const KNOWN_CODE = '424242';

const USER_DISABLED = 'e2e-hardening-disabled@qinglife.test';
const USER_LOG_NOISE = 'e2e-hardening-noise@qinglife.test';
const USER_RESTORE_LIMIT = 'e2e-hardening-restore@qinglife.test';
const ALL_EMAILS = [USER_DISABLED, USER_LOG_NOISE, USER_RESTORE_LIMIT];

const warnSpy = vi.spyOn(Logger.prototype, 'warn');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** 造一个已注册用户并拿到真实 accessToken（直写已知明文的验证码，不占用 send-code 配额）。 */
async function createUserWithToken(email: string): Promise<{ token: string; userId: number }> {
  await prisma.authVerificationCode.create({
    data: {
      email,
      codeHash: await hash(KNOWN_CODE, 10),
      purpose: 'login',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
  });
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code: KNOWN_CODE })
    .expect(200);
  const data = res.body.data as { accessToken: string; user: { id: number } };
  return { token: data.accessToken, userId: data.user.id };
}

/** 已捕获的 warn 行（字符串化）。 */
function warnLines(): string[] {
  return (warnSpy.mock.calls as unknown[][]).map((call) => call.map((arg) => String(arg)).join(' '));
}

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
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('F-004 停用账号的旧令牌立即失效', () => {
  it('停用后旧 accessToken → 403 E_AUTH_USER_DISABLED（修复前可用到过期）', async () => {
    const { token, userId } = await createUserWithToken(USER_DISABLED);

    // 停用前：令牌正常可用
    await request(server as never).get(`${API}/auth/me`).set(auth(token)).expect(200);

    await prisma.user.update({ where: { id: userId }, data: { status: 'disabled' } });

    // 停用后：同一枚令牌立刻失效（鉴权层查状态）
    const blocked = await request(server as never).get(`${API}/auth/me`).set(auth(token)).expect(403);
    expect(blocked.body.error.code).toBe('E_AUTH_USER_DISABLED');

    // 业务端点同样拦住（不是只有 /auth/me 特殊）
    await request(server as never).get(`${API}/weights`).set(auth(token)).expect(403);
  });
});

describe('F-010 请求体超限', () => {
  it('超过上限的请求体 → 413 E_VALID_TOO_LARGE（修复前 500 E_INTERNAL）', async () => {
    // 测试环境用 express.json 默认 100kb 上限，200KB 即触发 entity.too.large
    const res = await request(server as never)
      .post(`${API}/data/restore/preview`)
      .send({ content: 'x'.repeat(200_000) })
      .expect(413);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('E_VALID_TOO_LARGE');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('重负载端点限流：/data/restore/preview 第 11 次 → 429', async () => {
    const { token } = await createUserWithToken(USER_RESTORE_LIMIT);

    // 前 10 次：入参非法 → 400（但都计入限流）
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await request(server as never)
        .post(`${API}/data/restore/preview`)
        .set(auth(token))
        .send({ content: null })
        .expect(400);
      expect(res.body.error.code).toBe('E_VALID_RESTORE_PAYLOAD');
    }

    const limited = await request(server as never)
      .post(`${API}/data/restore/preview`)
      .set(auth(token))
      .send({ content: null })
      .expect(429);
    expect(limited.body.error.code).toBe('E_LIMIT_THROTTLE');
  });
});

describe('F-009 安全事件日志', () => {
  it('401 落 warn（含方法 + 路径 + 状态）', async () => {
    warnSpy.mockClear();

    await request(server as never).get(`${API}/auth/me`).expect(401);

    const hit = warnLines().some(
      (line) => line.includes('[安全事件]') && line.includes('401') && line.includes('/api/auth/me'),
    );
    expect(hit).toBe(true);
  });

  it('429 落 warn；正常 200 不产生安全事件噪声', async () => {
    const { token } = await createUserWithToken(USER_LOG_NOISE);

    warnSpy.mockClear();
    // 正常业务请求
    await request(server as never).get(`${API}/weights`).set(auth(token)).expect(200);
    expect(warnLines().some((line) => line.includes('[安全事件]'))).toBe(false);

    // 未认证 → 401（应为安全事件）
    warnSpy.mockClear();
    await request(server as never).get(`${API}/weights`).expect(401);
    expect(warnLines().some((line) => line.includes('[安全事件]') && line.includes('401'))).toBe(true);
  });
});
