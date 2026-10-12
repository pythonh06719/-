#!/usr/bin/env node
/**
 * 小字号对比度闸门（apps/web/scripts/check-contrast.mjs，2026-10-12 UI 评审 P2-2）。
 *
 * ## 治什么病
 *
 * `tailwind.config.ts` 字号 token 注释写着「caption(12px) 用于文字时必须确认对比度
 * ≥ 4.5:1」——但这句话此前**没有任何自动闸门**，全靠写代码的人自觉。静态扫描把
 * 「自觉」变成「提交即查」。
 *
 * ## 扫描口径（保守设计：宁可漏报，不可误报）
 *
 * - 只查**同一 className 串里同时出现 `text-caption` / `text-xs`** 的前景色 token
 *   （`text-{ramp}-{shade}` 与 `dark:text-{ramp}-{shade}`）。不跟小字号同串的颜色
 *   大概率是图标/装饰色，不在本脚本职责内。
 * - 不推断 DOM 背景（静态分析做不到可靠推断），改为**两组背景集合**校验：
 *   非 dark: 前缀色必须对浅色组全部达标；`dark:` 色必须对深色组全部达标。
 *   两组集合覆盖全站实际表面（白卡 / cream / brand-50 / warm-50 / slate-800 / slate-900）。
 * - 跨行 className（模板字符串折行）会漏扫 —— 取舍：漏报只损失覆盖率，误报会
 *   训练团队忽略闸门。
 *
 * ## 判定分级
 *
 * - `banned`：明确违规（如浅色底上的 slate-400 = 3.0:1），**非零退出码**，可挂 CI。
 * - `review`：白名单外但可能合法（如 `text-white` 在品牌实心底上做小字），只警告。
 *
 * 用法：`node apps/web/scripts/check-contrast.mjs`（仓库根），或
 * `npm run contrast:check -w @qsh/web`。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Tailwind 默认 slate（50–900 全档）+ 本项目品牌色板（值抄自 tailwind.config.ts，改动需同步两处）。 */
const PALETTE = {
  slate: {
    50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8',
    500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a',
  },
  brand: { 100: '#d9ede4', 200: '#b6ddc9', 300: '#8cc9ab', 500: '#2f9e78', 600: '#248263', 700: '#1c6a51', 800: '#155040', 900: '#0f3a2e' },
  warm: { 100: '#fdeccd', 200: '#fbd89c', 300: '#f8c06b', 500: '#eaa032', 600: '#cf8320', 700: '#a8631a', 800: '#7f4a17' },
  coral: { 100: '#fbe3d9', 200: '#f6c4b1', 300: '#eda184', 500: '#c95f3b', 600: '#a84a2d', 700: '#853a23' },
  white: '#ffffff',
};

/** 浅色组背景：全站浅色表面（白卡 / cream / brand-50·100 / warm-50·100 / slate-50·100）。 */
const LIGHT_BGS = ['#ffffff', '#fdfaf5', '#f0f7f4', '#d9ede4', '#fef7ea', '#fdeccd', '#f8fafc', '#f1f5f9'];
/** 深色组背景：全站深色表面（slate-800 卡 / slate-900 底 / brand-900 暖卡深色档）。 */
const DARK_BGS = ['#1e293b', '#0f172a', '#0f3a2e'];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lum(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const l1 = lum(fg), l2 = lum(bg);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
/** 前景色对某一组背景的**最差**比值（全达标才算合法）。 */
function worstRatio(fgHex, bgs) {
  return Math.min(...bgs.map((bg) => ratio(fgHex, bg)));
}

const RAMPS = Object.keys(PALETTE);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

const SMALL = /text-caption|text-xs\b/;
/**
 * 前景色 token：变体前缀整体纳入匹配，便于两种剔除：
 * ① `hover:` / `focus:` 前缀 —— 仅悬停/聚焦才出现的颜色不是常态前景，跳过；
 * ② `dark:` 前缀 —— 决定按哪组背景校验。
 * 白字（text-white）不判 banned：白底白字写了立即可见（开发时就会发现），
 * 而「品牌实心底 + 白字」是全站按钮/标签的常见合法模式（bg-brand-600 上 5.0:1），
 * 静态分析分不清这两种背景，故降为 review。
 */
const FG = /(?:(dark|hover|focus|group-hover|md|lg|sm):)*text-(slate|brand|warm|coral|white)(?:-(\d{2,3}))?/g;

const banned = [];
const review = [];
let scanned = 0;
let linesWithSmallText = 0;

for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!SMALL.test(line)) return;
    linesWithSmallText++;
    const rel = relative(SRC, file).replace(/\\/g, '/');
    for (const m of line.matchAll(FG)) {
      scanned++;
      const variants = (m[1] ?? '').split(':').filter(Boolean);
      // 悬停/聚焦态才出现的颜色不是常态前景，跳过（误报源：hover:text-brand-300 等）
      if (variants.some((v) => v === 'hover' || v === 'focus' || v === 'group-hover')) continue;
      const isDark = variants.includes('dark');
      const ramp = m[2];
      const shade = m[3];
      const hex = ramp === 'white' ? PALETTE.white : PALETTE[ramp]?.[Number(shade)];
      if (hex === undefined) {
        review.push(`${rel}:${i + 1}  dark=${isDark}  ${m[0]}（色板外，无法机判）`);
        continue;
      }
      // 白字不判 banned：白底白字开发时立即可见，而「品牌实心底 + 白字」是合法常见
      // 模式（bg-brand-600 上 5.0:1），静态分析分不清背景 → 降为人工确认。
      if (ramp === 'white') {
        review.push(`${rel}:${i + 1}  ${m[0]}（白字：仅当背景为品牌实心底时合法，需人工确认）`);
        continue;
      }
      const worst = worstRatio(hex, isDark ? DARK_BGS : LIGHT_BGS);
      const where = `${rel}:${i + 1}  ${isDark ? '深色档' : '浅色档'}  ${m[0].padEnd(22)} 最差比值 ${worst.toFixed(2)}`;
      if (worst < 4.5) banned.push(where);
    }
  });
}

console.log(`扫描 ${linesWithSmallText} 行含小字号（text-caption/text-xs）的代码，提取 ${scanned} 个前景色 token。\n`);

if (banned.length > 0) {
  console.log(`✗ banned（小字号前景色对常见背景 < 4.5:1，WCAG AA 不达标）${banned.length} 处：`);
  for (const b of banned) console.log(`  ${b}`);
  console.log('');
}
if (review.length > 0) {
  console.log(`? review（色板外或需人工确认背景，不阻断）${review.length} 处：`);
  for (const r of review.slice(0, 40)) console.log(`  ${r}`);
  if (review.length > 40) console.log(`  …另有 ${review.length - 40} 处`);
  console.log('');
}

if (banned.length === 0) {
  console.log('✓ 全部小字号前景色通过 4.5:1（浅/深两组背景的最差组合）');
  process.exit(0);
}
console.log('提示：12px 是全场最小字号（P0 已清零任意字号），小字必须 ≥4.5:1；');
console.log('若是图标/装饰色误入同一 className，请把它移到不含 text-caption/text-xs 的串上。');
process.exit(1);
