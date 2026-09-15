/**
 * 轻生活 MCP Server（stdio）—— **零新依赖**：MCP 协议手写实现。
 *
 * 为什么不用官方 SDK：`@modelcontextprotocol/sdk` 的安装在本机网络环境下会卡死
 * （部分子依赖托管在被墙的源）。而 MCP over stdio 本质就是**换行分隔的 JSON-RPC 2.0**，
 * 一个 4 工具的只读 server 手写协议只需 ~100 行，还顺带证明「理解协议本身」。
 *
 * 已实现的协议面（覆盖 stdio 传输的常用子集）：
 * - `initialize` 握手（协商 protocolVersion / capabilities / serverInfo）
 * - `notifications/initialized`、`notifications/cancelled`、`ping`（通知，不回包）
 * - `tools/list`（工具清单 + JSON Schema）
 * - `tools/call`（执行工具，文本结果）
 *
 * 暴露 4 个**只读**工具（stdio 本地服务无鉴权，因此刻意不暴露任何写操作与用户数据）：
 *   search_food       食物库检索（443 条：builtin / Open Food Facts / USDA）
 *   calc_budget       热量预算（Mifflin-St Jeor，含安全下限与缺口上限）
 *   estimate_exercise MET 公式运动消耗
 *   list_activities   支持的运动清单
 *
 * 客户端配置示例（任意 MCP 宿主）：
 *   { "mcpServers": { "qingshenghuo": {
 *       "command": "npx", "args": ["tsx", "apps/mcp-server/src/index.ts"],
 *       "cwd": "<仓库根>", "env": { "DATABASE_URL": "file:./apps/api/prisma/dev.db" } } } }
 */

import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import {
  buildSafetyMessages,
  calcExerciseKcal,
  findMetActivity,
  MET_ACTIVITY_LIBRARY,
  safeCalcCalorieBudget,
} from '@qsh/core';

const prisma = new PrismaClient();

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'qingshenghuo', version: '0.1.0' };

// ---------------------------------------------------------------------------
// 工具实现（全部只读）
// ---------------------------------------------------------------------------

function visibleFoodWhere() {
  return { OR: [{ source: { in: ['builtin', 'openfoodfacts', 'usda'] } }] };
}

function keywordWhere(keyword: string) {
  return {
    OR: [
      { name: { contains: keyword } },
      { namePinyin: { contains: keyword } },
      { aliases: { contains: keyword } },
    ],
  };
}

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

const tools: Record<string, ToolDef> = {
  search_food: {
    description: '按名称关键词搜索「轻生活」食物库（443 条中文食物，含每 100g 热量与三大营养素）',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '食物名称关键词，如「米饭」「豆腐」「鸡胸」' },
        limit: { type: 'integer', description: '返回条数，默认 5，最大 10' },
      },
      required: ['query'],
    },
    async run(args) {
      const query = String(args.query ?? '').trim();
      const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 10);
      if (query.length === 0) {
        return text({ error: 'query 不能为空' }, true);
      }
      const rows = await prisma.foodItem.findMany({
        where: { AND: [visibleFoodWhere(), keywordWhere(query)] },
        orderBy: [{ isVerified: 'desc' }, { id: 'asc' }],
        take: limit,
      });
      const items = rows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        kcalPer100g: row.kcalPer100g,
        proteinG: row.proteinGPer100g,
        fatG: row.fatGPer100g,
        carbG: row.carbGPer100g,
        source: row.source,
      }));
      return text({ query, found: items.length, items });
    },
  },

  calc_budget: {
    description:
      '计算每日热量预算（Mifflin-St Jeor BMR → TDEE → 缺口），内置安全下限（女 1200 / 男 1500 kcal）' +
      '与缺口上限（TDEE × 30%），并返回保护是否被触发（floorApplied / deficitCapped）',
    inputSchema: {
      type: 'object',
      properties: {
        gender: { type: 'string', enum: ['male', 'female'], description: '生理性别' },
        age: { type: 'integer', description: '年龄（10~100）' },
        heightCm: { type: 'number', description: '身高 cm（100~250）' },
        weightKg: { type: 'number', description: '当前体重 kg（25~300）' },
        targetWeightKg: { type: 'number', description: '目标体重 kg' },
        targetWeeks: { type: 'integer', description: '目标周期（周，1~104）' },
        activityLevel: {
          type: 'string',
          enum: ['sedentary', 'light', 'moderate', 'high', 'athlete'],
          description: '活动水平',
        },
      },
      required: ['gender', 'age', 'heightCm', 'weightKg', 'targetWeightKg', 'targetWeeks', 'activityLevel'],
    },
    async run(args) {
      // SafeCalorieResult 是判别联合：ok=false 表示入参未过校验（schema 已挡住绝大多数，这里兜底透出）
      const safe = safeCalcCalorieBudget({
        gender: String(args.gender) as 'male' | 'female',
        age: Number(args.age),
        heightCm: Number(args.heightCm),
        weightKg: Number(args.weightKg),
        targetWeightKg: Number(args.targetWeightKg),
        targetWeeks: Number(args.targetWeeks),
        activityLevel: String(args.activityLevel) as 'sedentary' | 'light' | 'moderate' | 'high' | 'athlete',
      });
      if (!safe.ok) {
        return text({ ok: false, errors: safe.errors }, true);
      }
      const budget = safe.result;
      return text({
        bmr: budget.bmr,
        tdee: budget.tdee,
        intakeRecommended: budget.intakeRecommended,
        deficit: {
          cap: budget.deficitCap,
          effective: budget.effectiveDeficit,
          isCapped: budget.isDeficitCapped,
        },
        // 安全机制是否生效（这是本引擎的核心卖点，向调用方透出）
        floorApplied: budget.floorApplied,
        deficitCapped: budget.isDeficitCapped,
        safetyMessages: buildSafetyMessages({
          floorApplied: budget.floorApplied,
          isDeficitCapped: budget.isDeficitCapped,
        }),
        note: 'intakeRecommended 已内置安全保护；floorApplied/deficitCapped 表示保护被触发',
      });
    },
  },

  estimate_exercise: {
    description: '按运动名称与时长估算消耗热量（MET 公式：kcal = MET × 体重kg × 时长h）',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', description: '运动名称，如「跑步」「快走」「游泳」' },
        minutes: { type: 'number', description: '时长（分钟，1~600）' },
        weightKg: { type: 'number', description: '体重 kg（缺省按 60kg）' },
      },
      required: ['activity', 'minutes'],
    },
    async run(args) {
      const activity = String(args.activity ?? '').trim();
      const minutes = Number(args.minutes);
      const weight = Number(args.weightKg ?? 60);
      if (activity.length === 0) {
        return text({ error: 'activity 不能为空' }, true);
      }
      const matched = findMetActivity(activity) ?? MET_ACTIVITY_LIBRARY.find((item) => item.name.includes(activity));
      if (!matched) {
        return text(
          {
            error: `未找到运动「${activity}」`,
            candidates: MET_ACTIVITY_LIBRARY.slice(0, 16).map((item) => `${item.code} ${item.name}`),
            hint: '请调用 list_activities 查看全部支持的名称',
          },
          true,
        );
      }
      const kcal = calcExerciseKcal(matched.met, weight, minutes);
      return text({
        activity: matched.name,
        code: matched.code,
        met: matched.met,
        minutes,
        weightKg: weight,
        kcalBurned: Math.round(kcal * 10) / 10,
      });
    },
  },

  list_activities: {
    description: '列出支持的运动类型清单（编码 / 名称 / MET 值），用于 estimate_exercise 前的选择',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      return text(
        MET_ACTIVITY_LIBRARY.map((item) => ({
          code: item.code,
          name: item.name,
          category: item.category,
          met: item.met,
        })),
      );
    },
  },
};

function text(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }],
    ...(isError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio（换行分隔）
// ---------------------------------------------------------------------------

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(id: string | number, method: string, params: Record<string, unknown>): void {
  try {
    switch (method) {
      case 'initialize':
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        });
        return;
      case 'tools/list':
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            tools: Object.entries(tools).map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        });
        return;
      case 'tools/call': {
        const name = String(params.name ?? '');
        const tool = tools[name];
        if (!tool) {
          writeMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${name}` } });
          return;
        }
        void tool
          .run((params.arguments ?? {}) as Record<string, unknown>)
          .then((result) => writeMessage({ jsonrpc: '2.0', id, result }))
          .catch((error) => {
            writeMessage({
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: `工具执行失败：${String(error)}` }], isError: true },
            });
          });
        return;
      }
      case 'ping':
        writeMessage({ jsonrpc: '2.0', id, result: {} });
        return;
      default:
        writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `方法不存在：${method}` } });
    }
  } catch (error) {
    writeMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } });
  }
}

const readline = createInterface({ input: process.stdin });
readline.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let message: { id?: string | number; method?: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // 非法行直接忽略（stdio 下不应出现）
  }
  const { id, method, params = {} } = message;
  if (id === undefined || method === undefined) {
    return; // 通知（如 notifications/initialized / cancelled）：无需回包
  }
  handleRequest(id, method, params);
});

process.stdin.on('end', () => {
  void prisma.$disconnect();
  process.exit(0);
});

console.error('[qingshenghuo-mcp] 已启动（stdio）：search_food / calc_budget / estimate_exercise / list_activities');
