import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  DRINK_LIBRARY,
  TAKEOUT_LIBRARY,
  estimateDrink,
  estimateFeast,
  estimateTakeout,
  findMetActivity,
  snackRedemption,
} from '@qsh/core';

/** 工具标签（R5.1~R5.4）。 */
type ToolTab = 'takeout' | 'snack' | 'feast' | 'drink';

const TABS: Array<{ key: ToolTab; label: string }> = [
  { key: 'takeout', label: '外卖换算' },
  { key: 'snack', label: '零食救赎' },
  { key: 'feast', label: '聚餐模式' },
  { key: 'drink', label: '饮品计算' },
];

/**
 * 生活化工具（`/tools`，PRD §6 第 8 行 / R5.1~R5.4，二期 —— 差异化重点）。
 *
 * 全部为**纯前端估算**（数据来自 `@qsh/core` 内置表），不发请求、不落库；
 * 给区间而非精确值，并始终附更轻松的替代建议（语气遵循 PRD §7）。
 */
export default function ToolsPage(): ReactElement {
  const [tab, setTab] = useState<ToolTab>('takeout');
  const [takeoutKind, setTakeoutKind] = useState<string>('malatang');
  const [snackName, setSnackName] = useState<string>('薯片（一包）');
  const [snackKcal, setSnackKcal] = useState<number>(550);
  const [weightKg, setWeightKg] = useState<number>(60);
  const [feastKind, setFeastKind] = useState<string>('hotpot');
  const [drinkKind, setDrinkKind] = useState<string>('milk_tea');
  const [drinkSize, setDrinkSize] = useState<number>(500);
  const [sugarLevel, setSugarLevel] = useState<string>('regular');

  const takeout = estimateTakeout(takeoutKind);
  const feast = estimateFeast(feastKind);
  const drink = useMemo(() => estimateDrink(drinkKind, drinkSize, sugarLevel), [drinkKind, drinkSize, sugarLevel]);
  const snack = useMemo(
    () => snackRedemption(snackName, snackKcal, weightKg, (code) => {
      const found = findMetActivity(code);
      return found ? { name: found.name, met: found.met } : undefined;
    }),
    [snackName, snackKcal, weightKg],
  );

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pb-24 pt-4">
      <div role="tablist" aria-label="工具切换" className="grid grid-cols-4 gap-1 qsh-surface p-1">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`rounded-xl px-2 py-2 text-xs font-medium transition-colors ${
              tab === item.key ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300'
            }`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'takeout' ? (
        <section className="qsh-surface p-5">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">外卖换算器</h2>
          <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300" htmlFor="takeout-kind">
            常点的品类
          </label>
          <select
            id="takeout-kind"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            value={takeoutKind}
            onChange={(event) => setTakeoutKind(event.target.value)}
          >
            {TAKEOUT_LIBRARY.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.name}
              </option>
            ))}
          </select>
          {takeout ? (
            <div className="mt-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                一整份大约{' '}
                <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
                  {takeout.range.min}–{takeout.range.max}
                </span>{' '}
                kcal
              </p>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">估算口径：{takeout.assumption}</p>
              <h3 className="mt-3 text-sm font-semibold text-brand-700 dark:text-brand-400">这样点更轻松</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                {takeout.swaps.map((swap) => (
                  <li key={swap}>{swap}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'snack' ? (
        <section className="qsh-surface p-5">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">零食救赎</h2>
          <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300" htmlFor="snack-name">
            想吃的零食
          </label>
          <input
            id="snack-name"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            value={snackName}
            onChange={(event) => setSnackName(event.target.value)}
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300" htmlFor="snack-kcal">
                大约热量 kcal
              </label>
              <input
                id="snack-kcal"
                type="number"
                min={0}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                value={snackKcal}
                onChange={(event) => setSnackKcal(Math.max(0, Number(event.target.value) || 0))}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300" htmlFor="snack-weight">
                你的体重 kg
              </label>
              <input
                id="snack-weight"
                type="number"
                min={20}
                max={400}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                value={weightKg}
                onChange={(event) => setWeightKg(Math.max(20, Number(event.target.value) || 60))}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            「{snack.name}」约 {snack.kcal} kcal，换成这些会更轻松：
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {snack.swaps.map((swap) => (
              <li key={swap}>{swap}</li>
            ))}
          </ul>
          <h3 className="mt-3 text-sm font-semibold text-brand-700 dark:text-brand-400">吃掉它大约需要</h3>
          <ul className="mt-1 space-y-1 text-sm text-slate-600 dark:text-slate-300">
            {snack.exercise.map((item) => (
              <li key={item.activityName}>
                {item.activityName} 约 <span className="font-bold">{item.minutes}</span> 分钟
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">想吃了就吃一点，不用有负担 —— 知道它换算成什么就好。</p>
        </section>
      ) : null}

      {tab === 'feast' ? (
        <section className="qsh-surface p-5">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">聚餐模式</h2>
          <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300" htmlFor="feast-kind">
            聚餐类型
          </label>
          <select
            id="feast-kind"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            value={feastKind}
            onChange={(event) => setFeastKind(event.target.value)}
          >
            <option value="hotpot">火锅</option>
            <option value="bbq">烧烤</option>
            <option value="buffet">自助餐</option>
          </select>
          {feast ? (
            <div className="mt-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {feast.name}人均大约{' '}
                <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
                  {feast.perPerson.min}–{feast.perPerson.max}
                </span>{' '}
                kcal（不含酒水）
              </p>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">估算口径：{feast.assumption}</p>
              <h3 className="mt-3 text-sm font-semibold text-brand-700 dark:text-brand-400">当天可以这样安排</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
                {feast.adjustTips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'drink' ? (
        <section className="qsh-surface p-5">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">饮品计算器</h2>
          <label className="mt-3 block text-sm text-slate-600 dark:text-slate-300" htmlFor="drink-kind">
            饮品
          </label>
          <select
            id="drink-kind"
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            value={drinkKind}
            onChange={(event) => setDrinkKind(event.target.value)}
          >
            {DRINK_LIBRARY.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300" htmlFor="drink-size">
                杯型 ml
              </label>
              <input
                id="drink-size"
                type="number"
                min={100}
                max={2000}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                value={drinkSize}
                onChange={(event) => setDrinkSize(Math.max(100, Number(event.target.value) || 500))}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300" htmlFor="drink-sugar">
                糖度
              </label>
              <select
                id="drink-sugar"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                value={sugarLevel}
                onChange={(event) => setSugarLevel(event.target.value)}
              >
                <option value="full">全糖</option>
                <option value="regular">正常糖</option>
                <option value="half">半糖</option>
                <option value="light">三分糖</option>
                <option value="none">无糖</option>
              </select>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            这一杯大约{' '}
            <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
              {drink.range.min}–{drink.range.max}
            </span>{' '}
            kcal
          </p>
          <h3 className="mt-3 text-sm font-semibold text-brand-700 dark:text-brand-400">低卡点单攻略</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {drink.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <Link
        to="/why-numbers"
        className="qsh-touch-target px-1 text-sm font-medium text-brand-700 dark:text-brand-300"
      >
        这些数字是怎么来的 →
      </Link>
    </div>
  );
}
