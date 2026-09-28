/**
 * `POST /api/data/import/weights` 端到端测试（GAP-6：CSV 体重导入改走批量接口）。
 *
 * 为什么必须补：前端此前**逐行 POST `/weights`**，这条批量接口「已实现、已优化」
 * 却**零测试覆盖**。改成批量后一次请求能带任意多行，安全边界（数组长度上限、
 * 二选一的空 payload）也没有任何测试钉住。
 *
 * 覆盖清单（与团队任务书一一对应）：
 * ① 传 `rows` 批量导入成功，`imported` 数正确；
 * ② **同日重复导入 → 覆盖不新增**（upsert 语义）；
 * ③ 非法行计入 `skipped`，**合法行仍写入**（尽力而为，不是整批 400）；
 * ④ 超数组上限 → 400（DTO 闸门）；
 * ⑤ 无 token → 401；
 * ⑥ 空 payload（既无 rows 也无 csvText）→ 400；
 * ⑦ `csvText` 分支仍可用（既有契约的回归保护）；
 * ⑧ 0 行不报错，`imported = 0`（空数组走 `rows` 分支）；
 * ⑨ `rows` 分支的错误行号是**原文件真实行号**（不因前一行非法而整体前移）。
 */
import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
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
const { MAX_IMPORT_ROWS } = require('../dist/apps/api/src/data/dto/import-weights.dto.js') as {
  MAX_IMPORT_ROWS: number;
};

const API = '/api';
const USER = 'e2e-import-weights@qinglife.test';
const D1 = '2026-07-01';
const D2 = '2026-07-02';
const D3 = '2026-07-03';

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

/** 直接调批量导入接口。 */
async function importWeights(
  body: unknown,
  tokenOverride?: string,
): Promise<{ status: number; body: unknown }> {
  const req = request(server as never).post(`${API}/data/import/weights`);
  if (tokenOverride !== undefined) {
    req.set(auth(tokenOverride));
  } else {
    req.set(auth(token));
  }
  const response = await req.send(body as never);
  return { status: response.status, body: response.body };
}

/** 读出某一天的体重记录（不存在返回 null）。 */
async function weightAt(date: string): Promise<{ weightKg: number; note: string | null } | null> {
  const row = await prisma.weightLog.findUnique({
    where: { userId_loggedAt: { userId, loggedAt: date } },
  });
  return row === null ? null : { weightKg: row.weightKg, note: row.note };
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
  await prisma.weightLog.deleteMany({ where: { userId } });
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

describe('GAP-6 · POST /api/data/import/weights（批量导入）', () => {
  it('传 rows 批量导入成功，imported 数正确且行都落库', async () => {
    const { status, body } = await importWeights({
      rows: [
        { date: D1, weightKg: 65.2 },
        { date: D2, weightKg: 65, note: '早上空腹' },
        { date: D3, weightKg: 64.8 },
      ],
    });

    expect(status).toBe(200);
    const data = (body as { data: { imported: number; skipped: number; errors: unknown[] } }).data;
    expect(data.imported).toBe(3);
    expect(data.skipped).toBe(0);
    expect(data.errors).toEqual([]);

    expect(await weightAt(D1)).toEqual({ weightKg: 65.2, note: null });
    expect(await weightAt(D2)).toEqual({ weightKg: 65, note: '早上空腹' });
    expect(await weightAt(D3)).toEqual({ weightKg: 64.8, note: null });
  });

  it('同日重复导入 → 覆盖不新增（upsert 语义）', async () => {
    await importWeights({ rows: [{ date: D1, weightKg: 65.2, note: '旧值' }] });
    const before = await prisma.weightLog.count({ where: { userId, loggedAt: D1 } });
    expect(before).toBe(1);

    const { status, body } = await importWeights({ rows: [{ date: D1, weightKg: 61.5, note: '新值' }] });
    expect(status).toBe(200);
    expect((body as { data: { imported: number } }).data.imported).toBe(1);

    // 仍是 1 条，且值被覆盖
    expect(await prisma.weightLog.count({ where: { userId } })).toBe(1);
    expect(await weightAt(D1)).toEqual({ weightKg: 61.5, note: '新值' });
  });

  it('非法行计入 skipped，合法行仍然写入（尽力而为，不整批 400）', async () => {
    const { status, body } = await importWeights({
      rows: [
        { date: '2026/07/01', weightKg: 60 }, // 日期格式错
        { date: D2, weightKg: 600 }, // 越界
        { date: D3, weightKg: 59.5 }, // 合法
      ],
    });

    expect(status).toBe(200);
    const data = (body as { data: { imported: number; skipped: number; errors: { row: number }[] } }).data;
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(2);
    expect(data.errors).toHaveLength(2);

    // 合法行落库，非法行没有写进去
    expect(await weightAt(D3)).toEqual({ weightKg: 59.5, note: null });
    expect(await weightAt(D2)).toBeNull();
  });

  it('rows 分支的错误行号是原文件真实行号（不因前一行非法而整体前移）', async () => {
    const { body } = await importWeights({
      rows: [
        { date: 'bad-date-1', weightKg: 60 }, // 第 2 行（表头是第 1 行）
        { date: D2, weightKg: 60 }, // 第 3 行（合法）
        { date: 'bad-date-2', weightKg: 60 }, // 第 4 行
      ],
    });

    const rows = (body as { data: { errors: { row: number }[] } }).data.errors.map((e) => e.row);
    // 修复前第二个错误会因为「过滤后数组序号」被算成 3 —— 现在必须是 4
    expect(rows).toEqual([2, 4]);
  });

  it('空数组 rows → imported 0，不报错（不白开一次事务）', async () => {
    const { status, body } = await importWeights({ rows: [] });
    expect(status).toBe(200);
    const data = (body as { data: { imported: number; skipped: number } }).data;
    expect(data.imported).toBe(0);
    expect(data.skipped).toBe(0);
  });

  it('超过数组上限 → 400（DTO 闸门挡住打爆事务的请求）', async () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => ({
      date: D1,
      weightKg: 60 + (index % 10),
    }));
    const { status, body } = await importWeights({ rows });
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('E_VALID_INPUT');
  });

  it('恰好等于上限 → 通过校验（边界值不被误伤）', async () => {
    // 全部落在同一天 → 走 upsert 覆盖，最终库里只有 1 条，验证的是「不 400」而非数据量
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, () => ({ date: D1, weightKg: 60 }));
    const { status } = await importWeights({ rows });
    expect(status).toBe(200);
  });

  it('无 token → 401', async () => {
    const { status } = await importWeights({ rows: [{ date: D1, weightKg: 60 }] }, 'not-a-real-token');
    expect(status).toBe(401);
  });

  it('空 payload（既无 rows 也无 csvText）→ 400 且错误码不变', async () => {
    const { status, body } = await importWeights({});
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe('E_VALID_IMPORT_EMPTY');
  });

  it('csvText 分支仍可用（既有契约的回归保护）', async () => {
    const csvText = ['date,weightKg,note', `${D1},70.1,导入自 CSV`, `${D2},70,`].join('\n');
    const { status, body } = await importWeights({ csvText });

    expect(status).toBe(200);
    const data = (body as { data: { imported: number; skipped: number } }).data;
    expect(data.imported).toBe(2);
    expect(data.skipped).toBe(0);
    expect(await weightAt(D1)).toEqual({ weightKg: 70.1, note: '导入自 CSV' });
    expect(await weightAt(D2)).toEqual({ weightKg: 70, note: null });
  });

  it('csvText 分支的非法行也走 skipped（两分支语义一致）', async () => {
    const csvText = ['date,weightKg', 'not-a-date,60', `${D3},58.2`].join('\n');
    const { status, body } = await importWeights({ csvText });

    expect(status).toBe(200);
    const data = (body as { data: { imported: number; skipped: number; errors: { row: number }[] } }).data;
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.errors[0]?.row).toBe(2);
    expect(await weightAt(D3)).toEqual({ weightKg: 58.2, note: null });
  });
});
