import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AuthResponse, SendCodeResponse } from '@qsh/shared-types';
import { api, ApiClientError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth.store';

/**
 * 登录卡片（components/common/LoginCard.tsx）—— 邮箱 + 验证码（R1.1 / US-03）。
 *
 * 一期页面结构未包含独立 `/login` 路由，故把登录做成可复用卡片：
 * 在「我的」页与引导流程中按需出现。登录成功后写入内存态 token 与用户信息。
 *
 * 后端未就绪 / 断网时给出温和提示，不阻塞其他功能（优雅降级）。
 */

export interface LoginCardProps {
  /** 登录成功回调 */
  onSuccess?: (payload: AuthResponse) => void;
}

export default function LoginCard({ onSuccess }: LoginCardProps): ReactElement {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const setSession = useAuthStore((state) => state.setSession);

  const sendCode = useMutation({
    mutationFn: (value: string) => api.post<SendCodeResponse>('/auth/send-code', { email: value }),
    onSuccess: (data) => {
      const minutes = Math.round(data.expiresInSeconds / 60);

      // 自用模式回显：后端仅在 `AUTH_LOG_CODE=true`（自用 / 开发）时把验证码一并返回，
      // 生产环境恒不返回 —— 此时保持原本的提示语，不暴露任何「回显」语义。
      // 防御性校验：只认 **6 位数字**（与验证码形状一致）；形状不对（脏数据 / 协议漂移）
      // 一律不预填、走原文案，避免把无法登录的值塞进输入框误导用户。
      if (typeof data.code === 'string' && /^\d{6}$/.test(data.code)) {
        setCode(data.code);
        setNotice(`验证码已发送，已替你填好（自用模式回显 ${data.code}），${minutes} 分钟内有效`);
        return;
      }

      setNotice(`验证码已发送，${minutes} 分钟内有效`);
    },
    onError: (error: unknown) =>
      setNotice(error instanceof ApiClientError ? error.message : '发送没有成功，稍后再试一次'),
  });

  const verify = useMutation({
    mutationFn: (payload: { email: string; code: string }) =>
      api.post<AuthResponse>('/auth/verify-code', payload),
    onSuccess: (data) => {
      setSession(data);
      setNotice('登录成功，欢迎回来');
      onSuccess?.(data);
    },
    onError: (error: unknown) =>
      setNotice(error instanceof ApiClientError ? error.message : '验证码没有核对成功，再试一次'),
  });

  const handleSend = (): void => {
    const trimmed = email.trim();
    if (trimmed === '') {
      setNotice('先填一下邮箱吧');
      return;
    }
    sendCode.mutate(trimmed);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedCode = code.trim();
    if (trimmedEmail === '' || trimmedCode === '') {
      setNotice('邮箱和验证码都填一下就好');
      return;
    }
    verify.mutate({ email: trimmedEmail, code: trimmedCode });
  };

  return (
    <section
      aria-label="邮箱登录"
      className="qsh-surface rounded-2xl p-5 dark:bg-slate-800 dark:ring-slate-700"
    >
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">登录后同步你的记录</h2>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        用邮箱 + 验证码登录即可，我们不需要密码。
      </p>

      <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
        <label className="block text-sm text-slate-600 dark:text-slate-300">
          邮箱
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            placeholder="you@example.com"
          />
        </label>

        <label className="block text-sm text-slate-600 dark:text-slate-300">
          验证码
          <div className="mt-1 flex gap-2">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              placeholder="6 位数字"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sendCode.isPending}
              className="qsh-touch-target shrink-0 rounded-lg bg-brand-100 px-3 text-sm font-medium text-brand-700 disabled:opacity-60 dark:bg-brand-900 dark:text-brand-200"
            >
              {sendCode.isPending ? '发送中' : '获取验证码'}
            </button>
          </div>
        </label>

        <button
          type="submit"
          disabled={verify.isPending}
          className="qsh-touch-target w-full rounded-lg bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {verify.isPending ? '核对中…' : '登录'}
        </button>
      </form>

      {notice !== null && (
        <p
          role="status"
          aria-live="polite"
          className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          {notice}
        </p>
      )}
    </section>
  );
}
