import type { ExportBundle, ExportFileDescriptor } from '@qsh/shared-types';

/**
 * 文件下载助手（lib/download.ts）—— 仅浏览器环境生效，测试环境自动跳过。
 *
 * 导出不经过任何第三方服务：全程在本地生成 Blob 并触发下载（隐私承诺，TC-46）。
 */

/** 触发浏览器下载一个文本文件。 */
export function downloadTextFile(file: ExportFileDescriptor): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return;
  }
  const blob = new Blob([file.content], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // 延迟回收，确保下载已开始
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 依次下载导出包内的全部文件（JSON + 各 CSV）。
 * 通过微小的间隔串行触发，避免浏览器把连续下载判定为弹窗拦截。
 */
export async function downloadExportBundle(bundle: ExportBundle): Promise<void> {
  const files: ExportFileDescriptor[] = [bundle.files[0], ...bundle.files.slice(1)].filter(
    (file): file is ExportFileDescriptor => file !== undefined,
  );
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file === undefined) {
      continue;
    }
    downloadTextFile(file);
    if (index < files.length - 1) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 250);
      });
    }
  }
}

/** 让用户选择并读取一个本地文本文件（CSV 导入用）。 */
export function readTextFile(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取没有成功，换个文件再试试'));
    reader.readAsText(file, 'utf-8');
  });
}
