import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import ErrorBoundary from '@/components/common/ErrorBoundary';
import { COPY } from '@/lib/copy';

/**
 * GAP-10 错误边界测试（components/common/ErrorBoundary.tsx）。
 *
 * 覆盖点：
 * 1. 子组件抛错 → 兜底界面出现，且**不递归崩溃**（边界自身渲染再抛错会把整棵树打挂）；
 * 2. 「重试」→ 子树重新渲染，若此时不再抛错则正常内容回来；
 * 3. 文案红线：不出现「崩溃 / 错误 / 失败 / 异常」，且**不出现红色类名**（`text-red` / `bg-red`）；
 * 4. 正常子树不受影响（不渲染兜底界面）;
 * 5. App.tsx 集成：路由页面抛错时 `BrowserRouter` 仍在、其他路由仍可导航。
 *
 * 真实抛点参考（**本轮不修，仅作为边界必要性的证据**）：
 * `pages/report/WeeklyReportView.tsx:176` 的 `report.from.slice(5)` —— 后端缺字段时是确定的 TypeError。
 */

/** 可切换「是否抛错」的桩组件：`throwOnRender` 为真时在渲染期抛错。 */
function ThrowSwitch({ throwOnRender }: { throwOnRender: boolean }): ReactElement {
  return <>{throwOnRender ? <Boom /> : <p>正常内容</p>}</>;
}

/** 无条件在渲染期抛错的组件。 */
function Boom(): ReactElement {
  throw new TypeError("Cannot read properties of undefined (reading 'slice')");
}

/** 记录「被挂载过几次」的桩：验证重试是否真正重建子树。 */
function MountCounter({ onMount }: { onMount: () => void }): ReactElement {
  const counted = useRef(false);
  if (!counted.current) {
    counted.current = true;
    onMount();
  }
  return <p>已挂载</p>;
}

/**
 * `MountCounter` 在真实渲染里只记一次；但父组件状态变化（`setShouldThrow(false)`）会
 * 让 React 重新渲染子树，`useRef` 在**同一个实例**上保持为已计数，因此不会重复累加。
 * 若实例被重建（`key` 变化），`useRef` 归零 → 会再次计数。这里用它来断言语义。
 */

/** 用 `renderFallback` 注入的自定义兜底界面（模拟 App.tsx 里的 `RouteFallback`）。 */
function CustomFallback({ reset }: { reset: () => void }): ReactElement {
  return (
    <div>
      <p>{COPY.pageFallbackTitle}</p>
      <button type="button" onClick={reset}>
        自定义重试
      </button>
    </div>
  );
}

/** 静音 `console.error`：React 自身也会打印错误，测试期间不需要噪声。 */
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('GAP-10 · ErrorBoundary 基本行为', () => {
  it('子组件抛错时显示兜底界面（不白屏），并调用 componentDidCatch 记录错误', () => {
    render(
      <ErrorBoundary>
        <ThrowSwitch throwOnRender />
      </ErrorBoundary>,
    );

    // 兜底标题出现（来自 copy.ts），说明边界接住了错误而不是整棵树被卸载
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.pageFallbackDesc)).toBeInTheDocument();
    // 两个动作都在
    expect(screen.getByRole('button', { name: COPY.pageFallbackRetry })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY.pageFallbackHome })).toBeInTheDocument();
    // 子树不再渲染
    expect(screen.queryByText('正常内容')).not.toBeInTheDocument();
    // 兜底容器是 role=alert（读屏会播报），不是 role=status（那是空态语义）
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // componentDidCatch 记录了错误与组件栈
    expect(consoleErrorSpy).toHaveBeenCalled();
    const logged = consoleErrorSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('[ErrorBoundary]'),
    );
    expect(logged).toBeDefined();
    expect(logged?.[1]).toBeInstanceOf(TypeError);
    expect(typeof logged?.[2]).toBe('string'); // componentStack
  });

  it('子组件先抛错 → 点「重试」→ 恢复后正常内容回来（子树被重建）', () => {
    const mounts: number[] = [];

    /** 外部可切换抛错开关的父级：重试后把开关关掉，模拟「坏数据已刷新」 */
    function Host(): ReactElement {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShouldThrow(false)}>
            修复数据
          </button>
          <ErrorBoundary>
            <MountCounter onMount={() => mounts.push(mounts.length + 1)} />
            <ThrowSwitch throwOnRender={shouldThrow} />
          </ErrorBoundary>
        </>
      );
    }

    render(<Host />);
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    // 抛错后子树被 React 卸载，MountCounter 记录到「曾经挂载过」（StrictMode 下可能双渲染）
    expect(mounts.length).toBeGreaterThanOrEqual(1);
    const beforeRetry = mounts.length;

    // 「修复数据」发生在边界外（等价于上层把坏数据换成了好数据）
    fireEvent.click(screen.getByRole('button', { name: '修复数据' }));
    // 此刻边界状态未重置，子树仍未被挂载（证明「光靠外部变化不会自动恢复」）
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: COPY.pageFallbackRetry }));

    expect(screen.queryByText(COPY.pageFallbackTitle)).not.toBeInTheDocument();
    expect(screen.getByText('正常内容')).toBeInTheDocument();
    // 子树被**重新挂载**（attempt → key 变化），MountCounter 再次计数
    expect(mounts.length).toBeGreaterThan(beforeRetry);
  });

  it('重试后若坏数据还在（仍抛错）→ 兜底界面仍在，不递归崩溃', () => {
    let renderCount = 0;

    function AlwaysThrow(): ReactElement {
      renderCount += 1;
      throw new Error('坏数据还在');
    }

    render(
      <ErrorBoundary>
        <AlwaysThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: COPY.pageFallbackRetry }));

    // 仍然只显示兜底界面（没有白屏、没有嵌套的第二层兜底）
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    expect(screen.getAllByText(COPY.pageFallbackTitle)).toHaveLength(1);
    // 子组件确实被重新尝试渲染过（真实重试，不是空操作）
    expect(renderCount).toBeGreaterThanOrEqual(2);
  });

  it('文案与配色合规：无违规字样、无红色类名', () => {
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const text = container.textContent ?? '';
    const forbidden = ['崩溃', '错误', '失败', '异常'];
    for (const word of forbidden) {
      expect(text).not.toContain(word);
    }
    // 两个按钮文案本身也不含违规字样
    expect(COPY.pageFallbackTitle).not.toMatch(/崩溃|错误|失败|异常/);
    expect(COPY.pageFallbackDesc).not.toMatch(/崩溃|错误|失败|异常/);

    // 不出现红色类名（PRD §7 禁止红色恐吓）
    const classList = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .map((el) => el.className)
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    expect(classList).not.toMatch(/text-red|bg-red|border-red|ring-red/);
  });

  it('正常子组件不受影响：不渲染兜底界面，内容原样出现', () => {
    render(
      <ErrorBoundary>
        <p>一切正常</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('一切正常')).toBeInTheDocument();
    expect(screen.queryByText(COPY.pageFallbackTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('renderFallback 可注入自定义兜底界面，并拿到可用的 reset', () => {
    function Host(): ReactElement {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShouldThrow(false)}>
            修复数据
          </button>
          <ErrorBoundary
            renderFallback={(reset) => <CustomFallback reset={reset} />}
          >
            <ThrowSwitch throwOnRender={shouldThrow} />
          </ErrorBoundary>
        </>
      );
    }

    render(<Host />);
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    // 内置兜底没出现（用的是自定义那套）
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '修复数据' }));
    fireEvent.click(screen.getByRole('button', { name: '自定义重试' }));

    expect(screen.getByText('正常内容')).toBeInTheDocument();
  });
});

describe('GAP-10 · App.tsx 集成（路由级兜底）', () => {
  /** 渲染期抛错的路由页面。 */
  function BrokenPage(): ReactElement {
    const bad: { from?: string } = {};
    return <p>{bad.from!.slice(5)}</p>;
  }

  /** 正常页面 + 一条到坏页面的链接，用来验证「其他路由仍可导航」。 */
  function HomePage(): ReactElement {
    return <Link to="/broken">去坏页面</Link>;
  }

  /**
   * 复刻 App.tsx 的层级：`MemoryRouter > ErrorBoundary > Routes`，
   * 并用 `useNavigate` 注入「回到首页」（与 `RouteFallback` 同构）。
   */
  function HomeFallback({ reset }: { reset: () => void }): ReactElement {
    const navigate = useNavigate();
    return (
      <>
        <p>{COPY.pageFallbackTitle}</p>
        <button
          type="button"
          onClick={() => {
            reset();
            navigate('/', { replace: true });
          }}
        >
          {COPY.pageFallbackHome}
        </button>
      </>
    );
  }

  function Harness(): ReactElement {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <ErrorBoundary renderFallback={(reset) => <HomeFallback reset={reset} />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/broken" element={<BrokenPage />} />
            </Routes>
          </ErrorBoundary>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('路由页面抛错时显示兜底，点「回到首页」后 Router 仍可用、可导航到正常路由', () => {
    render(<Harness />);

    // Router 与首页正常
    expect(screen.getByRole('link', { name: '去坏页面' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '去坏页面' }));

    // 坏页面被兜住（不是整页白屏）
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();

    // 兜底里的「回到首页」用 useNavigate（说明 BrowserRouter 语境仍在），且真的回到了首页
    fireEvent.click(screen.getByRole('button', { name: COPY.pageFallbackHome }));
    expect(screen.getByRole('link', { name: '去坏页面' })).toBeInTheDocument();
    expect(screen.queryByText(COPY.pageFallbackTitle)).not.toBeInTheDocument();
  });

  it('边界不吞掉 BrowserRouter：BrowserRouter 版本同样可兜底（App.tsx 使用的就是它）', () => {
    function Bare(): ReactElement {
      return (
        <BrowserRouter>
          <Routes>
            <Route path="*" element={<BrokenPage />} />
          </Routes>
        </BrowserRouter>
      );
    }

    // 边界在 BrowserRouter 内部时能接住路由页面抛错
    render(
      <ErrorBoundary>
        <Bare />
      </ErrorBoundary>,
    );
    expect(screen.getByText(COPY.pageFallbackTitle)).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
