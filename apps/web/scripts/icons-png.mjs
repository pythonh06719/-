/**
 * 从 public/icons/*.svg 栅格化出 PWA 位图图标（PNG）。
 *
 * 为什么需要：iOS Safari 的 apple-touch-icon **不支持 SVG**（只认 PNG），
 * 不给 PNG 时「添加到主屏幕」只能拿页面截图；manifest 里只有 SVG 条目时，
 * Android/Chrome 的安装提示与 Lighthouse 检查也不稳妥。PNG 192/512 是通用基线。
 *
 * 设计以 public/icons/*.svg 为唯一真源，本脚本只做栅格化 —— 改设计请改 SVG 后重跑：
 *   node scripts/icons-png.mjs
 *
 * 依赖：仓库内的 playwright（devDependencies，浏览器随包自带，无需额外下载）。
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ICONS_DIR = fileURLToPath(new URL('../public/icons', import.meta.url));

/** [源 SVG, 输出 PNG, 边长][] —— 全量重跑幂等。 */
const RENDERS = [
  // 常规图标：manifest `purpose: any`（favicon / 安装提示 / Lighthouse 192/512 基线）
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  // iOS 主屏幕图标：apple-touch-icon 只认 PNG；SVG 自带圆角与 iOS 的 squircle
  // 遮罩半径几乎一致（22.9% vs ~22.4%），直接栅格化即可，无需另出全出血变体
  ['icon.svg', 'apple-touch-icon.png', 180],
  // maskable：Android 自适应图标（整块裁切），全出血 + 内容收在安全区内
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
];

const browser = await chromium.launch();
try {
  for (const [svgName, pngName, size] of RENDERS) {
    const svg = await readFile(`${ICONS_DIR}/${svgName}`, 'utf8');
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><style>
           *{margin:0;padding:0}
           html,body{width:${size}px;height:${size}px;overflow:hidden}
           svg{display:block;width:100%;height:100%}
         </style></head><body>${svg}</body></html>`,
        { waitUntil: 'load' },
      );
      await page.screenshot({ path: `${ICONS_DIR}/${pngName}` });
    } finally {
      await page.close();
    }
    const { size: bytes } = await stat(`${ICONS_DIR}/${pngName}`);
    console.log(`✓ ${svgName} → ${pngName}（${size}×${size}，${(bytes / 1024).toFixed(1)} KB）`);
  }
} finally {
  await browser.close();
}
