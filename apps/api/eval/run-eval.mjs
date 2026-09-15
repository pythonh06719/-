/**
 * Agent 评测（Eval）运行器 —— 让「可靠」变成可度量的数字。
 *
 * 三种模式：
 *   node eval/run-eval.mjs --live     真实调用 LLM 跑全部用例，输出通过率报告（需要 AI_API_KEY）
 *   node eval/run-eval.mjs --record   同 live，并把每轮模型原始回复写入 eval/fixtures/<id>.json
 *   node eval/run-eval.mjs --replay   用 fixtures 回放（**不联网、零成本**），在 CI 中验证
 *                                     循环与断言逻辑本身没被改坏
 *
 * 设计取舍：
 * - 断言针对**可判定的行为**（状态 / 工具链 / 是否编造 / 是否触发安全闸），
 *   而不是比对逐字文案 —— 模型措辞天然会漂移，比对文案的 eval 只会天天红。
 * - 直接驱动 AgentService（不起 HTTP 服务）：更快，也能精确替换 LLM 提供者。
 * - `--live` 会消耗真实 token；`--replay` 在 CI 跑，因此 CI 永不花钱。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const mode = process.argv.includes('--live')
  ? 'live'
  : process.argv.includes('--record')
    ? 'record'
    : 'replay';
const LIVE = mode !== 'replay';
const FIXTURE_DIR = resolve(here, 'fixtures');
const REPORT_PATH = resolve(here, 'eval-report.json');

// replay 模式无需真实 key，但要满足「已配置」判定
if (!LIVE) {
  process.env.AI_ENABLED = 'true';
  process.env.AI_API_KEY = process.env.AI_API_KEY || 'replay-fixture-key';
  process.env.AI_BASE_URL = process.env.AI_BASE_URL || 'https://example.invalid/v1';
  process.env.AI_MODEL = process.env.AI_MODEL || 'fixture-model';
}

const distDir = resolve(here, '..', 'dist');
if (!existsSync(resolve(distDir, 'apps/api/src/main.js'))) {
  console.error('未找到构建产物，请先执行：npm run build -w @qsh/api');
  process.exit(2);
}

const { Test } = require('@nestjs/testing');
const { AppModule } = require(resolve(distDir, 'apps/api/src/app.module.js'));
const { AgentService } = require(resolve(distDir, 'apps/api/src/ai/agent.service.js'));
const { PrismaService } = require(resolve(distDir, 'apps/api/src/prisma/prisma.service.js'));
const { LLM_CHAT_WITH_TOOLS } = require(resolve(distDir, 'apps/api/src/ai/llm.client.js'));

/** 回放/录制状态 */
let currentCaseId = null;
let replayCursor = 0;
let capture = null;

function fixturesOf(caseId) {
  const file = resolve(FIXTURE_DIR, `${caseId}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** 提供者：live 用真实实现；record 记录；replay 回放 */
function makeLlmProvider(realChat) {
  return async (messages, tools) => {
    if (LIVE) {
      const result = await realChat(messages, tools);
      if (mode === 'record' && capture !== null) {
        capture.push(result);
      }
      return result;
    }
    const fixture = fixturesOf(currentCaseId);
    if (fixture === null) {
      throw new Error(`缺少 fixture：eval/fixtures/${currentCaseId}.json`);
    }
    const reply = fixture[replayCursor];
    replayCursor += 1;
    if (reply === undefined) {
      throw new Error(`fixture 轮次不足：${currentCaseId}（第 ${replayCursor} 轮）`);
    }
    return reply;
  };
}

function assertCase(testCase, run) {
  const failures = [];
  const expect = testCase.expect ?? {};
  const toolNames = run.steps
    .filter((step) => step.type === 'tool' || step.type === 'pending')
    .map((step) => step.tool);
  const answer = run.answer ?? '';

  if (expect.status !== undefined && run.status !== expect.status) {
    failures.push(`status=${run.status}（期望 ${expect.status}）`);
  }
  for (const tool of expect.toolsInclude ?? []) {
    if (!toolNames.includes(tool)) failures.push(`缺少工具调用 ${tool}`);
  }
  for (const tool of expect.toolsExclude ?? []) {
    if (toolNames.includes(tool)) failures.push(`不应调用 ${tool}`);
  }
  if (expect.pendingTool !== undefined) {
    const pending = run.pending?.tool ?? null;
    if (pending !== expect.pendingTool) failures.push(`pending=${pending}（期望 ${expect.pendingTool}）`);
  }
  if (expect.tokensZero === true && run.tokens !== 0) {
    failures.push(`tokens=${run.tokens}（期望 0：不应调用模型）`);
  }
  if (expect.maxToolCalls !== undefined && toolNames.length > expect.maxToolCalls) {
    failures.push(`工具调用 ${toolNames.length} 次（上限 ${expect.maxToolCalls}）`);
  }
  for (const pattern of expect.answerMatch ?? []) {
    if (!new RegExp(pattern).test(answer)) failures.push(`回答未匹配 /${pattern}/`);
  }
  for (const pattern of expect.answerNotMatch ?? []) {
    if (new RegExp(pattern).test(answer)) failures.push(`回答命中禁止项 /${pattern}/`);
  }
  return failures;
}

async function main() {
  const cases = readFileSync(resolve(here, 'cases.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  const llmClient = require(resolve(distDir, 'apps/api/src/ai/llm.client.js'));
  const realChat = llmClient.chatWithTools;
  const { getAiRuntimeConfig } = llmClient;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LLM_CHAT_WITH_TOOLS)
    .useValue(makeLlmProvider((messages, tools) => realChat(getAiRuntimeConfig(), messages, tools)))
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(PrismaService);
  const agent = app.get(AgentService);

  // 评测用户：有档案 + 目标，保证「剩余热量」等断言有真实数字可引用
  const email = 'eval-agent@qinglife.test';
  await prisma.user.deleteMany({ where: { email } });
  const user = await prisma.user.create({ data: { email, status: 'active' } });
  await prisma.userProfile.create({
    data: {
      userId: user.id,
      gender: 'female',
      birthDate: '1996-05-20',
      heightCm: 163,
      activityLevel: 'light',
      onboardingCompletedAt: new Date().toISOString(),
      disclaimerAcceptedAt: new Date().toISOString(),
    },
  });
  await prisma.userGoal.create({
    data: {
      userId: user.id,
      startWeightKg: 62,
      targetWeightKg: 56,
      targetWeeks: 12,
      weeklyLossKg: 0.5,
    },
  });
  await prisma.userSettings.create({ data: { userId: user.id, unit: 'kcal', waterGoalMl: 2000 } });
  const lunch = await prisma.foodItem.findFirst({ where: { name: { contains: '米饭' } } });

  if (mode === 'record' && !existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  const results = [];
  for (const testCase of cases) {
    currentCaseId = testCase.id;
    replayCursor = 0;
    capture = [];
    let run;
    try {
      run = await agent.run(user.id, testCase.question);
    } catch (error) {
      run = { status: 'failed', answer: String(error?.message ?? error), steps: [], tokens: 0, durationMs: 0 };
    }
    const failures = assertCase(testCase, run);
    results.push({
      id: testCase.id,
      category: testCase.category,
      status: run.status,
      tools: run.steps.filter((s) => s.type === 'tool' || s.type === 'pending').map((s) => s.tool),
      tokens: run.tokens,
      durationMs: run.durationMs,
      pass: failures.length === 0,
      failures,
    });

    if (mode === 'record') {
      writeFileSync(resolve(FIXTURE_DIR, `${testCase.id}.json`), JSON.stringify(capture, null, 1));
    }
    const mark = failures.length === 0 ? '✓' : '✗';
    console.log(`${mark} [${testCase.category}] ${testCase.id} → ${run.status} | 工具 ${results.at(-1).tools.join(',') || '—'} | ${run.tokens} token | ${run.durationMs}ms`);
    for (const failure of failures) console.log(`    ↳ ${failure}`);
  }

  const passed = results.filter((item) => item.pass).length;
  const rate = passed / results.length;
  const report = {
    mode,
    ranAt: new Date().toISOString(),
    model: process.env.AI_MODEL ?? '(from .env)',
    total: results.length,
    passed,
    passRate: Number(rate.toFixed(4)),
    avgTokens: Math.round(results.reduce((sum, item) => sum + item.tokens, 0) / results.length),
    avgDurationMs: Math.round(results.reduce((sum, item) => sum + item.durationMs, 0) / results.length),
    byCategory: results.reduce((acc, item) => {
      acc[item.category] = acc[item.category] ?? { total: 0, passed: 0 };
      acc[item.category].total += 1;
      if (item.pass) acc[item.category].passed += 1;
      return acc;
    }, {}),
    results,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n===== 评测汇总 =====');
  console.log(`模式: ${mode} | 用例 ${report.total} | 通过 ${passed} | 通过率 ${(rate * 100).toFixed(1)}%`);
  console.log(`平均 token: ${report.avgTokens} | 平均耗时: ${report.avgDurationMs}ms`);
  for (const [category, stat] of Object.entries(report.byCategory)) {
    console.log(`  ${category}: ${stat.passed}/${stat.total}`);
  }
  console.log(`报告: ${REPORT_PATH}`);

  if (liveFixtureHint(lunch)) {
    console.log('提示：本地库缺少「米饭」，写操作类用例可能受影响（先跑 db:seed）');
  }

  // 显式退出：Nest 测试容器在部分环境（Prisma / Throttler 持有句柄）下 close() 后进程不退出，
  // 会导致 CI 任务挂住 —— 这里不依赖"自然退出"，用完即走。
  await app.close().catch(() => undefined);
  // replay 必须全绿（CI 门禁）；live 允许少量波动，低于 85% 视为失败
  const threshold = LIVE ? 0.85 : 1;
  if (rate < threshold) {
    console.error(`\n❌ 通过率 ${(rate * 100).toFixed(1)}% 低于门禁 ${(threshold * 100).toFixed(0)}%`);
    process.exit(1);
  }
  process.exit(0);
}

function liveFixtureHint(food) {
  return LIVE && food === null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
