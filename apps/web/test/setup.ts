import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * 测试环境初始化：
 * - 引入 jest-dom 断言（`toBeInTheDocument` 等）
 * - 每个用例后卸载 React 树，避免 DOM 泄漏
 */
afterEach(() => {
  cleanup();
});
