/**
 * 轻生活 MCP Server（stdio）—— **零新依赖**：MCP 协议手写实现。
 *
 * 为什么不用官方 SDK：`@modelcontextprotocol/sdk` 的安装在本机网络环境下会卡死
 * （部分子依赖托管在被墙的源）。而 MCP over stdio 本质就是**换行分隔的 JSON-RPC 2.0**，
 * 一个 ~300 行的 server 手写协议即可，还顺带证明「理解协议本身」。
 *
 * 已实现的协议面（覆盖 stdio 传输的常用子集）：
 * - `initialize` 握手（协商 protocolVersion / capabilities / serverInfo）
 * - `notifications/initialized`、`notifications/cancelled`、`ping`（通知，不回包）
 * - `tools/list`（工具清单 + JSON Schema）
 * - `tools/call`（执行工具，文本结果）
 *
 * 暴露 **11 个工具**（4 只读 + 4 只读用户数据 + 3 写）：
 *   search_food         只读   食物库检索（builtin / Open Food Facts / USDA）
 *   calc_budget         只读   热量预算（Mifflin-St Jeor，含安全下限与缺口上限）
 *   estimate_exercise   只读   MET 公式运动消耗
 *   list_activities     只读   支持的运动清单
 *   explain_budget      只读   热量预算的「推导明细」（BMR/活动系数/TDEE/缺口上限/安全下限）
 *   get_daily_summary   只读*  当日摄入 / 剩余 / 饮水 / 运动汇总
 *   list_recent_meals   只读*  最近 N 天饮食记录
 *   get_weight_trend    只读*  体重趋势
 *   log_meal            写*    记录一餐
 *   log_water           写*    记录饮水
 *   log_weight          写*    记录体重
 *
 * 带 `*` 的工具读取/写入**本机当前用户**的数据，因此需要环境变量 `MCP_USER_ID`：
 * - 本工具刻意**不接受** `userId` 参数 —— 避免调用方任意指定他人账号（越权防线）；
 * - **写操作**在未配置 `MCP_USER_ID` 时直接返回可读错误，不做任何写入（默认关闭）；
 * - 单用户本地工具定位：一个 `MCP_USER_ID` 对应一台机器上的一个账号。
 *
 * 客户端配置示例（任意 MCP 宿主）：
 *   { "mcpServers": { "qingshenghuo": {
 *       "command": "npx", "args": ["tsx", "apps/mcp-server/src/index.ts"],
 *       "cwd": "<仓库根>",
 *       "env": { "DATABASE_URL": "file:./apps/api/prisma/dev.db", "MCP_USER_ID": "1" } } } }
 */

import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import {
  ACTIVITY_FACTORS,
  DEFICIT_CAP_RATIO,
  KCAL_PER_KG_FAT,
  SAFETY_FLOOR,
  ageFromBirthDate,
  buildSafetyMessages,
  calcExerciseKcal,
  deriveWeeklyLossKg,
  findMetActivity,
  MET_ACTIVITY_LIBRARY,
  round1,
  safeCalcCalorieBudget,
  toLocalDateKey,
} from '@qsh/core';
import type { ActivityLevel, Gender } from '@qsh/core';

const prisma = new PrismaClient();

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'qingshenghuo', version: '0.2.0' };

/** 餐次枚举（与 agent 侧 / API 侧同口径）。 */
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
type MealType = (typeof MEAL_TYPES)[number];

/** 单餐克数上界（与 agent 侧 `MAX_GRAMS` 一致；越界即拒绝，不静默截断）。 */
const MAX_GRAMS = 5000;
/** 运动时长上界（分钟，与 agent 侧一致）。 */
const MAX_MINUTES = 600;
/** 体重取值范围（kg）—— 与 agent 侧写入口径一致。 */
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 500;
/** 单次饮水量取值范围（ml）与默认值。 */
const WATER_ML_MIN = 50;
const WATER_ML_MAX = 2000;
const WATER_ML_DEFAULT = 250;

// ---------------------------------------------------------------------------
// 输入校验（非法值 → 可读错误，不静默转换）
// ---------------------------------------------------------------------------

/** 工具入参非法：`message` 会作为工具结果（`isError: true`）返回给调用方。 */
class ToolInputError extends Error {
  /** 附加的结构化字段（如候选清单 / 提示），会一并回给调用方。 */
  readonly data?: Record<string, unknown>;

  constructor(message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolInputError';
    this.data = data;
  }
}

/**
 * 解析当前用户 id：**只**从环境变量 `MCP_USER_ID` 取，绝不接受调用方传入的 `userId`。
 *
 * @param kind `write` 时使用「写操作已禁用」文案（未配置即默认关闭写入）
 * @throws ToolInputError 未配置 / 非正整数
 */
function resolveUserId(kind: 'read' | 'write'): number {
  const raw = process.env.MCP_USER_ID;
  if (raw === undefined || raw.trim() === '') {
    throw new ToolInputError(
      kind === 'write'
        ? '写操作已禁用：请设置 MCP_USER_ID 后再启用'
        : '读取用户数据前请先设置 MCP_USER_ID（本地单用户工具）',
    );
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolInputError(`MCP_USER_ID 必须是正整数（当前为「${raw}」）`);
  }
  return id;
}

/** 断言 `MCP_USER_ID` 对应的账号存在（避免外键写入失败给出晦涩报错）。 */
async function ensureUser(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (user === null) {
    throw new ToolInputError(`MCP_USER_ID=${userId} 对应的账号不存在，请检查配置`);
  }
}

/** 读取闭区间整数参数（越界即拒绝）。 */
function requireInt(
  args: Record<string, unknown>,
  key: string,
  options: { min: number; max: number },
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolInputError(`参数 ${key} 必须是整数`);
  }
  if (value < options.min || value > options.max) {
    throw new ToolInputError(`参数 ${key} 必须在 ${options.min} 到 ${options.max} 之间`);
  }
  return value;
}

/** 读取闭区间数值参数（越界即拒绝）。 */
function requireNumber(
  args: Record<string, unknown>,
  key: string,
  options: { min: number; max: number },
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value)) {
    throw new ToolInputError(`参数 ${key} 必须是数字`);
  }
  if (value < options.min || value > options.max) {
    throw new ToolInputError(`参数 ${key} 必须在 ${options.min} 到 ${options.max} 之间`);
  }
  return value;
}

/** 读取可选整数参数（缺省用 `fallback`）。 */
function optionalInt(
  args: Record<string, unknown>,
  key: string,
  options: { min: number; max: number },
  fallback: number,
): number {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    return fallback;
  }
  return requireInt(args, key, options);
}

/** 读取可选数值参数（缺省用 `fallback`）。 */
function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  options: { min: number; max: number },
  fallback: number,
): number {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    return fallback;
  }
  return requireNumber(args, key, options);
}

/** 校验餐次（必须是 4 个枚举之一）。 */
function requireMealType(args: Record<string, unknown>): MealType {
  const value = String(args.mealType ?? '').trim();
  if (!(MEAL_TYPES as readonly string[]).includes(value)) {
    throw new ToolInputError(`参数 mealType 必须是 ${MEAL_TYPES.join(' / ')} 之一`);
  }
  return value as MealType;
}

/** 读取可选日期（`YYYY-MM-DD`），缺省为本地今天；格式非法即拒绝。 */
function optionalDateKey(args: Record<string, unknown>, key: string): string {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') {
    return toLocalDateKey(new Date());
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ToolInputError(`参数 ${key} 必须是 YYYY-MM-DD 格式的日期`);
  }
  return raw;
}

/** 读取可选短文本（≤200 字），缺省 null。 */
function optionalNote(args: Record<string, unknown>, key: string, maxLength = 200): string | null {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new ToolInputError(`参数 ${key} 必须是字符串`);
  }
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length > maxLength) {
    throw new ToolInputError(`参数 ${key} 过长（最多 ${maxLength} 个字符）`);
  }
  return text;
}

/** 将 `YYYY-MM-DD` 向前推 `n` 天（本地时区）。 */
function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [year, month, day] = dateKey.split('-').map((part) => Number(part));
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() + deltaDays);
  return toLocalDateKey(date);
}

// ---------------------------------------------------------------------------
// 工具实现
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

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  /** 是否为写操作（仅用于文档与启动日志，不改变协议形状）。 */
  write?: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * 用 `try/catch` 包装工具主体：入参非法 → 可读错误（`isError: true`），
 * 其余异常 → 兜底可读错误。工具主体只需返回值（成功 payload）。
 */
function guard(handler: (args: Record<string, unknown>) => Promise<unknown>): ToolDef['run'] {
  return async (args) => {
    try {
      return text(await handler(args));
    } catch (error) {
      if (error instanceof ToolInputError) {
        return text({ error: error.message, ...(error.data ?? {}) }, true);
      }
      return text({ error: `工具执行失败：${String(error)}` }, true);
    }
  };
}

/** STEP 序号计数器（`explain_budget` 用）。 */
function steps(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return entries.map((entry, index) => ({ step: index + 1, ...entry }));
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
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) {
        return text({ error: `minutes 必须在 1 到 ${MAX_MINUTES} 之间` }, true);
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

  explain_budget: {
    description:
      '解释热量预算的**推导过程**（逐步明细）：BMR（Mifflin-St Jeor 公式）→ 活动系数 → TDEE → 每周目标减重 → ' +
      '原始缺口 → 缺口上限（TDEE × 30%）→ 有效缺口 → 安全下限（女 1200 / 男 1500）→ 建议摄入。' +
      '当任一保护（缺口上限 / 安全下限）被触发时明确标注。用于回答「这个数字是怎么来的」。',
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
    // 纯计算（不读用户数据），因此是只读且**不需要** MCP_USER_ID
    run: guard(async (args) => {
      const gender = String(args.gender) as Gender;
      const activityLevel = String(args.activityLevel) as ActivityLevel;
      const age = Number(args.age);
      const heightCm = Number(args.heightCm);
      const weightKg = Number(args.weightKg);
      const targetWeightKg = Number(args.targetWeightKg);
      const targetWeeks = Number(args.targetWeeks);

      const safe = safeCalcCalorieBudget({
        gender,
        age,
        heightCm,
        weightKg,
        targetWeightKg,
        targetWeeks,
        activityLevel,
      });
      if (!safe.ok) {
        // 入参未过校验：把引擎的字段级错误原样透出（可读、可纠正）
        throw new ToolInputError('入参未通过校验', { ok: false, errors: safe.errors });
      }
      const budget = safe.result;
      const weeklyLossKg = deriveWeeklyLossKg(weightKg, targetWeightKg, targetWeeks);
      const factor = ACTIVITY_FACTORS[activityLevel];

      return {
        input: { gender, age, heightCm, weightKg, targetWeightKg, targetWeeks, activityLevel },
        formulas: {
          bmr: '男：10×体重(kg) + 6.25×身高(cm) − 5×年龄 + 5；女：同式 − 161',
          tdee: 'TDEE = BMR × 活动系数',
          rawDeficit: '原始缺口 = 每周目标减重(kg) × 7700 ÷ 7',
          deficitCap: `缺口上限 = TDEE × ${DEFICIT_CAP_RATIO}（30%）`,
          effectiveDeficit: '有效缺口 = min(原始缺口, 缺口上限)',
          floor: `安全下限 = 女 ${SAFETY_FLOOR.female} / 男 ${SAFETY_FLOOR.male} kcal`,
          intake: '建议摄入 = max(TDEE − 有效缺口, 安全下限)',
        },
        derivation: steps([
          { name: 'BMR（基础代谢）', value: budget.bmr, unit: 'kcal' },
          { name: '活动系数', activityLevel, factor },
          { name: 'TDEE（每日总消耗）', value: budget.tdee, unit: 'kcal' },
          { name: '每周目标减重', value: round1(weeklyLossKg), unit: 'kg/周', perDayKcal: Math.round((weeklyLossKg * KCAL_PER_KG_FAT) / 7) },
          { name: '原始缺口', value: budget.targetDeficitRaw, unit: 'kcal/日' },
          { name: '缺口上限（TDEE×30%）', value: budget.deficitCap, unit: 'kcal/日' },
          { name: '有效缺口 = min(原始, 上限)', value: budget.effectiveDeficit, unit: 'kcal/日', capped: budget.isDeficitCapped },
          { name: '安全下限', value: budget.safetyFloor, unit: 'kcal/日', floorApplied: budget.floorApplied },
          { name: '建议摄入 = max(TDEE−有效缺口, 下限)', value: budget.intakeRecommended, unit: 'kcal/日' },
        ]),
        result: {
          bmr: budget.bmr,
          tdee: budget.tdee,
          intakeRecommended: budget.intakeRecommended,
          targetDeficitRaw: budget.targetDeficitRaw,
          deficitCap: budget.deficitCap,
          effectiveDeficit: budget.effectiveDeficit,
          isDeficitCapped: budget.isDeficitCapped,
          floorApplied: budget.floorApplied,
          safetyFloor: budget.safetyFloor,
        },
        safeguards: {
          deficitCapped: budget.isDeficitCapped,
          floorApplied: budget.floorApplied,
          messages: buildSafetyMessages({
            floorApplied: budget.floorApplied,
            isDeficitCapped: budget.isDeficitCapped,
          }),
        },
        note: '安全下限优先级高于缺口上限；两个保护可同时触发（见 safeguards）',
      };
    }),
  },

  get_daily_summary: {
    description:
      '获取本机当前用户【某一天】的汇总（摄入 / 剩余 / 饮水 / 运动 / 预算），默认今天。' +
      '本地单用户工具；读取用户数据需 MCP_USER_ID。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，缺省为今天' },
      },
      required: [],
    },
    run: guard(async (args) => {
      const userId = resolveUserId('read');
      await ensureUser(userId);
      const date = optionalDateKey(args, 'date');

      const [profile, goal, settings, mealAgg, waterAgg, exerciseAgg] = await Promise.all([
        prisma.userProfile.findUnique({ where: { userId } }),
        prisma.userGoal.findUnique({ where: { userId } }),
        prisma.userSettings.findUnique({ where: { userId } }),
        prisma.mealLog.aggregate({ _sum: { kcal: true }, where: { userId, loggedDate: date } }),
        prisma.waterLog.aggregate({ _sum: { amountMl: true }, where: { userId, loggedDate: date } }),
        prisma.exerciseLog.aggregate({ _sum: { kcalBurned: true }, where: { userId, loggedDate: date } }),
      ]);

      let intakeRecommended: number | null = null;
      let bmr: number | null = null;
      let tdee: number | null = null;
      let budgetWarnings: unknown[] = [];
      if (profile !== null && goal !== null) {
        const safe = safeCalcCalorieBudget({
          gender: profile.gender as Gender,
          age: ageFromBirthDate(profile.birthDate, new Date()),
          heightCm: profile.heightCm,
          weightKg: goal.startWeightKg,
          targetWeightKg: goal.targetWeightKg,
          targetWeeks: goal.targetWeeks,
          activityLevel: profile.activityLevel as ActivityLevel,
        });
        if (safe.ok) {
          intakeRecommended = safe.result.intakeRecommended;
          bmr = safe.result.bmr;
          tdee = safe.result.tdee;
          budgetWarnings = safe.result.warnings;
        }
      }

      const intakeKcal = round1(mealAgg._sum.kcal ?? 0);
      const burnedKcal = round1(exerciseAgg._sum.kcalBurned ?? 0);
      const waterMl = waterAgg._sum.amountMl ?? 0;
      const waterGoalMl = settings?.waterGoalMl ?? 2000;
      const remainingKcal = intakeRecommended === null ? null : round1(intakeRecommended - intakeKcal);
      const progressRatio =
        intakeRecommended !== null && intakeRecommended > 0 ? round1(intakeKcal / intakeRecommended) : null;

      return {
        date,
        intakeRecommended,
        bmr,
        tdee,
        intakeKcal,
        burnedKcal,
        remainingKcal,
        waterMl,
        waterGoalMl,
        progressRatio,
        budgetWarnings,
        note: intakeRecommended === null ? '尚未完成引导问卷，暂无热量预算' : undefined,
      };
    }),
  },

  list_recent_meals: {
    description:
      '列出本机当前用户最近 N 天的饮食记录（按日期倒序，含每笔的名称与热量），默认 3 天。' +
      '本地单用户工具；读取用户数据需 MCP_USER_ID。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '回溯天数，默认 3，最大 30' },
      },
      required: [],
    },
    run: guard(async (args) => {
      const userId = resolveUserId('read');
      await ensureUser(userId);
      const days = optionalInt(args, 'days', { min: 1, max: 30 }, 3);
      const today = toLocalDateKey(new Date());
      const from = shiftDateKey(today, -(days - 1));

      const rows = await prisma.mealLog.findMany({
        where: { userId, loggedDate: { gte: from, lte: today } },
        orderBy: [{ loggedDate: 'desc' }, { id: 'asc' }],
        include: { foodItem: { select: { name: true } } },
      });

      const entries = rows.map((row) => ({
        id: row.id,
        date: row.loggedDate,
        mealType: row.mealType,
        name: row.customName ?? row.foodItem?.name ?? '（未命名）',
        grams: row.grams,
        kcal: round1(row.kcal),
        source: row.source,
      }));
      const totalKcal = round1(entries.reduce((sum, entry) => sum + entry.kcal, 0));

      return { from, to: today, days, count: entries.length, totalKcal, entries };
    }),
  },

  get_weight_trend: {
    description:
      '获取本机当前用户的体重趋势（最近 N 天，按日期升序），默认 30 天；含最新值 / 区间变化 / 最小最大。' +
      '本地单用户工具；读取用户数据需 MCP_USER_ID。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '回溯天数，默认 30，最大 365' },
      },
      required: [],
    },
    run: guard(async (args) => {
      const userId = resolveUserId('read');
      await ensureUser(userId);
      const days = optionalInt(args, 'days', { min: 1, max: 365 }, 30);
      const today = toLocalDateKey(new Date());
      const from = shiftDateKey(today, -(days - 1));

      const rows = await prisma.weightLog.findMany({
        where: { userId, loggedAt: { gte: from, lte: today } },
        orderBy: { loggedAt: 'asc' },
        select: { loggedAt: true, weightKg: true },
      });

      let minKg: number | null = null;
      let maxKg: number | null = null;
      let latestKg: number | null = null;
      for (const row of rows) {
        minKg = minKg === null ? row.weightKg : Math.min(minKg, row.weightKg);
        maxKg = maxKg === null ? row.weightKg : Math.max(maxKg, row.weightKg);
        latestKg = row.weightKg;
      }
      const firstKg = rows.length > 0 ? (rows[0]?.weightKg ?? null) : null;
      const changeKg = firstKg === null || latestKg === null ? null : round1(latestKg - firstKg);

      return {
        from,
        to: today,
        days,
        points: rows.map((row) => ({ date: row.loggedAt, weightKg: row.weightKg })),
        stats: {
          count: rows.length,
          minKg,
          maxKg,
          latestKg,
          changeKg,
        },
      };
    }),
  },

  log_meal: {
    description:
      '为本机当前用户记录一餐（**写操作**）。foodId 必须来自 search_food 返回值。' +
      '本地单用户工具；写操作需 MCP_USER_ID，未配置则拒绝写入。',
    inputSchema: {
      type: 'object',
      properties: {
        foodId: { type: 'integer', description: '食物 id，来自 search_food（正整数）' },
        grams: { type: 'number', description: '克数，取值 1~5000' },
        mealType: {
          type: 'string',
          enum: [...MEAL_TYPES],
          description: '餐次：breakfast / lunch / dinner / snack',
        },
        date: { type: 'string', description: '日期 YYYY-MM-DD，缺省为今天' },
      },
      required: ['foodId', 'grams', 'mealType'],
    },
    write: true,
    run: guard(async (args) => {
      const userId = resolveUserId('write');
      await ensureUser(userId);

      const foodId = requireInt(args, 'foodId', { min: 1, max: 2_147_483_647 });
      const grams = requireNumber(args, 'grams', { min: 1, max: MAX_GRAMS });
      const mealType = requireMealType(args);
      const date = optionalDateKey(args, 'date');

      // 食物必须存在且可见（builtin/offf/usda 或本人自定义），否则拒绝写入
      const food = await prisma.foodItem.findFirst({
        where: {
          id: foodId,
          OR: [{ source: { in: ['builtin', 'openfoodfacts', 'usda'] } }, { createdByUserId: userId }],
        },
      });
      if (food === null) {
        throw new ToolInputError(`食物 id=${foodId} 不存在或不可见，请先用 search_food 查 id`);
      }

      const factor = grams / 100;
      const row = await prisma.mealLog.create({
        data: {
          userId,
          loggedDate: date,
          mealType,
          foodItemId: food.id,
          customName: null,
          grams: round1(grams),
          servingUnit: null,
          servingQty: null,
          kcal: round1(food.kcalPer100g * factor),
          proteinG: round1(food.proteinGPer100g * factor),
          fatG: round1(food.fatGPer100g * factor),
          carbG: round1(food.carbGPer100g * factor),
          fiberG: food.fiberGPer100g === null ? null : round1(food.fiberGPer100g * factor),
          sodiumMg: food.sodiumMgPer100g === null ? null : round1(food.sodiumMgPer100g * factor),
          source: 'ai',
        },
      });

      return {
        logged: true,
        entryId: row.id,
        date,
        mealType,
        food: { id: food.id, name: food.name },
        grams: round1(grams),
        kcal: round1(row.kcal),
        source: 'ai',
      };
    }),
  },

  log_water: {
    description:
      '为本机当前用户记录一笔饮水（**写操作**，默认 250ml）。' +
      '本地单用户工具；写操作需 MCP_USER_ID，未配置则拒绝写入。',
    inputSchema: {
      type: 'object',
      properties: {
        amountMl: { type: 'integer', description: `水量 ml，取值 ${WATER_ML_MIN}~${WATER_ML_MAX}，默认 ${WATER_ML_DEFAULT}` },
        date: { type: 'string', description: '日期 YYYY-MM-DD，缺省为今天' },
      },
      required: [],
    },
    write: true,
    run: guard(async (args) => {
      const userId = resolveUserId('write');
      await ensureUser(userId);

      const amountMl = optionalInt(args, 'amountMl', { min: WATER_ML_MIN, max: WATER_ML_MAX }, WATER_ML_DEFAULT);
      const date = optionalDateKey(args, 'date');

      const row = await prisma.waterLog.create({
        data: { userId, loggedDate: date, loggedAt: new Date().toISOString(), amountMl },
      });
      const totalAgg = await prisma.waterLog.aggregate({
        _sum: { amountMl: true },
        where: { userId, loggedDate: date },
      });
      const settings = await prisma.userSettings.findUnique({ where: { userId } });

      return {
        logged: true,
        logId: row.id,
        date,
        amountMl,
        totalMl: totalAgg._sum.amountMl ?? 0,
        goalMl: settings?.waterGoalMl ?? 2000,
      };
    }),
  },

  log_weight: {
    description:
      '为本机当前用户记录体重（**写操作**；同一天重复记录会覆盖当日值）。' +
      '本地单用户工具；写操作需 MCP_USER_ID，未配置则拒绝写入。',
    inputSchema: {
      type: 'object',
      properties: {
        weightKg: { type: 'number', description: `体重 kg，取值 ${WEIGHT_MIN}~${WEIGHT_MAX}` },
        date: { type: 'string', description: '日期 YYYY-MM-DD，缺省为今天' },
        note: { type: 'string', description: '备注（≤200 字，可选）' },
      },
      required: ['weightKg'],
    },
    write: true,
    run: guard(async (args) => {
      const userId = resolveUserId('write');
      await ensureUser(userId);

      const weightKg = optionalNumber(args, 'weightKg', { min: WEIGHT_MIN, max: WEIGHT_MAX }, Number.NaN);
      if (!Number.isFinite(weightKg)) {
        throw new ToolInputError('参数 weightKg 必须是数字');
      }
      const date = optionalDateKey(args, 'date');
      const note = optionalNote(args, 'note');

      const row = await prisma.weightLog.upsert({
        where: { userId_loggedAt: { userId, loggedAt: date } },
        create: { userId, loggedAt: date, weightKg: round1(weightKg), note, source: 'manual' },
        update: { weightKg: round1(weightKg), note, updatedAt: new Date().toISOString() },
      });

      return {
        logged: true,
        logId: row.id,
        date,
        weightKg: row.weightKg,
        updated: row.createdAt !== row.updatedAt,
      };
    }),
  },
};

function text(payload: unknown, isError = false): ToolResult {
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

console.error(
  `[qingshenghuo-mcp] 已启动（stdio）：${Object.keys(tools).join(' / ')}` +
    `（写操作需 MCP_USER_ID，当前${process.env.MCP_USER_ID ? `已配置=${process.env.MCP_USER_ID}` : '未配置→写操作禁用'}）`,
);
