import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WATER_GOAL_MAX_ML, WATER_GOAL_MIN_ML, isValidWaterGoalMl } from '@qsh/core';
import { COPY, waterGoalInvalidFor } from '@/lib/copy';
import { pushSettings } from '@/lib/settings-sync';
import { persistWaterGoalMl, resolveWaterGoalMl } from '@/lib/water-goal';

/**
 * 「每日饮水目标」编辑卡（`/exercise` 喝水区，GAP-3）。
 *
 * ## 解决什么
 *
 * 后端两条通道（`PATCH /water/goal` 与 `PATCH /users/settings`）都已就绪且把范围
 * 对齐到 500–8000，但前端**没有任何输入入口** —— 用户永远看 2000 默认值，改不了。
 * 本卡把入口补上。
 *
 * ## 为什么落在这里（`/exercise` 的喝水区）
 *
 * 喝水区已经在展示 `0 / 2000 ml` —— 用户正是在这里第一次「看见」那个目标数字。
 * 把「可以改」放在「看得见这个值」的同一处，意图与动作不隔屏，最容易被发现；
 * 且它属于**饮水**这个域，与 `+250ml / 撤销` 同屏，语义连贯。
 *
 * ## 为什么走 `/users/settings` 而不是 `/water/goal`
 *
 * 设置类字段有**离线 dirty 标记 + 联网补推**（`lib/settings-sync.ts`），
 * `/water/goal` 入不了离线队列；`SettingsPatch` 早已声明 `waterGoalMl`、补推逻辑也写好了
 * （`flushPendingSettings` 会给它补推），只缺调用方。一次改多字段的语义本就属「设置」，
 * 故复用 `pushSettings({ waterGoalMl })`，与 `lib/units.ts` / `theme/useTheme.ts` 同一模式：
 * **本地快路径（先写 localStorage） + fire-and-forget 落库（失败静默并记 dirty，联网后补推）**。
 *
 * ## 不展示新数字（NFR-11）
 *
 * 本卡只回显用户**自己设的**那个值（目标 ml），不引入任何新口径/新指标，
 * 故**无需**改动 `/why-numbers`。合法区间 500–8000 是**输入约束**，仅在校验不通过时
 * 以中性提示给出 —— 与 `GoalSettingsCard` 对身高 / 体重区间的处理同一惯例。
 *
 * 语气（PRD §7 / 硬约束 1）：目标是「给自己的参考」，永不出现「必须喝够 / 坚持 / 失败」。
 */

interface WaterGoalCardProps {
  /** `GET /water` 返回的当日目标（`goalMl`）；未加载 / 离线时为 `undefined`，本机值优先。 */
  serverGoalMl?: number;
}

export default function WaterGoalCard({ serverGoalMl }: WaterGoalCardProps): ReactElement {
  const queryClient = useQueryClient();
  /**
   * 输入框初值 = 当前生效值（本机记住的 > 服务端 > 默认）。
   * 惰性初始化即取一次，避免首帧空串。
   */
  const [value, setValue] = useState<string>(() => String(resolveWaterGoalMl(serverGoalMl)));
  /**
   * 「用户正在编辑」标记 —— 为什么需要它，见下面 useEffect 里的 ⚠️ 注释。
   *
   * 判据是**用户改过值**（输入框内容 ≠ 当前生效值），而不是「有没有焦点」：
   * 输入框失焦但还没保存时，那半截输入同样是用户亲手敲的，不能被服务端回流抹掉。
   */
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** 当前生效值（服务端目标到货、单位或本机值变化时刷新输入框）。 */
  const current = resolveWaterGoalMl(serverGoalMl);
  useEffect(() => {
    /*
     * ⚠️ 编辑期间**不**把 `current` 灌回输入框：服务端数据一回流（比如另一台设备
     * 刚把目标改了），用户正在敲到一半的数字会被无声抹掉 —— 那是「用户亲眼看见
     * 自己输入消失」，比安静地算错更伤。
     *
     * 什么时候恢复同步（必须双向收口，否则会退化成「服务端再也无法更新输入框」）：
     * 1. 保存成功 —— 见 `handleSubmit`，那时 `current` 已经等于刚保存的值，同步不会打回去；
     * 2. 放弃编辑 —— 用户把输入改回等于当前生效值，见 `handleChange`（不额外加 UI）。
     */
    if (editing) {
      return;
    }
    setValue(String(current));
  }, [current, editing]);

  /** 用户输入：顺带维护「是否处于编辑中」。 */
  const handleChange = (next: string): void => {
    setValue(next);
    // 改回等于当前生效值 = 放弃这次编辑，同步重新生效
    setEditing(next.trim() !== String(current));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = Number(value.trim());

    // 与后端 DTO 同源的范围校验（500–8000）—— 前端先拦，不发出必被 400 的请求。
    if (!isValidWaterGoalMl(parsed)) {
      setNotice(waterGoalInvalidFor(WATER_GOAL_MIN_ML, WATER_GOAL_MAX_ML));
      return;
    }

    // 1) 本地快路径：立即记住，离线也能显示、联网后可补推（见 lib/water-goal.ts）。
    persistWaterGoalMl(parsed);
    // 此刻 `current` 已经等于 parsed（快路径写完了），可以放心退出编辑态：
    // 同步恢复不会把输入框打回去，而服务端后续更新从此又能照常同步进来。
    setEditing(false);
    // 2) 服务端权威值：fire-and-forget 落库（失败静默重试一次，仍失败则记 dirty，联网后补推）。
    void pushSettings({ waterGoalMl: parsed });

    setNotice(COPY.waterGoalSaved);
    // 目标变了 → 喝水卡与看板的进度都随之变化，失效重取（服务端为唯一权威）。
    void queryClient.invalidateQueries({ queryKey: ['water'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return (
    <section
      aria-labelledby="water-goal-title"
      className="qsh-surface p-5"
    >
      <h2 id="water-goal-title" className="text-subtitle font-semibold text-slate-800 dark:text-slate-100">
        {COPY.waterGoalTitle}
      </h2>
      <p className="mt-tight text-xs text-slate-500 dark:text-slate-400">{COPY.waterGoalDesc}</p>

      <form data-testid="water-goal-form" className="mt-4 flex items-end gap-3" onSubmit={handleSubmit}>
        <label className="flex-1 text-sm text-slate-600 dark:text-slate-300" htmlFor="water-goal-input">
          {COPY.waterGoalLabel}
          {/* ⚠️ 刻意**不**加 `min` / `max` / `step`：那会让浏览器在提交时弹出**原生气泡**
              （「值必须小于等于 8000」这类），既与「中性、无恐吓」的语气规范冲突，
              也把校验权交给了不可控的系统文案。改为在 `handleSubmit` 里用 core 的
              `isValidWaterGoalMl` 校验并给**我们自己的中性提示** —— 与 `GoalSettingsCard`
              「无 min/max、提交时校验」的既有惯例一致。 */}
          <input
            id="water-goal-input"
            data-testid="water-goal-input"
            type="number"
            inputMode="numeric"
            value={value}
            onChange={(event) => handleChange(event.target.value)}
            className="mt-tight w-full rounded-control border border-slate-200 px-3 py-2 text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        <button
          type="submit"
          className="qsh-touch-target rounded-control bg-brand-600 px-4 py-3 font-medium text-white transition-colors duration-qsh-fast ease-qsh-out hover:bg-brand-700"
        >
          {COPY.waterGoalButton}
        </button>
      </form>

      {notice !== null && (
        <p
          role="status"
          aria-live="polite"
          data-testid="water-goal-notice"
          className="mt-2 text-sm text-brand-700 dark:text-brand-300"
        >
          {notice}
        </p>
      )}
    </section>
  );
}
