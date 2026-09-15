import { useRef, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * 分享卡片（三期）：把周报关键数据用 Canvas 画成 720×960 卡片，一键下载 PNG。
 *
 * 隐私约束（K10 / PRD Q12）：
 * - 不含邮箱、不含绝对体重数值，**只有体重变化量**；
 * - 卡片自带浅色底 + 深色文字，深色模式下下载出来的图片同样可读；
 * - 纯前端实现（原生 canvas API），无新依赖。
 */

export interface ShareCardProps {
  /** 周起止标签（如 `09-06 ~ 09-12`） */
  weekLabel: string;
  /** 日均摄入 kcal */
  avgIntakeKcal: number;
  /** 一周运动消耗合计 kcal */
  totalExerciseKcal: number;
  /** 体重变化 kg（无记录为 null → 显示「—」） */
  weightChangeKg: number | null;
  /** 一句鼓励语（来自周报数据生成，不含敏感信息） */
  encouragement: string;
}

/** 导出文件名（导出为纯函数便于单测；过滤路径分隔符等不安全字符）。 */
export function shareCardFileName(from: string, to: string): string {
  const safe = (value: string) => value.replace(/[^\w-]+/g, '-');
  return `qinglife-week-${safe(from)}_${safe(to)}.png`;
}

/** 画卡片并返回 dataURL（导出为纯函数便于复用 / 测试 mock）。 */
export function drawShareCard(canvas: HTMLCanvasElement, data: ShareCardProps): string {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return '';
  }

  const W = 720;
  const H = 960;
  const BRAND = '#14b8a6';
  const INK = '#1e293b';
  const SUB = '#64748b';

  // 背景：浅色渐变（固定浅色，保证导出图片在深色模式下也可读）
  const gradient = ctx.createLinearGradient(0, 0, 0, H);
  gradient.addColorStop(0, '#f0fdfa');
  gradient.addColorStop(1, '#ffffff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  // 顶部品牌条
  ctx.fillStyle = BRAND;
  ctx.fillRect(0, 0, W, 12);

  // 标题
  ctx.fillStyle = INK;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = 'bold 44px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('轻生活 · 我的一周', 56, 72);

  ctx.fillStyle = SUB;
  ctx.font = '26px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(data.weekLabel, 56, 140);

  // 三个数据块
  const cards: Array<{ label: string; value: string; unit: string }> = [
    { label: '日均摄入', value: `${Math.round(data.avgIntakeKcal)}`, unit: 'kcal' },
    { label: '运动消耗', value: `${Math.round(data.totalExerciseKcal)}`, unit: 'kcal' },
    {
      label: '体重变化',
      value: data.weightChangeKg === null ? '—' : data.weightChangeKg > 0 ? `+${data.weightChangeKg}` : `${data.weightChangeKg}`,
      unit: 'kg',
    },
  ];

  cards.forEach((card, index) => {
    const x = 56 + index * 204;
    const y = 220;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ccfbf1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    // roundRect 兼容：手动圆角路径（旧浏览器 canvas 无 roundRect）
    const rw = 184;
    const rh = 160;
    const r = 20;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + rw, y, x + rw, y + rh, r);
    ctx.arcTo(x + rw, y + rh, x, y + rh, r);
    ctx.arcTo(x, y + rh, x, y, r);
    ctx.arcTo(x, y, x + rw, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = SUB;
    ctx.font = '24px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(card.label, x + 20, y + 24);

    ctx.fillStyle = INK;
    ctx.font = 'bold 44px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(card.value, x + 20, y + 64);

    ctx.fillStyle = SUB;
    ctx.font = '22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(card.unit, x + 20, y + 118);
  });

  // 鼓励语
  ctx.fillStyle = INK;
  ctx.font = '30px "PingFang SC", "Microsoft YaHei", sans-serif';
  wrapText(ctx, data.encouragement, 56, 470, W - 112, 46);

  // 底部落款
  ctx.fillStyle = SUB;
  ctx.font = '24px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('不节食 · 不贩卖焦虑 · 用记录照顾自己', 56, H - 96);
  ctx.fillStyle = BRAND;
  ctx.fillText('轻生活', 56, H - 140);

  return canvas.toDataURL('image/png');
}

/** 简易中文换行（Canvas 不自动换行）。 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  let line = '';
  let cursorY = y;
  for (const char of text) {
    if (ctx.measureText(line + char).width > maxWidth) {
      ctx.fillText(line, x, cursorY);
      line = char;
      cursorY += lineHeight;
    } else {
      line += char;
    }
  }
  if (line.length > 0) {
    ctx.fillText(line, x, cursorY);
  }
}

export default function ShareCard(props: ShareCardProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = (): void => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      setError('这一步没有成功，稍后再试一次就好');
      return;
    }
    try {
      const dataUrl = drawShareCard(canvas, props);
      if (dataUrl === '') {
        setError('这台设备暂时不支持生成图片');
        return;
      }
      const link = document.createElement('a');
      const [from, to] = props.weekLabel.split(' ~ ');
      link.download = shareCardFileName(from ?? props.weekLabel, to ?? '');
      link.href = dataUrl;
      link.click();
      setError(null);
    } catch {
      setError('这一步没有成功，稍后再试一次就好');
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <canvas ref={canvasRef} width={720} height={960} className="hidden" aria-hidden="true" />
      <button
        type="button"
        onClick={handleDownload}
        className="rounded-xl border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 hover:bg-teal-100 dark:border-teal-700 dark:bg-teal-900/40 dark:text-teal-200"
      >
        生成分享卡片
      </button>
      {error !== null && <p className="text-xs text-slate-400">{error}</p>}
    </div>
  );
}
