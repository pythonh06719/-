import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import BottomNav from './BottomNav';
import BrandDecor from '@/components/common/BrandDecor';
import { useTheme } from '@/theme/useTheme';
import { energyLabel, useUnitStore, weightLabel } from '@/lib/units';
import { COPY } from '@/lib/copy';
import { flushQueue, queueLength, subscribeQueue } from '@/pwa/offline-queue';

/**
 * 应用外壳（components/layout/AppShell.tsx）。
 *
 * - 移动端：顶部标题栏 + 底部导航；桌面端：内容居中，导航转为胶囊条（响应式）
 * - 全局开关：深色模式（跟随系统 / 手动）、热量单位 kcal ↔ kJ
 * - 无障碍：跳过导航链接、`main` 语义区、离线状态 `aria-live` 提示（TC-48）
 * - **不发任何用户未开启的通知**（NFR-10）
 * - **GAP-9**：顶部横幅同时承载「离线」与「N 笔待同步」两件事（见 `OfflineSyncBanner`）
 * - **C-6**：`wide` 页面（今天 / 变化 / 周报）在 ≥1024px（`lg`）放宽内容列宽，容纳多栏布局
 */

export interface AppShellProps {
  /** 页面内容 */
  children: ReactNode;
  /** 顶栏标题（缺省「轻生活」） */
  title?: string;
  /**
   * 宽屏（≥1024px）放宽内容列宽（C-6）。
   *
   * - `false`（默认）：`main` 恒为 `max-w-3xl`，与改动前逐字节一致 —— 移动端优先是产品定位，
   *   大多数单栏页面在桌面也保持这条舒适阅读宽度（过宽会让正文行长得难读）。
   * - `true`：**仅在 `lg:` 断点**额外加 `lg:max-w-6xl`，供少数信息密度高的页面（今天 / 变化 / 周报）
   *   在桌面摊成两栏 / 三栏。移动端（`<1024px`）一行不变。
   *
   * ⚠️ 刻意**不**全局放宽：那会让 /why-numbers 这类长文页面在桌面变成超宽长行，属于「全站重排」，
   * 与 C-6「只做信息密度最高的 2~3 个页面」的收敛要求相冲突。故按页开启。
   */
  wide?: boolean;
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

/** 同步横幅的可见状态（渲染用，与 `copy.ts` 的文案一一对应）。 */
type SyncNotice = 'none' | 'offline' | 'offlinePending' | 'syncing' | 'dropped';

/**
 * 待同步条数的可见状态机（纯函数，便于单测与推演）。
 *
 * 输入只有三个事实：是否联网、队列里还有几条、这轮同步有没有记录被丢弃。
 * 输出唯一一个要渲染的状态 —— 五者互斥，**不会**出现「离线」与「已同步」同时显示。
 *
 * | online | pending | hasDropped | 结果 | 说明 |
 * |---|---|---|---|---|
 * | 否 | ≥0 | — | `offline` | 断网：队列条数由副行（`offline*days`）另行提示，见下 |
 * | 是 | >0 | — | `dropped`/`syncing` | 联网后仍在排队：先告知丢失（若本轮发生过），否则说「正在同步」 |
 * | 是 | 0 | 是 | `dropped` | 联网、队列已空，但这一轮丢过记录 → 给一个软着陆的说明 |
 * | 是 | 0 | 否 | `none` | 无事发生：横幅**整块不渲染**（不占位、不写「已同步」常驻文案） |
 *
 * ⚠️ `hasDropped` 只在**队列已空**时才被采纳：队列还有货时「正在同步」更重要，
 * 丢失提示留到收尾那一刻说，避免一次冒出两句话。
 */
export function deriveSyncNotice(
  online: boolean,
  pending: number,
  hasDropped: boolean,
): SyncNotice {
  if (!online) {
    return pending > 0 ? 'offlinePending' : 'offline';
  }
  if (pending > 0) {
    return hasDropped ? 'dropped' : 'syncing';
  }
  return hasDropped ? 'dropped' : 'none';
}

/**
 * 顶部同步横幅（GAP-9：把「还有 N 笔没送出去」摊给用户看）。
 *
 * ### 为什么把「N 笔」并入离线横幅，而不是另起一条
 * 断网与「有东西排队」在用户眼里是**同一件事的两面**（网络状态 → 记录是否已送达）。
 * 拆成两条横幅会在顶部叠两层几乎同色的色块，也会让「离线时到底有几笔」要跨两行读。
 * 所以合并成一条两行的横幅：主行讲网络，副行讲这 N 笔的去向。
 *
 * ### 为什么联网时要显示（`!online || pending > 0`）
 * 纯 `!online` 的横幅在**联网后立刻消失** —— 而那正是用户最需要看到反馈的时刻
 * （刚记完一笔、网络恢复，用户在等它同步完）。所以只要还有待同步，
 * 横幅就继续留着，直到队列归零才收起来。
 *
 * ### 做不到的诚实
 * 横幅只展示「队列里有几笔 + 本会话本轮有没有丢弃」，**不展示「已同步 N 笔」**：
 * 前者是本模块能保证的事实，后者只是个瞬时事件计数，容易被误读成累计成绩。
 *
 * ### 视觉与语气
 * 沿用离线横幅既有配色（暖 coral），**不引入 red**；无进度条、无百分比、无失败次数。
 */
function OfflineSyncBanner({ online }: { online: boolean }): ReactElement | null {
  const [pending, setPending] = useState(0);
  /**
   * 本会话「有记录被丢弃」的**一次性**记忆：一经触发就常驻，直到用户刷新页面。
   *
   * - 为什么用 ref 而不是 state 的依赖：`dropped` 只影响下一次渲染要显示哪一句话，
   *   真正的重渲染由 `pending` 驱动；如果把它塞进 effect 依赖，会因为
   *   effect 重跑而反复触发冲队。所以用一个「只读不订阅」的容器装它。
   * - 为什么是**会话级**而不是每条队列项级：`flushQueue` 的丢弃上限
   *   （`MAX_FLUSH_ATTEMPTS = 3`）是按**请求**记的，一次失败重试可能横跨多轮同步；
   *   用户侧的语义只有一个 ——「这阵子有记录没能送出去」，那就是会话级的。
   */
  const droppedRef = useRef(false);
  const [hasDropped, setHasDropped] = useState(false);

  /** 重读一次队列长度并落到 state；任何一步失败都不影响横幅本身。 */
  const refreshPending = async (): Promise<void> => {
    try {
      setPending(await queueLength());
    } catch {
      // 队列不可读（隐私模式等极端情况）：保持上一次的数字，不抛、不清零
    }
  };

  // 订阅「队列变化」→ 重读条数。首挂载先读一次（可能有上次会话遗留的队列）。
  useEffect(() => {
    void refreshPending();
    return subscribeQueue(() => {
      void refreshPending();
    });
  }, []);

  // 恢复联网：**主动冲一次**，冲完再重读条数。
  // 注意 `registerSW.startOfflineSync()` 也会在 `online` 时冲队，但那只在 main.tsx 初始化时挂；
  // 这里再冲一次是幂等的（空队列直接返回），换来的是「横幅挂载后即使用户没刷新页面也能看到数字归零」。
  useEffect(() => {
    if (!online) {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      let result: { dropped: number } | null = null;
      try {
        result = await flushQueue();
      } catch {
        result = null;
      }
      if (cancelled) {
        return;
      }
      if (result !== null && result.dropped > 0) {
        droppedRef.current = true;
        setHasDropped(true);
      }
      // 无论冲队成功与否，都用真实长度覆盖一次 —— 避免「冲完还是 0 条」这种假象。
      await refreshPending();
    })();
    return () => {
      cancelled = true;
    };
  }, [online]);

  const notice = deriveSyncNotice(online, pending, hasDropped);

  if (notice === 'none') {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={COPY.offlineSyncBannerLabel}
      data-testid="offline-sync-banner"
      data-sync-notice={notice}
      className="bg-coral-50 px-5 py-2 text-center text-xs text-coral-700 dark:bg-coral-900/30 dark:text-coral-200"
    >
      {/* 主行：① 断网 → 既有文案（回归保护，一字未改）；② 联网但还在同步 → 说明在等什么 */}
      <p>
        {notice === 'syncing'
          ? COPY.offlineSyncing(pending)
          : notice === 'dropped'
            ? COPY.offlineSynced
            : COPY.offlineNotice}
      </p>
      {/* 副行：只在「断网且有排队」与「联网但出现丢弃」这两种需要额外解释时才出现 */}
      {notice === 'offlinePending' && (
        <p data-testid="offline-pending-line" className="mt-0.5">
          {COPY.offlinePending(pending)}
        </p>
      )}
      {notice === 'dropped' && (
        <p data-testid="offline-dropped-line" className="mt-0.5">
          {COPY.offlineSyncDropped}
        </p>
      )}
    </div>
  );
}

export default function AppShell({ children, title = '轻生活', wide = false }: AppShellProps): ReactElement {
  const { resolved, toggle } = useTheme();
  const unit = useUnitStore((state) => state.unit);
  const toggleUnit = useUnitStore((state) => state.toggle);
  const weightUnit = useUnitStore((state) => state.weightUnit);
  const toggleWeightUnit = useUnitStore((state) => state.toggleWeightUnit);
  const online = useOnlineStatus();
  /**
   * 宽屏列宽增量：**只加 `lg:` 前缀**。`wide === false` 时拼接空串，
   * 保证顶栏 / `main` 的 `className` 与改动前逐字符相同（移动端零回归）。
   */
  const wideWidth = wide ? ' lg:max-w-6xl' : '';

  return (
    <div className="min-h-screen bg-brand-50 pb-20 dark:bg-slate-900 md:pb-8">
      <a href="#main" className="qsh-skip-link">
        跳到主要内容
      </a>

      <header className="sticky top-0 z-30 border-b border-brand-100 bg-white/90 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
        <div className={`mx-auto flex max-w-3xl items-center justify-between px-5 py-3.5${wideWidth}`}>
          {/* 标题用 `text-title`（20px）而非正文号：页头是全站层级的地基，
              标题与正文同号会让每一页都「没有开始」 */}
          <p className="text-title font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            {title}
          </p>
          <div className="flex items-center gap-1.5">
            {/* 品牌角饰：一朵小花的「印章」，放在按钮左侧。shrink-0 保证它不会被标题挤扁 */}
            <BrandDecor variant="corner" className="h-6 w-6 shrink-0 text-brand-300 opacity-50" />
            <button
              type="button"
              onClick={toggleUnit}
              className="qsh-touch-target rounded-xl px-3 text-caption font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
              aria-label={`切换热量单位为${unit === 'kcal' ? '千焦' : '千卡'}，当前 ${energyLabel(unit)}`}
            >
              {energyLabel(unit)}
            </button>
            {/* 体重单位切换（D-3）：与热量单位按钮同构 —— 同为「展示换算」，不改变任何存储。
                顶栏原本已有两个按钮（热量 + 深色），第三个用更紧凑的间距（`gap-1.5`）容纳：
                按钮本身仍是 ≥44px 的触控目标，窄屏下标题仍占得下。 */}
            <button
              type="button"
              onClick={toggleWeightUnit}
              className="qsh-touch-target rounded-xl px-3 text-caption font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
              aria-label={`切换体重单位为${weightUnit === 'jin' ? '千克' : '斤'}，当前 ${weightLabel(weightUnit)}`}
            >
              {weightLabel(weightUnit)}
            </button>
            <button
              type="button"
              onClick={toggle}
              className="qsh-touch-target rounded-xl px-3 text-caption font-medium text-slate-600 ring-1 ring-brand-100 dark:text-slate-300 dark:ring-slate-700"
              aria-label={resolved === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            >
              {resolved === 'dark' ? '浅色' : '深色'}
            </button>
          </div>
        </div>
      </header>

      {/* 离线 / 待同步横幅（GAP-9）：`!online` 或「还有 N 笔在路上」时出现 */}
      <OfflineSyncBanner online={online} />

      {/* 内容两侧多留一档呼吸（py-8）：全站每页统一；页面内部间距各自负责，此处不叠加。
          C-6：`wide` 页面在 lg 断点放宽到 6xl，供内部多栏；非 wide 页面类名与改动前一致。 */}
      <main id="main" className={`mx-auto max-w-3xl animate-fade-in px-5 py-8${wideWidth}`}>
        {children}
      </main>

      <BottomNav />
    </div>
  );
}
