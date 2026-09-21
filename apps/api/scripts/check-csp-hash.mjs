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
const NGINX_CONF = resolve(REPO_ROOT, 'infra/nginx/default.conf');

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

/**
 * 两处 CSP 声明都必须放行同一段内联脚本：
 * - `apps/api/src/main.ts`   → 单 URL 部署（API 直接伺服 HTML）
 * - `infra/nginx/default.conf` → Docker 部署（nginx 伺服 HTML）
 * 漏掉任何一处，对应部署形态下深色主题预置都会静默失效。
 */
const TARGETS = [
  { file: MAIN_TS, label: 'apps/api/src/main.ts', hint: '把 helmet 的 script-src 换成上面「期望」的值' },
  {
    file: NGINX_CONF,
    label: 'infra/nginx/default.conf',
    hint: '把 nginx CSP 里的 script-src 换成上面「期望」的值',
  },
];

let failed = false;
for (const { file, label, hint } of TARGETS) {
  const text = readFileSync(file, 'utf-8');
  if (text.includes(hash)) {
    console.log(`  ✓ ${label}`);
    continue;
  }
  failed = true;
  console.error(`  ✗ ${label}：hash 未同步。`);
  const declared = text.match(/'sha256-[A-Za-z0-9+/=]+'/)?.[0] ?? '(未找到)';
  console.error(`      期望（当前脚本）：${hash}`);
  console.error(`      该文件里是：      ${declared}`);
  console.error(`      处理：${hint}。`);
  console.error('      影响：该部署形态下内联主题脚本被 CSP 拦掉，深色用户首屏闪浅色。');
}

if (failed) {
  process.exit(1);
}

console.log(`✅ CSP hash 一致（两处声明，${hash}）`);
