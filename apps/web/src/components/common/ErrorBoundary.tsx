import { Component, Fragment } from 'react';
import type { ErrorInfo, ReactElement, ReactNode } from 'react';
import { COPY } from '@/lib/copy';

/**
 * 通用错误边界（components/common/ErrorBoundary.tsx）—— GAP-10。
 *
 * ## 为什么需要它
 *
 * 全站此前**零错误边界**：任何页面在渲染期抛一个 `TypeError`（例如报表拿到缺字段的响应后
 * 调 `report.from.slice(5)`，见 `pages/report/WeeklyReportView.tsx`），React 会卸载整棵树 ——
 * 用户看到的是**整页白屏**，且没有任何自救手段（刷新往往还是同一份坏数据，白屏复现）。
 * `Suspense` 只兜 chunk 加载、`fetch` 错误的 catch 只兜请求失败，**都兜不住「渲染抛错」**。
 *
 * ## 设计取舍
 *
 * - **类组件**：`getDerivedStateFromError` / `componentDidCatch` 是 React 唯一提供错误边界的机制，
 *   函数组件（含 hooks 版本）至今没有等价能力，因此这里必须是 class。
 * - **不外报**：个人非商业自用项目，不引入 Sentry 一类的远端上报（也不该在用户设备上偷偷发数据）。
 *   只在 `componentDidCatch` 里 `console.error` 留下错误与组件栈，便于开发者排查。
 * - **软着陆文案**：兜底界面走 `copy.ts` 的「页面兜底」小节，语气沿用全站口径 ——
 *   说清「这一页暂时打不开、别的地方还能用」，并给**两个动作**（重试 / 回到首页）。
 *   不使用「崩溃 / 错误 / 异常」作为标题，不使用红色（PRD §7 无负罪感规范）。
 * - **重试真的能让内容回来**：`componentDidCatch` 的 log 只跑一次；用户点「重试」时
 *   `setState({ error: null })` 重置边界 → 子树**重新挂载并重新渲染**（React 会丢掉旧子树、
 *   用 `key` 变化强制重建），坏数据若已被上层刷新为正常数据，页面即恢复正常。
 *
 * ## 使用
 *
 * ```tsx
 * // 1) 最简：什么都不传，直接兜住 children
 * <ErrorBoundary><PageX /></ErrorBoundary>
 *
 * // 2) 需要「回到首页」用路由跳转（类组件里不能用 hook）时，
 * //    用 renderFallback 注入一个由函数组件提供的自定义兜底界面：
 * <ErrorBoundary renderFallback={(reset) => <Fallback onReset={reset} />}>
 *   <PageX />
 * </ErrorBoundary>
 * ```
 *
 * ## 无障碍
 *
 * 兜底容器带 `role="alert"`：错误发生后屏幕阅读器会主动播报这条状态，
 * 其中的两个按钮则是普通 `<button>`，键盘可达、可聚焦。
 */

/** 错误边界对外暴露的 props。 */
export interface ErrorBoundaryProps {
  /** 需要被保护的子树（页面 / 路由出口 / 整棵应用） */
  children: ReactNode;
  /**
   * 自定义兜底界面。`reset` 即边界自身的重试方法（重置状态并重挂子树）。
   * 不传时使用内置的默认兜底界面（重试 + `window.location.assign('/')`）。
   */
  renderFallback?: (reset: () => void) => ReactNode;
}

/** 错误边界的内部状态。 */
interface ErrorBoundaryState {
  /** 捕获到的错误；`null` 表示子树正常。 */
  error: Error | null;
  /**
   * 每次失败 / 重试自增，作为包裹 `children` 的 `key`。
   *
   * ⚠️ 没有它就**没有真正的「重试」**：React 在错误后已经卸载了旧子树，但同一个
   * `children` 元素引用在 `setState({ error: null })` 后会照原样重新挂载 —— 若子组件
   * 因模块级缓存（例如 `useState` 初始化读取的坏数据）仍会抛同样的错，边界会立刻再次进入
   * 兜底，用户看到「点了重试没反应」。改变 `key` 强制 React 当作全新子树处理，语义最干净。
   */
  attempt: number;
}

/** 错误边界的默认兜底容器类名（与全站页面容器 / 背景约定一致）。 */
const FALLBACK_SHELL_CLASS =
  'min-h-screen bg-brand-50 px-5 py-8 dark:bg-slate-900';
/**
 * 错误边界的默认兜底卡片类名。
 *
 * 走 `.qsh-surface`（elevation-1 + 描边 + 深色自动成立），不再手写 `bg-white shadow-sm`：
 * 错误态是用户最需要「页面还站得住」的时刻，不该用全站最弱的一档 elevation。
 * `p-6` 保留 —— 兜底页只有一个居中块，宽松一些更稳。
 */
const FALLBACK_CARD_CLASS = 'qsh-surface mx-auto max-w-3xl p-6 text-center';
/** 主按钮（回到首页 / 重试）—— 品牌绿，不用红色。 */
const FALLBACK_PRIMARY_BUTTON_CLASS =
  'rounded-control bg-brand-500 px-4 py-2 text-sm font-medium text-white transition-colors duration-qsh-base ease-qsh-out hover:bg-brand-600';
/**
 * 次按钮（重试）—— 中性描边，视觉权重低于主按钮。
 *
 * 焦点环刻意**不写** `focus-visible:outline-none` / `ring-*`：原来的 `ring-brand-400`
 * 对白底只有 2.6:1（`theme/a11y.css` 的全局规则用 `brand-600`，4.72:1），
 * 局部写死等于绕过一个更严的全局约定。删掉后交给全局规则接管。
 */
const FALLBACK_SECONDARY_BUTTON_CLASS =
  'rounded-control border border-brand-200 bg-white px-4 py-2 text-sm font-medium text-brand-700 transition-colors duration-qsh-base ease-qsh-out hover:bg-brand-50 dark:border-slate-600 dark:bg-slate-800 dark:text-brand-200 dark:hover:bg-slate-700';

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /** 当前已捕获的错误状态（初始为正常）。 */
  public override state: ErrorBoundaryState = { error: null, attempt: 0 };

  /**
   * 渲染期捕获到错误时，先切到兜底界面。
   *
   * 必须是**静态**方法（React 在实例方法可用前调用它），且必须是**纯函数** ——
   * 这里不允许产生副作用（副作用只能放在 `componentDidCatch`）。
   */
  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  /**
   * 提交阶段记录错误详情（含组件栈）。
   *
   * 仅写入本机控制台，**不做任何远端上报**。在 `console.error` 外再包一层 `try/catch`，
   * 是因为少数测试环境 / 宿主页面会替换 `console.error`，避免日志本身再抛错把边界二次打挂。
   */
  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    try {
      // eslint-disable-next-line no-console -- 错误边界排查必须有本地日志
      console.error('[ErrorBoundary] 页面渲染时发生未捕获错误：', error, errorInfo.componentStack);
    } catch {
      /* 日志失败不应影响兜底界面渲染 */
    }
  }

  /** 重试：清空错误状态并换 `key`，让子树以全新实例重新渲染。 */
  private readonly handleReset = (): void => {
    this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }));
  };

  /** 内置兜底界面的「回到首页」：不依赖 React Router（最外层兜底时 Router 可能已不可用）。 */
  private readonly handleGoHome = (): void => {
    window.location.assign('/');
  };

  /** 渲染内置兜底界面（`renderFallback` 未提供时使用）。 */
  private renderDefaultFallback(): ReactElement {
    return (
      <div className={FALLBACK_SHELL_CLASS}>
        <div role="alert" className={FALLBACK_CARD_CLASS}>
          <p className="text-title font-semibold tracking-tight text-slate-800 dark:text-slate-100">
            {COPY.pageFallbackTitle}
          </p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {COPY.pageFallbackDesc}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={this.handleReset}
              className={FALLBACK_SECONDARY_BUTTON_CLASS}
            >
              {COPY.pageFallbackRetry}
            </button>
            <button
              type="button"
              onClick={this.handleGoHome}
              className={FALLBACK_PRIMARY_BUTTON_CLASS}
            >
              {COPY.pageFallbackHome}
            </button>
          </div>
        </div>
      </div>
    );
  }

  public override render(): ReactNode {
    const { error, attempt } = this.state;
    const { children, renderFallback } = this.props;

    if (error !== null) {
      return renderFallback !== undefined ? renderFallback(this.handleReset) : this.renderDefaultFallback();
    }

    // `key` 随 attempt 变化：重试后强制 React 重建子树（详见 `attempt` 的注释）。
    return <Fragment key={attempt}>{children}</Fragment>;
  }
}
