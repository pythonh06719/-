/**
 * Agent 工具层（P0：把领域能力暴露为 LLM 可调用的工具）。
 *
 * 设计原则（也是与「直接把数据塞进 prompt」的本质区别）：
 * 1. **薄封装**：只调用既有 Service，不复制业务逻辑、不绕过校验（可见性、餐次枚举、配额等都照旧生效）；
 * 2. **读写分权**：`write: true` 的工具**不直接执行**，先返回待确认卡片（human-in-the-loop），
 *    用户点确认后才落库 —— 避免模型擅自动用户数据；
 * 3. **参数自校验**：模型给的是 JSON，可能缺字段/超范围。校验失败抛 `AgentToolError`，
 *    其 message 会作为工具结果回灌给模型，让它自我纠正重试（而不是 500）；
 * 4. **结果摘要化**：回给模型的不是整坨数据，而是紧凑 JSON/文本，控制 token 消耗。
 */

import type { DashboardService } from '../dashboard/dashboard.service';
import type { ExerciseService } from '../exercise/exercise.service';
import type { FoodsService } from '../foods/foods.service';
import type { MealsService } from '../meals/meals.service';
import type { ReportService } from '../report/report.service';
import type { MealType } from '@qsh/shared-types';

/** 工具参数校验失败：message 会被回灌给模型作为观察结果。 */
export class AgentToolError extends Error {}

/** 工具执行上下文（由 AgentService 注入，工具本身不感知用户/日期来源）。 */
export interface AgentToolContext {
  userId: number;
  /** 服务端本地日期 `YYYY-MM-DD`（模型不该自己猜今天） */
  dateKey: string;
}

/** 工具执行结果。 */
export interface AgentToolResult {
  ok: boolean;
  /** 给模型看的紧凑结果（会被写入 messages 的 tool 消息） */
  content: string;
  /** 同时回给前端展示的结构化数据（可选） */
  data?: unknown;
}

/** 工具定义（含 OpenAI function calling 所需的 JSON Schema）。 */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 写操作：需用户确认后才会真正执行 */
  write?: boolean;
  /** 待确认时给用户看的中文说明（例如「要记录：米饭 200g（午餐）」） */
  describe?(args: Record<string, unknown>, ctx: AgentToolContext): Promise<string>;
  run(args: Record<string, unknown>, ctx: AgentToolContext): Promise<AgentToolResult>;
}

/** 工具依赖（全部为既有 Service，测试可注入替身）。 */
export interface AgentToolDeps {
  foods: FoodsService;
  meals: MealsService;
  dashboard: DashboardService;
  exercise: ExerciseService;
  report: ReportService;
}

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const MEAL_LABEL: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
};

/** 文本参数长度上限（字符数）—— 防止模型把整段话塞进关键词字段。 */
const MAX_TEXT_LENGTH = 50;
/** `search_food.limit` 的默认条数（与 MCP 侧 `search_food` 同口径）。 */
const DEFAULT_SEARCH_LIMIT = 5;
/** `search_food.limit` 的夹紧上界（1~10，与 MCP 侧 `Math.min(Math.max(..., 1), 10)` 一致）。 */
const MAX_SEARCH_LIMIT = 10;
/** 单餐克数上界（5000 克 ≈ 一顿不可能达到的量；超出视为模型幻觉，拒绝而非截断）。 */
const MAX_GRAMS = 5000;
/** 运动时长上界（分钟）—— 600 分钟 = 10 小时，超出视为幻觉。 */
const MAX_MINUTES = 600;

/**
 * 读取必填字符串参数。
 *
 * @param args 模型给出的原始参数
 * @param key 参数名
 * @param maxLength 长度上限（默认 50 字符）
 * @throws AgentToolError 缺失 / 非字符串 / 空白 / 超长（message 会回灌给模型）
 */
function requireString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number = MAX_TEXT_LENGTH,
): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentToolError(`参数 ${key} 必须是非空字符串`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new AgentToolError(`参数 ${key} 过长（最多 ${maxLength} 个字符），请只传关键词`);
  }
  return text;
}

/**
 * 读取闭区间数值参数（越界即拒绝并回灌错误，让模型自我纠正）。
 *
 * 说明：**写入 / 计算类**参数（克数、时长）采用「校验并拒绝」而非静默夹紧 ——
 * 静默把 999999 克截成 5000 克会凭空写出错误数据；而只读分页参数（`limit`）
 * 仅影响展示条数，故沿用 MCP 侧「夹紧」写法。两种取舍见各调用点注释。
 *
 * @param args 模型给出的原始参数
 * @param key 参数名
 * @param options 取值范围与整数要求
 * @throws AgentToolError 非数字 / 非整数 / 越界
 */
function requireNumberInRange(
  args: Record<string, unknown>,
  key: string,
  options: { min: number; max: number; integer?: boolean },
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value)) {
    throw new AgentToolError(`参数 ${key} 必须是数字`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new AgentToolError(`参数 ${key} 必须是整数`);
  }
  if (value < options.min || value > options.max) {
    throw new AgentToolError(`参数 ${key} 必须在 ${options.min} 到 ${options.max} 之间`);
  }
  return value;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 解析并校验 log_meal 参数（describe 与 run 共用：**确认前**就要拦住脏参数）。 */
function parseLogMealArgs(args: Record<string, unknown>): {
  foodId: number;
  grams: number;
  mealType: MealType;
} {
  const foodId = Number(args.foodId);
  if (!Number.isInteger(foodId) || foodId <= 0) {
    throw new AgentToolError('参数 foodId 必须是 search_food 返回的整数 id');
  }
  // 写入类参数：1~5000 克，越界即拒绝（避免把幻觉克数静默落库）
  const grams = requireNumberInRange(args, 'grams', { min: 1, max: MAX_GRAMS });
  const mealType = requireString(args, 'mealType', 20) as MealType;
  if (!MEAL_TYPES.includes(mealType)) {
    throw new AgentToolError(`参数 mealType 必须是 ${MEAL_TYPES.join(' / ')} 之一`);
  }
  return { foodId, grams, mealType };
}

/**
 * 创建工具注册表（每个请求新建，闭包持有 ctx 无关的 deps）。
 */
export function createAgentTools(deps: AgentToolDeps): Record<string, AgentTool> {
  const list: AgentTool[] = [
    {
      name: 'search_food',
      description:
        '按名称关键词搜索食物库，返回候选食物（含 id、每 100 克热量与三大营养素）。' +
        '当用户提到具体食物但未给出食物 id 时，必须先用本工具查 id，再调用 log_meal。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '食物名称关键词（最多 50 字），如「米饭」「豆腐」' },
          limit: { type: 'integer', description: '返回条数，默认 5，最大 10（超出按 10 处理）' },
        },
        required: ['query'],
      },
      async run(args, ctx) {
        const query = requireString(args, 'query');
        // 只读分页参数：夹紧到 [1, 10]（与 MCP 侧 search_food 完全同口径，不拒绝）
        const limit = Math.min(
          Math.max(Number(args.limit ?? DEFAULT_SEARCH_LIMIT) || DEFAULT_SEARCH_LIMIT, 1),
          MAX_SEARCH_LIMIT,
        );
        const result = await deps.foods.search(ctx.userId, { q: query, pageSize: limit });
        const items = result.items.map((item) => ({
          id: item.id,
          name: item.name,
          kcalPer100g: item.kcalPer100g,
          category: item.category ?? null,
        }));
        return {
          ok: items.length > 0,
          content: JSON.stringify({
            query,
            found: items.length,
            items,
            hint: items.length === 0 ? '未命中；可换更短的关键词再试一次，或告知用户记不了。' : undefined,
          }),
          data: items,
        };
      },
    },
    {
      name: 'get_today_status',
      description:
        '获取用户【今天】的热量预算与已摄入情况（推荐摄入、已摄入、剩余、运动消耗、饮水）。' +
        '回答「今天还能吃多少」「我今天吃得怎么样」这类问题前必须先调用本工具取真实数字，禁止凭空估算。',
      parameters: { type: 'object', properties: {}, required: [] },
      async run(_args, ctx) {
        const data = await deps.dashboard.get(ctx.userId, ctx.dateKey);
        // 字段严格取自 DashboardResponse（服务端已算好，工具不重复计算）
        const summary = {
          date: data.date,
          intakeRecommended: data.budget?.intakeRecommended ?? null,
          intakeKcal: round(data.intakeKcal),
          remainingKcal: round(data.remainingKcal),
          burnedKcal: round(data.burnedKcal),
          waterMl: data.waterMl,
          waterGoalMl: data.waterGoalMl,
          progressRatio: round(data.progressRatio, 2),
          encouragement: data.encouragement,
        };
        return { ok: true, content: JSON.stringify(summary), data: summary };
      },
    },
    {
      name: 'estimate_exercise',
      description:
        '按运动名称与时长估算消耗热量（MET 公式）。用于回答「跑步半小时消耗多少」或换算零食的等价运动量。',
      parameters: {
        type: 'object',
        properties: {
          activity: {
            type: 'string',
            description: '运动名称或关键词（最多 50 字），如「跑步」「快走」「游泳」',
          },
          minutes: { type: 'number', description: '时长（分钟），取值 1~600' },
        },
        required: ['activity', 'minutes'],
      },
      async run(args, ctx) {
        const activity = requireString(args, 'activity');
        // 计算类参数：1~600 分钟，越界即拒绝并回灌错误（不静默截断）
        const minutes = requireNumberInRange(args, 'minutes', { min: 1, max: MAX_MINUTES });
        const activities = deps.exercise.listActivities();
        const keyword = activity.toLowerCase();
        const matched =
          activities.find((item) => item.name === activity) ??
          activities.find((item) => item.name.includes(activity) || keyword.includes(item.name)) ??
          activities.find((item) => item.category.includes(activity) || item.code.includes(keyword));
        if (!matched) {
          return {
            ok: false,
            content: JSON.stringify({
              error: '未找到该运动类型',
              candidates: activities.slice(0, 12).map((item) => item.name),
              hint: '请从候选名称中选一个更接近的重新调用。',
            }),
          };
        }
        const estimate = await deps.exercise.estimate(ctx.userId, {
          activityCode: matched.code,
          minutes,
        });
        const summary = {
          activity: matched.name,
          minutes,
          met: estimate.met,
          weightKg: estimate.weightKg,
          kcalBurned: round(estimate.kcalBurned),
        };
        return { ok: true, content: JSON.stringify(summary), data: summary };
      },
    },
    {
      name: 'get_weekly_report',
      description:
        '获取最近 7 天的周报摘要（日均摄入、热量缺口、记录天数、微量营养素达标情况）。用于回答趋势类问题。',
      parameters: { type: 'object', properties: {}, required: [] },
      async run(_args, ctx) {
        const data = await deps.report.weekly(ctx.userId, ctx.dateKey);
        const days = data.days;
        const logged = days.filter((day) => day.intakeKcal > 0).length;
        // direction='min' 表示「至少摄入」，低于参考值 70% 才算明显不足；'max' 表示「不超上限」
        const notable = data.micronutrients
          .filter((item) =>
            item.direction === 'min'
              ? item.dailyAvg < item.reference * 0.7
              : item.dailyAvg > item.reference,
          )
          .map((item) => `${item.name} ${item.dailyAvg}/${item.reference}${item.unit}`)
          .slice(0, 5);
        const summary = {
          from: data.from,
          to: data.to,
          daysLogged: logged,
          avgIntakeKcal: data.avgIntakeKcal,
          totalExerciseKcal: data.totalExerciseKcal,
          weightChangeKg: data.weightChangeKg,
          micronutrientsNotable: notable,
          referenceNote: data.referenceNote,
        };
        return { ok: true, content: JSON.stringify(summary), data: summary };
      },
    },
    {
      name: 'log_meal',
      description:
        '为用户记录一餐（写操作，会先请用户确认）。foodId 必须来自 search_food 的返回结果，不允许编造。',
      parameters: {
        type: 'object',
        properties: {
          foodId: { type: 'integer', description: '食物 id，来自 search_food 结果（正整数）' },
          grams: { type: 'number', description: '克数，取值 1~5000' },
          mealType: {
            type: 'string',
            enum: [...MEAL_TYPES],
            description: '餐次：breakfast/lunch/dinner/snack（仅接受这 4 个值）',
          },
        },
        required: ['foodId', 'grams', 'mealType'],
      },
      write: true,
      // 参数不合法时抛错 → AgentService 会把它回灌给模型纠正，**不会**生成脏确认卡片
      async describe(args, ctx) {
        const { foodId, grams, mealType } = parseLogMealArgs(args);
        const food = await deps.foods.requireVisibleFood(ctx.userId, foodId);
        const kcal = Math.round((food.kcalPer100g * grams) / 100);
        return `要记录：${MEAL_LABEL[mealType] ?? mealType} · ${food.name} ${grams} 克（约 ${kcal} 千卡）`;
      },
      async run(args, ctx) {
        const { foodId, grams, mealType } = parseLogMealArgs(args);
        const food = await deps.foods.requireVisibleFood(ctx.userId, foodId);
        const result = await deps.meals.create(ctx.userId, {
          loggedDate: ctx.dateKey,
          mealType,
          foodId,
          grams,
          source: 'ai',
        });
        const entry = result.entry;
        const summary = {
          logged: true,
          entryId: entry.id,
          food: food.name,
          grams,
          mealType: MEAL_LABEL[mealType] ?? mealType,
          kcal: round(Number(entry.kcal)),
        };
        return { ok: true, content: JSON.stringify(summary), data: summary };
      },
    },
  ];

  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

/** 导出给 AgentService 用（与工具注册表保持一致）。 */
export { MEAL_TYPES };
