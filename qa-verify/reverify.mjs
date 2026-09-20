// Round-2 re-verification after the P2-1 timing fix.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = 'http://127.0.0.1:3000/';
const OUT = 'C:/Users/18049/WorkBuddy/2026-09-12-10-33-46/ui-shots';
fs.mkdirSync(OUT, { recursive: true });

const INIT = () => {
  window.__qa = {
    navStart: performance.now(),
    saw: false,
    tFade: null,
    scalesAtFade: null,
    tAllGrown: null,
    tRemoved: null,
    maxScales: [0, 0, 0, 0, 0, 0, 0],
  };
  const scale = (el) => {
    const m = getComputedStyle(el).transform;
    if (m === 'none') return 1;
    const p = m.match(/matrix\(([^)]+)\)/);
    return p ? +p[1].split(',')[3] : 1;
  };
  const scales = () => {
    const s = document.getElementById('qsh-splash');
    return s ? [...s.querySelectorAll('.qsh-grow')].map(scale) : [];
  };
  const attach = () => {
    const el = document.getElementById('qsh-splash');
    if (!el) return setTimeout(attach, 5);
    const mo = new MutationObserver(() => {
      if (window.__qa.tFade === null && el.classList.contains('qsh-splash--out')) {
        window.__qa.tFade = performance.now();
        window.__qa.scalesAtFade = scales();
      }
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  };
  attach();
  const loop = () => {
    const el = document.getElementById('qsh-splash');
    if (el) {
      window.__qa.saw = true;
      const s = scales();
      s.forEach((v, i) => {
        if (v > window.__qa.maxScales[i]) window.__qa.maxScales[i] = v;
      });
      if (window.__qa.tAllGrown === null && s.length && s.every((v) => v >= 0.999)) {
        window.__qa.tAllGrown = performance.now();
      }
      requestAnimationFrame(loop);
      return;
    }
    if (window.__qa.saw) {
      window.__qa.tRemoved = performance.now();
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

const browser = await chromium.launch();
const results = {};

async function run(name, { reducedMotion, throttle, secondLoad, jsBlocked } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(reducedMotion ? { reducedMotion } : {}),
  });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  if (jsBlocked) await page.route('**/assets/index-*.js', (r) => r.abort());

  let cdp = null;
  if (throttle) {
    cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (throttle.network) await cdp.send('Network.emulateNetworkConditions', throttle.network);
    if (throttle.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle.cpu });
  } else if (throttle === undefined && secondLoad === undefined) {
    // nothing
  }

  let wallStart = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const wallDomReady = Date.now() - wallStart;

  let wallRemoved = null;
  if (jsBlocked) {
    await page.waitForTimeout(1500);
  } else {
    await page.waitForFunction(() => document.getElementById('qsh-splash') === null, null, { timeout: 15000 });
    wallRemoved = Date.now() - wallStart;
    await page.waitForTimeout(60); // let the rAF loop settle
  }

  const qa = await page.evaluate(() => window.__qa);
  const domState = await page.evaluate(() => ({
    splashInDom: !!document.getElementById('qsh-splash'),
    rootChildren: document.getElementById('root')?.children.length ?? null,
  }));

  // if secondLoad requested, do a warm reload in the same context and measure again
  let warm = null;
  if (secondLoad) {
    await page.evaluate(() => {
      window.__qa = null;
    }).catch(() => {});
    await page.addInitScript(INIT);
    const t = Date.now();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('qsh-splash') === null, null, { timeout: 15000 });
    const w = Date.now() - t;
    const q2 = await page.evaluate(() => window.__qa);
    warm = { wallMs: w, removedPerf: q2 ? q2.tRemoved : null, allGrown: q2 ? q2.tAllGrown : null };
  }

  results[name] = {
    wallDomReadyMs: wallDomReady,
    wallRemovedMs: wallRemoved,
    removedPerfMs: qa ? +(qa.tRemoved ?? NaN).toFixed(1) : null,
    fadeAtPerfMs: qa ? (qa.tFade == null ? null : +qa.tFade.toFixed(1)) : null,
    allGrownAtPerfMs: qa ? (qa.tAllGrown == null ? null : +qa.tAllGrown.toFixed(1)) : null,
    scalesAtFade: qa ? qa.scalesAtFade : null,
    minScaleAtFade: qa && qa.scalesAtFade ? +Math.min(...qa.scalesAtFade).toFixed(3) : null,
    maxScales: qa ? qa.maxScales.map((v) => +v.toFixed(3)) : null,
    domState,
    warm,
  };
  await ctx.close();
}

await run('A_default_fresh');
await run('B_cacheDisabled_cpu4x_slow4G', {
  throttle: {
    cpu: 4,
    network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  },
});
await run('C_warm_reload_sameContext', { secondLoad: true });
await run('D_reduced_motion_real');

// reduced motion, JS blocked -> static composition full-size?
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.route('**/assets/index-*.js', (r) => r.abort());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#qsh-splash', { timeout: 8000 });
  await page.waitForTimeout(1200);
  results.E_reducedMotion_static = await page.evaluate(() => {
    const s = document.getElementById('qsh-splash');
    const grow = [...s.querySelectorAll('.qsh-grow')].map((el) => {
      const r = el.getBoundingClientRect();
      return { h: +r.height.toFixed(1), anim: getComputedStyle(el).animationName, transform: getComputedStyle(el).transform };
    });
    return {
      grow,
      allHeightsPositive: grow.every((g) => g.h > 0),
      allAnimNone: grow.every((g) => g.anim === 'none'),
      allTransformNone: grow.every((g) => g.transform === 'none'),
      brandOpacity: getComputedStyle(s.querySelector('.qsh-brand')).opacity,
    };
  });
  await page.screenshot({ path: `${OUT}/splash-05-after-fix-reduced-motion.png` });
  await ctx.close();
}

await browser.close();
fs.writeFileSync('qa-verify/reverify.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
