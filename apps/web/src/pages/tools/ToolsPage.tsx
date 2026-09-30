import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  DRINK_LIBRARY,
  SUGAR_LEVELS,
  TAKEOUT_LIBRARY,
  estimateDrink,
  estimateFeast,
  estimateTakeout,
  findMetActivity,
  snackRedemption,
} from '@qsh/core';
import {
  energyLabel,
  fromDisplayEnergy,
  fromDisplayWeight,
  toDisplayEnergy,
  toDisplayWeight,
  useUnitStore,
  weightLabel,
} from '@/lib/units';
import { readRememberedChoice, rememberToolChoice } from '@/lib/tool-memory';

/** 工具标签（R5.1~R5.4）。 */
type ToolTab = 'takeout' | 'snack' | 'feast' | 'drink';

/**
 * 「我的常点」（C2）可选的合法档位（记忆白名单）。
 *
 * 库里若下架了某个品类 / 改了档位名，记忆里那条会因为不在白名单里而被忽略，
 * 页面回落到默认档位 —— 绝不拿一个已经不存在的选项去预选。
 */
const TAKEOUT_KINDS: readonly string[] = TAKEOUT_LIBRARY.map((item) => item.kind);
const DRINK_KINDS: readonly string[] = DRINK_LIBRARY.map((item) => item.kind);

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
  // 「我的常点」（C2）：只在**挂载时**读一次记忆，用来预选档位。
  // 后面用户每次改动都会写回记忆，但本页展示的估算完全不受它影响（见下方 estimate* 调用）。
  const rememberedTakeout = useMemo(
    () => readRememberedChoice('takeout', { kind: TAKEOUT_KINDS }),
    [],
  );
  const rememberedDrink = useMemo(
    () => readRememberedChoice('drink', { kind: DRINK_KINDS, sugar: SUGAR_LEVELS }),
    [],
  );

  const [tab, setTab] = useState<ToolTab>('takeout');
  const [takeoutKind, setTakeoutKind] = useState<string>(rememberedTakeout?.kind ?? 'malatang');
  const [snackName, setSnackName] = useState<string>('薯片（一包）');
  /** 零食热量真值（**始终以 kcal 存储**，换算只发生在展示层） */
  const [snackKcal, setSnackKcal] = useState<number>(550);
  const [weightKg, setWeightKg] = useState<number>(60);
  const [feastKind, setFeastKind] = useState<string>('hotpot');
  const [drinkKind, setDrinkKind] = useState<string>(rememberedDrink?.kind ?? 'milk_tea');
  const [drinkSize, setDrinkSize] = useState<number>(() => {
    const size = Number(rememberedDrink?.size);
    return Number.isFinite(size) && size >= 100 && size <= 2000 ? Math.round(size) : 500;
  });
  const [sugarLevel, setSugarLevel] = useState<string>(rememberedDrink?.sugar ?? 'regular');

  /** 全局热量单位（K6 / R2.11）：所有热量文字按此换算，**不改任何估算口径**。 */
  const unit = useUnitStore((state) => state.unit);

  /**
   * 零食热量输入框的**回显文本**（当前单位下的数值）。
   *
   * 为什么需要独立的文本态：输入框是「人填的数字」，若直接用换算后的数值做受控值，
   * 每敲一位都会 `input → toDisplayEnergy → 回显` 来回取整，kJ 模式下边打字边跳数。
   * 故文本态独立保存、仅在**切换单位**时按新单位重新回显；真值 `snackKcal` 始终是 kcal。
   */
  const [snackKcalText, setSnackKcalText] = useState<string>(() => String(toDisplayEnergy(550, unit)));
  useEffect(() => {
    // 单位切换时把输入框按新单位重新表达（kcal 真值 snackKcal 不变）
    setSnackKcalText(String(toDisplayEnergy(snackKcal, unit)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);

  /** 全局体重单位（D-3）：体重输入按当前单位回显 / 理解，真值 `weightKg` 始终是 kg。 */
  const weightUnit = useUnitStore((state) => state.weightUnit);

  /**
   * 体重输入框的**回显文本**（当前单位下的数值），与 `snackKcalText` 同一模式：
   * 文本态独立保存，避免边打字边换算取整；仅在**切换单位**时按新单位重新表达。
   * 真值 `weightKg` 始终是 kg（换算只在展示与输入层，D-3）。
   */
  const [weightText, setWeightText] = useState<string>(() =>
    String(toDisplayWeight(60, useUnitStore.getState().weightUnit)),
  );
  useEffect(() => {
    // 单位切换时把输入框按新单位重新表达（kg 真值 weightKg 不变）
    setWeightText(String(toDisplayWeight(weightKg, weightUnit)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weightUnit]);

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
            onChange={(event) => {
              const kind = event.target.value;
              setTakeoutKind(kind);
              // 「我的常点」（C2）：只记品类，不推荐、不评判
              rememberToolChoice('takeout', { kind });
            }}
          >
            {TAKEOUT_LIBRARY.map((item) => (
              <option key={item.kind} value={item.kind}>
                {item.name}
              </option>
            ))}
          </select>
          {/* 预选说明（中性）：被预选的档位与记忆一致时才提示，换掉了就不再说 */}
          {rememberedTakeout !== null && takeoutKind === rememberedTakeout.kind && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              按你常点的先选好了，换一个也随时可以
            </p>
          )}
          {takeout ? (
            <div className="mt-4">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                一整份大约{' '}
                <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
                  {toDisplayEnergy(takeout.range.min, unit)}–{toDisplayEnergy(takeout.range.max, unit)}
                </span>{' '}
                {energyLabel(unit)}
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
                大约热量（{energyLabel(unit)}）
              </label>
              <input
                id="snack-kcal"
                type="number"
                min={0}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                value={snackKcalText}
                onChange={(event) => {
                  const raw = event.target.value;
                  setSnackKcalText(raw);
                  const parsed = Number(raw);
                  // 输入按当前单位理解，回写成 kcal 真值（口径不变）
                  setSnackKcal(Number.isFinite(parsed) ? Math.max(0, fromDisplayEnergy(parsed, unit)) : 0);
                }}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300" htmlFor="snack-weight">
                你的体重（{weightLabel(weightUnit)}）
              </label>
              <input
                id="snack-weight"
                type="number"
                min={Math.round(toDisplayWeight(20, weightUnit))}
                max={Math.round(toDisplayWeight(400, weightUnit))}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
                value={weightText}
                onChange={(event) => {
                  const raw = event.target.value;
                  setWeightText(raw);
                  const parsed = Number(raw);
                  // 输入按当前单位理解，回写成 kg 真值（口径不变，同 snackKcal）
                  if (Number.isFinite(parsed) && parsed > 0) {
                    setWeightKg(Math.min(400, Math.max(20, fromDisplayWeight(parsed, weightUnit))));
                  }
                }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            「{snack.name}」约 {toDisplayEnergy(snack.kcal, unit)} {energyLabel(unit)}，换成这些会更轻松：
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
                  {toDisplayEnergy(feast.perPerson.min, unit)}–{toDisplayEnergy(feast.perPerson.max, unit)}
                </span>{' '}
                {energyLabel(unit)}（不含酒水）
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
            onChange={(event) => {
              const kind = event.target.value;
              setDrinkKind(kind);
              // 「我的常点」（C2）：品类与档位一起记（杯型 / 糖度沿用当前值）
              rememberToolChoice('drink', { kind, size: String(drinkSize), sugar: sugarLevel });
            }}
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
                onChange={(event) => {
                  const size = Math.max(100, Number(event.target.value) || 500);
                  setDrinkSize(size);
                  rememberToolChoice('drink', { kind: drinkKind, size: String(size), sugar: sugarLevel });
                }}
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
                onChange={(event) => {
                  const sugar = event.target.value;
                  setSugarLevel(sugar);
                  rememberToolChoice('drink', { kind: drinkKind, size: String(drinkSize), sugar });
                }}
              >
                <option value="full">全糖</option>
                <option value="regular">正常糖</option>
                <option value="half">半糖</option>
                <option value="light">三分糖</option>
                <option value="none">无糖</option>
              </select>
            </div>
          </div>
          {/* 预选说明（中性）：与记忆一致时才提示，用户改掉了就不再说 */}
          {rememberedDrink !== null &&
            drinkKind === rememberedDrink.kind &&
            sugarLevel === rememberedDrink.sugar && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                按你常点的先选好了，换一个也随时可以
              </p>
            )}
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            这一杯大约{' '}
            <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
              {toDisplayEnergy(drink.range.min, unit)}–{toDisplayEnergy(drink.range.max, unit)}
            </span>{' '}
            {energyLabel(unit)}
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
