import type {
  PeriodReport,
  TopFoodItem,
  WeightTrendPoint,
  WeightUnit,
  WinLog,
} from '@qsh/shared-types';
import { formatSignedWeight, formatWeight, weightLabel } from '@/lib/units';

/** 下载前必须原样展示的个人数据提示。 */
export const PERIOD_ARCHIVE_SENSITIVE_NOTICE =
  '这一份包含你的体重等个人数据，请存到安全的地方。文件只会在当前设备生成，不会发送到第三方服务。';

/** 存档中最多摘录的「体重之外的变化」条数；计数仍使用 R11.3 的完整聚合值。 */
const ARCHIVE_WIN_EXCERPT_LIMIT = 6;

/** 存档页面需要的全部数据；主指标直接接收 R11.3 已展示的聚合结果。 */
export interface PeriodArchiveInput {
  report: PeriodReport;
  topFoods: readonly TopFoodItem[];
  weightPoints: readonly WeightTrendPoint[];
  wins: readonly WinLog[];
  weightUnit: WeightUnit;
  generatedAt?: Date;
}

/** HTML 文本转义，避免用户自定义食物名或变化文字破坏离线存档结构。 */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 只接受有限数，异常缓存值统一回退为 0。 */
function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 将 ISO 日期显示为中文年月日；非法值原样转义，不尝试猜测。 */
function formatArchiveDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return escapeHtml(value);
  }
  return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
}

/** 绘图所用的体重点，以及这些点是否来自带真实日期的明细。 */
interface ResolvedWeightSeries {
  points: WeightTrendPoint[];
  hasRecordedDates: boolean;
}

/** 归一化趋势点；若明细与当前回顾快照不一致，则退回回顾里的起止值，避免两处数字打架。 */
function resolveWeightSeries(input: PeriodArchiveInput): ResolvedWeightSeries {
  const weight = input.report.weight;
  if (
    weight === null ||
    !Number.isFinite(weight.startKg) ||
    !Number.isFinite(weight.endKg)
  ) {
    return { points: [], hasRecordedDates: false };
  }

  const validPoints = input.weightPoints
    .filter(
      (point) =>
        typeof point.date === 'string' &&
        point.date >= input.report.from &&
        point.date <= input.report.to &&
        Number.isFinite(point.weightKg),
    )
    .map((point) => ({ date: point.date, weightKg: point.weightKg }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const first = validPoints[0];
  const last = validPoints[validPoints.length - 1];
  const matchesSnapshot =
    first !== undefined &&
    last !== undefined &&
    validPoints.length >= 2 &&
    Math.abs(first.weightKg - weight.startKg) < 0.005 &&
    Math.abs(last.weightKg - weight.endKg) < 0.005;

  if (matchesSnapshot) {
    return { points: validPoints, hasRecordedDates: true };
  }

  // R11.3 汇总不包含首末记录的具体日期；降级时只展示中性标签，不把区间边界伪装成记录日期。
  return {
    points: [
      { date: '', weightKg: weight.startKg },
      { date: '', weightKg: weight.endKg },
    ],
    hasRecordedDates: false,
  };
}

/** 把体重点转换成可内联的 SVG 折线路径；横向等距，纵向只表达记录之间的相对变化。 */
function buildWeightChart(series: ResolvedWeightSeries, weightUnit: WeightUnit): string {
  const { points } = series;
  if (points.length < 2) {
    return '';
  }

  const width = 760;
  const height = 210;
  const paddingX = 26;
  const paddingY = 24;
  const weights = points.map((point) => point.weightKg);
  const minimum = Math.min(...weights);
  const maximum = Math.max(...weights);
  const spread = Math.max(maximum - minimum, 0.5);
  const drawableWidth = width - paddingX * 2;
  const drawableHeight = height - paddingY * 2;
  const coordinates = points.map((point, index) => {
    const x = paddingX + (index / (points.length - 1)) * drawableWidth;
    const y = paddingY + ((maximum - point.weightKg) / spread) * drawableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const firstLabel = series.hasRecordedDates ? formatArchiveDate(first.date) : '阶段开始记录';
  const lastLabel = series.hasRecordedDates ? formatArchiveDate(last.date) : '阶段末次记录';

  return `
    <figure class="weight-chart" aria-labelledby="weight-chart-caption">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="这段时间的体重记录折线">
        <line x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}" class="chart-axis" />
        <polyline points="${coordinates.join(' ')}" class="chart-line" />
        <circle cx="${coordinates[0]!.split(',')[0]}" cy="${coordinates[0]!.split(',')[1]}" r="5" class="chart-dot" />
        <circle cx="${coordinates[coordinates.length - 1]!.split(',')[0]}" cy="${coordinates[coordinates.length - 1]!.split(',')[1]}" r="5" class="chart-dot" />
      </svg>
      <figcaption id="weight-chart-caption">
        <span>${firstLabel} · ${escapeHtml(formatWeight(first.weightKg, weightUnit))}</span>
        <span>${lastLabel} · ${escapeHtml(formatWeight(last.weightKg, weightUnit))}</span>
      </figcaption>
    </figure>`;
}

/** 生成本地 HTML 存档文件名。 */
export function periodArchiveFileName(report: PeriodReport): string {
  const safeFrom = String(report.from ?? '').replace(/[^0-9-]/g, '') || 'start';
  const safeTo = String(report.to ?? '').replace(/[^0-9-]/g, '') || 'end';
  return `qingshenghuo-period-${safeFrom}_${safeTo}.html`;
}

/**
 * 生成完全自包含、离线可打开且适合 A4 打印的阶段回顾 HTML。
 *
 * 该函数不读取浏览器状态、不发请求；所有指标由调用方把页面当前快照显式传入，
 * 因此可单测、可复现，也不会出现“屏幕一套、存档另算一套”的隐式口径。
 */
export function buildPeriodArchiveHtml(input: PeriodArchiveInput): string {
  const { report, weightUnit } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const title = report.days === 365 ? '我的这一年' : '我的这段时光';
  const periodLabel = `${formatArchiveDate(report.from)} — ${formatArchiveDate(report.to)}`;
  const weight = report.weight;
  const weightSeries = resolveWeightSeries(input);
  const validTopFoods = input.topFoods.filter(
    (food) => typeof food.name === 'string' && food.name.trim() !== '' && Number.isFinite(food.dayCount),
  );
  const wins = input.wins
    .filter(
      (win) =>
        typeof win.text === 'string' &&
        win.text.trim() !== '' &&
        typeof win.loggedDate === 'string' &&
        win.loggedDate >= report.from &&
        win.loggedDate <= report.to,
    )
    .slice(-ARCHIVE_WIN_EXCERPT_LIMIT)
    .reverse();

  const topFoodsHtml =
    validTopFoods.length === 0
      ? '<p class="empty">这段时间的常吃记录暂时没有可展示的条目。</p>'
      : `<ol class="rank-list">${validTopFoods
          .map(
            (food) =>
              `<li><span>${escapeHtml(food.name)}</span><span>在 ${safeNumber(food.dayCount)} 天里记过</span></li>`,
          )
          .join('')}</ol>`;

  const winsHtml =
    wins.length === 0
      ? '<p class="empty">这段时间的文字摘录暂时没有可展示的条目。</p>'
      : `<ul class="quote-list">${wins
          .map(
            (win) =>
              `<li><blockquote>“${escapeHtml(win.text.trim())}”</blockquote><time datetime="${escapeHtml(win.loggedDate)}">${formatArchiveDate(win.loggedDate)}</time></li>`,
          )
          .join('')}</ul>`;

  const weightHtml =
    weight === null ||
    !Number.isFinite(weight.startKg) ||
    !Number.isFinite(weight.endKg) ||
    !Number.isFinite(weight.deltaKg)
      ? '<p class="empty">这段时间还没有形成可展示的体重起止变化。</p>'
      : `<div class="weight-summary">
          <div><span>阶段开始记录</span><strong>${escapeHtml(formatWeight(weight.startKg, weightUnit))}</strong></div>
          <div><span>阶段末次记录</span><strong>${escapeHtml(formatWeight(weight.endKg, weightUnit))}</strong></div>
          <div><span>起止变化</span><strong>${escapeHtml(formatSignedWeight(weight.deltaKg, weightUnit))} ${escapeHtml(weightLabel(weightUnit))}</strong></div>
        </div>
        ${buildWeightChart(weightSeries, weightUnit)}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · 轻生活</title>
  <style>
    :root { color-scheme: light; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: #1e293b; background: #edf6f2; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #edf6f2; line-height: 1.65; }
    main { width: min(920px, calc(100% - 32px)); margin: 32px auto; }
    header { padding: 40px; border-radius: 28px; color: #fff; background: #248263; }
    h1 { margin: 0; font-size: clamp(30px, 5vw, 48px); letter-spacing: .04em; }
    header p { margin: 10px 0 0; opacity: .92; }
    .actions { display: flex; justify-content: flex-end; margin: 16px 0; }
    button { border: 0; border-radius: 999px; padding: 11px 20px; color: #fff; background: #248263; font: inherit; font-weight: 700; cursor: pointer; }
    section { margin-top: 18px; padding: 28px; border: 1px solid #d9ede4; border-radius: 22px; background: #fff; break-inside: avoid; }
    h2 { margin: 0 0 18px; color: #175b47; font-size: 22px; }
    .overview, .weight-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .overview div, .weight-summary div { padding: 18px; border-radius: 16px; background: #f0f7f4; }
    .overview span, .weight-summary span { display: block; color: #64748b; font-size: 13px; }
    .overview strong, .weight-summary strong { display: block; margin-top: 5px; color: #173f34; font-size: 25px; font-variant-numeric: tabular-nums; }
    .weight-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .weight-chart { margin: 22px 0 0; }
    .weight-chart svg { display: block; width: 100%; height: auto; border-radius: 16px; background: #fbfdfc; }
    .chart-axis { stroke: #cbd5e1; stroke-width: 1; }
    .chart-line { fill: none; stroke: #248263; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }
    .chart-dot { fill: #248263; }
    figcaption { display: flex; justify-content: space-between; gap: 16px; margin-top: 8px; color: #475569; font-size: 12px; font-variant-numeric: tabular-nums; }
    .rank-list, .quote-list { margin: 0; padding: 0; list-style: none; }
    .rank-list li { display: flex; justify-content: space-between; gap: 20px; padding: 11px 0; border-bottom: 1px solid #e2e8f0; }
    .rank-list li:last-child { border-bottom: 0; }
    .rank-list li span:last-child { flex: none; color: #64748b; font-size: 13px; }
    .quote-list { display: grid; gap: 12px; }
    .quote-list li { padding: 16px 18px; border-left: 4px solid #8ec9b4; border-radius: 0 12px 12px 0; background: #f8fafc; }
    blockquote { margin: 0; white-space: pre-wrap; }
    time { display: block; margin-top: 6px; color: #64748b; font-size: 12px; }
    .source { margin: 18px 0 0; padding-top: 12px; border-top: 1px dashed #cbd5e1; color: #64748b; font-size: 12px; }
    .empty { margin: 0; color: #64748b; }
    footer { margin: 20px 0 0; padding: 18px 22px; border-radius: 16px; color: #355b50; background: #dcefe7; font-size: 13px; }
    @media (max-width: 640px) {
      main { width: min(100% - 20px, 920px); margin: 10px auto; }
      header, section { padding: 22px; border-radius: 18px; }
      .overview, .weight-summary { grid-template-columns: 1fr; }
      .rank-list li, figcaption { align-items: flex-start; flex-direction: column; gap: 2px; }
    }
    @page { size: A4; margin: 14mm; }
    @media print {
      body { background: #fff; }
      main { width: 100%; margin: 0; }
      .actions { display: none; }
      header { border-radius: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      section { box-shadow: none; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p>${periodLabel} · ${safeNumber(report.days)} 天回顾</p>
    </header>
    <div class="actions"><button type="button" onclick="window.print()">打印或另存 PDF</button></div>

    <section aria-labelledby="overview-title">
      <h2 id="overview-title">留下来的记录</h2>
      <div class="overview">
        <div><span>有记录的日子</span><strong>${safeNumber(report.loggedDays)} 天</strong></div>
        <div><span>记录过的不同食物</span><strong>${safeNumber(report.distinctFoodCount)} 种</strong></div>
      </div>
      <p class="source">来源：与「这段时间」页面同一份阶段回顾汇总。有记录的日子按饮食、体重、饮水、运动、习惯和体重之外的变化中任一类当天有记录计算；食物种类按同名合并后计数。</p>
    </section>

    <section aria-labelledby="weight-title">
      <h2 id="weight-title">体重记录的起止与折线</h2>
      ${weightHtml}
      <p class="source">来源：起止数值直接采用「这段时间」页面的同一份汇总；折线读取同一日期范围内的体重记录。若保存时明细快照已变化，折线只连接当前回顾中的起止值。</p>
    </section>

    <section aria-labelledby="foods-title">
      <h2 id="foods-title">常吃记录</h2>
      ${topFoodsHtml}
      <p class="source">来源：与「这段时间」页面相同的常吃榜查询，按所选时间范围统计出现过的天数，最多展示页面上的前五项。</p>
    </section>

    <section aria-labelledby="wins-title">
      <h2 id="wins-title">体重之外的变化 · 摘录</h2>
      ${winsHtml}
      <p class="source">来源：所选时间范围内由你亲手写下的「体重之外的变化」；这里只摘取最近几条原文，不生成评价。</p>
    </section>

    <footer>
      ${escapeHtml(PERIOD_ARCHIVE_SENSITIVE_NOTICE)}<br>
      生成时间：${escapeHtml(generatedAt.toLocaleString('zh-CN', { hour12: false }))} · 轻生活
    </footer>
  </main>
</body>
</html>`;
}
