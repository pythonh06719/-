import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

/**
 * 条码扫描（components/common/BarcodeScanner.tsx，Phase C-2 / R3.6）。
 *
 * 设计要点：
 * - **零新依赖**：使用浏览器**原生 `BarcodeDetector`** + `getUserMedia`，不引入任何扫码库；
 * - **隐私优先**：画面只在本地识别，不上传、不留存；识别到合法条码后立即停止摄像头轨道；
 * - **优雅回退**：不支持 `BarcodeDetector` / 无摄像头 / 拒绝授权 → 给出可读说明 + **手动输入条码**兜底；
 * - **无障碍**：`role="dialog"` + `aria-live` 状态播报 + 触控目标 ≥44px（`qsh-touch-target`）。
 */

/** 8–14 位数字条码（EAN-8 / UPC-12 / EAN-13 / GTIN-14）。 */
const BARCODE_PATTERN = /^\d{8,14}$/;

/** 原生 `BarcodeDetector` 的最小结构（不依赖 lib.dom 的具体版本）。 */
interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

/** 读取可用的 `BarcodeDetector` 构造器；不支持返回 `null`。 */
function getBarcodeDetector(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof candidate === 'function' ? (candidate as BarcodeDetectorCtor) : null;
}

export interface BarcodeScannerProps {
  /** 识别到（或手动输入）合法条码时回调 */
  onDetected: (code: string) => void;
  /** 关闭扫描面板 */
  onClose: () => void;
}

type ScanStatus = 'starting' | 'scanning' | 'denied' | 'unsupported' | 'error' | 'detected';

/** 各状态的用户可读文案。 */
const STATUS_TEXT: Readonly<Record<ScanStatus, string>> = {
  starting: '正在打开摄像头…',
  scanning: '把商品条码放进取景框',
  denied: '没有拿到摄像头权限，手动输入条码也一样',
  unsupported: '这台设备暂时不能自动扫码，手动输入条码也行',
  error: '摄像头暂时打不开，手动输入条码也可以',
  detected: '已经扫到条码啦',
};

export default function BarcodeScanner({ onDetected, onClose }: BarcodeScannerProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const [status, setStatus] = useState<ScanStatus>('starting');
  const [manualCode, setManualCode] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  /** 停止取景计时器 + 关闭摄像头轨道（幂等，卸载时亦调用）。 */
  const stopCamera = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video !== null) {
      video.srcObject = null;
    }
  }, []);

  /** 命中条码：停摄像头 + 只回调一次。 */
  const finish = useCallback(
    (code: string): void => {
      if (finishedRef.current) {
        return;
      }
      finishedRef.current = true;
      stopCamera();
      setStatus('detected');
      onDetected(code);
    },
    [onDetected, stopCamera],
  );

  useEffect(() => {
    let cancelled = false;
    const detectorCtor = getBarcodeDetector();
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;

    // 不支持原生识别 / 无 getUserMedia → 直接回退手动输入（不报错）
    if (detectorCtor === null || media === undefined || typeof media.getUserMedia !== 'function') {
      setStatus('unsupported');
      return () => {
        cancelled = true;
      };
    }

    const detector = new detectorCtor({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
    });

    const start = async (): Promise<void> => {
      try {
        const stream = await media.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setStatus('scanning');

        timerRef.current = window.setInterval(() => {
          const node = videoRef.current;
          if (node === null || node.readyState < 2 || finishedRef.current) {
            return;
          }
          void detector
            .detect(node)
            .then((results) => {
              for (const result of results) {
                const code = result.rawValue.trim();
                if (BARCODE_PATTERN.test(code)) {
                  finish(code);
                  return;
                }
              }
            })
            .catch(() => undefined);
        }, 400);
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
      }
    };

    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [finish, stopCamera]);

  /** 手动输入兜底。 */
  const submitManual = (event: FormEvent): void => {
    event.preventDefault();
    const code = manualCode.trim();
    if (!BARCODE_PATTERN.test(code)) {
      setManualError('条码一般是 8–14 位数字，检查一下再试');
      return;
    }
    setManualError(null);
    finish(code);
  };

  const showVideo = status === 'starting' || status === 'scanning';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="扫描商品条码"
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
    >
      {/* 扫码弹窗 → elevation-3（原 shadow-xl 是硬边大阴影，与「柔和」气质冲突） */}
      <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-qsh-3 dark:bg-slate-800 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">扫描条码</h2>
          <button
            type="button"
            onClick={onClose}
            className="qsh-touch-target rounded-lg px-3 text-sm text-slate-500 dark:text-slate-400"
            aria-label="关闭扫码"
          >
            关闭
          </button>
        </div>

        {/* 状态播报（屏幕阅读器） */}
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {STATUS_TEXT[status]}
        </p>

        {showVideo && (
          <div className="mt-3 overflow-hidden rounded-2xl bg-slate-900">
            <video
              ref={videoRef}
              className="h-56 w-full object-cover"
              playsInline
              muted
              aria-label="摄像头取景框"
            />
          </div>
        )}

        {/* 手动输入：始终可用（不支持 / 拒绝授权时的兜底，也方便输入包装上的数字） */}
        <form onSubmit={submitManual} className="mt-4 space-y-2">
          <label className="block text-sm text-slate-600 dark:text-slate-300">
            手动输入条码
            <input
              inputMode="numeric"
              value={manualCode}
              onChange={(event) => {
                setManualCode(event.target.value);
                setManualError(null);
              }}
              placeholder="如：6901234567890"
              className="mt-1 w-full rounded-lg border border-brand-100 px-3 py-2 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          {manualError !== null && (
            <p role="alert" className="text-xs text-coral-600 dark:text-coral-300">
              {manualError}
            </p>
          )}
          <button
            type="submit"
            className="qsh-touch-target w-full rounded-xl bg-brand-600 py-3 font-medium text-white transition hover:bg-brand-700"
          >
            查询这个条码
          </button>
        </form>

        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          画面只在你手机上识别，不会上传，也不保存照片。
        </p>
      </div>
    </div>
  );
}
