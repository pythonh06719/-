/**
 * 验证码回显端到端测试（自用 / 开发模式，`AUTH_LOG_CODE`）。
 *
 * 为什么单开一份文件：`/auth/send-code` 挂有 **5 次 / 分钟 / IP** 限流（ARCHITECTURE §1.7），
 * `auth.e2e.test.ts` 已用掉 3 次；本文件的两条断言再各发一次码（共 2 次），
 * 独立文件可拿到独立的 Nest 实例与限流计数，不留 flaky 隐患。
 *
 * 覆盖（安全属性的两个方向，缺一不可）：
 * 1. `AUTH_LOG_CODE=false`（默认）→ 响应**不含** `code`（生产绝不泄露验证码）；
 * 2. `AUTH_LOG_CODE=true` → 响应带回显的 `code`，且**该码确实能登录**（不是装饰性字段）。
 *
 * ⚠️ 与 `auth.e2e.test.ts` 相同机制：加载 `dist/**` 编译产物（装饰器元数据）。
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
const USER_ECHO_ON = 'e2e-code-echo-on@qinglife.test';
const USER_ECHO_OFF = 'e2e-code-echo-off@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let originalFlag: string | undefined;

/**
 * 显式切换 `AUTH_LOG_CODE`。
 *
 * 不依赖 `.env`：既避免「本机 .env 恰好开着」造成的假阴性，也不依赖用例执行顺序。
 * `getAppConfig()` 每次请求都重新读 `process.env`，故这里直接改环境变量即生效。
 */
function setEchoFlag(enabled: boolean): void {
  process.env.AUTH_LOG_CODE = enabled ? 'true' : 'false';
}

/** 清理测试用户与其验证码（验证码表无外键，需单独清理）。 */
async function cleanup(): Promise<void> {
  const emails = [USER_ECHO_ON, USER_ECHO_OFF];
  await prisma.authVerificationCode.deleteMany({ where: { email: { in: emails } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}

beforeAll(async () => {
  originalFlag = process.env.AUTH_LOG_CODE;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();
});

afterAll(async () => {
  // 还原环境变量：api 的 vitest 是 singleFork，本进程后续还会跑其它测试文件
  if (originalFlag === undefined) {
    delete process.env.AUTH_LOG_CODE;
  } else {
    process.env.AUTH_LOG_CODE = originalFlag;
  }

  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('验证码回显（自用 / 开发模式，AUTH_LOG_CODE）', () => {
  it('AUTH_LOG_CODE=false（默认）：响应不含 code（生产绝不泄露）', async () => {
    setEchoFlag(false);

    const res = await request(server as never)
      .post(`${API}/auth/send-code`)
      .send({ email: USER_ECHO_OFF })
      .expect(200);

    expect(res.body.error).toBeNull();
    const data = res.body.data as { email: string; expiresInSeconds: number; code?: string };
    expect(data.email).toBe(USER_ECHO_OFF);
    expect(data.expiresInSeconds).toBeGreaterThan(0);
    expect(data.code).toBeUndefined();
    // 字段必须**整体缺席**，而不是「值是空串/占位符」
    expect(data).not.toHaveProperty('code');
  });

  it('AUTH_LOG_CODE=true：响应带回显的 code，且该 code 真的能登录', async () => {
    setEchoFlag(true);

    const sent = await request(server as never)
      .post(`${API}/auth/send-code`)
      .send({ email: USER_ECHO_ON })
      .expect(200);

    expect(sent.body.error).toBeNull();
    const data = sent.body.data as { email: string; code?: string };
    expect(data.email).toBe(USER_ECHO_ON);
    expect(typeof data.code).toBe('string');
    expect(data.code).toMatch(/^\d{6}$/);

    // 回显的必须是**真能用的**验证码，而不只是一个长得像验证码的字符串
    const res = await request(server as never)
      .post(`${API}/auth/verify-code`)
      .send({ email: USER_ECHO_ON, code: data.code })
      .expect(200);

    expect(res.body.error).toBeNull();
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.user.email).toBe(USER_ECHO_ON);
  });
});
