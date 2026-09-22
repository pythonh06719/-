/**
 * 数据备份（C6）接线测试（pages/settings-data/SettingsDataPage.tsx）。
 *
 * 覆盖需求要求的三个动作 + 语气边界：
 * - **触发**：点「导出备份」→ 调 `GET /api/data/export` 并触发一次文件下载；
 * - **写入**：成功后把时间戳写进 `localStorage.lastBackupAt`；
 * - **文案**：据本机时间戳展示「上次备份于 X 天前 / 就是今天 / 还没有备份过」；
 * - **失败**：拿不到服务端数据时如实反馈，**不写时间戳、不下载**，也不出现催促词。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ExportJsonPayload } from '@qsh/shared-types';
import SettingsDataPage from '@/pages/settings-data/SettingsDataPage';
import { COPY, lastBackupLabel } from '@/lib/copy';
import { LAST_BACKUP_KEY, daysSinceLastBackup } from '@/lib/backup';
import { createEmptyExportPayload } from '@/lib/csv';

vi.mock('@/lib/download', () => ({
  downloadTextFile: vi.fn(),
  downloadExportBundle: vi.fn(),
  readTextFile: vi.fn(),
}));

import { downloadTextFile } from '@/lib/download';

/** 造一份服务端 `/data/export` 会返回的载荷（含 2 条体重，便于校验内容）。 */
function samplePayload(): ExportJsonPayload {
  const payload = createEmptyExportPayload('2026-09-12T00:00:00.000Z');
  payload.weights = [
    { date: '2026-09-01', weightKg: 60, note: '' },
    { date: '2026-09-02', weightKg: 59.8, note: '' },
  ];
  return payload;
}

/** stub 一次成功的 fetch（返回统一 `{ data, error }` 包装）。 */
function stubFetchOk(data: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data, error: null }),
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <SettingsDataPage />
    </MemoryRouter>,
  );
}

describe('SettingsDataPage 备份（C6）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('点「导出备份」→ 调 /api/data/export、下载文件、写入 lastBackupAt 并给出温和反馈', async () => {
    const payload = samplePayload();
    const fetchMock = stubFetchOk(payload);

    renderPage();
    // 从未备份 → 中性引导语
    expect(screen.getByTestId('last-backup')).toHaveTextContent(COPY.dataBackupNever);

    fireEvent.click(screen.getByRole('button', { name: COPY.dataBackupButton }));

    await waitFor(() => {
      expect(downloadTextFile).toHaveBeenCalledTimes(1);
    });

    // 触发：请求的是服务端权威导出端点
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/data/export');

    // 下载文件的形状：一个带日期的 JSON，内容是服务端返回的载荷
    const file = (downloadTextFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      fileName: string;
      mimeType: string;
      content: string;
    };
    expect(file.fileName).toMatch(/^qingshenghuo-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(file.mimeType).toContain('json');
    expect(JSON.parse(file.content).weights).toHaveLength(2);

    // 写入：时间戳落到本机
    const stored = window.localStorage.getItem(LAST_BACKUP_KEY);
    expect(stored).not.toBeNull();
    expect(Number.isNaN(Date.parse(stored ?? ''))).toBe(false);

    // 反馈：温和的完成语 + 状态行更新为「就是今天」
    expect(screen.getByText(COPY.dataBackupDone)).toBeInTheDocument();
    expect(screen.getByTestId('last-backup')).toHaveTextContent(COPY.dataBackupToday);
  });

  it('据本机时间戳展示「上次备份于 X 天前」', () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    window.localStorage.setItem(LAST_BACKUP_KEY, threeDaysAgo.toISOString());
    stubFetchOk(samplePayload());

    renderPage();

    expect(screen.getByTestId('last-backup')).toHaveTextContent('上次备份于 3 天前');
  });

  it('从未备份 → 兜底文案不含催促 / 恐吓词', () => {
    stubFetchOk(samplePayload());
    renderPage();

    const line = screen.getByTestId('last-backup').textContent ?? '';
    expect(line).toBe(COPY.dataBackupNever);
    for (const banned of ['尽快', '赶紧', '建议', '记得', '再不', '马上']) {
      expect(line).not.toContain(banned);
      expect(COPY.dataBackupDesc).not.toContain(banned);
    }
  });

  it('拿不到服务端数据 → 如实反馈失败，不写时间戳、不下载', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: COPY.dataBackupButton }));

    await waitFor(() => {
      expect(screen.getByText(COPY.dataBackupFailed)).toBeInTheDocument();
    });
    expect(downloadTextFile).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_BACKUP_KEY)).toBeNull();
    // 仍显示中性引导语（不因失败而变成警告）
    expect(screen.getByTestId('last-backup')).toHaveTextContent(COPY.dataBackupNever);
  });
});

describe('lastBackupLabel / daysSinceLastBackup（C6 纯函数）', () => {
  it('lastBackupLabel：null / NaN → 从未备份；0 → 就是今天；n → X 天前', () => {
    expect(lastBackupLabel(null)).toBe(COPY.dataBackupNever);
    expect(lastBackupLabel(Number.NaN)).toBe(COPY.dataBackupNever);
    expect(lastBackupLabel(0)).toBe(COPY.dataBackupToday);
    expect(lastBackupLabel(-2)).toBe(COPY.dataBackupToday);
    expect(lastBackupLabel(1)).toBe('上次备份于 1 天前');
    expect(lastBackupLabel(7.9)).toBe('上次备份于 7 天前');
  });

  it('daysSinceLastBackup：按本地日粒度算差，坏值返回 null', () => {
    const now = new Date(2026, 8, 12, 20, 0, 0); // 本地 2026-09-12 20:00
    // 用「本地时间构造」再转 ISO，避免测试依赖运行机器的时区
    expect(daysSinceLastBackup(new Date(2026, 8, 12, 0, 30).toISOString(), now)).toBe(0);
    expect(daysSinceLastBackup(new Date(2026, 8, 9, 23, 0).toISOString(), now)).toBe(3);
    expect(daysSinceLastBackup(null, now)).toBeNull();
    expect(daysSinceLastBackup('not-a-date', now)).toBeNull();
  });
});
