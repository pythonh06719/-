import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiDailySummaryResponse,
  AiFreeAskResponse,
  AiRecognizeFoodCandidate,
  AiRecognizeFoodResponse,
  AiTodayPlanResponse,
  AiUsageResponse,
} from '@qsh/shared-types';
import { api, ApiClientError, postStream } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';
import { todayKey } from '@/lib/format';
import SafetyBanner from '@/components/feedback/SafetyBanner';

type AiTab = 'daily' | 'plan' | 'ask' | 'trace';

/** Agent 工具名 → 用户可读的标签（可观测性：告诉用户"我查了什么"）。 */
const TOOL_LABELS: Record<string, string> = {
  get_today_status: '今日看板',
  search_food: '食物库',
  estimate_exercise: '运动换算',
  get_weekly_report: '周报',
  log_meal: '记录饮食',
};

/**
 * `GET /ai/agent/traces` 返回的**单条轨迹**（裸数组元素，无包装类型）。
 *
 * 字段与后端 `AgentService.listTraces` 对齐；`steps` 元素形状同 `AgentStep`。
 * ⚠️ 响应里**含 `tokens`**，但本页**刻意不渲染它**（开发者指标，对用户无意义且易焦虑）。
 */
interface AgentTrace {
  id: number;
  question: string;
  status: 'answered' | 'need_confirm' | 'max_steps' | 'failed' | 'disabled' | string;
  answer: string;
  toolCalls: number;
  tokens: number;
  durationMs: number;
  createdAt: string;
  steps: Array<{
    index: number;
    type: 'tool' | 'pending' | 'final' | 'note' | string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    note?: string;
    ms?: number;
  }>;
  pending: unknown | null;
}

/** 轨迹列表一次取多少条（后端把 limit 夹在 1~50；无游标分页，不做伪「加载更多」）。 */
const TRACE_LIMIT = 20;

/** `POST /ai/agent/confirm` 的响应（确认执行待办写操作）。 */
interface AgentConfirmResult {
  status: 'answered';
  answer: string;
  result: { logged?: boolean; kcal?: number };
  traceId: number;
}

const TABS: ReadonlyArray<{ key: AiTab; label: string }> = [
  { key: 'daily', label: COPY.aiDailyTab },
  { key: 'plan', label: COPY.aiPlanTab },
  { key: 'ask', label: COPY.aiAskTab },
  { key: 'trace', label: COPY.aiTraceTab },
];

/** 轨迹状态 → 中性中文（`failed` **不译成「失败」**，序号只覆盖已知值，其余走兜底）。 */
function traceStatusLabel(status: string): string {
  switch (status) {
    case 'answered':
      return COPY.aiTraceStatusAnswered;
    case 'need_confirm':
      return COPY.aiTraceStatusNeedConfirm;
    case 'max_steps':
      return COPY.aiTraceStatusMaxSteps;
    case 'failed':
      return COPY.aiTraceStatusFailed;
    case 'disabled':
      return COPY.aiTraceStatusDisabled;
    default:
      return COPY.aiTraceStatusUnknown;
  }
}

/** 时间戳 → 简短中文时刻（`9月23日 14:05`）；无效日期不出错，回退到原串。 */
function traceTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * 单条轨迹卡片（GAP-7 可解释性）。
 *
 * ## 展示口径（**刻意克制**）
 * - 展示：提问内容、状态、用到的工具名、每个工具耗时（`step.ms`）、整轮耗时（`durationMs`）；
 * - **不展示 `tokens`** —— 那是开发者指标，对用户既无意义又易引发焦虑（硬约束 2 / 无感文案）。
 *   耗时只是「过程透明度」（让用户理解"为什么慢"），不是饮食 / 热量类**业务数字**，
 *   故**不需要** `/why-numbers` 新增条目（AI 用量口径已由既有 ⑭ 条解释）。
 */
function TraceCard({ trace }: { trace: AgentTrace }): ReactElement {
  const toolSteps = Array.isArray(trace.steps) ? trace.steps.filter((step) => step.type === 'tool') : [];
  return (
    <li
      data-testid={`ai-trace-${trace.id}`}
      className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-700"
    >
      <p className="text-sm text-slate-800 dark:text-slate-100">{trace.question}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
        <span>{traceTimeLabel(trace.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{traceStatusLabel(trace.status)}</span>
        <span aria-hidden="true">·</span>
        <span className="qsh-tnum">{COPY.aiTraceDurationLine(trace.durationMs)}</span>
      </p>

      {toolSteps.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.aiTraceNoTools}</p>
      ) : (
        <div className="mt-2">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {COPY.aiTraceToolsPrefix}
            {toolSteps.map((step) => (step.tool !== undefined ? (TOOL_LABELS[step.tool] ?? step.tool) : '这一步')).join(
              ' · ',
            )}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
            {toolSteps.map((step, index) => (
              <li key={`${step.index}-${index}`} className="flex items-center justify-between gap-3">
                <span>{step.tool !== undefined ? (TOOL_LABELS[step.tool] ?? step.tool) : '这一步'}</span>
                {typeof step.ms === 'number' ? (
                  <span className="qsh-tnum shrink-0">{COPY.aiTraceStepMs(step.ms)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * 执行轨迹面板（GAP-7）：`GET /ai/agent/traces?limit=N` 只回自己的最近若干条。
 *
 * 空态指一条去路（去「自由提问」），读取不顺软着陆且**不复用空态文案**（读不到 ≠ 没问过）。
 */
function TracePanel(): ReactElement {
  const tracesQuery = useQuery({
    queryKey: queryKeys.aiTraces(TRACE_LIMIT),
    queryFn: () => api.get<AgentTrace[]>('/ai/agent/traces', { limit: TRACE_LIMIT }),
    retry: 0,
  });

  // 防御：响应形态异常（旧缓存 / 测试桩通用返回）时按空列表处理，不让整页崩
  const traces = Array.isArray(tracesQuery.data) ? tracesQuery.data : [];

  return (
    <section className="qsh-surface p-5" aria-live="polite">
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{COPY.aiTraceTitle}</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.aiTraceDesc}</p>

      {tracesQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{COPY.aiTraceLoading}</p>
      ) : tracesQuery.isError && traces.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-testid="ai-trace-error">
          {COPY.aiTraceError}
        </p>
      ) : traces.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-testid="ai-trace-empty">
          {COPY.aiTraceEmpty}
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-2" aria-label={COPY.aiTraceTitle}>
            {traces.map((trace) => (
              <TraceCard key={trace.id} trace={trace} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.aiTraceLimitNote}</p>
        </>
      )}
    </section>
  );
}

/** 温和的业务错误提示（PRD §7）。 */
function errorMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : '这一步没有成功，稍后再试一次就好';
}

/** `available: false` 时的「暂不可用」提示条（TC-24），下方仍渲染规则兜底内容。 */
function UnavailableNotice(): ReactElement {
  return (
    <p className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-600 dark:bg-slate-700 dark:text-slate-300">
      {COPY.aiUnavailable}
    </p>
  );
}

/** 复盘 / 方案卡片（结论 + 依据 + 建议）。 */
function InsightCard({ insight }: { insight: { conclusion: string; basis: string[]; suggestion: string } }): ReactElement {
  return (
    <div className="qsh-surface p-5">
      <p className="text-base font-semibold leading-relaxed text-slate-800 dark:text-slate-100">{insight.conclusion}</p>
      <ul className="mt-3 space-y-1.5" aria-label="依据">
        {insight.basis.map((item) => (
          <li key={item} className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            · {item}
          </li>
        ))}
      </ul>
      <p className="mt-3 rounded-xl bg-brand-50 px-4 py-3 text-sm leading-relaxed text-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
        {insight.suggestion}
      </p>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{COPY.aiRuleModeNote}</p>
    </div>
  );
}

/**
 * 当日剩余次数（B6）。
 *
 * ⚠️ **取不到就整行不显示**：用量只是展示信息，拿不到（后端未就绪 / 未登录 / 网络错误）
 * 时不报错、不占位、不白屏 —— 更不能因为拿不到用量就拦住 AI 入口。
 * 措辞保持中性（COPY.aiUsageRemaining / COPY.aiUsagePlenty），不出现「已达上限 / 超限」式评判。
 */
function UsageLine({ usage }: { usage: AiUsageResponse | undefined }): ReactElement | null {
  if (usage === undefined) {
    return null;
  }
  return (
    <p
      className="px-1 text-xs text-slate-500 dark:text-slate-400"
      aria-label={usage.remaining > 0 ? COPY.aiUsageRemaining(usage.remaining) : COPY.aiUsagePlenty}
    >
      {usage.remaining > 0 ? (
        <>
          {COPY.aiUsageRemaining(usage.remaining)}
          <span className="ml-1">{COPY.aiUsageResetNote}</span>
        </>
      ) : (
        COPY.aiUsagePlenty
      )}
    </p>
  );
}

/** 食物识别（R3.7）：描述 → 候选（库内热量）→ 用户确认才调 POST /meals 入库。 */
function FoodRecognizePanel(): ReactElement {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [confirmedName, setConfirmedName] = useState<string | null>(null);

  const recognizeQuery = useQuery({
    queryKey: queryKeys.aiRecognizeFood(submitted),
    queryFn: () => api.post<AiRecognizeFoodResponse>('/ai/recognize-food', { description: submitted }),
    enabled: submitted.length > 0,
    retry: 0,
  });

  // 识别会消耗一次限额 → 成功返回后刷新剩余次数（B6）
  useEffect(() => {
    if (recognizeQuery.data !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiUsage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recognizeQuery.data]);

  // 确认入库：复用既有 POST /meals（source: 'ai'），热量由服务端按食物库计算
  const confirmMutation = useMutation({
    mutationFn: (candidate: AiRecognizeFoodCandidate) =>
      api.post('/meals', {
        mealType: candidate.category === '水果' || candidate.category === '零食' ? 'snack' : 'lunch',
        source: 'ai',
        foodId: candidate.foodId,
        servingUnit: candidate.servingUnitLabel ?? undefined,
        servingQty: candidate.servingUnitLabel ? 1 : undefined,
        grams: candidate.servingUnitLabel ? undefined : candidate.defaultServingGrams ?? undefined,
      }),
    onSuccess: (_data, candidate) => {
      setConfirmedName(candidate.name);
      void queryClient.invalidateQueries({ queryKey: ['meals'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const candidates = recognizeQuery.data?.candidates ?? [];
  const loading = recognizeQuery.isFetching;

  return (
    <section className="qsh-surface p-5">
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{COPY.aiRecognizeTitle}</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{COPY.aiRecognizeHint}</p>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={description}
          maxLength={200}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="比如：一个包子、一杯豆浆"
          aria-label={COPY.aiRecognizeTitle}
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-400 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={() => {
            setConfirmedName(null);
            setSubmitted(description.trim());
          }}
          disabled={description.trim().length === 0 || loading}
          className="shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          找一找
        </button>
      </div>

      {submitted.length > 0 && (
        <div className="mt-4" aria-live="polite">
          {loading && <p className="text-sm text-slate-500 dark:text-slate-400">正在找相近的食物…</p>}
          {!loading && recognizeQuery.isError && <p className="text-sm text-slate-500 dark:text-slate-400">{errorMessage(recognizeQuery.error)}</p>}
          {!loading && !recognizeQuery.isError && candidates.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-300">{COPY.aiRecognizeEmpty}</p>
          )}
          {!loading && candidates.length > 0 && (
            <ul className="space-y-2">
              {candidates.map((candidate) => (
                <li
                  key={candidate.foodId}
                  className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-700"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-100">{candidate.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-300">
                      每 100g 约 {candidate.kcalPer100g} kcal
                      {candidate.servingKcal !== null && candidate.servingUnitLabel !== null
                        ? `；一份（${candidate.servingUnitLabel}）约 ${candidate.servingKcal} kcal`
                        : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => confirmMutation.mutate(candidate)}
                    disabled={confirmMutation.isPending}
                    className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    {COPY.aiRecognizeConfirm}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {confirmedName !== null && (
            <p className="mt-3 text-sm text-brand-600 dark:text-brand-300">{COPY.aiRecognizeConfirmed}</p>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">确认后才会记入饮食日记，热量按食物库计算。</p>
        </div>
      )}
    </section>
  );
}

/** AI 助手页（`/ai`，三期）：三个 tab + 食物识别入口。 */
export default function AiPage(): ReactElement {
  const date = todayKey();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AiTab>('daily');
  const [dailyTrigger, setDailyTrigger] = useState(0);
  const [planTrigger, setPlanTrigger] = useState(0);
  const [question, setQuestion] = useState('');
  const [askSubmitted, setAskSubmitted] = useState('');
  /** 已确认的 Agent 待办轨迹 id（用于隐藏确认卡片并展示成功态） */
  const [confirmedTraceId, setConfirmedTraceId] = useState<number | null>(null);

  /** 确认执行 Agent 的待办写操作（human-in-the-loop 第二半）。 */
  const confirmMutation = useMutation({
    mutationFn: (payload: { traceId: number }) =>
      api.post<AgentConfirmResult>('/ai/agent/confirm', payload),
    onSuccess: () => {
      // 记录落库 → 看板 / 日记 / 预算都要刷新
      void queryClient.invalidateQueries({ queryKey: ['meals'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  /**
   * 当日剩余次数（B6）：**只用于展示**。
   *
   * 取不到（未登录 / 后端未就绪 / 网络错误）时 `data === undefined` → `UsageLine` 整行不渲染，
   * 既不报错也不占位；AI 未配置（无 LLM key）时后端仍返回 200，入口照原样降级。
   */
  const usageQuery = useQuery({
    queryKey: queryKeys.aiUsage,
    queryFn: () => api.get<AiUsageResponse>('/ai/usage'),
    retry: 0,
  });

  /** 任何一次真正消耗限额的调用之后，让剩余次数重新取一次（保持显示与实际一致）。 */
  const refreshUsage = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aiUsage });
  };

  /** 一次提问结束后刷新轨迹缓存：让「回答记录」tab 马上能看到刚这次（GAP-7）。 */
  const refreshTraces = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['ai', 'traces'] });
  };

  const dailyQuery = useQuery({
    queryKey: queryKeys.aiDailySummary(date),
    queryFn: () => api.post<AiDailySummaryResponse>('/ai/daily-summary', { date }),
    enabled: false,
    retry: 0,
  });
  const planQuery = useQuery({
    queryKey: queryKeys.aiTodayPlan(date),
    queryFn: () => api.post<AiTodayPlanResponse>('/ai/today-plan', { date }),
    enabled: false,
    retry: 0,
  });
  /**
   * ask 流式状态：形状刻意对齐 useQuery 的 `{ data, isFetching, isError, error }`，
   * 渲染侧只需把 `askQuery.` 换成 `askQueryLike.`，改动最小。
   */
  const [askQueryLike, setAskQueryLike] = useState<{
    data: AiFreeAskResponse | undefined;
    isFetching: boolean;
    isError: boolean;
    error: unknown;
  }>({ data: undefined, isFetching: false, isError: false, error: null });
  /** Agent 实时步骤（流式 step 事件累积；done 后清空，答案区接管） */
  const [liveSteps, setLiveSteps] = useState<
    Array<{ index: number; type: string; tool?: string; note?: string; result?: string }>
  >([]);

  /**
   * 流式发起自由提问：`free-ask/stream` 与 `free-ask` **同一套分流逻辑**
   * （医疗安全闸 / 食物库命中 → 确定性回答；否则 Agent 多步，逐步推送）。
   * 流式不可用 / 失败 → 回退到原非流式端点（同一分流，不白屏）。
   */
  const runAsk = async (questionText: string): Promise<void> => {
    setConfirmedTraceId(null);
    setLiveSteps([]);
    setAskQueryLike({ data: undefined, isFetching: true, isError: false, error: null });
    try {
      await postStream(
        '/ai/free-ask/stream',
        { question: questionText, date },
        (event) => {
          if (event.type === 'step') {
            setLiveSteps((prev) => [
              ...prev,
              { index: event.step.index, type: event.step.type, tool: event.step.tool, note: event.step.note },
            ]);
          }
          if (event.type === 'done') {
            setLiveSteps([]);
            setAskQueryLike({
              data: event.result as AiFreeAskResponse,
              isFetching: false,
              isError: false,
              error: null,
            });
          }
          if (event.type === 'error') {
            setAskQueryLike((prev) => ({ ...prev, isFetching: false, isError: true, error: new Error(event.message) }));
          }
        },
      );
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.code === 'E_STREAM_UNSUPPORTED') {
        // 服务端 / 浏览器不支持流式 → 回退原非流式端点（同一分流逻辑）
        try {
          const data = await api.post<AiFreeAskResponse>('/ai/free-ask', { question: questionText, date });
          setAskQueryLike({ data, isFetching: false, isError: false, error: null });
          setLiveSteps([]);
        } catch (fallbackError) {
          setAskQueryLike({ data: undefined, isFetching: false, isError: true, error: fallbackError });
        }
        return;
      }
      setAskQueryLike({ data: undefined, isFetching: false, isError: true, error: cause });
    } finally {
      // 提问（无论成功 / 失败 / 命中限额）都刷新一次剩余次数
      refreshUsage();
      // 新轨迹可能已落库 → 让「回答记录」tab 保持最新
      refreshTraces();
    }
  };

  // 点击「生成」才发起请求（POST 探测不自动发）
  useEffect(() => {
    if (dailyTrigger > 0) {
      void dailyQuery.refetch().finally(refreshUsage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyTrigger]);
  useEffect(() => {
    if (planTrigger > 0) {
      void planQuery.refetch().finally(refreshUsage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planTrigger]);

  return (
    // 宽度与留白交给 AppShell（max-w-3xl / px-5 / py-6），此处不再自搞一层宽度与内距
    <div className="flex flex-col gap-4">
      {/* Tab 切换 */}
      <div role="tablist" aria-label="AI 助手" className="grid grid-cols-4 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-slate-800">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`qsh-touch-target rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
              tab === item.key
                ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-700 dark:text-brand-300'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 当日剩余次数（B6）：中性陈述，取不到则整行不显示 */}
      <UsageLine usage={usageQuery.data} />

      {/* 每日总结（R9.1） */}
      {tab === 'daily' && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <button
            type="button"
            onClick={() => setDailyTrigger((value) => value + 1)}
            disabled={dailyQuery.isFetching}
            className="rounded-2xl bg-brand-600 px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
          >
            {COPY.aiDailyGenerate}
          </button>
          {dailyQuery.isFetching && <p className="text-center text-sm text-slate-600 dark:text-slate-400">正在整理今天的记录…</p>}
          {dailyQuery.isError && <p className="text-center text-sm text-slate-600 dark:text-slate-400">{errorMessage(dailyQuery.error)}</p>}
          {!dailyQuery.isFetching && dailyQuery.data !== undefined && (
            <>
              {dailyQuery.data.available === false && <UnavailableNotice />}
              <InsightCard insight={dailyQuery.data.insight} />
            </>
          )}
        </div>
      )}

      {/* 今日方案（R9.2） */}
      {tab === 'plan' && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <button
            type="button"
            onClick={() => setPlanTrigger((value) => value + 1)}
            disabled={planQuery.isFetching}
            className="rounded-2xl bg-brand-600 px-4 py-3 text-sm font-medium text-white disabled:opacity-40"
          >
            {COPY.aiPlanGenerate}
          </button>
          {planQuery.isFetching && <p className="text-center text-sm text-slate-600 dark:text-slate-400">正在看最近两天的记录…</p>}
          {planQuery.isError && <p className="text-center text-sm text-slate-600 dark:text-slate-400">{errorMessage(planQuery.error)}</p>}
          {!planQuery.isFetching && planQuery.data !== undefined && (
            <>
              {planQuery.data.available === false && <UnavailableNotice />}
              {planQuery.data.cached && (
                <p className="text-xs text-slate-600 dark:text-slate-400">记录没有变化，这是刚整理过的方案</p>
              )}
              <InsightCard insight={planQuery.data.insight} />
            </>
          )}
        </div>
      )}

      {/* 自由提问（R9.3 + Agent P0）：确定性回答或 Agent 多步工具链；写操作需确认 */}
      {tab === 'ask' && (
        <div className="flex flex-col gap-3" aria-live="polite">
          <div className="flex gap-2">
            <input
              type="text"
              value={question}
              maxLength={200}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={COPY.aiAskPlaceholder}
              aria-label={COPY.aiAskTab}
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-brand-400 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => {
                const text = question.trim();
                setAskSubmitted(text);
                void runAsk(text);
              }}
              disabled={question.trim().length === 0 || askQueryLike.isFetching}
              className="shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {COPY.aiAskSend}
            </button>
          </div>
          {question.trim().length === 0 && askSubmitted.length === 0 && (
            <p className="text-xs text-slate-600 dark:text-slate-400">{COPY.aiAskEmpty}</p>
          )}
          {askQueryLike.isFetching && (
            <p className="text-center text-sm text-slate-600 dark:text-slate-400">
              {liveSteps.length > 0 ? '正在处理…' : '正在想怎么回答…'}
            </p>
          )}
          {askQueryLike.isFetching && liveSteps.length > 0 && (
            <ul
              aria-label="正在进行的步骤"
              className="rounded-2xl bg-brand-50 p-4 text-sm text-brand-700 dark:bg-brand-900/30 dark:text-brand-200"
            >
              {liveSteps.map((step, i) => (
                <li key={`${step.index}-${i}`} className="flex items-start gap-1.5">
                  {step.tool !== undefined && (
                    <span className="font-medium">{TOOL_LABELS[step.tool] ?? step.tool}</span>
                  )}
                  {step.note !== undefined && <span>{step.note}</span>}
                  {step.result !== undefined && (
                    <span className="text-slate-500 dark:text-slate-400">{step.result}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {askQueryLike.isError && <p className="text-center text-sm text-slate-600 dark:text-slate-400">{errorMessage(askQueryLike.error)}</p>}
          {!askQueryLike.isFetching && askQueryLike.data !== undefined && (
            <>
              {/* 医疗安全兜底：高亮展示安全提示（R9.6 / TC-44） */}
              {askQueryLike.data.safetyFlag && <SafetyBanner safetyMessages={[askQueryLike.data.answer]} />}
              {askQueryLike.data.available === false && <UnavailableNotice />}
              <div className="qsh-surface p-5">
                <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-100">{askQueryLike.data.answer}</p>
                {/* 可观测性：告诉用户数字是怎么来的（Agent 实际调用了哪些工具） */}
                {askQueryLike.data.tools !== undefined && askQueryLike.data.tools.length > 0 && (
                  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                    我查了：{askQueryLike.data.tools.map((tool) => TOOL_LABELS[tool] ?? tool).join(' · ')}
                  </p>
                )}
              </div>
              {/* Agent 写操作待确认卡片（human-in-the-loop）：确认后才落库 */}
              {askQueryLike.data.pending !== null &&
                askQueryLike.data.pending !== undefined &&
                askQueryLike.data.traceId !== undefined &&
                confirmedTraceId !== askQueryLike.data.traceId && (
                  <div
                    role="status"
                    className="rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-700/50 dark:bg-amber-900/20"
                  >
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200">需要你确认</p>
                    <p className="mt-1 text-sm leading-relaxed text-amber-700 dark:text-amber-100">
                      {askQueryLike.data.pending.describe}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          confirmMutation.mutate({ traceId: askQueryLike.data!.traceId as number })
                        }
                        disabled={confirmMutation.isPending}
                        className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                      >
                        {confirmMutation.isPending ? '记录中…' : '确认记录'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmedTraceId(askQueryLike.data!.traceId as number)}
                        className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-300"
                      >
                        先不记
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-amber-600/70 dark:text-amber-200/60">
                      确认后才会记入饮食日记。
                    </p>
                  </div>
                )}
              {confirmedTraceId !== null &&
                askQueryLike.data.traceId === confirmedTraceId &&
                confirmMutation.isSuccess && (
                  <p className="rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
                    已按确认记录好了，去饮食日记看看吧。
                  </p>
                )}
            </>
          )}
        </div>
      )}

      {/* 执行轨迹（GAP-7）：最近几次提问是「怎么答的」，可解释性回看 */}
      {tab === 'trace' && <TracePanel />}

      {/* 食物识别入口（R3.7） */}
      <FoodRecognizePanel />
    </div>
  );
}
