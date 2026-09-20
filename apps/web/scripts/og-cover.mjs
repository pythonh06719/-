/**
 * 生成社交分享封面（public/og-cover.png，1200×630）。
 *
 * 花园与品牌徽标**直接从 index.html 抽取**，不重画 —— 这样封面与 App 视觉永远同步；
 * 花园改版后重跑本脚本即可（`node scripts/og-cover.mjs`）。
 *
 * 依赖：仓库内的 playwright（已随 devDependencies 安装，无需额外下载浏览器）。
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const INDEX_HTML = fileURLToPath(new URL('../index.html', import.meta.url));
const OUT_PNG = fileURLToPath(new URL('../public/og-cover.png', import.meta.url));

const source = await readFile(INDEX_HTML, 'utf8');

/** 花园装饰 SVG（index.html 内唯一的 viewBox="0 0 400 220"）。 */
const garden = source.match(/<svg viewBox="0 0 400 220"[\s\S]*?<\/svg>/)?.[0];
/** 品牌徽标 SVG。 */
const logo = source.match(/<svg class="qsh-logo"[\s\S]*?<\/svg>/)?.[0];

if (garden === undefined || logo === undefined) {
  throw new Error('未能从 index.html 抽取花园或徽标 SVG —— 选择器可能已失效，请检查 index.html。');
}

const card = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1200px;height:630px;overflow:hidden}
  body{position:relative;display:flex;background:#f0f7f4;
       font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif}
  .left{position:relative;z-index:2;width:700px;padding-left:88px;
       display:flex;flex-direction:column;justify-content:center;gap:28px}
  /* 徽标 SVG 自 index.html，其 class 是 qsh-logo（不是 logo）—— 选择器必须同名，否则会按默认尺寸撑满容器 */
  .qsh-logo{display:block;width:80px;height:80px}
  h1{font-size:66px;font-weight:600;letter-spacing:.1em;color:#0f3a2e;line-height:1}
  .sub{font-size:27px;color:#1c6a51;line-height:1.5}
  .chips{display:flex;gap:12px;flex-wrap:wrap}
  .chip{font-size:19px;color:#155040;background:#d9ede4;border-radius:9999px;padding:11px 22px}
  .garden{position:absolute;right:-10px;bottom:-4px;width:620px}
  .garden svg{display:block;width:100%;height:auto}
</style></head><body>
  <div class="left">
    ${logo}
    <h1>轻生活</h1>
    <p class="sub">让好的生活习惯让你变轻</p>
    <div class="chips">
      <span class="chip">科学热量预算</span>
      <span class="chip">3 次点击记一餐</span>
      <span class="chip">无负罪感设计</span>
    </div>
  </div>
  <div class="garden">${garden}</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(card, { waitUntil: 'load' });
// 封面是静态构图：花园在 index.html 中带 .qsh-grow（scaleY 0→1）动画类，
// 但本页未引入那些 keyframes，故元素按原尺寸渲染 —— 无需等待动画结束。
await page.screenshot({ path: OUT_PNG });
await browser.close();

// 仅报告体积，便于确认没有异常膨胀（封面应远小于 300KB）
const { size } = await stat(OUT_PNG);
console.log(`✓ 已生成 ${OUT_PNG}（${(size / 1024).toFixed(1)} KB）`);
