import type { ReactElement, ReactNode } from 'react';
import BrandDecor from './BrandDecor';

/**
 * 空状态（components/common/EmptyState.tsx）。
 *
 * 全站此前没有共用空状态组件，文案散落在各页 —— 这里先立**一个**形状：
 * 品牌花 + 一句话 + 可选动作，语气沿用 PRD §7（温和、不催、不评判）。
 *
 * 视觉上直接复用 `.qsh-surface-warm`：暖色卡片本身就是「生活感」的表达，
 * 装饰花也随之出现（右下角那枚由 CSS 背景提供），无需重复画一遍。
 *
 * 无障碍：`role="status"` 让屏幕阅读器在空状态出现时播报；文字对比度按 AA 选色
 * （`text-slate-600` / `dark:text-slate-300`，在设计底上均 ≥ 4.5:1）。
 */

export interface EmptyStateProps {
  /** 主文案（一句话，尽量给「下一步」而不是结论） */
  title: string;
  /** 补充说明（可选） */
  description?: string;
  /** 可选动作（按钮 / 链接） */
  action?: ReactNode;
  /** 附加样式（尺寸、间距等由调用方决定） */
  className?: string;
}

export default function EmptyState({
  title,
  description,
  action,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <section
      role="status"
      className={`qsh-surface-warm flex items-center gap-4 p-5 ${className ?? ''}`.trim()}
    >
      <BrandDecor variant="bloom" className="h-11 w-11 shrink-0 text-brand-400" />
      <div className="min-w-0">
        <p className="text-subtitle font-medium text-slate-800 dark:text-slate-100">{title}</p>
        {description !== undefined && (
          <p className="mt-1 text-body text-slate-600 dark:text-slate-300">{description}</p>
        )}
        {action !== undefined && <div className="mt-3">{action}</div>}
      </div>
    </section>
  );
}
