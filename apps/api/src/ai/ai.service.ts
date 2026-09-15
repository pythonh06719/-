import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type {
  AiDailySummaryResponse,
  AiFeature,
  AiFreeAskFood,
  AiFreeAskResponse,
  AiInsight,
  AiRecognizeFoodCandidate,
  AiRecognizeFoodResponse,
  AiTodayPlanResponse,
} from '@qsh/shared-types';

import { addDays, todayLocalKey } from '../common/utils/date.util';
import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { keywordWhere, visibleFoodWhere } from '../foods/foods.util';
import { MealsService } from '../meals/meals.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import {
  AI_DAILY_LIMIT,
  AI_DISCLAIMER_NOTE,
  AI_SYSTEM_PROMPT,
  MEDICAL_INTENT_KEYWORDS,
  MEDICAL_REPLY,
} from './ai.constants';
import {
  chatCompletion,
  extractJson,
  getAiRuntimeConfig,
  isAiConfigured,
  type LlmCompletion,
} from './llm.client';
import type { DailySummaryDto, FreeAskDto, RecognizeFoodDto, TodayPlanDto } from './dto/ai.dto';

/** 「今天还能吃 X 吗」句式（R9.3 示例场景，兜底规则可确定性回答）。 */
const CAN_EAT_PATTERN = /(?:还能|还可以|能|可以)(?:再)?吃(?:点|一些|一[点点个些份])?(?<food>.{1,20}?)(?:吗|么|嘛)?[??！!。]?\s*$/;

/** LLM 润色输出的 JSON 形状。 */
interface InsightJson {
  conclusion?: unknown;
  basis?: unknown;
  suggestion?: unknown;
}

/** today-plan 缓存条目（内存缓存即可，进程重启丢失无碍）。 */
interface PlanCacheEntry {
  /** 缓存键 = 最近两日记录内容哈希 */
  hash: string;
  payload: AiTodayPlanResponse;
}

/**
 * AI 助手服务（三期，R9.1~R9.6 / R3.7）。
 *
 * 职责链（每个端点一致）：
 * 1. 入参校验（空文本 → `E_VALID_AI_EMPTY`）；
 * 2. **医疗安全闸（R9.6）**：用户输入或 LLM 输出命中医疗意图 → 固定就医建议，
 *    不调用 LLM、不消耗限额、输出 `safetyFlag: true`；
 * 3. **限额（R9.4）**：`ai_usage` 按 feature 分行计数，判断时 SUM 当日各 feature 行；
 *    合计 ≥ 50 → 429 `E_LIMIT_AI`；daily-summary / today-plan 命中缓存不加计数；
 * 4. **生成**：key 已配置 → LLM（热量数字只允许来自给定数据，输出仍过安全闸）；
 *    未配置 / 失败 → 规则兜底模板基于真实记录生成（可演示，TC-24 显示「暂不可用」提示）。
 */
@Injectable()
export class AiService {
  /** today-plan 内存缓存：userId → 最近一次 {hash, payload}。 */
  private readonly planCache = new Map<number, PlanCacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly mealsService: MealsService,
  ) {}

  // ---------------------------------------------------------------------------
  // R9.1 每日总结
  // ---------------------------------------------------------------------------

  /** 当日复盘：直接结论 + 依据 + 一条可执行建议。 */
  async dailySummary(userId: number, dto: DailySummaryDto): Promise<AiDailySummaryResponse> {
    const date = dto.date ?? todayLocalKey();
    const data = await this.gatherDayContext(userId, date);
    const ruleInsight = this.buildDailySummaryInsight(date, data);

    if (!isAiConfigured()) {
      await this.consumeQuota(userId, 'daily_summary');
      return { date, available: false, reason: 'ai_not_configured', mode: 'rule', insight: ruleInsight };
    }

    await this.consumeQuota(userId, 'daily_summary');
    const llm = await this.polishInsight(
      userId,
      'daily_summary',
      `请根据用户 ${date} 的真实记录，生成当日复盘（JSON：{"conclusion":"一句话直接结论","basis":["依据1","依据2"],"suggestion":"一条可执行建议"}）。\n用户数据：${JSON.stringify(data)}`,
    );

    const insight = llm !== null ? llm : ruleInsight;
    return {
      date,
      available: true,
      mode: llm !== null ? 'llm' : 'rule',
      insight,
    };
  }

  // ---------------------------------------------------------------------------
  // R9.2 今日方案（数据未变 → 复用内存缓存，不计数）
  // ---------------------------------------------------------------------------

  /** 今日方案：据最近两日记录生成；缓存键 = 记录内容哈希。 */
  async todayPlan(userId: number, dto: TodayPlanDto): Promise<AiTodayPlanResponse> {
    const date = dto.date ?? todayLocalKey();
    const context = await this.gatherTwoDayContext(userId, date);
    const hash = createHash('sha1').update(JSON.stringify(context)).digest('hex');

    const cached = this.planCache.get(userId);
    if (cached !== undefined && cached.hash === hash) {
      return { ...cached.payload, cached: true };
    }

    const ruleInsight = this.buildTodayPlanInsight(date, context);

    if (!isAiConfigured()) {
      await this.consumeQuota(userId, 'today_plan');
      const payload: AiTodayPlanResponse = {
        date,
        available: false,
        reason: 'ai_not_configured',
        mode: 'rule',
        insight: ruleInsight,
        cached: false,
      };
      this.planCache.set(userId, { hash, payload });
      return payload;
    }

    await this.consumeQuota(userId, 'today_plan');
    const llm = await this.polishInsight(
      userId,
      'today_plan',
      `请根据用户最近两天的真实记录，为 ${date} 生成一份温和的今日方案（JSON：{"conclusion":"一句话结论","basis":["依据1","依据2"],"suggestion":"一条可执行建议"}）。\n用户数据：${JSON.stringify(context)}`,
    );

    const payload: AiTodayPlanResponse = {
      date,
      available: true,
      mode: llm !== null ? 'llm' : 'rule',
      insight: llm ?? ruleInsight,
      cached: false,
    };
    this.planCache.set(userId, { hash, payload });
    return payload;
  }

  // ---------------------------------------------------------------------------
  // R9.3 自由提问（「今天还能吃 X 吗」等；热量数字一律来自食物库）
  // ---------------------------------------------------------------------------

  /** 自由提问。医疗意图 → 固定就医回复（不消耗限额）；句式命中 → 数据确定性回答。 */
  async freeAsk(userId: number, dto: FreeAskDto): Promise<AiFreeAskResponse> {
    const date = dto.date ?? todayLocalKey();
    const question = dto.question.trim();
    if (question.length === 0) {
      throw new ApiException(400, ERROR_CODES.VALID_AI_EMPTY, '想问点什么都可以，先写一句吧', {
        question: '问题不能为空',
      });
    }

    // R9.6 医疗安全闸：先于 LLM 调用与限额消费
    if (matchMedicalIntent(question)) {
      return {
        date,
        question,
        answer: MEDICAL_REPLY,
        available: isAiConfigured(),
        reason: 'matched_medical_intent',
        mode: 'rule',
        safetyFlag: true,
        matchedFood: null,
      };
    }

    await this.consumeQuota(userId, 'free_ask');
    const available = isAiConfigured();

    // 句式命中「还能吃 X 吗」：热量数字全部来自食物库，确定性回答（不依赖 LLM）
    const matched = CAN_EAT_PATTERN.exec(question);
    const foodText = matched?.groups?.food?.trim() ?? '';
    if (foodText.length > 0) {
      const answer = await this.answerCanEat(userId, date, foodText);
      return {
        date,
        question,
        answer: answer.text,
        available,
        mode: 'rule',
        safetyFlag: false,
        matchedFood: answer.food,
      };
    }

    // 非「还能吃 X」句式：key 已配置 → LLM 开放回答（附当日数据，输出仍过安全闸）
    if (available) {
      const data = await this.gatherDayContext(userId, date);
      const completion = await this.tryChat(
        [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `用户的问题：「${question}」\n当日真实数据：${JSON.stringify(data)}\n请用 2~3 句话温和回答；热量数字只能引用上面数据或说明「记录里没有这个信息」，不要编造数字。直接输出回答文本。`,
          },
        ],
        false,
      );
      if (completion !== null && !matchMedicalIntent(completion.content)) {
        return {
          date,
          question,
          answer: completion.content.trim(),
          available: true,
          mode: 'llm',
          safetyFlag: false,
          matchedFood: null,
        };
      }
      if (completion !== null && matchMedicalIntent(completion.content)) {
        // LLM 输出触医疗闸 → 固定就医建议
        return {
          date,
          question,
          answer: MEDICAL_REPLY,
          available: true,
          reason: 'matched_medical_intent',
          mode: 'rule',
          safetyFlag: true,
          matchedFood: null,
        };
      }
    }

    // key 未配置且句式未命中：返回 available:false（前端显示「暂不可用」）+ 引导文案
    return {
      date,
      question,
      answer:
        'AI 助手暂不可用，暂时回答不了这个问题。可以先试试问我「今天还能吃 X 吗」，' +
        '或者把这一餐记录下来，我帮你做整理。',
      available: false,
      reason: 'ai_not_configured',
      mode: 'rule',
      safetyFlag: false,
      matchedFood: null,
    };
  }

  // ---------------------------------------------------------------------------
  // R3.7 食物识别（文字描述 → 食物库模糊匹配候选；绝不写 meal_logs）
  // ---------------------------------------------------------------------------

  /** 描述 → 候选列表（含每 100g / 默认份量热量）。结果需用户确认才入库。 */
  async recognizeFood(userId: number, dto: RecognizeFoodDto): Promise<AiRecognizeFoodResponse> {
    const description = dto.description.trim();
    if (description.length === 0) {
      throw new ApiException(400, ERROR_CODES.VALID_AI_EMPTY, '描述一下吃了什么，我来帮你找找', {
        description: '描述不能为空',
      });
    }

    await this.consumeQuota(userId, 'food_recognize');

    // 候选名称来源：key 已配置 → LLM 抽取食物名（失败降级分词）；未配置 → 直接分词
    let names = tokenizeDescription(description);
    if (isAiConfigured()) {
      const completion = await this.tryChat(
        [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `从下面的描述中抽取出现的食物名称（不要推算热量，不要新增描述外的食物），输出 JSON：{"foods":["名称1","名称2"]}。\n描述：「${description}」`,
          },
        ],
        true,
      );
      if (completion !== null) {
        const parsed = extractJson<{ foods?: unknown }>(completion.content);
        const foods = parsed?.foods;
        if (Array.isArray(foods)) {
          const llmNames = foods
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim());
          if (llmNames.length > 0) {
            names = llmNames;
          }
        }
      }
    }

    const candidates: AiRecognizeFoodCandidate[] = [];
    const seenFoodIds = new Set<number>();
    // 并行查询（最多 8 个名字 × 各取 3 条），避免串行 N+1
    const nameResults = await Promise.all(
      names.slice(0, 8).map((name) =>
        this.prisma.foodItem.findMany({
          where: { AND: [visibleFoodWhere(userId), keywordWhere(name)] },
          orderBy: [{ isVerified: 'desc' }, { id: 'asc' }],
          take: 3,
        }),
      ),
    );
    for (const name of names.slice(0, 8)) {
      const index = names.indexOf(name);
      const rows = nameResults[index] ?? [];
      for (const row of rows) {
        if (seenFoodIds.has(row.id)) {
          continue;
        }
        seenFoodIds.add(row.id);
        const kcalPer100g = Math.round(row.kcalPer100g);
        const defaultGrams = row.defaultServingGrams;
        const unitLabel = parseServingUnitLabel(row.servingUnits);
        candidates.push({
          foodId: row.id,
          name: row.name,
          category: row.category,
          kcalPer100g,
          matchedText: name,
          defaultServingGrams: defaultGrams,
          servingUnitLabel: unitLabel,
          servingKcal:
            defaultGrams !== null && defaultGrams > 0
              ? Math.round((row.kcalPer100g * defaultGrams) / 100)
              : null,
        });
      }
    }

    return { description, candidates };
  }

  // ---------------------------------------------------------------------------
  // 内部：限额（R9.4）
  // ---------------------------------------------------------------------------

  /**
   * 消耗一次限额：**先原子累加，再合计校验**，超限则回退并 429 `E_LIMIT_AI`。
   * （读→判→写的旧实现存在并发竞态：两个请求同时读到 49 会双双放行。）
   */
  private async consumeQuota(userId: number, feature: AiFeature): Promise<void> {
    const usageDate = todayLocalKey();
    await this.prisma.aiUsage.upsert({
      where: { userId_usageDate_feature: { userId, usageDate, feature } },
      create: { userId, usageDate, feature, requestCount: 1 },
      update: { requestCount: { increment: 1 } },
    });

    const aggregated = await this.prisma.aiUsage.aggregate({
      _sum: { requestCount: true },
      where: { userId, usageDate },
    });
    if ((aggregated._sum.requestCount ?? 0) > AI_DAILY_LIMIT) {
      await this.prisma.aiUsage.update({
        where: { userId_usageDate_feature: { userId, usageDate, feature } },
        data: { requestCount: { decrement: 1 } },
      });
      throw new ApiException(429, ERROR_CODES.LIMIT_AI, '今天的 AI 次数已经用完啦，明天再来聊聊就好');
    }
  }

  /** 累计 LLM token 用量（单独 upsert，失败静默——限额统计不受影响）。 */
  private async recordTokens(userId: number, feature: AiFeature, completion: LlmCompletion): Promise<void> {
    if (completion.tokenIn === 0 && completion.tokenOut === 0) {
      return;
    }
    try {
      await this.prisma.aiUsage.upsert({
        where: { userId_usageDate_feature: { userId, usageDate: todayLocalKey(), feature } },
        create: { userId, usageDate: todayLocalKey(), feature, tokenIn: completion.tokenIn, tokenOut: completion.tokenOut },
        update: { tokenIn: { increment: completion.tokenIn }, tokenOut: { increment: completion.tokenOut } },
      });
    } catch {
      // token 统计失败不影响主流程
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：数据聚合 + 规则兜底生成器
  // ---------------------------------------------------------------------------

  /** 单日上下文（复盘 / LLM 提示词用）。 */
  private async gatherDayContext(userId: number, date: string): Promise<{
    date: string;
    intakeKcal: number;
    burnedKcal: number;
    waterMl: number;
    intakeRecommended: number | null;
  }> {
    const [dayTotals, waterAgg, exerciseAgg, profile] = await Promise.all([
      this.mealsService.dayTotals(userId, date),
      this.prisma.waterLog.aggregate({ _sum: { amountMl: true }, where: { userId, loggedDate: date } }),
      this.prisma.exerciseLog.aggregate({ _sum: { kcalBurned: true }, where: { userId, loggedDate: date } }),
      this.usersService.getProfile(userId),
    ]);

    return {
      date,
      intakeKcal: Math.round(dayTotals.kcal),
      burnedKcal: Math.round(exerciseAgg._sum.kcalBurned ?? 0),
      waterMl: waterAgg._sum.amountMl ?? 0,
      intakeRecommended: profile.budget?.intakeRecommended ?? null,
    };
  }

  /** 最近两日上下文（today-plan 缓存键 = 本结构的哈希）。 */
  private async gatherTwoDayContext(userId: number, date: string): Promise<{
    days: Array<{ date: string; intakeKcal: number; burnedKcal: number }>;
    intakeRecommended: number | null;
  }> {
    const from = addDays(date, -1);
    const rows = await this.prisma.mealLog.findMany({
      where: { userId, loggedDate: { gte: from, lte: date } },
      select: { loggedDate: true, kcal: true },
    });
    const exercises = await this.prisma.exerciseLog.findMany({
      where: { userId, loggedDate: { gte: from, lte: date } },
      select: { loggedDate: true, kcalBurned: true },
    });
    const profile = await this.usersService.getProfile(userId);

    const days = [from, date].map((day) => ({
      date: day,
      intakeKcal: Math.round(rows.filter((row) => row.loggedDate === day).reduce((sum, row) => sum + row.kcal, 0)),
      burnedKcal: Math.round(exercises.filter((row) => row.loggedDate === day).reduce((sum, row) => sum + row.kcalBurned, 0)),
    }));
    return { days, intakeRecommended: profile.budget?.intakeRecommended ?? null };
  }

  /** 每日总结规则兜底（结论 + 依据 + 一条可执行建议，全部来自真实记录）。 */
  private buildDailySummaryInsight(
    date: string,
    data: { intakeKcal: number; burnedKcal: number; waterMl: number; intakeRecommended: number | null },
  ): AiInsight {
    if (data.intakeKcal === 0 && data.burnedKcal === 0 && data.waterMl === 0) {
      return {
        conclusion: `${date} 还没有记录，先把饮食记下来，我们再一起看。`,
        basis: ['今天还没有任何饮食 / 运动 / 饮水记录'],
        suggestion: '从下一餐开始记一笔就好，几秒钟就够',
      };
    }

    const basis: string[] = [`饮食记录合计 ${data.intakeKcal} kcal`];
    if (data.burnedKcal > 0) {
      basis.push(`运动消耗 ${data.burnedKcal} kcal`);
    }
    if (data.waterMl > 0) {
      basis.push(`饮水 ${data.waterMl} ml`);
    }
    if (data.intakeRecommended !== null) {
      basis.push(`参考摄入 ${data.intakeRecommended} kcal，已用约 ${Math.round((data.intakeKcal / Math.max(1, data.intakeRecommended)) * 100)}%`);
    }
    basis.push(AI_DISCLAIMER_NOTE);

    const remaining = data.intakeRecommended === null ? null : data.intakeRecommended - data.intakeKcal;
    let suggestion: string;
    if (remaining === null) {
      suggestion = '完成引导问卷后，这里可以给出更贴合你的参考';
    } else if (remaining > 300) {
      suggestion = `还剩约 ${Math.round(remaining)} kcal，晚上可以安排一份清淡的蛋白质，比如鸡蛋或豆制品`;
    } else if (remaining >= 0) {
      suggestion = '今天的安排刚刚好，记得慢慢吃，饭后走一走';
    } else {
      suggestion = '今天吃得丰富了一些，明天照常就好，不必刻意补救';
    }

    return {
      conclusion: `今天摄入约 ${data.intakeKcal} kcal，记录得很完整`,
      basis,
      suggestion,
    };
  }

  /** 今日方案规则兜底（据最近两日记录）。 */
  private buildTodayPlanInsight(
    date: string,
    context: { days: Array<{ date: string; intakeKcal: number; burnedKcal: number }>; intakeRecommended: number | null },
  ): AiInsight {
    const logged = context.days.filter((day) => day.intakeKcal > 0);
    if (logged.length === 0) {
      return {
        conclusion: '最近两天还没有记录，先轻轻松松记一餐',
        basis: ['最近两天暂无饮食记录'],
        suggestion: '把接下来的一餐记下来，方案会越来越贴合你',
      };
    }

    const avgIntake = Math.round(logged.reduce((sum, day) => sum + day.intakeKcal, 0) / logged.length);
    const basis = logged.map(
      (day) => `${day.date} 摄入 ${day.intakeKcal} kcal${day.burnedKcal > 0 ? `，运动 ${day.burnedKcal} kcal` : ''}`,
    );
    basis.push(AI_DISCLAIMER_NOTE);

    let suggestion: string;
    if (context.intakeRecommended !== null && avgIntake > context.intakeRecommended) {
      suggestion = '最近吃得比较丰富，今天正常吃、多喝水就好，不用刻意少吃';
    } else {
      suggestion = `最近日均约 ${avgIntake} kcal，按现在的节奏继续，记得搭配些蔬菜`;
    }

    return {
      conclusion: `最近两天日均摄入约 ${avgIntake} kcal，节奏挺平稳`,
      basis,
      suggestion,
    };
  }

  // ---------------------------------------------------------------------------
  // 内部：「还能吃 X 吗」确定性回答
  // ---------------------------------------------------------------------------

  /** 依据当日剩余热量与食物库回答（热量数字一律来自食物库）。 */
  private async answerCanEat(
    userId: number,
    date: string,
    foodText: string,
  ): Promise<{ text: string; food: AiFreeAskFood | null }> {
    const [rows, profile, dayTotals] = await Promise.all([
      this.prisma.foodItem.findMany({
        where: { AND: [visibleFoodWhere(userId), keywordWhere(foodText)] },
        orderBy: [{ isVerified: 'desc' }, { id: 'asc' }],
        take: 1,
      }),
      this.usersService.getProfile(userId),
      this.mealsService.dayTotals(userId, date),
    ]);

    const row = rows[0];
    if (row === undefined) {
      return {
        text: `食物库里暂时没有找到「${foodText}」。可以在饮食日记里手动记一笔，或者换个说法再问我。`,
        food: null,
      };
    }

    const kcalPer100g = Math.round(row.kcalPer100g);
    const defaultGrams = row.defaultServingGrams;
    const servingKcal =
      defaultGrams !== null && defaultGrams > 0 ? Math.round((row.kcalPer100g * defaultGrams) / 100) : null;

    const food: AiFreeAskFood = {
      foodId: row.id,
      name: row.name,
      category: row.category,
      kcalPer100g,
      defaultServingGrams: defaultGrams,
      servingKcal,
    };

    const remaining = (profile.budget?.intakeRecommended ?? 0) - Math.round(dayTotals.kcal);
    if (remaining <= 0) {
      return {
        text: `${row.name}每 100g 约 ${kcalPer100g} kcal。今天已摄入的已经超过参考摄入了，想吃的话少量尝一点就好，明天照常安排。`,
        food,
      };
    }

    const fitGrams = Math.floor((remaining / Math.max(1, kcalPer100g)) * 100);
    let text: string;
    if (kcalPer100g < 40) {
      // 极低热量食物：按剩余热量折算克数会出现「吃 8000g」式荒谬建议，改用定性话术
      text = `${row.name}每 100g 只有约 ${kcalPer100g} kcal，热量很低，正常份量吃没有负担。`;
    } else if (servingKcal !== null && servingKcal <= remaining) {
      text = `可以安排。今天还剩约 ${Math.round(remaining)} kcal，一份${row.name}（约 ${Math.round(defaultGrams ?? 0)} g）约 ${servingKcal} kcal，在剩余范围内。`;
    } else if (fitGrams >= 50) {
      const capped = Math.min(fitGrams, 500);
      text = `可以安排一些。今天还剩约 ${Math.round(remaining)} kcal，${row.name}每 100g 约 ${kcalPer100g} kcal，吃 ${capped} g 左右是合适的。`;
    } else {
      text = `${row.name}每 100g 约 ${kcalPer100g} kcal，今天剩余空间不大，少量尝一点就好。`;
    }
    return { text, food };
  }

  // ---------------------------------------------------------------------------
  // 内部：LLM 润色（失败 / 触安全闸 → 降级规则）
  // ---------------------------------------------------------------------------

  /** 用 LLM 润色复盘 / 方案；失败或输出触医疗闸 → 返回 null（上层用规则兜底）。 */
  private async polishInsight(userId: number, feature: AiFeature, prompt: string): Promise<AiInsight | null> {
    const completion = await this.tryChat(
      [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      true,
    );
    if (completion === null) {
      return null;
    }
    await this.recordTokens(userId, feature, completion);

    const parsed = extractJson<InsightJson>(completion.content);
    if (parsed === null || typeof parsed.conclusion !== 'string' || typeof parsed.suggestion !== 'string') {
      return null;
    }
    const basis = Array.isArray(parsed.basis)
      ? parsed.basis.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : [];
    // LLM 输出也要过医疗安全闸（R9.6）：conclusion / basis / suggestion 全部参与匹配
    if (matchMedicalIntent([parsed.conclusion, ...basis, parsed.suggestion].join(' '))) {
      return null;
    }

    return {
      conclusion: parsed.conclusion.trim(),
      basis: basis.length > 0 ? [...basis, AI_DISCLAIMER_NOTE] : [AI_DISCLAIMER_NOTE],
      suggestion: parsed.suggestion.trim(),
    };
  }

  /** 尝试调用 LLM：任何异常 → 返回 null（上层降级），绝不向上抛。 */
  private async tryChat(messages: Parameters<typeof chatCompletion>[1], jsonMode: boolean): Promise<LlmCompletion | null> {
    const config = getAiRuntimeConfig();
    try {
      return await chatCompletion(config, messages, jsonMode);
    } catch {
      return null;
    }
  }
}

/**
 * 医疗安全闸（R9.6）：输入或输出命中任一关键词即触发。
 * 导出为纯函数，便于单测。
 */
export function matchMedicalIntent(text: string): boolean {
  return MEDICAL_INTENT_KEYWORDS.some((keyword) => text.includes(keyword));
}

/** 描述分词：按常见分隔符切开，过滤过短片段。 */
export function tokenizeDescription(description: string): string[] {
  return description
    .split(/[,，。；;、！!？?\s和加了喝吃了]+/u)
    .map((token) => token.replace(/^(?:一个|一份|一杯|一碗|一块|一些|点)/u, '').trim())
    .filter((token) => token.length >= 2);
}

/** 从 servingUnits JSON 中取默认单位标签。 */
function parseServingUnitLabel(servingUnitsJson: string): string | null {
  try {
    const units = JSON.parse(servingUnitsJson) as Array<{ unit?: unknown; isDefault?: unknown }>;
    if (!Array.isArray(units)) {
      return null;
    }
    const preferred = units.find((unit) => unit.isDefault === true) ?? units[0];
    return typeof preferred?.unit === 'string' ? preferred.unit : null;
  } catch {
    return null;
  }
}
