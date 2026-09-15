/**
 * AI 助手契约（三期，R9.1~R9.6 / R3.7）。
 *
 * 设计要点（ARCHITECTURE §1.8）：
 * - `available` 表示 **LLM 增强能力** 是否可用（key 仅服务端，前端永远拿不到 key）；
 *   `available: false`（`reason: 'ai_not_configured'`）时前端显示「暂不可用」（TC-24），
 *   但响应内仍可携带**规则兜底**基于真实记录生成的内容（保证功能可演示）。
 * - 热量数字一律来自食物库 / 用户记录，LLM 只做润色与自由文本解析（R3.7）。
 * - 命中医疗意图 → `safetyFlag: true` + 固定就医建议回复，不调用 LLM（R9.6 / TC-44）。
 */

/** AI 生成模式：`llm` = 配置了 key 的模型生成/润色；`rule` = 服务端规则模板（兜底）。 */
export type AiMode = 'llm' | 'rule';

/**
 * 不可用原因：
 * - `ai_not_configured` = 未配置 key（TC-24，前端显示「暂不可用」）；
 * - `ai_call_failed` = 已配置但调用失败（网络/额度），前端提示「稍后再试」；
 * - `ai_max_steps` = Agent 达到步数上限仍未收敛（P0），前端提示换个问法。
 */
export type AiUnavailableReason = 'ai_not_configured' | 'ai_call_failed' | 'ai_max_steps';

/** 安全闸命中原因：响应由固定就医建议模板生成（R9.6 / TC-44），前端据此区分展示。 */
export type AiSafetyReason = 'matched_medical_intent';

/**
 * 可用性 / 原因标记。
 * - `available: false` + `reason: 'ai_not_configured'` → 前端显示「暂不可用」；
 * - `safetyFlag: true` 的响应必带 `reason: 'matched_medical_intent'`。
 */
export interface AiAvailability {
  available: boolean;
  reason?: AiUnavailableReason | AiSafetyReason;
}

/** 注：`AiFeature`（`ai_usage.feature` 枚举）定义于 `entities.ts`，经 `index.ts` 统一导出。 */

/** 复盘 / 方案通用的「结论 + 依据 + 一条可执行建议」结构（R9.1 / R9.2）。 */
export interface AiInsight {
  /** 直接结论（一句话） */
  conclusion: string;
  /** 依据（来自用户真实记录的数字与事实） */
  basis: string[];
  /** 一条可执行建议 */
  suggestion: string;
}

/** `POST /api/ai/daily-summary` 请求（R9.1）。 */
export interface AiDailySummaryRequest {
  /** 复盘日期 `YYYY-MM-DD`，缺省 = 服务端本地今天 */
  date?: string;
}

/** `POST /api/ai/daily-summary` 响应。 */
export interface AiDailySummaryResponse extends AiAvailability {
  /** 复盘日期 `YYYY-MM-DD` */
  date: string;
  /** 生成模式 */
  mode: AiMode;
  /** 结论 + 依据 + 建议（规则兜底或 LLM 生成） */
  insight: AiInsight;
}

/** `POST /api/ai/today-plan` 请求（R9.2）。 */
export interface AiTodayPlanRequest {
  /** 方案日期 `YYYY-MM-DD`，缺省 = 服务端本地今天 */
  date?: string;
}

/** `POST /api/ai/today-plan` 响应（数据未变则复用服务端内存缓存）。 */
export interface AiTodayPlanResponse extends AiAvailability {
  /** 方案日期 `YYYY-MM-DD` */
  date: string;
  /** 生成模式 */
  mode: AiMode;
  /** 结论 + 依据 + 建议 */
  insight: AiInsight;
  /** 是否命中缓存（命中时不计入当日限额） */
  cached: boolean;
}

/** `POST /api/ai/free-ask` 请求（R9.3）。 */
export interface AiFreeAskRequest {
  /** 用户问题（1~200 字） */
  question: string;
  /** 提问日期 `YYYY-MM-DD`，缺省 = 服务端本地今天 */
  date?: string;
}

/** 自由提问命中的食物信息（热量数字一律来自食物库）。 */
export interface AiFreeAskFood {
  foodId: number;
  name: string;
  category: string;
  /** 每 100g 热量 kcal */
  kcalPer100g: number;
  /** 默认份量克数（可空） */
  defaultServingGrams: number | null;
  /** 一份的估算热量 kcal（`kcalPer100g × defaultServingGrams ÷ 100`，可空） */
  servingKcal: number | null;
}

/** `POST /api/ai/free-ask` 响应。 */
export interface AiFreeAskResponse extends AiAvailability {
  /** 回答日期 `YYYY-MM-DD` */
  date: string;
  /** 原问题（原样回显） */
  question: string;
  /** 回答文本（医疗兜底时为固定就医建议模板） */
  answer: string;
  /** 生成模式 */
  mode: AiMode;
  /** 是否命中医疗安全闸（R9.6），命中时 `answer` 为固定就医建议 */
  safetyFlag: boolean;
  /** 「还能吃 X 吗」命中的食物信息（热量来自食物库；未命中为 null） */
  matchedFood: AiFreeAskFood | null;
  /**
   * Agent 模式（已配置 key 且非确定性句式）下的轨迹 id。
   * 若 `pending` 非空，前端需据此调用 `POST /ai/agent/confirm` 完成写操作。
   */
  traceId?: number;
  /** Agent 模式下的待确认写操作（human-in-the-loop；无待办为 null / 缺省） */
  pending?: { tool: string; describe: string } | null;
  /** Agent 模式下实际执行的工具链（便于前端展示"我查了什么"） */
  tools?: string[];
}

/** 食物识别候选（R3.7 / US-09）：仅返回名称与库内热量，**需用户确认才入库**（TC-22/23）。 */
export interface AiRecognizeFoodCandidate {
  /** 食物库条目 id（确认入库时作为 `foodId` 传给 `POST /meals`） */
  foodId: number;
  /** 食物库内名称 */
  name: string;
  /** 分类 */
  category: string;
  /** 每 100g 热量 kcal（来自食物库） */
  kcalPer100g: number;
  /** 命中的描述片段 */
  matchedText: string;
  /** 默认份量克数（可空） */
  defaultServingGrams: number | null;
  /** 默认份量单位标签（可空，如「个 / 碗」） */
  servingUnitLabel: string | null;
  /** 一份（默认份量）的估算热量 kcal（可空） */
  servingKcal: number | null;
}

/** `POST /api/ai/recognize-food` 请求（R3.7 文字描述识别）。 */
export interface AiRecognizeFoodRequest {
  /** 文字描述（1~200 字，如「早上吃了一个包子喝了一杯豆浆」） */
  description: string;
}

/** `POST /api/ai/recognize-food` 响应。本端点**绝不直接写 `meal_logs`**。 */
export interface AiRecognizeFoodResponse {
  /** 原描述（原样回显） */
  description: string;
  /** 候选列表（可能与食物库零匹配，此时前端引导手动记录） */
  candidates: AiRecognizeFoodCandidate[];
}
