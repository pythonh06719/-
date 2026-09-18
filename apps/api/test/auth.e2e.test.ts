/**
 * 鉴权端到端测试（T03 一期 R1.1 / R1.6 / R1.7，vitest + supertest，真实启动 Nest + SQLite）。
 *
 * 为什么单开一份文件：`api.e2e.test.ts` 只覆盖「链路通了 + 错误码被拒」，
 * 而**验证码的一次性与过期**是最该被钉死、又最容易回归的两条路径（安全属性），
 * 故此处独立聚焦、逐条断言。
 *
 * 覆盖：
 * 1. 错误验证码 → 400 `E_AUTH_CODE_INVALID`；正确验证码 → 200 + 令牌，且令牌可访问受保护接口；
 * 2. **一次性**：同一验证码第二次校验必须失败（不得重放）；
 * 3. **过期**：把 code 的 `expiresAt` 改到过去 → 校验失败 `E_AUTH_CODE_EXPIRED`；
 * 4. 无有效验证码记录时同样 400（不泄露「该邮箱是否发过码」）；
 * 5. 未带 / 伪造令牌访问受保护接口 → 401（`E_AUTH_*`）。
 *
 * ⚠️ 说明：`/auth/send-code` 自身挂有 **5 次 / 分钟 / IP** 的限流（ARCHITECTURE §1.7）。
 * 因此本文件刻意把「同一次发码」复用给「先错后对」两条断言，全文件仅发码 3 次，
 * 避免测试自身撞上流控而变得 flaky。
 *
 * ⚠️ 与 `api.e2e.test.ts` 相同机制：加载 `dist/**` 编译产物（装饰器元数据）。
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
const USER_TOKEN = 'e2e-auth-token@qinglife.test';
const USER_SINGLE_USE = 'e2e-auth-single-use@qinglife.test';
const USER_EXPIRED = 'e2e-auth-expired@qinglife.test';
const USER_NO_CODE = 'e2e-auth-no-code@qinglife.test';

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;

/** 从日志中提取某邮箱的最新 6 位验证码。 */
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

/** 发码并返回验证码（对外不返回，仅打印到服务端日志）。 */
async function sendCode(email: string): Promise<string> {
  const res = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  expect(res.body.error).toBeNull();
  return findCode(email);
}

/** 清理测试用户与其验证码（验证码表无外键，需单独清理）。 */
async function cleanup(): Promise<void> {
  const emails = [USER_TOKEN, USER_SINGLE_USE, USER_EXPIRED, USER_NO_CODE];
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: emails } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
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

describe('鉴权（R1.1 / R1.6 / R1.7）', () => {
  it('错误验证码 → 400 E_AUTH_CODE_INVALID；正确验证码 → 200 + 令牌（R1.1）', async () => {
    const code = await sendCode(USER_TOKEN);

    // ① 库里存在未消费记录，但码不匹配 → 400
    const wrong = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_TOKEN, code: '000000' })
      .expect(400);
    expect(wrong.body.data).toBeNull();
    expect(wrong.body.error.code).toBe('E_AUTH_CODE_INVALID');

    // ② 正确码 → 令牌（邮箱不存在时自动注册）
    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_TOKEN, code })
      .expect(200);
    expect(res.body.error).toBeNull();

    const data = res.body.data as { accessToken: string; user: { email: string } };
    expect(typeof data.accessToken).toBe('string');
    expect(data.accessToken.length).toBeGreaterThan(20);
    expect(data.user.email).toBe(USER_TOKEN);

    // ③ 该令牌确实可用（否则「发 token」是空话）
    const me = await request(server as never)
      .get(`${API}/auth/me`)
      .set(auth(data.accessToken))
      .expect(200);
    expect(me.body.data.user.email).toBe(USER_TOKEN);
  });

  it('验证码一次性：同一码第二次校验必须失败（不得重放）', async () => {
    const code = await sendCode(USER_SINGLE_USE);

    await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_SINGLE_USE, code })
      .expect(200);

    const replay = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_SINGLE_USE, code })
      .expect(400);
    expect(replay.body.error.code).toBe('E_AUTH_CODE_INVALID');

    // 库里该码已被标记消费（consumedAt 非空）
    const record = await prisma.authVerificationCode.findFirst({
      where: { email: USER_SINGLE_USE },
      orderBy: { id: 'desc' },
    });
    expect(record?.consumedAt).not.toBeNull();
  });

  it('验证码过期：把 expiresAt 改到过去 → 400 E_AUTH_CODE_EXPIRED（R1.1）', async () => {
    const code = await sendCode(USER_EXPIRED);

    // 直接操作库把有效期改到 1 小时前（不等待真实 TTL，测试必须确定性）
    const past = new Date(Date.now() - 3600_000).toISOString();
    await prisma.authVerificationCode.updateMany({
      where: { email: USER_EXPIRED, consumedAt: null },
      data: { expiresAt: past },
    });

    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_EXPIRED, code })
      .expect(400);
    expect(res.body.error.code).toBe('E_AUTH_CODE_EXPIRED');
  });

  it('从未发过码的邮箱 → 400 E_AUTH_CODE_INVALID（不泄露是否存在记录）', async () => {
    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_NO_CODE, code: '123456' })
      .expect(400);
    expect(res.body.error.code).toBe('E_AUTH_CODE_INVALID');
  });

  it('未携带令牌访问受保护接口 → 401 E_AUTH_UNAUTHORIZED（TC-43）', async () => {
    const res = await request(server as never).get(`${API}/auth/me`).expect(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('E_AUTH_UNAUTHORIZED');
  });

  it('伪造令牌访问受保护接口 → 401（TC-43）', async () => {
    const res = await request(server as never)
      .get(`${API}/auth/me`)
      .set('Authorization', 'Bearer forged.token.value')
      .expect(401);
    expect(res.body.error.code).toBe('E_AUTH_UNAUTHORIZED');
  });
});
