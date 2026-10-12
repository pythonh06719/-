import type { ReactElement } from 'react';

/**
 * 一个「术语 → 数值」的定义行。
 *
 * 布局说明（可解释性红线：公式必须完整可读，不能被容器裁掉）：
 * 原来是 `flex items-baseline justify-between` + `<dd className="shrink-0">`。
 * `shrink-0` 让公式拒绝收缩，按 max-content 定宽（如「女性」行 315px），
 * 而窄屏（390px 视口）该行可用宽度只有 278px → `<dd>` 溢出 `<dl>` 约 47px，
 * 末尾 `− 161` 落到视口外，被 `styles/index.css` 的 `body { overflow-x: hidden }`
 * **静默裁掉且不产生横向滚动条**。用户因此看不到完整计算式 —— 属于 NFR-11 红线破损。
 *
 * 现在改为「能并排就并排，放不下就让值换到下一行」：
 *   - `flex-wrap` + `gap-x-3 gap-y-1`：放不下时值独占一行，不再溢出
 *   - `dt` 的 `min-w-[5.5rem]`：给术语一个下限，避免长值挤占后术语被压成「一字一行」的竖排
 *   - `dd` 去掉 `shrink-0`，改 `min-w-0` + 任意值 `overflow-wrap: anywhere`：
 *     允许在任意位置断行，是「逐字完整可读」的技术前提（仅 `break-word` 在长串时不生效）
 * 宽屏放得下时仍是原来的「术语左、值右」两列对齐观感（`justify-between` 未动），属渐进降级
 * 而非无条件堆叠。实测 390px：溢出行19→0、文档宽 516→390、术语折行 46/150→1/150。
 *
 * 2026-10-12（P2-4 注册表化）：从 `WhyNumbersPage.tsx` 抽出到本文件 ——
 * 26 条条目里有 24 条用它，抽出来后各条目组件才能共享同一套断行契约
 * （`test/why-numbers-toc.test.tsx` 的「公式完整可读」四组断言即钉在这里）。
 */
export default function DerivationRow({
  term,
  value,
  hint,
}: {
  term: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-100 py-2 last:border-b-0 dark:border-slate-700">
      <dt className="min-w-[5.5rem] text-sm text-slate-600 dark:text-slate-300">
        {term}
        {hint !== undefined && (
          <span className="ml-2 text-xs text-slate-600 dark:text-slate-300">{hint}</span>
        )}
      </dt>
      <dd className="qsh-tnum min-w-0 text-sm font-semibold text-slate-800 [overflow-wrap:anywhere] dark:text-slate-100">
        {value}
      </dd>
    </div>
  );
}
