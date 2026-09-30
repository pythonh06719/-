/**
 * D-3 体重单位「斤」端到端测试（`PATCH /users/settings` + 备份恢复链路）。
 *
 * ## 口径（为什么这些断言值得钉死）
 *
 * `weightUnit` 是**展示偏好**：内部存储与导出恒为 kg（`weight_logs.weight_kg` 不变），
 * 本字段只决定前端把 kg 换算成「斤」展示 / 输入（1 kg = 2 市斤）。因此这里锁定三件事：
 *
 * 1. **可读写**：设置接口能落库 / 回读 `weightUnit`；新账号默认 `kg`；非法值（`pound`）→ 400；
 * 2. **部分更新不变**：不传 `weightUnit` 时它保持原值，其他字段照常单独更新；
 * 3. **★ 备份恢复链路**：`GET /data/export` 的 `settings` 含 `weightUnit`；
 *    恢复后仍在；**旧备份**（无该字段）兜底为 `kg` 且不报错（core 解析层宽容读取）。
 *
 * ## 机制
 *
 * 与既有 e2e 同机制：通过 Node 原生 `require` 加载 `nest build` 产出的 `dist/**`。
 * 运行前必须 `npm run build -w @qsh/api`。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import type { ExportJsonPayload, RestorePreviewResponse } from '@qsh/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
const USER = 'e2e-weight-unit@qinglife.test';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';
let userId = 0;

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

async function login(email: string): Promise<string> {
  const sent = await request(server as never).post(`${API}/auth/send-code`).send({ email }).expect(200);
  const code = (sent.body.data as { code?: string }).code;
  if (typeof code !== 'string') {
    throw new Error(`未取到 ${email} 的验证码回显`);
  }
  const verified = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email, code })
    .expect(200);
  return (verified.body.data as { accessToken: string }).accessToken;
}

/** `PATCH /users/settings`（不 assert，便于断言 400）。 */
function patchSettings(
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return request(server as never)
    .patch(`${API}/users/settings`)
    .set(auth(token))
    .send(body)
    .then((res) => ({ status: res.status, body: res.body }));
}

/** `GET /users/settings`。 */
async function getSettings(): Promise<{ unit: string; weightUnit: string; darkMode: boolean }> {
  const res = await request(server as never).get(`${API}/users/settings`).set(auth(token)).expect(200);
  return res.body.data as { unit: string; weightUnit: string; darkMode: boolean };
}

/** `GET /data/export` 的完整 JSON 备份体。 */
async function exportAll(): Promise<ExportJsonPayload> {
  const res = await request(server as never).get(`${API}/data/export`).set(auth(token)).expect(200);
  return res.body.data as ExportJsonPayload;
}

/** 第一步：只解析预览，不写入。 */
async function preview(payload: unknown): Promise<RestorePreviewResponse> {
  const res = await request(server as never)
    .post(`${API}/data/restore/preview`)
    .set(auth(token))
    .send({ content: JSON.stringify(payload) })
    .expect(200);
  return res.body.data as RestorePreviewResponse;
}

/** 第二步：确认恢复。 */
async function confirm(previewToken: string): Promise<void> {
  await request(server as never)
    .post(`${API}/data/restore`)
    .set(auth(token))
    .send({ previewToken })
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

  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });
  token = await login(USER);
  userId = (await prisma.user.findUniqueOrThrow({ where: { email: USER } })).id;
});

beforeEach(async () => {
  // 每个用例从「无 settings 行」开始（验证默认值 + 让落库断言干净）。
  await prisma.userSettings.deleteMany({ where: { userId } });
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
    await prisma.user.deleteMany({ where: { email: USER } });
  }
  if (app !== undefined) {
    await app.close();
  }
});

describe('D-3 · PATCH /users/settings 的 weightUnit', () => {
  it('新账号默认 weightUnit = kg（1:1 扩展行按 schema 默认值建）', async () => {
    const settings = await getSettings();
    expect(settings.weightUnit).toBe('kg');
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    expect(row?.weightUnit).toBe('kg');
  });

  it("weightUnit='jin' → 200，返回体与库内都为 'jin'", async () => {
    const res = await patchSettings({ weightUnit: 'jin' });
    expect(res.status).toBe(200);
    expect((res.body.data as { weightUnit: string }).weightUnit).toBe('jin');
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    expect(row?.weightUnit).toBe('jin');
  });

  it('落库后 GET /users/settings 回读 weightUnit（跨请求一致）', async () => {
    await patchSettings({ weightUnit: 'jin' });
    expect((await getSettings()).weightUnit).toBe('jin');
    await patchSettings({ weightUnit: 'kg' });
    expect((await getSettings()).weightUnit).toBe('kg');
  });

  it("非法值 'pound' → 400（E_VALID_INPUT，字段级错误）", async () => {
    const res = await patchSettings({ weightUnit: 'pound' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
    expect(res.body.error.fields.weightUnit).toBeDefined();
  });

  it('不传 weightUnit 时其他字段仍可独立更新（部分更新语义不被破坏）', async () => {
    await patchSettings({ weightUnit: 'jin' });
    const res = await patchSettings({ unit: 'kj', darkMode: true });
    expect(res.status).toBe(200);
    const data = res.body.data as { unit: string; weightUnit: string; darkMode: boolean };
    expect(data.unit).toBe('kj');
    expect(data.darkMode).toBe(true);
    // 未传的 weightUnit 保持上一次的值（'jin'），不应被重置
    expect(data.weightUnit).toBe('jin');
  });
});

describe('D-3 · ★ 备份恢复链路携带 weightUnit', () => {
  it('导出的 settings 含 weightUnit；恢复后仍然保留', async () => {
    await patchSettings({ weightUnit: 'jin' });

    const exported = await exportAll();
    expect(exported.settings.weightUnit).toBe('jin');

    // 换回 kg，再恢复刚才那份备份 → 应还原为 jin
    await patchSettings({ weightUnit: 'kg' });
    expect((await getSettings()).weightUnit).toBe('kg');

    const previewResult = await preview(exported);
    expect(previewResult.schemaVersion).toBe(2);
    await confirm(previewResult.previewToken);

    expect((await getSettings()).weightUnit).toBe('jin');

    // 再导出一份，确认导出的偏好与库内一致（「可完整恢复」承诺自洽）
    expect((await exportAll()).settings.weightUnit).toBe('jin');
  });

  it('旧备份（settings 缺 weightUnit）恢复 → 兜底 kg，不报错（宽容读取）', async () => {
    await patchSettings({ weightUnit: 'jin' });

    const legacy = await exportAll();
    // 模拟「D-3 之前导出的旧备份」：抹掉 settings.weightUnit
    delete (legacy.settings as { weightUnit?: unknown }).weightUnit;

    const previewResult = await preview(legacy);
    await confirm(previewResult.previewToken);

    expect((await getSettings()).weightUnit).toBe('kg');
  });
});
