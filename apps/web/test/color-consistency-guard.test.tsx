/**
 * 颜色一致性护栏（tasks 145）：① `/exercise` 不再出现孤儿冷蓝 `sky-*`；② `SafetyBanner` 的
 * coral 只作描边与文字、不再糊满整块底。
 *
 * ## 为什么要「防回灌」测试
 *
 * `sky-*` 曾在 `/exercise` 出现 4 处（进度填充 + 两个主按钮 + 快捷反馈文字），是全站唯一的
 * 冷蓝 —— 只出现在饮水模块，视觉上像「另一个产品」。接品牌色后若没有机械可查的断言，
 * 下一个新页面很容易顺手写下 `bg-sky-500`（Tailwind 内置色，不缺不缺、不会报错、不会被告警），
 * 于是不一致悄悄长回来。故本文件断言的是**类名本身**，不依赖渲染上下文。
 *
 * 另注：`sky` 是 Tailwind 内置色板，`tailwind.config.ts` 未扩展它 —— 也就是说它**不是**项目
 * 刻意选的语义色，而是「手滑就用」的默认色。断言 `not.toContain('sky-')` 因此是安全的：
 * 项目没有任何一处合法需要 sky。
 *
 * ## 手法
 *
 * - ① 用**真实渲染**（渲染 `ExercisePage` 后取 `innerHTML`）—— 覆盖 JSX 里所有 class 来源，
 *   比读源码更贴近「用户真正看到的」；
 * - ② 另用 `readFileSync` **递归扫全量 `.tsx`**，兜住「写在模板字符串 / 拼接 className 里、
 *   当前数据路径没走到」的情况；
 * - ③ `SafetyBanner` 断言的是**结构约束**（底色必须不是 coral、文字必须仍是 coral），
 *   而非「必须等于某个具体色值」—— 前者是本轮的设计意图（coral 保留但只落在边与字），
 *   后者会把实现细节冻死。
 *
 * ## ⚠️ 这条守卫曾经是**假绿**（2026-10-07 修）
 *
 * 原实现是**硬编码 4 个文件**的 `readSrc`（ExercisePage / WaterGoalCard / DashboardPage /
 * SafetyBanner），用例名却写着「**全仓** src 不应再有 sky-*」。而 `src/` 下共 59 个 `.tsx`。
 * 已实跑证实的假绿：往**不在列表**的 `pages/weight/WeightPage.tsx` 注入 `bg-sky-500`，
 * 本守卫 **5/5 全绿**；往列表内的 `ExercisePage.tsx` 注入才恰好 3 例转红。
 *
 * 讽刺之处正在本文件自己的注释里：它写「下一个新页面很容易顺手写下 `bg-sky-500`」——
 * 而**新页面恰恰全在覆盖范围之外**。从 5 个页面涨到 59 个，守卫一次都没扩展过。
 *
 * 现改为与 `surface-dark-ring-guard.test.ts` / `secondary-text-contrast.test.ts` 同一套
 * `readdirSync` 递归遍历（见 {@link collectTsx}），并加**自证断言**堵死「一个文件都没扫到」
 * 这条假绿路径。**不再手工维护文件列表** —— 那是本缺陷的根因。
 *
 * ## 扫描口径：`sky-` 带连字符，不是裸 `sky`
 *
 * 裸 `sky` 会误报：`lib/copy.ts` 的 `riskyGroupNotice`、以及引用它的 `OnboardingPage.tsx`
 * 都含子串 `sky`。只有带连字符的 `sky-`（Tailwind 色号形态 `sky-500` / `text-sky-700`）
 * 才是要拦的孤儿冷蓝。当前实测：裸 `sky` 命中 2 处（全是误报），`sky-` 命中 0 处。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import ExercisePage from '@/pages/exercise/ExercisePage';
import SafetyBanner from '@/components/feedback/SafetyBanner';

const SRC_ROOT = resolve(process.cwd(), 'src');

/**
 * 读源码。路径以 **cwd** 为基准（vitest 从 `apps/web` 跑）——
 * 不能用 `import.meta.url`：本项目 vitest 下它会解析成盘符根（`C:\`），拼不出 `src/`。
 */
const readSrc = (rel: string): string => readFileSync(resolve(SRC_ROOT, rel), 'utf8');

/**
 * 递归列出 `src/` 下所有 `.tsx`（手写遍历，不引 glob 依赖）。
 *
 * 与 `surface-dark-ring-guard.test.ts` / `secondary-text-contrast.test.ts` 同一形状。
 * **这是本守卫从「假绿」变成真覆盖的关键**：原先的 4 条硬编码路径只覆盖 59 个文件里的 4 个。
 */
function collectTsx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTsx(full));
    } else if (entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/** 绝对路径 → 以 `/` 分隔的 `src/` 相对路径（保证报错信息跨平台可读）。 */
function relOf(abs: string): string {
  return abs.slice(SRC_ROOT.length + 1).replace(/\\/g, '/');
}

interface SkyHit {
  readonly relPath: string;
  readonly line: number;
  readonly text: string;
}

/**
 * 扫一个文件里所有含 `sky-` 的行。
 *
 * 只取**整行**而非精确到列，是刻意的：孤儿冷蓝既可能是 `bg-sky-500`，
 * 也可能藏在 `className={[ … ].join(' ')}` 的跨行数组里；按行抓文本足以定位到人，
 * 且能顺带覆盖拼接写法（按精确的 className 块扫反而会漏跨行数组）。
 */
function scanSky(abs: string): SkyHit[] {
  const relPath = relOf(abs);
  const hits: SkyHit[] = [];
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      if (raw.includes('sky-')) {
        hits.push({ relPath, line: index + 1, text: raw.trim() });
      }
    });
  return hits;
}

/** ExercisePage 会发的请求（与 `water-goal-edit.test.tsx` 同一套桩）。 */
function stubFetch(): void {
  const ok = (data: unknown): Response =>
    ({ ok: true, status: 200, json: async () => ({ data, error: null }) }) as unknown as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/water')) {
        // 750/2000 = 38%：让进度填充真的有一段宽度，便于断言填充元素存在
        return ok({ date: '2026-10-04', totalMl: 750, goalMl: 2000, logs: [] });
      }
      if (url.includes('/api/exercises')) {
        return ok({ date: '2026-10-04', logs: [], totalKcal: 0 });
      }
      throw new Error(`测试桩未覆盖的请求：${url}`);
    }),
  );
}

function renderExercise(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/exercise']}>
        <ExercisePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('① 孤儿冷蓝 sky-* 已从全站清除（防回灌）', () => {
  // 全量扫描：递归 `src/` 下所有 `.tsx`（原先只扫 4 个硬编码文件 → 假绿）
  const files = collectTsx(SRC_ROOT);
  const offenders = files.flatMap(scanSky);

  it('★ 自证：扫描器真的扫到了 .tsx（否则下面全是假绿）', () => {
    // 这条不是业务断言，是**守卫自身的健康检查**：
    // 若 cwd 不对（忘记从 apps/web 跑）或遍历逻辑坏了，files 会是空数组，
    // 下一条 `toEqual([])` 会永远通过 —— 用断言把「假绿」这条路堵死。
    // 阈值刻意宽松：这里要挡的是「一个都没扫到」，不是给数量设下限。
    expect(files.length).toBeGreaterThan(20);
    // 关键：必须**超过原先硬编码的 4 个**，否则等于退回旧行为。
    expect(files.length).toBeGreaterThan(4);
    // 还要确认「列到文件名」= 「真读到了内容」：若路径算出来了但读回空串
    // （编码/路径异常等），下一条 `toEqual([])` 照样假绿。
    const totalChars = files.reduce((sum, abs) => sum + readFileSync(abs, 'utf8').length, 0);
    expect(totalChars).toBeGreaterThan(10000);
  });

  it('渲染 /exercise 后页面里不出现任何 sky-* 类名', async () => {
    stubFetch();
    const container = renderExercise();

    // 等数据到货，务必落在「喝水」卡已渲染之后（wait 锚点 = 进度条，与被测行为无关）
    await waitFor(() => {
      expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    });

    expect(container.innerHTML).not.toContain('sky-');
  });

  it('/exercise 源码里也不再出现 sky-*（兜住未走到分支 / 拼接 className）', () => {
    for (const rel of ['pages/exercise/ExercisePage.tsx', 'pages/exercise/WaterGoalCard.tsx']) {
      expect(readSrc(rel), `${rel} 不应再含 sky-*`).not.toContain('sky-');
    }
  });

  it('★ 反向：全仓 src 不应再有 sky-* 孤儿色（递归全量扫描，不是几个页面）', () => {
    // 机械可查的规则：`sky` 未在 tailwind.config.ts 扩展，是 Tailwind 内置色。
    // 项目刻意选的语义色只有 brand / coral / warm / cream / slate，故 src 里不应再出现 sky-。
    //
    // 报出 `文件:行号 + 原文` 而不是只报文件名：孤儿冷蓝长回来时，
    // owner 需要能直接定位到那一行，而不是再手工 grep 一遍。
    expect(
      offenders.map((o) => `${o.relPath}:${o.line}  ${o.text}`),
      '这些位置出现了 Tailwind 内置冷蓝 sky-*（项目语义色里没有 sky，应改用 brand）',
    ).toEqual([]);
  });
});

describe('② SafetyBanner：coral 只落在描边与文字，不糊满底（调性收口）', () => {
  it('★ 块底色不是 coral 底；描边与文字仍是 coral（语义不丢）', () => {
    const { container } = render(
      <SafetyBanner safetyMessages={['这已接近安全下限，建议把目标调得更温和一些']} />,
    );
    const banner = screen.getByRole('status');
    const cls = (banner as HTMLElement).className;

    // 底色不再是 coral-50 / coral-900（那层底与页面底对比度仅 1.00:1，等于没有，
    // 却让描边被迫独自承重 → 成为全站最刺眼元素）
    expect(cls).not.toContain('bg-coral-50');
    expect(cls).not.toContain('bg-coral-900');
    // 描边仍是 coral：coral 是项目为「接近上下限」刻意保留的语义色，不删
    expect(cls).toContain('border-coral-');

    // 文字仍是 coral 系
    const text = container.textContent ?? '';
    expect(text).toContain('这已接近安全下限');
    expect(container.innerHTML).toContain('text-coral-');
  });

  it('★ 仍是「有描边的独立块」—— 降低刺眼 ≠ 降低可读性', () => {
    const { container } = render(
      <SafetyBanner safetyMessages={['这已接近安全下限，建议把目标调得更温和一些']} />,
    );
    const cls = (screen.getByRole('status') as HTMLElement).className;

    // 块必须仍有边界：若把描边也换掉，这块内容就没有任何区域信号了
    expect(cls).toContain('border');
    // 文字对比度靠文字本身承载（实测 7.99:1 浅 / 9.37:1 深），不能降级成 slate 系
    expect(container.innerHTML).not.toContain('text-slate-6');
  });
});
