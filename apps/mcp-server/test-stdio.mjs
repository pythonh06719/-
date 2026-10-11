/**
 * MCP server 验证脚本（stdio 客户端，零依赖）。
 *
 * 完整走一遍 MCP 协议，覆盖 11 个工具：
 *   - initialize → notifications/initialized → tools/list（断言工具数 = 11）
 *   - `explain_budget`：无需 MCP_USER_ID，验证推导明细
 *   - **授权闸**：未设 MCP_USER_ID 时，写工具（log_meal / log_water / log_weight）
 *     与读用户数据工具必须返回**可读错误**（拒绝而非静默失败）
 *   - 设了测试用 MCP_USER_ID 时：get_daily_summary / list_recent_meals 真实取数，
 *     并验证 log_water 的成功路径（写入后清理，保持库干净）
 *
 * 用法：node apps/mcp-server/test-stdio.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** 期望工具清单（顺序即 `tools/list` 顺序）。 */
const EXPECTED_TOOLS = [
  'search_food',
  'calc_budget',
  'estimate_exercise',
  'list_activities',
  'explain_budget',
  'get_daily_summary',
  'list_recent_meals',
  'get_weight_trend',
  'log_meal',
  'log_water',
  'log_weight',
];

/** 测试用数据库连接（仅用于挑选测试账号与写入后清理，不影响被测服务）。 */
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./dev.db';
const prisma = new PrismaClient();

/** 基础环境：DATABASE_URL 指向本地 dev.db，并**确保**不含 MCP_USER_ID（由调用方按需显式设置）。 */
const baseEnv = { ...process.env, DATABASE_URL: 'file:./dev.db' };
delete baseEnv.MCP_USER_ID;

/** 启动一个 MCP server 子进程 + 简单的 JSON-RPC 客户端。 */
function startServer(env) {
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: here,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const pending = new Map();
  const readline = createInterface({ input: child.stdout });
  readline.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolvePromise = pending.get(message.id);
      pending.delete(message.id);
      resolvePromise(message);
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolvePromise) => {
      pending.set(id, resolvePromise);
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async function handshake() {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-script', version: '0.1.0' },
    });
    if (init.error) throw new Error(`initialize 失败：${JSON.stringify(init.error)}`);
    notify('notifications/initialized');
    return init.result?.serverInfo;
  }

  return { child, request, notify, handshake, getStderr: () => stderr };
}

/** 取工具调用返回的文本 payload（解析 JSON）。 */
function payloadOf(message) {
  const text = message.result?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function fail(message, stderr) {
  console.error(`✗ ${message}`);
  if (stderr && stderr.length > 0) console.error('--- stderr ---\n' + stderr.slice(0, 1500));
  process.exitCode = 1;
}

const results = {};
let createdWaterId = null;

/**
 * 体重趋势统计口径校验用的**一次性隔离账号**。
 *
 * 为什么另建账号而不是拿真实用户的数据去凑数：
 * `get_weight_trend` 的窗口锚定在今天，真实用户在窗口里的既有体重记录会混进来，
 * 污染 min/max/change 的期望值（也拿不到稳定的、能区分 round1/round2 的数字）。
 * 用一个新账号自造三条 >2 位小数的体重，断言才有确定性；跑完连同账号删掉。
 */
const TREND_PROBE_EMAIL = 'mcp-trend-parity-probe@qsh.local';

try {
  // -------------------------------------------------------------------------
  // 阶段一：未设 MCP_USER_ID —— 工具清单 + 授权闸
  // -------------------------------------------------------------------------
  const phaseOne = startServer({ ...baseEnv });
  results.serverInfo = await phaseOne.handshake();

  const list = await phaseOne.request('tools/list');
  results.tools = (list.result?.tools ?? []).map((tool) => tool.name);
  if (results.tools.length !== EXPECTED_TOOLS.length) {
    fail(`工具数应为 ${EXPECTED_TOOLS.length}，实际 ${results.tools.length}`, phaseOne.getStderr());
  } else if (EXPECTED_TOOLS.some((name) => !results.tools.includes(name))) {
    fail(`工具清单缺少：${EXPECTED_TOOLS.filter((name) => !results.tools.includes(name)).join(', ')}`, phaseOne.getStderr());
  }

  // explain_budget 无需用户配置，应成功（纯计算）
  const explain = await phaseOne.request('tools/call', {
    name: 'explain_budget',
    arguments: {
      gender: 'female',
      age: 28,
      heightCm: 163,
      weightKg: 62,
      targetWeightKg: 56,
      targetWeeks: 12,
      activityLevel: 'light',
    },
  });
  const explainPayload = payloadOf(explain);
  results.explainBudget = {
    isError: explain.result?.isError === true,
    derivationSteps: Array.isArray(explainPayload.derivation) ? explainPayload.derivation.length : 0,
    intakeRecommended: explainPayload.result?.intakeRecommended ?? null,
    safeguardFlags: explainPayload.safeguards ?? null,
  };
  if (explain.result?.isError === true) fail('explain_budget 不应报错（纯计算工具）', phaseOne.getStderr());
  if (results.explainBudget.derivationSteps !== 9) {
    fail(`explain_budget 推导应为 9 步，实际 ${results.explainBudget.derivationSteps}`, phaseOne.getStderr());
  }
  if (typeof explainPayload.result?.intakeRecommended !== 'number' || explainPayload.result.intakeRecommended <= 0) {
    fail('explain_budget 未返回有效 intakeRecommended', phaseOne.getStderr());
  }

  // -------------------------------------------------------------------------
  // A3：taper 命中的算例（70 → 68.5 / 10 周）——「每周目标减重」必须与「原始缺口」同源
  //
  // 为什么必须钉住：改前这一行用本地 `deriveWeeklyLossKg` 重算，拿到的是 taper **前** 的
  // base 速度 0.15；而紧邻的「原始缺口」来自 core taper **后** 的 123.7 ——
  // 0.15 × 7700 ÷ 7 = 165 ≠ 123.7，同一份响应里两个数字乘不出彼此（NFR-11 破损）。
  //
  // 断言取「两行互为一致」的反推式写法，而不是「165 不该出现」—— 后者是从没被打印过
  // 的值，改不改都绿，等于没测。
  // -------------------------------------------------------------------------
  const explainTaper = await phaseOne.request('tools/call', {
    name: 'explain_budget',
    arguments: {
      gender: 'female',
      age: 28,
      heightCm: 163,
      weightKg: 70,
      targetWeightKg: 68.5,
      targetWeeks: 10,
      activityLevel: 'light',
    },
  });
  const taperPayload = payloadOf(explainTaper);
  const taperRawText = explainTaper.result?.content?.[0]?.text ?? '';
  const taperStep = (taperPayload.derivation ?? []).find((entry) => entry.name === '每周目标减重');
  const taperDeficitStep = (taperPayload.derivation ?? []).find((entry) => entry.name === '原始缺口');
  const taperDerivedPerDayKcal = ((taperStep?.value ?? 0) * 7700) / 7;
  const taperDeficitGap = Math.abs(taperDerivedPerDayKcal - (taperDeficitStep?.value ?? 0));
  results.explainBudgetTaper = {
    isError: explainTaper.result?.isError === true,
    weeklyLossKg: taperStep?.value ?? null,
    targetDeficitRaw: taperDeficitStep?.value ?? null,
    hint: taperStep?.hint ?? null,
    hasPerDayKcal: taperRawText.includes('perDayKcal'),
    deficitGap: Math.round(taperDeficitGap * 100) / 100,
  };

  // ① 必须是 core taper **后** 的 0.11，不是 taper 前的 0.15
  if (taperStep?.value !== 0.11) {
    fail(`taper 算例「每周目标减重」应为 core 的 0.11（不是 taper 前的 0.15），实际 ${taperStep?.value}`, phaseOne.getStderr());
  }
  // ② perDayKcal 已按契约删减（与「原始缺口」是同一个概念，不再给第三个精度）
  if (taperRawText.includes('perDayKcal')) {
    fail('explain_budget 响应里不应再出现 perDayKcal 字段', phaseOne.getStderr());
  }
  // ③ 同一份响应里的这两行必须互为一致：由行值反推的 kcal/日 落在 core 取整容差内
  //    （0.11 × 7700 ÷ 7 = 121.0 vs 123.7 → 差 2.7 ≤ 6；退回 0.15 则为 165，差 41.3 → 转红）
  if (!(taperDeficitGap <= 6)) {
    fail(`「每周目标减重」与「原始缺口」应互为一致（反推差 ≤ 6），实际差 ${taperDeficitGap}`, phaseOne.getStderr());
  }
  // ④ taper 生效时要有提示，且措辞守住无负罪感红线
  if (typeof taperStep?.hint !== 'string' || taperStep.hint.length === 0) {
    fail('taper 生效时「每周目标减重」应带 hint', phaseOne.getStderr());
  } else {
    const BANNED_WORDS = ['失败', '错误', '警告', '崩溃', '必须', '一定', '坚持', '赶紧'];
    const bannedHits = BANNED_WORDS.filter((word) => taperStep.hint.includes(word));
    results.explainBudgetTaper.bannedWords = bannedHits;
    if (bannedHits.length > 0) {
      fail(`taper hint 含禁用词：${bannedHits.join('、')}（原文：${taperStep.hint}）`, phaseOne.getStderr());
    }
  }

  // 授权闸：写工具在未设 MCP_USER_ID 时必须返回可读错误（拒绝写入）
  const writeCalls = [
    { name: 'log_meal', arguments: { foodId: 1, grams: 150, mealType: 'lunch' } },
    { name: 'log_water', arguments: {} },
    { name: 'log_weight', arguments: { weightKg: 60 } },
  ];
  results.writeGate = {};
  for (const call of writeCalls) {
    const response = await phaseOne.request('tools/call', call);
    const payload = payloadOf(response);
    const errored = response.result?.isError === true;
    const mentionsConfig = typeof payload.error === 'string' && payload.error.includes('MCP_USER_ID');
    results.writeGate[call.name] = { isError: errored, message: payload.error ?? payload };
    if (!errored || !mentionsConfig) {
      fail(`${call.name} 在未设 MCP_USER_ID 时应返回包含「MCP_USER_ID」的可读错误`, phaseOne.getStderr());
    }
  }

  // 读用户数据工具同样需要 MCP_USER_ID（否则无用户可读）→ 应给出可读错误
  const readGate = await phaseOne.request('tools/call', { name: 'get_daily_summary', arguments: {} });
  const readGatePayload = payloadOf(readGate);
  results.readGate = { isError: readGate.result?.isError === true, message: readGatePayload.error ?? readGatePayload };
  if (readGate.result?.isError !== true) {
    fail('get_daily_summary 在未设 MCP_USER_ID 时应返回可读错误', phaseOne.getStderr());
  }

  phaseOne.child.kill();

  // -------------------------------------------------------------------------
  // 阶段二：设置测试用 MCP_USER_ID —— 真实取数 + 写成功路径（写后清理）
  // -------------------------------------------------------------------------
  const testUser = await prisma.user.findFirst({ select: { id: true, email: true } });
  if (testUser === null) {
    results.phaseTwo = '跳过：库中暂无用户可用于成功路径验证';
  } else {
    const phaseTwo = startServer({ ...baseEnv, MCP_USER_ID: String(testUser.id) });
    await phaseTwo.handshake();

    const summary = await phaseTwo.request('tools/call', { name: 'get_daily_summary', arguments: {} });
    const summaryPayload = payloadOf(summary);
    results.dailySummary = {
      isError: summary.result?.isError === true,
      date: summaryPayload.date ?? null,
      intakeKcal: summaryPayload.intakeKcal ?? null,
    };
    if (summary.result?.isError === true) fail('get_daily_summary 在配置 MCP_USER_ID 后应成功', phaseTwo.getStderr());
    if (typeof summaryPayload.date !== 'string') fail('get_daily_summary 未返回 date', phaseTwo.getStderr());

    const recent = await phaseTwo.request('tools/call', { name: 'list_recent_meals', arguments: { days: 3 } });
    const recentPayload = payloadOf(recent);
    results.recentMeals = {
      isError: recent.result?.isError === true,
      days: recentPayload.days ?? null,
      count: recentPayload.count ?? null,
    };
    if (recent.result?.isError === true) fail('list_recent_meals 应成功', phaseTwo.getStderr());
    if (!Array.isArray(recentPayload.entries)) fail('list_recent_meals 未返回 entries 数组', phaseTwo.getStderr());

    // 写成功路径：log_water（追加型记录，写后按 id 清理）
    const water = await phaseTwo.request('tools/call', { name: 'log_water', arguments: { amountMl: 250 } });
    const waterPayload = payloadOf(water);
    results.logWaterSuccess = {
      isError: water.result?.isError === true,
      logged: waterPayload.logged ?? false,
      logId: waterPayload.logId ?? null,
      totalMl: waterPayload.totalMl ?? null,
    };
    if (water.result?.isError === true || waterPayload.logged !== true) {
      fail('log_water 成功路径失败（已配置 MCP_USER_ID）', phaseTwo.getStderr());
    }
    if (typeof waterPayload.logId === 'number') createdWaterId = waterPayload.logId;

    // 食物存在性校验：不存在的 foodId 应返回可读错误（不写入）
    const badFood = await phaseTwo.request('tools/call', {
      name: 'log_meal',
      arguments: { foodId: 99999999, grams: 150, mealType: 'lunch' },
    });
    const badFoodPayload = payloadOf(badFood);
    results.logMealBadFood = { isError: badFood.result?.isError === true, message: badFoodPayload.error ?? null };
    if (badFood.result?.isError !== true) fail('log_meal 对不存在的 foodId 应返回可读错误', phaseTwo.getStderr());

    phaseTwo.child.kill();
    results.phaseTwo = { userId: testUser.id, email: testUser.email };
  }

  // -------------------------------------------------------------------------
  // 阶段三：体重趋势统计口径必须与 App 一致（round2），不能是第三份答案
  //
  // 这三条体重都故意带 3 位小数。分歧点：
  //   round2（App 口径）→ min 59.88 / max 61.23 / change -0.68
  //   round1（改前的 MCP 口径）→ change -0.7
  //   不取整（改前的 MCP 口径）→ min 59.876 / max 61.234
  // 断言取 round2，等于同时否掉另外两种。
  // -------------------------------------------------------------------------
  const todayKey = (() => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  })();
  const shiftKey = (key, deltaDays) => {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + deltaDays);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  };
  const probeWeightKgByDate = new Map([
    [shiftKey(todayKey, -2), 60.555],
    [shiftKey(todayKey, -1), 61.234],
    [todayKey, 59.876],
  ]);

  await prisma.user.deleteMany({ where: { email: TREND_PROBE_EMAIL } });
  const probeUser = await prisma.user.create({ data: { email: TREND_PROBE_EMAIL } });
  for (const [date, weightKg] of probeWeightKgByDate) {
    await prisma.weightLog.create({ data: { userId: probeUser.id, loggedAt: date, weightKg } });
  }

  try {
    const phaseThree = startServer({ ...baseEnv, MCP_USER_ID: String(probeUser.id) });
    await phaseThree.handshake();

    const trend = await phaseThree.request('tools/call', {
      name: 'get_weight_trend',
      arguments: { days: 3 },
    });
    const trendPayload = payloadOf(trend);
    const trendStats = trendPayload.stats ?? {};

    results.weightTrendParity = {
      isError: trend.result?.isError === true,
      count: trendStats.count ?? null,
      points: Array.isArray(trendPayload.points) ? trendPayload.points.length : 0,
      minKg: trendStats.minKg ?? null,
      maxKg: trendStats.maxKg ?? null,
      latestKg: trendStats.latestKg ?? null,
      changeKg: trendStats.changeKg ?? null,
    };

    if (trend.result?.isError === true) {
      fail('get_weight_trend 应成功（隔离账号）', phaseThree.getStderr());
    }
    if (trendPayload.points?.length !== 3 || trendStats.count !== 3) {
      fail(`窗口内应有 3 条体重记录，实际 points=${trendPayload.points?.length} count=${trendStats.count}`, phaseThree.getStderr());
    }
    // 核心断言：必须等于 round2（App 口径），且不等于 round1 / 不取整那两个旧答案
    if (trendStats.minKg !== 59.88) {
      fail(`minKg 应为 round2 的 59.88（不是 59.876、也不是 round1 的 59.9），实际 ${trendStats.minKg}`, phaseThree.getStderr());
    }
    if (trendStats.maxKg !== 61.23) {
      fail(`maxKg 应为 round2 的 61.23（不是 61.234），实际 ${trendStats.maxKg}`, phaseThree.getStderr());
    }
    if (trendStats.latestKg !== 59.88) {
      fail(`latestKg 应为 round2 的 59.88（取最晚一天，不是数组末位的巧合），实际 ${trendStats.latestKg}`, phaseThree.getStderr());
    }
    if (trendStats.changeKg !== -0.68) {
      fail(`changeKg 应为 round2 的 -0.68（不是 round1 的 -0.7），实际 ${trendStats.changeKg}`, phaseThree.getStderr());
    }

    // ---------------------------------------------------------------------
    // A1：`log_weight` 写库不得取整 —— 必须与后端写路径（`WeightsService`）一致
    //
    // 为什么必须钉住：MCP 侧**曾经** `round1(weightKg)`，同一笔 62.345 走 API 存 62.345、
    // 走 MCP 却存 62.3（round1 得 62.3）或 62.35（round2）—— 写侧取整是**不可逆**的精度
    // 丢失，存量数据被抹掉真实值，且没有备份可回滚。这里同时断言响应与落库的行。
    // ---------------------------------------------------------------------
    const rawWeightKg = 62.345;
    const rawWeightDate = shiftKey(todayKey, -5);
    const weightWrite = await phaseThree.request('tools/call', {
      name: 'log_weight',
      arguments: { weightKg: rawWeightKg, date: rawWeightDate },
    });
    const weightWritePayload = payloadOf(weightWrite);
    const storedWeight = await prisma.weightLog.findUnique({
      where: { userId_loggedAt: { userId: probeUser.id, loggedAt: rawWeightDate } },
      select: { weightKg: true },
    });
    results.logWeightPrecision = {
      isError: weightWrite.result?.isError === true,
      respondedKg: weightWritePayload.weightKg ?? null,
      storedKg: storedWeight?.weightKg ?? null,
    };
    if (weightWrite.result?.isError === true) {
      fail('log_weight 成功路径应可用（隔离账号）', phaseThree.getStderr());
    }
    if (weightWritePayload.weightKg !== rawWeightKg) {
      fail(`log_weight 应原样返回 ${rawWeightKg}（不是 round1 的 62.3），实际 ${weightWritePayload.weightKg}`, phaseThree.getStderr());
    }
    if (storedWeight?.weightKg !== rawWeightKg) {
      fail(`log_weight 落库应为 ${rawWeightKg}（后端写路径同样不取整），实际 ${storedWeight?.weightKg}`, phaseThree.getStderr());
    }

    // ---------------------------------------------------------------------
    // A5：非法日历日期必须**拒绝**，不能静默改写成另一天
    //
    // 为什么必须钉住：`2026-02-31` 形状合法但日历上不存在。旧实现只验形状 → 放行，
    // 然后被**原样写进日期键**（饮水写 `loggedDate`，是日期键字符串，不做 Date 转换，
    // 所以并不会「自动纠正」），留下一条日历上不存在的桶：UI 永远翻不到这一天，
    // 却会污染按日期聚合的查询；而同一输入走 API 侧是 `@IsLocalDateKey` 直接 400 拒绝。
    // ---------------------------------------------------------------------
    const illegalDate = '2026-02-31';
    const illegalWrite = await phaseThree.request('tools/call', {
      name: 'log_water',
      arguments: { amountMl: 200, date: illegalDate },
    });
    const illegalPayload = payloadOf(illegalWrite);
    // 脏数据的落点：就是 `loggedDate` 本身（不是 loggedAt —— loggedAt 是本笔的时间戳）
    const illegalRow = await prisma.waterLog.findFirst({
      where: { userId: probeUser.id, loggedDate: illegalDate },
      select: { id: true },
    });
    results.illegalDateKey = {
      isError: illegalWrite.result?.isError === true,
      message: illegalPayload.error ?? null,
      illegalRowCreated: illegalRow !== null,
    };
    if (illegalWrite.result?.isError !== true) {
      fail(`log_water 传 ${illegalDate} 应被拒绝（不存在的日历日期），实际返回成功`, phaseThree.getStderr());
    }
    if (illegalRow !== null) {
      fail(`log_water 传 ${illegalDate} 不应真的写成 ${illegalDate} 这一天（库里出现了该行）`, phaseThree.getStderr());
    }

    // ---------------------------------------------------------------------
    // A2：`log_meal` 的营养换算必须走 core `scaleFoodNutrients`
    //
    // 为什么必须钉在边界上：主路径 `per100 × grams ÷ 100` 两种写法数值等价，只有边界不同 ——
    // 膳食纤维 / 钠，core 用 `isPositive(...)`（**0 与负数 → null**），旧写法用 `=== null`
    // 判断（**0 → 0**）。这里专门造一个 fiber / sodium 都是 0 的食物：
    // 正确的结果是 **`null`**（缺失），旧写法会落一个真的 `0` —— 而 0 会被读侧当成真值
    // 参与求和，正是本项目踩过两次的「缺失被算成达标」事故。
    // ---------------------------------------------------------------------
    const zeroMicroFood = await prisma.foodItem.create({
      data: {
        name: 'mcp-scale-boundary-probe',
        category: 'other',
        kcalPer100g: 100,
        proteinGPer100g: 5,
        fatGPer100g: 2,
        carbGPer100g: 10,
        fiberGPer100g: 0,
        sodiumMgPer100g: 0,
        source: 'user_custom',
        createdByUserId: probeUser.id,
      },
    });
    const mealWrite = await phaseThree.request('tools/call', {
      name: 'log_meal',
      arguments: { foodId: zeroMicroFood.id, grams: 100, mealType: 'lunch' },
    });
    const mealWritePayload = payloadOf(mealWrite);
    const storedMeal = await prisma.mealLog.findUnique({
      where: { id: Number(mealWritePayload.entryId ?? 0) },
      select: { kcal: true, fiberG: true, sodiumMg: true },
    });
    results.logMealScaleBoundary = {
      isError: mealWrite.result?.isError === true,
      entryId: mealWritePayload.entryId ?? null,
      kcal: storedMeal?.kcal ?? null,
      fiberG: storedMeal?.fiberG ?? null,
      sodiumMg: storedMeal?.sodiumMg ?? null,
    };
    if (mealWrite.result?.isError === true) {
      fail('log_meal 成功路径应可用（隔离账号 + 本人自定义食物）', phaseThree.getStderr());
    }
    if (storedMeal?.fiberG !== null) {
      fail(`log_meal 对 fiberGPer100g=0 的食物应落 null（core 的 isPositive 口径），实际 ${storedMeal?.fiberG}`, phaseThree.getStderr());
    }
    if (storedMeal?.sodiumMg !== null) {
      fail(`log_meal 对 sodiumMgPer100g=0 的食物应落 null，实际 ${storedMeal?.sodiumMg}`, phaseThree.getStderr());
    }

    phaseThree.child.kill();
  } finally {
    // 清理：先删依赖行再删账号，确保脚本可重复运行且不残留
    await prisma.weightLog.deleteMany({ where: { userId: probeUser.id } });
    await prisma.waterLog.deleteMany({ where: { userId: probeUser.id } });
    await prisma.mealLog.deleteMany({ where: { userId: probeUser.id } });
    await prisma.foodItem.deleteMany({ where: { createdByUserId: probeUser.id } });
    await prisma.user.delete({ where: { id: probeUser.id } });
    results.weightTrendCleanup = `已删除隔离账号 ${TREND_PROBE_EMAIL} 及其 ${probeWeightKgByDate.size} 条体重`;
  }

  // -------------------------------------------------------------------------
  // 清理：删除本次成功路径写入的饮水记录（保持库干净、脚本可重复运行）
  // -------------------------------------------------------------------------
  if (createdWaterId !== null) {
    await prisma.waterLog.delete({ where: { id: createdWaterId } }).catch(() => undefined);
    results.cleanup = `已删除测试饮水记录 id=${createdWaterId}`;
  }

  await prisma.$disconnect();

  console.log(JSON.stringify(results, null, 1));
  if (process.exitCode === 1) {
    console.error('\n✗ MCP server 验证未通过');
  } else {
    console.log('\n✓ MCP server 验证通过（11 个工具 / 授权闸 / 只读取数 / 写成功路径 全部正常）');
  }
  process.exit(process.exitCode ?? 0);
} catch (error) {
  await prisma.$disconnect().catch(() => undefined);
  fail(`验证失败：${error?.message ?? error}`);
  process.exit(1);
}
