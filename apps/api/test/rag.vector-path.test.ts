/**
 * 回归测试：种子向量文件路径解析与安全降级（Bug 修复锁定）。
 *
 * 背景（Bug）：`vector-search.service.ts` 曾用
 *   `join(process.cwd(), 'infra/db/seed/food_embeddings.json')`
 * 解析向量文件。当服务从 `apps/api` 目录启动（cwd = apps/api）时解析到不存在的路径，
 * 触发 ENOENT → 内存向量恒为空 → 向量检索静默退化成 LIKE 关键词（生产因恰好从仓库根
 * 启动而掩盖了问题）。本测试锁定修复后的行为：
 *   1. 无论 cwd 是什么，都能解析到真实存在的 `food_embeddings.json`；
 *   2. `FOOD_EMBEDDINGS_PATH` 显式覆盖优先（绝对 / 相对路径均支持）；
 *   3. 三级候选全部不可用时安全降级，**不抛错**。
 * 纯函数 / 无网络 / 无外部依赖。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveFoodEmbeddingsPath,
  VectorSearchService,
} from '../src/foods/rag/vector-search.service';

/** 期望的向量文件相对仓库根路径后缀。 */
const SEED_SUFFIX = join('infra', 'db', 'seed', 'food_embeddings.json');

const originalCwd = process.cwd();
const originalEmbeddingsEnv = process.env.FOOD_EMBEDDINGS_PATH;

afterEach(() => {
  // 还原 cwd 与环境变量，避免用例间相互污染。
  process.chdir(originalCwd);
  if (originalEmbeddingsEnv === undefined) {
    delete process.env.FOOD_EMBEDDINGS_PATH;
  } else {
    process.env.FOOD_EMBEDDINGS_PATH = originalEmbeddingsEnv;
  }
  vi.restoreAllMocks();
});

describe('resolveFoodEmbeddingsPath —— 与 cwd 解耦', () => {
  it('cwd 为仓库根 / apps/api / 系统临时目录时，均能解析到真实存在的向量文件', () => {
    const cwds = [
      originalCwd, // apps/api（vitest 默认 cwd —— 曾是 Bug 触发点）
      join(originalCwd, '..', '..'), // 仓库根
      tmpdir(), // 与仓库无关的任意目录
    ];
    for (const cwd of cwds) {
      process.chdir(cwd);
      const resolved = resolveFoodEmbeddingsPath();
      expect(isAbsolute(resolved)).toBe(true);
      expect(resolved.endsWith(SEED_SUFFIX)).toBe(true);
      expect(existsSync(resolved)).toBe(true);
    }
  });

  it('FOOD_EMBEDDINGS_PATH 显式覆盖（绝对路径）优先命中', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qsh-emb-abs-'));
    const fake = join(dir, 'custom.json');
    writeFileSync(fake, JSON.stringify({ dim: 256, vectors: [] }), 'utf-8');
    process.env.FOOD_EMBEDDINGS_PATH = fake;
    expect(resolveFoodEmbeddingsPath()).toBe(fake);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FOOD_EMBEDDINGS_PATH 支持相对路径（相对 cwd 解析）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qsh-emb-rel-'));
    const fake = join(dir, 'custom.json');
    writeFileSync(fake, JSON.stringify({ dim: 256, vectors: [] }), 'utf-8');
    process.chdir(dir);
    process.env.FOOD_EMBEDDINGS_PATH = 'custom.json';
    expect(resolveFoodEmbeddingsPath()).toBe(fake);
    process.chdir(originalCwd); // Windows 下不能删除仍为 cwd 的目录
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveFoodEmbeddingsPath —— 安全降级', () => {
  it('三级候选全部不可用时，返回不存在的路径且不抛错', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qsh-none-'));
    let resolved = '';
    expect(() => {
      resolved = resolveFoodEmbeddingsPath({ startDir: empty, cwd: empty });
    }).not.toThrow();
    expect(isAbsolute(resolved)).toBe(true);
    expect(existsSync(resolved)).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('VectorSearchService —— 加载与降级', () => {
  it('向量未加载（未初始化）时 search 安全返回空数组，不抛错', async () => {
    const service = new VectorSearchService({} as never);
    await expect(service.search(1, '豆腐', 3)).resolves.toEqual([]);
  });

  it('onModuleInit 从 apps/api（Bug 触发 cwd）加载向量，且不再出现 not loaded 告警', async () => {
    // 显式回到 apps/api —— 修复前该 cwd 下必现 ENOENT。
    process.chdir(originalCwd);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const logSpy = vi.spyOn(Logger.prototype, 'log');

    const service = new VectorSearchService({} as never);
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const notLoaded = warnSpy.mock.calls.some((call) => String(call[0]).includes('not loaded'));
    expect(notLoaded).toBe(false);
    const loaded = logSpy.mock.calls.some((call) => String(call[0]).includes('loaded'));
    expect(loaded).toBe(true);
  });
});
