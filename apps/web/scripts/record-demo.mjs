#!/usr/bin/env node
/**
 * 录制简历动图：跑 Playwright smoke 场景并输出 GIF。
 * 产物：docs/e2e-demo.gif（可直接嵌 README）
 *
 * 依赖：npm i -D playwright @playwright/test gif-encoder-2 -w @qsh/web && npx playwright install chromium
 * 运行：node apps/web/scripts/record-demo.mjs
 */
import { chromium, devices } from 'playwright';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../../../docs/e2e-demo.gif');

const FPS = 8;
const DURATION_MS = 12_000;
const FRAME_INTERVAL = Math.floor(1000 / FPS);

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices['Pixel 7'], // 移动端优先产品，动图用手机视口更有说服力
  recordVideo: { dir: '/tmp/e2e-video', size: { width: 412, height: 915 } },
});
const page = await context.newPage();

await page.goto(process.env.E2E_BASE_URL ?? 'http://localhost:5173', { waitUntil: 'networkidle' });

// 演示脚本：滚动展示落地页 → 填写计算器 → 计算
await page.waitForTimeout(1500);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(1000);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(1000);

const age = page.getByLabel(/年龄/).or(page.getByRole('spinbutton').first());
if (await age.count()) {
  await age.fill('28');
  await page.waitForTimeout(400);
  await page.getByLabel(/身高/).fill('175');
  await page.waitForTimeout(400);
  await page.getByLabel(/体重/).fill('70');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /计算/ }).click();
  await page.waitForTimeout(2500);
}

const video = await page.video();
await context.close();
await browser.close();

if (!video) {
  console.error('未生成视频（playwright video 未启用）');
  process.exit(1);
}
const videoPath = await video.path();

// 视频 → GIF（ffmpeg 若可用直接转，否则用 gifenc 逐帧）
const { execSync } = await import('node:child_process');
mkdirSync(dirname(OUT), { recursive: true });
try {
  execSync(
    `ffmpeg -y -i "${videoPath}" -vf "fps=${FPS},scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${OUT}"`,
    { stdio: 'inherit' },
  );
  console.log(`GIF written: ${OUT}`);
} catch {
  console.error('ffmpeg 不可用；请安装 ffmpeg 后重跑，或用 playwright video（webm）直接嵌入 README');
  process.exit(1);
}
