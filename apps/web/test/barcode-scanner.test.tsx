import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BarcodeScanner from '@/components/common/BarcodeScanner';

/**
 * 条码扫描组件测试（Phase C-2）。
 *
 * jsdom 下既无 `BarcodeDetector` 也无 `navigator.mediaDevices`，因此组件应
 * **自动回退到手动输入** 并给出可读说明（不抛错、不白屏）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BarcodeScanner', () => {
  it('设备不支持自动扫码时回退手动输入，并给出隐私说明', async () => {
    render(<BarcodeScanner onDetected={vi.fn()} onClose={vi.fn()} />);

    // 兜底文案（异步 setStatus 后出现） + 手动输入 + 隐私说明
    expect(await screen.findByText(/暂时不能自动扫码/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('如：6901234567890')).toBeInTheDocument();
    expect(screen.getByText(/不会上传/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('手动输入：非法条码给可读提示，合法条码触发回调', async () => {
    const onDetected = vi.fn();
    render(<BarcodeScanner onDetected={onDetected} onClose={vi.fn()} />);

    const input = screen.getByPlaceholderText('如：6901234567890');
    const submit = screen.getByRole('button', { name: '查询这个条码' });

    fireEvent.change(input, { target: { value: '123' } });
    fireEvent.click(submit);
    expect(onDetected).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('8–14 位数字');

    fireEvent.change(input, { target: { value: '6901234567890' } });
    fireEvent.click(submit);
    expect(onDetected).toHaveBeenCalledWith('6901234567890');
  });
});
