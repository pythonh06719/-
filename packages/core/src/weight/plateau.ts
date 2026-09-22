/**
 * 平台期判定（R2.7）—— **纯函数、唯一真源**。
 *
 * 「平台期」= 体重连续约 3 周没有明显变化。这里的目的**不是医学诊断**，而是：
 * 当只显示一条平线会让人觉得「坚持了这么久却没用」的时候，**主动解释为什么**，
 * 并把视角从「每天的数字」拉到「4 周斜率」。
 *
 * ## 阈值是怎么定的（写在这里，避免以后被随手改动）
 *
 * - **观察窗 21 天（3 周）**：7 日均线已经把日波动平滑掉；窗口再短（7~14 天），
 *   一次聚餐带来的 +1kg 就会被误判成「趋势变了」。3 周是「能排除短期噪声、
 *   又不至于让人等太久」的最小观察尺度。
 * - **变化阈值 0.3 kg**：日常水分、食物重量、衣物与作息带来的日内波动常见幅度在
 *   0.5~1.5 kg，小于 0.3 kg 的差异在噪声里分辨不出来；同时
 *   0.3kg / 3 周 ≈ 0.1 kg/周，已经远低于「每周 0.25~0.5 kg」的温和节奏 ——
 *   这时正确的回应是**拉长视角**，而不是加大缺口。
 * - **至少 3 个记录日**：只有 1~2 个点时，无法区分「体重没变」和「没有记录」。
 * - **停更保护**：最后一条记录距今过久（> 14 天）时不判定 —— 那是「没在记录」，
 *   不是「平台期」，此时弹说明牌是答非所问。
 *
 * ⚠️ 语气约束（PRD §7）：本模块**只产出中性事实**，不含任何面向用户的措辞；
 * 文案一律由 `apps/web/src/lib/copy.ts` 负责。
 *
 * 设计约束：
 * - 零 IO、零运行时依赖（`@qsh/core` 铁律）；日期一律用本地日粒度 `YYYY-MM-DD`，
 *   不读取 `Date.now()`（K8）；
 * - 数据不足时返回 `isPlateau: false`，调用方据此不渲染说明卡片；
 * - 无法计算 4 周斜率时返回 `slope4wKgPerWeek: null`，绝不返回 `NaN`。
 */

import { round2 } from '../calorie/rounding';

/** 一天的毫秒数（本地日粒度差值用 `Math.round` 归一，跨夏令时也不漂移）。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 一周的天数（斜率从「每天」换算到「每周」）。 */
const DAYS_PER_WEEK = 7;

/** 平台期的最短观察窗口（天）。 */
export const PLATEAU_WINDOW_DAYS = 21;

/** 判定「没有明显变化」的阈值（kg）：窗口内与最新值的差值小于它即视为没动。 */
export const PLATEAU_THRESHOLD_KG = 0.3;

/** 至少需要的记录日数：少于它无法区分「没变化」和「没记录」。 */
export const PLATEAU_MIN_POINTS = 3;

/** 停更保护阈值（天）：最后一条记录距今超过它，就不判定平台期。 */
export const PLATEAU_STALE_DAYS = 14;

/** 4 周斜率的回归窗口（天）。 */
export const SLOPE_WINDOW_DAYS = 28;

/** `YYYY-MM-DD` 形态校验（宽松：允许 1~2 位月/日，真实存在性交由 `Date` 归一）。 */
const DATE_KEY_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** 归一化后的序列点。 */
export interface PlateauPoint {
  /** `YYYY-MM-DD` */
  date: string;
  /** 体重 kg（优先取 7 日移动平均，其次原始体重） */
  weightKg: number;
}

/** `detectWeightPlateau` 的输入。 */
export interface PlateauInput {
  /** 原始体重点（任意顺序，函数内部排序） */
  points?: ReadonlyArray<{ date: string; weightKg: number }>;
  /** 与 `points` 日期对齐的 7 日移动平均（`null` = 断点，会被跳过） */
  movingAverage?: ReadonlyArray<{ date: string; value: number | null }>;
  /**
   * 参照日 `YYYY-MM-DD`（由调用方注入，保持 core 零 IO / K8）。
   * 传入后会启用「停更保护」；省略则不判断记录是否停更。
   */
  asOf?: string;
}

/** 平台期判定结果。 */
export interface PlateauResult {
  /** 是否判定为平台期（`stalledDays >= PLATEAU_WINDOW_DAYS` 且未触发停更保护） */
  isPlateau: boolean;
  /** 停滞天数：从「最近一次明显变化的那天」到最新记录日的跨度 */
  stalledDays: number;
  /** 近 4 周斜率 kg/周（负 = 下降；数据不足时 `null`） */
  slope4wKgPerWeek: number | null;
  /** 判定所用观察窗（天），供可解释性展示 */
  windowDays: number;
  /** 判定所用阈值（kg），供可解释性展示 */
  thresholdKg: number;
}

/**
 * 把 `YYYY-MM-DD` 按**本地时区**解析为当天 00:00 的时间戳。
 *
 * @returns 时间戳；非法格式返回 `null`
 */
function toTime(dateKey: string): number | null {
  const matched = DATE_KEY_PATTERN.exec(dateKey);
  if (matched === null) {
    return null;
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const time = new Date(year, month - 1, day).getTime();
  return Number.isNaN(time) ? null : time;
}

/** 两个日期键相差天数（`to - from`）；任一非法时返回 0。 */
function dayDiff(from: string, to: string): number {
  const start = toTime(from);
  const end = toTime(to);
  if (start === null || end === null) {
    return 0;
  }
  return Math.round((end - start) / MS_PER_DAY);
}

/**
 * 归一化输入为「升序、时间合法」的体重序列。
 *
 * **优先使用 7 日移动平均**（噪声更小，不会因为某天多喝两杯水就判成平台期）；
 * 均线点数不足时退回原始体重点。
 */
function normalizeSeries(input: PlateauInput): PlateauPoint[] {
  const fromAverage: PlateauPoint[] = (input.movingAverage ?? [])
    .filter(
      (item): item is { date: string; value: number } =>
        typeof item.date === 'string' &&
        typeof item.value === 'number' &&
        Number.isFinite(item.value),
    )
    .map((item) => ({ date: item.date, weightKg: item.value }));

  const fromRaw: PlateauPoint[] = (input.points ?? []).filter(
    (item): item is PlateauPoint =>
      typeof item.date === 'string' &&
      typeof item.weightKg === 'number' &&
      Number.isFinite(item.weightKg),
  );

  const source = fromAverage.length >= PLATEAU_MIN_POINTS ? fromAverage : fromRaw;

  return source
    .filter((item) => toTime(item.date) !== null)
    .sort((a, b) => (toTime(a.date) ?? 0) - (toTime(b.date) ?? 0));
}

/**
 * 用最小二乘线性回归算最近 4 周的体重斜率（kg/周）。
 *
 * 用回归而不是「首末两点相减」：单点异常值对首末差的影响过大，
 * 而回归会把整段趋势一起考虑，得到的斜率更稳。
 *
 * @returns kg/周；窗口内不足 2 个点或退化为一条垂直线时返回 `null`
 */
function slopePerWeek(series: ReadonlyArray<PlateauPoint>, endDate: string): number | null {
  const endTime = toTime(endDate);
  const startDateKey = shiftDays(endDate, -(SLOPE_WINDOW_DAYS - 1));
  const startTime = startDateKey === null ? null : toTime(startDateKey);
  if (endTime === null || startTime === null) {
    return null;
  }

  const window = series.filter((point) => {
    const pointTime = toTime(point.date);
    return pointTime !== null && pointTime >= startTime && pointTime <= endTime;
  });
  if (window.length < 2) {
    return null;
  }

  const baseTime = toTime(window[0]!.date);
  if (baseTime === null) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of window) {
    const pointTime = toTime(point.date);
    if (pointTime === null) {
      continue;
    }
    const x = (pointTime - baseTime) / MS_PER_DAY;
    sumX += x;
    sumY += point.weightKg;
    sumXY += x * point.weightKg;
    sumXX += x * x;
  }

  const count = window.length;
  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) {
    return null;
  }
  const slopePerDay = (count * sumXY - sumX * sumY) / denominator;
  return round2(slopePerDay * DAYS_PER_WEEK);
}

/**
 * 在本地日期上增加天数（跨月 / 跨年 / 闰年由 `Date` 处理）。
 *
 * @returns `YYYY-MM-DD`；输入非法时返回 `null`
 */
function shiftDays(dateKey: string, delta: number): string | null {
  const time = toTime(dateKey);
  if (time === null) {
    return null;
  }
  const date = new Date(time);
  date.setDate(date.getDate() + delta);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 判定是否处于平台期（R2.7）。
 *
 * 算法：
 * 1. 归一化出升序体重序列（均线优先），不足 3 个点直接不算；
 * 2. 停更保护：最后一条记录距 `asOf` 超过 14 天 → 不计平台期；
 * 3. 从最新点往前回溯，找「最近一次与最新值相差 ≥ 0.3kg」的那天，
 *    它到最新记录日的跨度即 `stalledDays`；
 * 4. `stalledDays >= 21` → 判定为平台期；
 * 5. 无论是否构成平台期，都把近 4 周回归斜率一并算出（供「拉长视角」文案使用）。
 *
 * @param input 见 {@link PlateauInput}
 * @returns 判定结果（含 4 周斜率与判定常量，便于前端解释依据）
 */
export function detectWeightPlateau(input: PlateauInput = {}): PlateauResult {
  const base: PlateauResult = {
    isPlateau: false,
    stalledDays: 0,
    slope4wKgPerWeek: null,
    windowDays: PLATEAU_WINDOW_DAYS,
    thresholdKg: PLATEAU_THRESHOLD_KG,
  };

  const series = normalizeSeries(input);
  if (series.length < PLATEAU_MIN_POINTS) {
    return base;
  }

  const latest = series[series.length - 1];
  if (latest === undefined) {
    return base;
  }

  const slope = slopePerWeek(series, latest.date);

  // 记录已停更：不是「体重不动」，而是「没有数据」，此时不该弹平台期说明
  if (typeof input.asOf === 'string') {
    const staleDays = dayDiff(latest.date, input.asOf);
    if (staleDays > PLATEAU_STALE_DAYS) {
      return { ...base, slope4wKgPerWeek: slope };
    }
  }

  let index = series.length - 1;
  while (
    index > 0 &&
    Math.abs(series[index - 1]!.weightKg - latest.weightKg) < PLATEAU_THRESHOLD_KG
  ) {
    index -= 1;
  }

  const stalledDays = Math.max(0, dayDiff(series[index]!.date, latest.date));

  return {
    isPlateau: stalledDays >= PLATEAU_WINDOW_DAYS,
    stalledDays,
    slope4wKgPerWeek: slope,
    windowDays: PLATEAU_WINDOW_DAYS,
    thresholdKg: PLATEAU_THRESHOLD_KG,
  };
}
