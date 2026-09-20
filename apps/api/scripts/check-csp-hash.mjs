/**
 * CSP hash 一致性门禁（apps/api/scripts/check-csp-hash.mjs）。
 *
 * 背景：`apps/web/index.html` 里有一段「首屏前预置深色主题」的内联脚本，靠它防止深色用户
 * 先看到浅色再翻深（FOUC）。单 URL 部署下 HTML 由 API 同源伺服，`helmet()` 的默认
 * `script-src 'self'` 会**连带拦掉**这段脚本 —— 表现为「深色主题预置静默失效、开头闪一下浅色」，
 * 且在本地 dev（HTML 走 Vite、无 CSP）完全看不出来。
 *
 * 修法是 hash 白名单（见 `src/main.ts` 的 helmet 配置），但 hash 与脚本内容**逐字节绑定**：
 * 任何人改动那段脚本（哪怕只加一个空格）都会让线上 hash 失配，CSP 重新拦掉，且**不会报错**。
 * 所以本脚本把这个隐式耦合升级为**构建期门禁**：失配直接 CI 红。
 *
 * 用法：
 *   node apps/api/scripts/check-csp-hash.mjs            # 校验（CI 用），失配退出码 1
 *   node apps/api/scripts/check-csp-hash.mjs --print    # 打印当前应写入 main.ts 的 hash
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../..');
const INDEX_HTML = resolve(REPO_ROOT, 'apps/web/index.html');
const MAIN_TS = resolve(REPO_ROOT, 'apps/api/src/main.ts');

/** 取出 index.html 中第一段无属性的内联 `<script>`（即主题预置脚本）。 */
function extractInlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (match === null) {
    throw new Error(`未在 ${INDEX_HTML} 找到内联 <script> —— 选择器可能已失效。`);
  }
  return match[1];
}

const html = readFileSync(INDEX_HTML, 'utf-8');
const script = extractInlineScript(html);
const hash = `sha256-${createHash('sha256').update(script, 'utf-8').digest('base64')}`;

if (process.argv.includes('--print')) {
  console.log(hash);
  process.exit(0);
}

const mainTs = readFileSync(MAIN_TS, 'utf-8');

if (!mainTs.includes(hash)) {
  console.error('✗ CSP hash 失配：index.html 的内联脚本已变更，但 main.ts 里的 hash 未同步。');
  console.error(`  期望（当前脚本）：${hash}`);
  const declared = mainTs.match(/'sha256-[A-Za-z0-9+/=]+'/)?.[0] ?? '(未找到)';
  console.error(`  实际（main.ts）：  ${declared}`);
  console.error('  处理：把 main.ts 中 helmet 的 script-src 换成上面「期望」的值。');
  console.error('  影响：不改则该内联脚本会被 CSP 拦掉，深色主题预置静默失效（首屏闪浅色）。');
  process.exit(1);
}

console.log(`✅ CSP hash 一致（${hash}）`);
