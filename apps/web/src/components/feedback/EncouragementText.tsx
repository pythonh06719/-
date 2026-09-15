import type { ReactElement } from 'react';
import { COPY } from '@/lib/copy';

/**
 * 鼓励语（components/feedback/EncouragementText.tsx）—— 无负罪感设计（PRD §7 / G3）。
 *
 * 文案来源优先级：后端 `dashboard.encouragement` → 本地兜底文案。
 * 组件本身不生成指责性内容；缺省值取自 `lib/copy.ts`。
 */

export interface EncouragementTextProps {
  /** 文案（缺省使用中性鼓励语） */
  text?: string;
  /** 屏幕阅读器播报（如记录后反馈） */
  live?: boolean;
}

export default function EncouragementText({ text, live = false }: EncouragementTextProps): ReactElement {
  const content = text === undefined || text.trim() === '' ? COPY.defaultEncouragement : text;

  return (
    <p
      className="rounded-2xl bg-brand-50 px-4 py-3 text-center text-sm font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
      {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})}
    >
      {content}
    </p>
  );
}
