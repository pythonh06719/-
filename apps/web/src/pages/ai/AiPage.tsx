import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiDailySummaryResponse,
  AiFreeAskResponse,
  AiRecognizeFoodCandidate,
  AiRecognizeFoodResponse,
  AiTodayPlanResponse,
} from '@qsh/shared-types';
import { api, ApiClientError } from '@/lib/api';
import { queryKeys } from '@/lib/queryClient';
import { COPY } from '@/lib/copy';
import { todayKey } from '@/lib/format';
import SafetyBanner from '@/components/feedback/SafetyBanner';

type AiTab = 'daily' | 'plan' | 'ask';

/** Agent 工具名 → 用户可读的标签（可观测性：告诉用户"我查了什么"）。 */
const TOOL_LABELS: Record<string, string> = {
  get_today_status: '今日看板',
  search_food: '食物库',
  estimate_exercise: '运动换算',
  get_weekly_report: '周报',
  log_meal: '记录饮食',
};

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
];

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
  const askQuery = useQuery({
    queryKey: queryKeys.aiFreeAsk(date, askSubmitted),
    queryFn: () => api.post<AiFreeAskResponse>('/ai/free-ask', { question: askSubmitted, date }),
    enabled: askSubmitted.length > 0,
    retry: 0,
  });

  // 点击「生成」才发起请求（POST 探测不自动发）
  useEffect(() => {
    if (dailyTrigger > 0) {
      void dailyQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyTrigger]);
  useEffect(() => {
    if (planTrigger > 0) {
      void planQuery.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planTrigger]);

  return (
    // 宽度与留白交给 AppShell（max-w-3xl / px-5 / py-6），此处不再自搞一层宽度与内距
    <div className="flex flex-col gap-4">
      {/* Tab 切换 */}
      <div role="tablist" aria-label="AI 助手" className="grid grid-cols-3 gap-1 rounded-2xl bg-slate-100 p-1 dark:bg-slate-800">
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
                setConfirmedTraceId(null);
                setAskSubmitted(question.trim());
              }}
              disabled={question.trim().length === 0 || askQuery.isFetching}
              className="shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {COPY.aiAskSend}
            </button>
          </div>
          {question.trim().length === 0 && askSubmitted.length === 0 && (
            <p className="text-xs text-slate-600 dark:text-slate-400">{COPY.aiAskEmpty}</p>
          )}
          {askQuery.isFetching && <p className="text-center text-sm text-slate-600 dark:text-slate-400">正在想怎么回答…</p>}
          {askQuery.isError && <p className="text-center text-sm text-slate-600 dark:text-slate-400">{errorMessage(askQuery.error)}</p>}
          {!askQuery.isFetching && askQuery.data !== undefined && (
            <>
              {/* 医疗安全兜底：高亮展示安全提示（R9.6 / TC-44） */}
              {askQuery.data.safetyFlag && <SafetyBanner safetyMessages={[askQuery.data.answer]} />}
              {askQuery.data.available === false && <UnavailableNotice />}
              <div className="qsh-surface p-5">
                <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-100">{askQuery.data.answer}</p>
                {/* 可观测性：告诉用户数字是怎么来的（Agent 实际调用了哪些工具） */}
                {askQuery.data.tools !== undefined && askQuery.data.tools.length > 0 && (
                  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                    我查了：{askQuery.data.tools.map((tool) => TOOL_LABELS[tool] ?? tool).join(' · ')}
                  </p>
                )}
              </div>
              {/* Agent 写操作待确认卡片（human-in-the-loop）：确认后才落库 */}
              {askQuery.data.pending !== null &&
                askQuery.data.pending !== undefined &&
                askQuery.data.traceId !== undefined &&
                confirmedTraceId !== askQuery.data.traceId && (
                  <div
                    role="status"
                    className="rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-700/50 dark:bg-amber-900/20"
                  >
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200">需要你确认</p>
                    <p className="mt-1 text-sm leading-relaxed text-amber-700 dark:text-amber-100">
                      {askQuery.data.pending.describe}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          confirmMutation.mutate({ traceId: askQuery.data!.traceId as number })
                        }
                        disabled={confirmMutation.isPending}
                        className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                      >
                        {confirmMutation.isPending ? '记录中…' : '确认记录'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmedTraceId(askQuery.data!.traceId as number)}
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
                askQuery.data.traceId === confirmedTraceId &&
                confirmMutation.isSuccess && (
                  <p className="rounded-2xl bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
                    已按确认记录好了，去饮食日记看看吧。
                  </p>
                )}
            </>
          )}
        </div>
      )}

      {/* 食物识别入口（R3.7） */}
      <FoodRecognizePanel />
    </div>
  );
}
