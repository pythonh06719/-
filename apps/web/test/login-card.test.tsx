/**
 * 登录卡片回显测试（components/common/LoginCard.tsx）。
 *
 * 钉死「自用模式回显」的预填边界（QA 对 c856daa 的 P2）：
 * - `code` 为 **6 位数字** → 预填输入框 + 「自用模式回显」提示；
 * - `code` 形状不对（`"12345"` / `"abcdef"` / `""` / `null` / 缺省）→
 *   **不预填**，走原本的「验证码已发送」文案 —— 防止把无法登录的值塞进输入框误导用户。
 *
 * 通过 stub 全局 `fetch` 模拟 `POST /auth/send-code` 的 `{data, error}` 响应封装。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import LoginCard from '@/components/common/LoginCard';

/** `{data, error}` 响应封装（与后端全局拦截器一致）。 */
function ok(data: unknown): { ok: true; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => ({ data, error: null }) };
}

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LoginCard />
    </QueryClientProvider>,
  );
}

/**
 * 填邮箱 → 点「获取验证码」→ stub 返回体中带指定的 `code`。
 *
 * `code` 用 `undefined` 表示「响应里没有这个字段」；其余值原样放进响应（含 `null`），
 * 用于验证前端对脏数据的容错。
 */
async function sendCode(code?: unknown): Promise<void> {
  const payload: Record<string, unknown> = { email: 'me@qinglife.test', expiresInSeconds: 300 };
  if (code !== undefined) {
    payload.code = code;
  }
  vi.stubGlobal('fetch', vi.fn(async () => ok(payload)));

  renderCard();
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@qinglife.test' } });
  fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
  await screen.findByRole('status');
}

/** 验证码输入框（label「验证码」包住的就是它）。 */
function codeInput(): HTMLInputElement {
  return screen.getByLabelText('验证码') as HTMLInputElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('登录卡片：验证码回显的预填边界', () => {
  it('6 位数字 → 预填输入框 + 回显提示', async () => {
    await sendCode('012345');

    expect(codeInput().value).toBe('012345');
    expect(screen.getByRole('status').textContent).toBe(
      '验证码已发送，已替你填好（自用模式回显 012345），5 分钟内有效',
    );
  });

  it('"12345"（5 位）→ 不预填，走原文案', async () => {
    await sendCode('12345');

    expect(codeInput().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('验证码已发送，5 分钟内有效');
  });

  it('"abcdef"（非数字）→ 不预填，走原文案', async () => {
    await sendCode('abcdef');

    expect(codeInput().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('验证码已发送，5 分钟内有效');
  });

  it('"" → 不预填，走原文案', async () => {
    await sendCode('');

    expect(codeInput().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('验证码已发送，5 分钟内有效');
  });

  it('null → 不预填，走原文案', async () => {
    await sendCode(null);

    expect(codeInput().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('验证码已发送，5 分钟内有效');
  });

  it('响应缺 code 字段（生产常态）→ 不预填，走原文案', async () => {
    await sendCode(undefined);

    expect(codeInput().value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('验证码已发送，5 分钟内有效');
  });
});
