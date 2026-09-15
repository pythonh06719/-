/**
 * MCP server 验证脚本（stdio 客户端，零依赖）。
 *
 * 完整走一遍 MCP 协议：initialize → notifications/initialized → tools/list
 * → tools/call（calc_budget / search_food / estimate_exercise）→ 输出结果。
 *
 * 用法：node apps/mcp-server/test-stdio.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
  cwd: here,
  env: { ...process.env, DATABASE_URL: 'file:./dev.db' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const pending = new Map();
let buffer = '';

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolvePromise) => {
    pending.set(id, resolvePromise);
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
}

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

function fail(message) {
  console.error(message);
  if (stderr.length > 0) console.error('--- stderr ---\n' + stderr.slice(0, 1200));
  child.kill();
  process.exit(1);
}

const results = {};

try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-script', version: '0.1.0' },
  });
  if (init.error) fail(`initialize 失败：${JSON.stringify(init.error)}`);
  results.serverInfo = init.result?.serverInfo;
  results.protocolVersion = init.result?.protocolVersion;
  notify('notifications/initialized');

  const list = await request(2, 'tools/list');
  results.tools = (list.result?.tools ?? []).map((tool) => tool.name);
  if (results.tools.length !== 4) fail(`工具数应为 4，实际 ${results.tools.length}`);

  const budget = await request(3, 'tools/call', {
    name: 'calc_budget',
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
  const budgetPayload = JSON.parse(budget.result?.content?.[0]?.text ?? '{}');
  results.budget = budgetPayload;
  if (typeof budgetPayload.intakeRecommended !== 'number' || budgetPayload.intakeRecommended <= 0) {
    fail('calc_budget 未返回有效 intakeRecommended');
  }
  if (typeof budgetPayload.floorApplied !== 'boolean') fail('calc_budget 缺少 floorApplied');

  const search = await request(4, 'tools/call', { name: 'search_food', arguments: { query: '米饭', limit: 3 } });
  const searchPayload = JSON.parse(search.result?.content?.[0]?.text ?? '{}');
  results.searchFound = searchPayload.found;
  results.firstFood = searchPayload.items?.[0]?.name ?? null;
  if (!searchPayload.found) fail('search_food 未命中「米饭」');

  const exercise = await request(5, 'tools/call', {
    name: 'estimate_exercise',
    arguments: { activity: '跑步', minutes: 30 },
  });
  const exercisePayload = JSON.parse(exercise.result?.content?.[0]?.text ?? '{}');
  results.exercise = exercisePayload;
  if (typeof exercisePayload.kcalBurned !== 'number' || exercisePayload.kcalBurned <= 0) {
    fail('estimate_exercise 未返回有效消耗');
  }

  child.kill();
  console.log(JSON.stringify(results, null, 1));
  console.log('\n✓ MCP server 验证通过（协议握手 / 工具清单 / 三个工具调用全部正常）');
  process.exit(0);
} catch (error) {
  fail(`验证失败：${error?.message ?? error}`);
}
