import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import BackupRestoreCard from '@/pages/settings-data/BackupRestoreCard';
import { readTextFile } from '@/lib/download';

vi.mock('@/lib/download', () => ({
  readTextFile: vi.fn(),
}));

function wrappedResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, error: null }),
  } as Response;
}

describe('BackupRestoreCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('先预览条数与跨度，确认前不调用恢复接口；确认后才合并', async () => {
    vi.mocked(readTextFile).mockResolvedValue('{"meta":{}}');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        wrappedResponse({
          previewToken: 'preview-token-a',
          schemaVersion: 2,
          counts: { weights: 2, meals: 3, exercises: 1, habits: 4, water: 5, wins: 2 },
          dateRange: { from: '2026-08-01', to: '2026-09-12' },
          mergeStrategy: 'same-day-replace',
        }),
      )
      .mockResolvedValueOnce(
        wrappedResponse({
          restored: { weights: 2, meals: 3, exercises: 1, habits: 4, water: 5, wins: 2 },
          dateRange: { from: '2026-08-01', to: '2026-09-12' },
          mergeStrategy: 'same-day-replace',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(<BackupRestoreCard />);
    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('选择 JSON 备份文件'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('restore-preview')).toBeInTheDocument());
    expect(screen.getByText('体重之外的变化')).toBeInTheDocument();
    expect(screen.getByText('2026-08-01 ～ 2026-09-12')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/data/restore/preview');

    fireEvent.click(screen.getByRole('button', { name: '确认合并这份备份' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('17 条记录'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/data/restore');
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      previewToken: 'preview-token-a',
    });
  });

  it('明确写出同日替换、其他日期保留，且文案不含评判词', () => {
    render(<BackupRestoreCard />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('备份里出现的日期');
    expect(text).toContain('备份未包含的日期会保留');
    expect(text).not.toMatch(/失败|损坏|无效|错误/);
  });
});
