/**
 * 在线食物库兜底 / 条码识别 端到端测试（Phase C-1 / C-2：R3.6）。
 *
 * 覆盖：
 * 1. `GET /foods/live-search`：归一化到 FoodItem 形状、过滤脏数据并统计 `skipped`、
 *    缺失/负热量被剔除、`source`/`license`/`sourceUrl` 正确；
 * 2. 上游异常（抛错 / 非 2xx）→ `degraded: true` 且 **HTTP 200**（绝不 500）；
 * 3. 空搜索词短路：不发请求；
 * 4. 鉴权：未带令牌 → 401；
 * 5. `GET /foods/barcode/:code`：非法格式 400、命中入库 200、查不到 404、网络异常降级 200；
 * 6. `POST /foods/import-external`：**入库值来自上游 stub（非请求体）**、按 externalId 幂等、
 *    查不到 404、上游异常 503 `E_EXTERNAL_UNAVAILABLE`。
 *
 * ⚠️ 与 `api.e2e.test.ts` 相同的机制：加载 `dist/**` 编译产物（装饰器元数据）。
 * ⚠️ **全程 stub `globalThis.fetch`**：测试**永不**访问真实 Open Food Facts（离线可跑、确定性）。
 */

import 'reflect-metadata';

import { createRequire } from 'node:module';

import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
const USER = 'e2e-foods-live@qinglife.test';

/** 测试用独立条码（避开种子数据；便于精确清理）。 */
const SEARCH_CODE = '9990000000001';
const NOTRUST_CODE = '9990000000100';
const IDEM_CODE = '9990000000200';
const DEGRADE_CODE = '9990000000300';
const IMPORT_404_CODE = '9990000000400';
const BC_OK_CODE = '9990000000500';
const BC_404_CODE = '9990000000600';
const BC_DEGRADE_CODE = '9990000000700';

const ALL_CODES = [
  SEARCH_CODE,
  NOTRUST_CODE,
  IDEM_CODE,
  DEGRADE_CODE,
  IMPORT_404_CODE,
  BC_OK_CODE,
  BC_404_CODE,
  BC_DEGRADE_CODE,
];

const logSpy = vi.spyOn(Logger.prototype, 'log');

let app: INestApplication;
let prisma: PrismaServiceClass;
let server: unknown;
let token = '';

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

function auth(value: string): { Authorization: string } {
  return { Authorization: `Bearer ${value}` };
}

/** 清理测试用户（级联）与测试导入的食物库条目。 */
async function cleanup(): Promise<void> {
  await prisma.authVerificationCode.deleteMany({ where: { email: USER } });
  await prisma.user.deleteMany({ where: { email: USER } });
  await prisma.foodItem.deleteMany({ where: { barcode: { in: ALL_CODES } } });
}

/** stub `fetch` 返回固定 JSON。 */
function stubFetchJson(payload: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({ ok, status, json: async () => payload }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** 构造一条 OFF 产品。 */
function offProduct(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    code: SEARCH_CODE,
    product_name: '测试气泡水',
    brands: 'FeelGood, OtherBrand',
    categories: 'Beverages, Sparkling waters',
    nutriments: { 'energy-kcal_100g': 2, proteins_100g: 0, fat_100g: 0, carbohydrates_100g: 0.5 },
    serving_quantity: 330,
    ...overrides,
  };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (prisma) {
    await cleanup();
  }
  await app?.close();
});

describe('在线食物库兜底（Phase C-1）', () => {
  it('live-search：归一化 + 过滤脏数据 + skipped + source/license，且不带用户数据', async () => {
    const fetchMock = stubFetchJson({
      products: [
        offProduct({ code: SEARCH_CODE }),
        offProduct({ code: '9990000000002', product_name: '无热量', nutriments: {} }),
        offProduct({ code: '9990000000003', product_name: '负热量', nutriments: { 'energy-kcal_100g': -3 } }),
        offProduct({ code: '9990000000004', product_name: '', generic_name: '' }),
        offProduct({ code: '', product_name: '缺条码' }),
      ],
    });

    const res = await request(server as never)
      .get(`${API}/foods/live-search`)
      .query({ q: '气泡水', limit: 10 })
      .set(auth(token))
      .expect(200);

    expect(res.body.error).toBeNull();
    const data = res.body.data as {
      items: Array<Record<string, unknown>>;
      found: number;
      skipped: number;
      degraded: boolean;
      source: string;
      license: string;
    };

    expect(data.items).toHaveLength(1);
    expect(data.found).toBe(1);
    expect(data.skipped).toBe(4);
    expect(data.degraded).toBe(false);
    expect(data.source).toBe('openfoodfacts');
    expect(data.license).toBe('ODbL 1.0');

    const item = data.items[0] as Record<string, unknown>;
    expect(item.externalId).toBe(SEARCH_CODE);
    expect(item.name).toBe('测试气泡水');
    expect(item.brand).toBe('FeelGood');
    expect(item.category).toBe('饮料');
    expect(item.kcalPer100g).toBe(2);
    expect(item.defaultServingGrams).toBe(330);
    expect(item.source).toBe('openfoodfacts');
    expect(item.license).toBe('ODbL 1.0');
    expect(item.sourceUrl).toBe(`https://world.openfoodfacts.org/product/${SEARCH_CODE}`);

    // 只向 OFF 发搜索词：请求 URL 不含任何用户标识
    const calledUrl = String((fetchMock.mock.calls[0]?.[0] as unknown) ?? '');
    expect(calledUrl).toContain('search_terms=');
    expect(calledUrl).not.toContain('userId');
    expect(calledUrl).not.toContain(String(token));
  });

  it('live-search：上游抛错 → degraded:true 且 HTTP 200（绝不 500）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('off down');
    }));

    const res = await request(server as never)
      .get(`${API}/foods/live-search`)
      .query({ q: '任意词' })
      .set(auth(token))
      .expect(200);

    const data = res.body.data as { items: unknown[]; found: number; degraded: boolean };
    expect(data.degraded).toBe(true);
    expect(data.items).toHaveLength(0);
    expect(data.found).toBe(0);
  });

  it('live-search：上游 500 → degraded:true 且 HTTP 200', async () => {
    stubFetchJson({}, false, 500);
    const res = await request(server as never)
      .get(`${API}/foods/live-search`)
      .query({ q: '任意词2' })
      .set(auth(token))
      .expect(200);
    expect((res.body.data as { degraded: boolean }).degraded).toBe(true);
  });

  it('live-search：空搜索词短路（不发任何外部请求）', async () => {
    const fetchMock = stubFetchJson({ products: [] });
    const res = await request(server as never)
      .get(`${API}/foods/live-search`)
      .set(auth(token))
      .expect(200);
    expect((res.body.data as { items: unknown[]; degraded: boolean }).items).toHaveLength(0);
    expect((res.body.data as { degraded: boolean }).degraded).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('live-search：未带令牌 → 401', async () => {
    stubFetchJson({ products: [] });
    await request(server as never).get(`${API}/foods/live-search`).query({ q: 'x' }).expect(401);
  });

  it('import-external：入库值来自上游（忽略请求体中的热量字段）', async () => {
    stubFetchJson({
      status: 1,
      product: offProduct({
        code: NOTRUST_CODE,
        product_name: '测试麦片',
        brands: 'TestBrand',
        categories: 'Breakfast cereals',
        nutriments: { 'energy-kcal_100g': 380, proteins_100g: 12, fat_100g: 6, carbohydrates_100g: 60 },
        serving_quantity: 40,
      }),
    });

    const res = await request(server as never)
      .post(`${API}/foods/import-external`)
      .set(auth(token))
      // 恶意/错误字段：DTO whitelist 会剥离，且服务端一律以重新拉取为准
      .send({ externalId: NOTRUST_CODE, kcalPer100g: 99999, name: '伪造名称' })
      .expect(200);

    const item = res.body.data as Record<string, unknown>;
    expect(item.kcalPer100g).toBe(380); // 来自上游，不是 99999
    expect(item.name).toBe('测试麦片'); // 来自上游，不是「伪造名称」
    expect(item.source).toBe('openfoodfacts');
    expect(item.barcode).toBe(NOTRUST_CODE);

    const row = await prisma.foodItem.findFirst({ where: { barcode: NOTRUST_CODE } });
    expect(row?.kcalPer100g).toBe(380);
    expect(row?.source).toBe('openfoodfacts');
    expect(row?.createdByUserId).toBeNull();
  });

  it('import-external：幂等（重复导入不重复插，返回同一条）', async () => {
    stubFetchJson({
      status: 1,
      product: offProduct({
        code: IDEM_CODE,
        product_name: '幂等测试食物',
        nutriments: { 'energy-kcal_100g': 120 },
      }),
    });

    const first = await request(server as never)
      .post(`${API}/foods/import-external`)
      .set(auth(token))
      .send({ externalId: IDEM_CODE })
      .expect(200);

    const second = await request(server as never)
      .post(`${API}/foods/import-external`)
      .set(auth(token))
      .send({ externalId: IDEM_CODE })
      .expect(200);

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await prisma.foodItem.count({ where: { barcode: IDEM_CODE } })).toBe(1);
  });

  it('import-external：上游确认不存在 → 404 E_NOTFOUND_FOOD', async () => {
    stubFetchJson({ status: 0, status_verbose: 'product not found' });
    const res = await request(server as never)
      .post(`${API}/foods/import-external`)
      .set(auth(token))
      .send({ externalId: IMPORT_404_CODE })
      .expect(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_FOOD');
  });

  it('import-external：上游异常 → 503 E_EXTERNAL_UNAVAILABLE（不 500）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('off down');
    }));
    const res = await request(server as never)
      .post(`${API}/foods/import-external`)
      .set(auth(token))
      .send({ externalId: DEGRADE_CODE })
      .expect(503);
    expect(res.body.error.code).toBe('E_EXTERNAL_UNAVAILABLE');
  });

  it('import-external：非法条码 → 400 E_VALID_INPUT', async () => {
    stubFetchJson({ status: 1, product: offProduct({ code: 'abc' }) });
    const res = await request(server as never)
      .post(`${API}/foods/import-external`)
      .set(auth(token))
      .send({ externalId: 'abc' })
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
  });
});

describe('条码识别（Phase C-2）', () => {
  it('barcode：非法格式 → 400 E_VALID_INPUT', async () => {
    stubFetchJson({ status: 0 });
    const res = await request(server as never)
      .get(`${API}/foods/barcode/abc`)
      .set(auth(token))
      .expect(400);
    expect(res.body.error.code).toBe('E_VALID_INPUT');
  });

  it('barcode：命中（上游）→ 200 且幂等入库', async () => {
    stubFetchJson({
      status: 1,
      product: offProduct({ code: BC_OK_CODE, product_name: '扫码测试牛奶', categories: 'Dairies' }),
    });

    const res = await request(server as never)
      .get(`${API}/foods/barcode/${BC_OK_CODE}`)
      .set(auth(token))
      .expect(200);

    const data = res.body.data as { item: Record<string, unknown> | null; degraded: boolean };
    expect(data.degraded).toBe(false);
    expect(data.item?.barcode).toBe(BC_OK_CODE);
    expect(data.item?.name).toBe('扫码测试牛奶');
    expect(data.item?.source).toBe('openfoodfacts');

    expect(await prisma.foodItem.count({ where: { barcode: BC_OK_CODE } })).toBe(1);

    // 再次查询命中本地库（不再访问上游）
    const fetchMock = stubFetchJson({ status: 0 });
    const again = await request(server as never)
      .get(`${API}/foods/barcode/${BC_OK_CODE}`)
      .set(auth(token))
      .expect(200);
    expect((again.body.data as { item: { barcode: string } }).item.barcode).toBe(BC_OK_CODE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('barcode：上游确认不存在 → 404 E_NOTFOUND_FOOD', async () => {
    stubFetchJson({ status: 0, status_verbose: 'product not found' });
    const res = await request(server as never)
      .get(`${API}/foods/barcode/${BC_404_CODE}`)
      .set(auth(token))
      .expect(404);
    expect(res.body.error.code).toBe('E_NOTFOUND_FOOD');
  });

  it('barcode：上游异常 → 200 + degraded:true（item 为 null，不 500）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('off down');
    }));
    const res = await request(server as never)
      .get(`${API}/foods/barcode/${BC_DEGRADE_CODE}`)
      .set(auth(token))
      .expect(200);
    const data = res.body.data as { item: unknown; degraded: boolean };
    expect(data.degraded).toBe(true);
    expect(data.item).toBeNull();
  });

  it('barcode：未带令牌 → 401', async () => {
    stubFetchJson({ status: 0 });
    await request(server as never).get(`${API}/foods/barcode/${BC_OK_CODE}`).expect(401);
  });
});
