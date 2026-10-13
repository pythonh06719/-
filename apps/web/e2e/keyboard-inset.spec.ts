import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 键盘遮挡修复的**几何验证**（e2e/keyboard-inset.spec.ts）。
 *
 * ## 为什么要有这个文件
 *
 * `4e3b089` 的修法是「visualViewport 差值 → CSS 变量 `--qsh-keyboard-inset` →
 * 抽屉容器 pb / 面板 max-h 消费」。单测（test/keyboard-inset.test.tsx）只能钉
 * 纯函数边界与「三个抽屉确实写了变量」——**jsdom 没有布局引擎，量不出几何**，
 * 所以修复后一直挂着「待真机复核」。
 *
 * 本文件用真实浏览器补上这一环：注入可控的 `visualViewport`（桌面 Chromium
 * 无法真弹软键盘，但公式链路、CSS 变量、布局消费全都是真的），断言面板
 * **真的**抬到了键盘上沿之上。
 *
 * ## 注入策略
 *
 * `addInitScript` 在页面脚本之前把 `window.visualViewport` 换成 mock ——
 * `main.tsx` 的 `initKeyboardInset()` 因此把监听挂到 mock 上，后续
 * `__kb.set()` 改高度并派发 resize，走的完全是生产路径。
 *
 * 覆盖 `visualViewport` 是否会影响别的模块？全仓只有 keyboard-inset.ts 用它。
 */

/**
 * 模拟 iPhone 软键盘高度（真实约 260~340）。
 *
 * ⚠️ 布局视口高**不写死**为 `devices['Pixel 7']` 的 915：Chromium 的移动模拟下
 * `window.innerHeight` 实际是 839（本轮实测），而修复用的正是 `innerHeight` ——
 * 硬编码会让断言与实现错位，故一律从页面里读。
 */
const KEYBOARD_HEIGHT = 344;
/** 模拟 Safari 地址栏显隐造成的收缩（约 60~90）—— **应当被阈值滤掉**。 */
const ADDRESS_BAR_SHRINK = 60;
/** 1px 容差：subpixel 与边框。 */
const EPS = 1;

/** 注入 mock visualViewport，必须在页面脚本之前执行。 */
async function installVisualViewportMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // `height` 未 override 时**跟随 `window.innerHeight`** —— 即「可视视口 = 布局视口」
    // 的无键盘状态。写死 915 会在移动模拟下让它与真实 `innerHeight` 差几十像素，
    // 初始化那一刻就算出一个假的 inset。
    const state = {
      width: 412,
      override: null as number | null,
      offsetTop: 0,
      pageTop: 0,
      scale: 1,
    };
    const listeners = new Map<string, Array<() => void>>();
    const vv = {
      get width() {
        return state.width;
      },
      get height() {
        return state.override ?? window.innerHeight;
      },
      get offsetTop() {
        return state.offsetTop;
      },
      get pageTop() {
        return state.pageTop;
      },
      get scale() {
        return state.scale;
      },
      addEventListener(type: string, fn: () => void): void {
        const arr = listeners.get(type) ?? [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      removeEventListener(type: string, fn: () => void): void {
        const arr = listeners.get(type) ?? [];
        const index = arr.indexOf(fn);
        if (index >= 0) arr.splice(index, 1);
      },
    };
    Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
    (window as unknown as { __kb: unknown }).__kb = {
      /** 设置可视视口高度 / 纵向平移，并派发 resize（生产路径与之一致）。 */
      set(height: number, offsetTop = 0): void {
        state.override = height;
        state.offsetTop = offsetTop;
        for (const fn of listeners.get('resize') ?? []) fn();
      },
    };
  });
}

/**
 * 等面板（及后代）的动画落定再量几何。
 *
 * 面板带 `animate-fade-in`，其 keyframes 含 `transform` —— 动画进行中
 * `boundingBox()` 拿到的是位移后的位置（本轮实测偏 3.4px，直接打红）。
 * ⚠️ 用 `race` 兜底：页面里有 `animate-pulse` 这类无限动画，
 * 干等 `finished` 会永远不 resolve。
 */
async function settle(locator: Locator): Promise<void> {
  await locator.evaluate(async (node) => {
    const animations = [node, ...Array.from(node.querySelectorAll('*'))].flatMap((el) =>
      el.getAnimations(),
    );
    await Promise.race([
      Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => {
        setTimeout(resolve, 800);
      }),
    ]);
  });
}

/** `/api/foods/mine` 的桩：一条本人自建食物（MyFoodsPage 只列自建）。 */
function stubMyFoods(page: Page): Promise<void> {
  return page.route('**/api/foods/mine', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 1,
            name: '外婆秘制红烧肉',
            namePinyin: null,
            aliases: [],
            category: '家常菜',
            kcalPer100g: 320,
            proteinGPer100g: 12,
            fatGPer100g: 26,
            carbGPer100g: 6,
            fiberGPer100g: null,
            sodiumMgPer100g: null,
            saturatedFatGPer100g: null,
            sugarGPer100g: null,
            calciumMgPer100g: null,
            ironMgPer100g: null,
            potassiumMgPer100g: null,
            vitaminDUgPer100g: null,
            b12UgPer100g: null,
            magnesiumMgPer100g: null,
            servingUnits: [{ unit: '克', grams: 100 }],
            defaultServingGrams: 100,
            barcode: null,
            source: 'user_custom',
            createdByUserId: 1,
            isVerified: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        error: null,
      }),
    }),
  ).then(() => undefined);
}

test.describe('软键盘弹起时底部抽屉的几何（iOS 布局视口不收缩）', () => {
  test('键盘 344px：面板整体抬到键盘上沿之上，且变量、max-h 同步', async ({ page }, testInfo) => {
    // 桌面端抽屉被 `sm:` 改成居中（无「贴底→被键盘压住」这回事），几何口径不同
    test.skip(testInfo.project.name !== 'mobile-chrome', '仅移动端（桌面抽屉居中）');
    await installVisualViewportMock(page);
    await stubMyFoods(page);

    await page.goto('/settings/foods');
    await page.getByTestId('my-food-edit-1').click();
    const dialog = page.getByTestId('edit-food-dialog');
    await expect(dialog).toBeVisible();
    const panel = dialog.locator('> div');
    await expect(panel).toBeVisible();

    // 修复用的是 `window.innerHeight`，断言就照它算（移动模拟下 ≠ viewport 高度）
    const layoutHeight = await page.evaluate(() => window.innerHeight);

    // ① 无键盘：变量为 0，面板底边贴在视口底
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--qsh-keyboard-inset').trim(),
        ),
      )
      .toBe('0px');
    await settle(panel);
    const before = await panel.boundingBox();
    expect(before).not.toBeNull();
    expect(before!.y + before!.height).toBeLessThanOrEqual(layoutHeight + EPS);

    // ② 键盘弹起（可视视口比布局视口矮 344）：走 init 注册的真实 resize 路径
    await page.evaluate((shrunk) => {
      (window as unknown as { __kb: { set: (h: number, o?: number) => void } }).__kb.set(shrunk);
    }, layoutHeight - KEYBOARD_HEIGHT);

    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--qsh-keyboard-inset').trim(),
        ),
      )
      .toBe(`${KEYBOARD_HEIGHT}px`);

    await settle(panel);
    const after = await panel.boundingBox();
    expect(after).not.toBeNull();

    // ★ 核心断言：面板底边不得越过键盘上沿（布局视口 − 键盘 344）
    expect(after!.y + after!.height).toBeLessThanOrEqual(layoutHeight - KEYBOARD_HEIGHT + EPS);
    // 面板确实被抬高了（底边上移量 = 键盘高度，容差 2px）
    expect(before!.y + before!.height - (after!.y + after!.height)).toBeGreaterThan(
      KEYBOARD_HEIGHT - 2,
    );
    // 面板自身被 max-h 压短：不再有半截沉在键盘底下
    expect(after!.height).toBeLessThan(before!.height);

    // ③ max-h 真的按变量算（88vh − 344）
    const maxHeight = await panel.evaluate((node) => getComputedStyle(node).maxHeight);
    expect(parseFloat(maxHeight)).toBeCloseTo(layoutHeight * 0.88 - KEYBOARD_HEIGHT, 0);
  });

  test('地址栏显隐（收缩 60px）不误判为键盘：抽屉纹丝不动', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', '仅移动端（桌面抽屉居中）');
    await installVisualViewportMock(page);
    await stubMyFoods(page);

    await page.goto('/settings/foods');
    await page.getByTestId('my-food-edit-1').click();
    const panel = page.getByTestId('edit-food-dialog').locator('> div');
    await expect(panel).toBeVisible();
    await settle(panel);
    const before = await panel.boundingBox();
    const layoutHeight = await page.evaluate(() => window.innerHeight);

    await page.evaluate(
      ({ shrunk }) => {
        (window as unknown as { __kb: { set: (h: number, o?: number) => void } }).__kb.set(shrunk);
      },
      { shrunk: layoutHeight - ADDRESS_BAR_SHRINK },
    );

    // 阈值 150px 滤掉了 60px 的地址栏抖动
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--qsh-keyboard-inset').trim(),
        ),
      )
      .toBe('0px');

    await settle(panel);
    const after = await panel.boundingBox();
    expect(after).not.toBeNull();
    expect(before).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(EPS);
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(EPS);
  });
});
