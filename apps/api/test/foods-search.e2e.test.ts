/**
 * `GET /api/foods/search` 端到端测试（阶段 2：先结果相关，再结果完整，不误导）。
 *
 * 覆盖：
 * 1. **相关度排序**：前缀命中 > 子串命中 > 仅别名命中（三类各至少一条，且顺序被钉死）；
 * 2. **稳定分页**：同档按 `id` 升序；`pageSize=2` 时翻页不跳条、不重复，越界页为空；
 * 3. **`total` 正确**：等于命中的总条数（不受分页影响）；
 * 4. **跨来源同物异名标注**：`蘑菇(干)` / `蘑菇（鲜蘑）` / `蘑菇（罐头）` 三条**都在**
 *    （不静默合并），各自带自己的区分词 `qualifier`；
 * 5. **红线：不按热量排序** —— 三条蘑菇同档，热量最高的「干」（295）**不是**第一条，
 *    顺序只由 `id` 决定（本用例刻意让「入库顺序」与「热量高低」相反来证明它）；
 * 6. **可见性**：`user_custom` 且不属于当前用户的条目不出现在结果里；
 * 7. **旧契约未收紧**：`GET /api/foods` 仍是 `{items,total,page,pageSize}` 且单条**没有**
 *    `qualifier` 字段（新字段只加在新端点上）；
 * 8. 鉴权：未带令牌 → 401。
 *
 * ⚠️ 与既有 e2e 相同的机制：加载 `dist/**` 编译产物（装饰器元数据），因此需先 `nest build`。
 * ⚠️ 测试数据全部带唯一前缀 `柠青实验`，结束后按 id 精确清理，不污染食物库。
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
const USER = 'e2e-foods-search@qinglife.test';

/** 唯一关键词：真实种子里不可能出现，保证 `total` 可精确断言。 */
const KEYWORD = '柠青实验';

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';

/** 已创建条目的 id（清理用）。 */
const createdIds: number[] = [];

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

/** 登录验证码经 `Logger.log` 输出，spy 住以便从日志里取码（与既有 e2e 同款）。 */
const logSpy = vi.spyOn(Logger.prototype, 'log');

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

/** 建一条测试食物，返回 id。 */
async function createFood(input: {
  name: string;
  kcalPer100g: number;
  aliases?: string[];
  namePinyin?: string | null;
  source?: string;
  createdByUserId?: number | null;
  category?: string;
}): Promise<number> {
  const row = await prisma.foodItem.create({
    data: {
      name: input.name,
      namePinyin: input.namePinyin ?? null,
      aliases: JSON.stringify(input.aliases ?? []),
      category: input.category ?? 'other',
      kcalPer100g: input.kcalPer100g,
      servingUnits: JSON.stringify([]),
      source: input.source ?? 'builtin',
      createdByUserId: input.createdByUserId ?? null,
      isVerified: false,
    },
    select: { id: true },
  });
  createdIds.push(row.id);
  return row.id;
}

async function cleanup(): Promise<void> {
  if (createdIds.length > 0) {
    await prisma.foodItem.deleteMany({ where: { id: { in: createdIds } } });
    createdIds.length = 0;
  }
  // 兜底：万一某次运行在测试中途崩溃，残留的测试条目按唯一关键词名清理
  // （⚠️ 只删带唯一前缀名的，绝不按「蘑菇」这类真实食物名删除种子数据）。
  await prisma.foodItem.deleteMany({ where: { name: { contains: KEYWORD } } });
  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });
}

/** 建「前缀 / 子串 / 仅别名」三条 + 一条不可见的私有条目。 */
interface Fixture {
  prefixId: number;
  substringId: number;
  aliasId: number;
  privateId: number;
}

async function seedRankFixture(): Promise<Fixture> {
  // 顺序刻意「前缀 → 子串 → 别名」，与期望顺序一致；id 升序即期望顺序。
  const prefixId = await createFood({ name: `${KEYWORD}气泡水`, kcalPer100g: 12, namePinyin: 'ningqingshiyan' });
  const substringId = await createFood({ name: `白桃${KEYWORD}味`, kcalPer100g: 40 });
  const aliasId = await createFood({ name: 'ZQ-Soda', kcalPer100g: 30, aliases: [KEYWORD] });
  // 不可见：source=user_custom 且 createdByUserId 为 null（不属于任何用户）→ 必须被过滤
  const privateId = await createFood({
    name: `${KEYWORD}私有款`,
    kcalPer100g: 99,
    source: 'user_custom',
    createdByUserId: null,
  });
  return { prefixId, substringId, aliasId, privateId };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  prisma = app.get(PrismaService);
  server = app.getHttpServer();

  await cleanup();

  await request(server as never).post(`${API}/auth/send-code`).send({ email: USER }).expect(200);
  const code = findCode(USER);
  const res = await request(server as never)
    .post(`${API}/auth/verify-code`)
    .send({ email: USER, code })
    .expect(200);
  token = (res.body.data as { accessToken: string }).accessToken;
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

interface SearchHitBody {
  id: number;
  name: string;
  qualifier: string | null;
  matchRank: number;
  kcalPer100g: number;
}

interface SearchBody {
  items: SearchHitBody[];
  total: number;
  page: number;
  pageSize: number;
}

describe('GET /foods/search 相关度排序（阶段 2.1 / 2.2）', () => {
  it('前缀命中 > 子串命中 > 仅别名命中，且 total 正确', async () => {
    const fixture = await seedRankFixture();

    const res = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: KEYWORD, pageSize: 20 })
      .set(auth(token))
      .expect(200);

    expect(res.body.error).toBeNull();
    const data = res.body.data as SearchBody;

    // 私有条目被可见性过滤：total 恰好是 3（前缀 / 子串 / 别名）
    expect(data.total).toBe(3);
    expect(data.items.map((item) => item.id)).toEqual([
      fixture.prefixId,
      fixture.substringId,
      fixture.aliasId,
    ]);
    // 档位：0 前缀 / 1 子串 / 2 仅别名
    expect(data.items.map((item) => item.matchRank)).toEqual([0, 1, 2]);
  });

  it('稳定分页：pageSize=2 时翻页不跳条、不重复，越界页为空', async () => {
    const res1 = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: KEYWORD, page: 1, pageSize: 2 })
      .set(auth(token))
      .expect(200);
    const page1 = res1.body.data as SearchBody;
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);

    const res2 = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: KEYWORD, page: 2, pageSize: 2 })
      .set(auth(token))
      .expect(200);
    const page2 = res2.body.data as SearchBody;
    expect(page2.total).toBe(3);
    expect(page2.items).toHaveLength(1);

    // 两页拼接 = 全部命中，且无重复（稳定分页）
    const ids = [...page1.items, ...page2.items].map((item) => item.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);

    const res3 = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: KEYWORD, page: 9, pageSize: 2 })
      .set(auth(token))
      .expect(200);
    expect((res3.body.data as SearchBody).items).toEqual([]);
  });

  it('也可用 q/keyword 的别名写法与 limit/offset（沿用既有 DTO）', async () => {
    const res = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ keyword: KEYWORD, limit: 1, offset: 1 })
      .set(auth(token))
      .expect(200);
    const data = res.body.data as SearchBody;
    expect(data.total).toBe(3);
    expect(data.items).toHaveLength(1);
    // offset=1 / limit=1 → 第 2 条（子串命中）
    expect(data.items[0]?.matchRank).toBe(1);
  });

  it('未带令牌 → 401（鉴权不变）', async () => {
    await request(server as never).get(`${API}/foods/search`).query({ q: KEYWORD }).expect(401);
  });
});

describe('跨来源同物异名：标注区分词而非合并（阶段 2.3）', () => {
  it('搜「蘑菇」三条干/鲜/罐头都在，各带自己的区分词；且不按热量排序', async () => {
    // 入库顺序刻意与热量高低**相反**：
    // 鲜蘑 24 kcal 先入库（id 最小）、干 295 kcal 次之、罐头 22 kcal 最后。
    // 若实现真按热量排（或按「低卡优先」），顺序就会变成 干 在前 —— 本用例会立刻失败。
    const freshId = await createFood({ name: '蘑菇（鲜蘑）', kcalPer100g: 24, category: '蔬菜' });
    const dryId = await createFood({ name: '蘑菇(干)', kcalPer100g: 295, category: '蔬菜' });
    const canId = await createFood({ name: '蘑菇（罐头）', kcalPer100g: 22, category: '蔬菜' });

    const res = await request(server as never)
      .get(`${API}/foods/search`)
      .query({ q: '蘑菇', pageSize: 100 })
      .set(auth(token))
      .expect(200);
    const data = res.body.data as SearchBody;

    const mine = data.items.filter((item) => [freshId, dryId, canId].includes(item.id));
    // 三条都在：**没有**被静默合并成一条
    expect(mine).toHaveLength(3);
    // 同档（都是前缀命中）→ 按 id 升序 = 入库顺序，与热量无关
    expect(mine.map((item) => item.id)).toEqual([freshId, dryId, canId]);
    expect(mine.map((item) => item.qualifier)).toEqual(['鲜蘑', '干', '罐头']);
    // 热量最高的「干」排在中间而不是第一 —— 排序里没有任何营养值参与
    expect(mine[0]?.kcalPer100g).toBe(24);
    expect(mine[1]?.kcalPer100g).toBe(295);
  });
});

describe('旧端点契约未被收紧（阶段 2.1 边界）', () => {
  it('GET /foods 仍是 {items,total,page,pageSize}，单条不带 qualifier', async () => {
    const res = await request(server as never)
      .get(`${API}/foods`)
      .query({ q: KEYWORD, limit: 20, offset: 0 })
      .set(auth(token))
      .expect(200);
    const data = res.body.data as SearchBody & { items: Array<Record<string, unknown>> };
    expect(Object.keys(data).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(data.total).toBe(3); // 私有条目同样不可见（可见性口径不变）
    for (const item of data.items) {
      expect(item).not.toHaveProperty('qualifier');
      expect(item).not.toHaveProperty('matchRank');
    }
  });
});
