/**
 * 「我的常点」接线测试（C2，pages/tools/ToolsPage.tsx）。
 *
 * 钉死五件事：
 * ① 改过档位后重新打开 → 默认选中上次常点的（外卖品类 / 饮品的品类 + 杯型 + 糖度）；
 * ② 没有记忆时回落默认档位，不出现「预选好了」的提示；
 * ③ 本地缓存被改坏 → 不崩，回落默认（记忆只是省事，不能让工具打不开）；
 * ④ **不改变估算输出**：有记忆与无记忆下，同一档位渲染出的热量区间完全一致；
 * ⑤ **只记忆不评判**：页面不出现「推荐 / 更健康 / 超标 / 少喝点」等评判式措辞。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DRINK_LIBRARY, TAKEOUT_LIBRARY, estimateDrink, estimateTakeout } from '@qsh/core';

import ToolsPage from '@/pages/tools/ToolsPage';
import { CACHE_KEYS, cacheClearAll, cacheSet } from '@/lib/local-cache';

function renderTools(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ToolsPage />
    </MemoryRouter>,
  );
}

/** 切到某个工具 tab。 */
function openTab(label: string): void {
  fireEvent.click(screen.getByRole('tab', { name: label }));
}

/** 直接写一份记忆（白盒 setup：结构与 core 一致）。 */
function seedMemory(memory: unknown): void {
  cacheSet(CACHE_KEYS.toolChoices, memory);
}

describe('ToolsPage「我的常点」（C2）', () => {
  beforeEach(() => {
    cacheClearAll();
  });

  it('外卖：换过品类后重新打开 → 默认选中常点的那个，且估算区间不变', () => {
    const { unmount } = renderTools();
    const select = screen.getByLabelText('常点的品类') as HTMLSelectElement;
    expect(select.value).toBe('malatang');

    fireEvent.change(select, { target: { value: 'burger' } });
    expect((screen.getByLabelText('常点的品类') as HTMLSelectElement).value).toBe('burger');

    // 估算输出仍是汉堡套餐自己的区间（记忆不改写估算）
    const expected = estimateTakeout('burger');
    expect(document.body.textContent).toContain(`${expected?.range.min}–${expected?.range.max}`);

    unmount();
    renderTools();

    // 下次打开：默认就是常点的品类
    expect((screen.getByLabelText('常点的品类') as HTMLSelectElement).value).toBe('burger');
    expect(document.body.textContent).toContain(`${expected?.range.min}–${expected?.range.max}`);
    // 中性提示：只是说明「为什么是这个」，不做推荐
    expect(screen.getByText('按你常点的先选好了，换一个也随时可以')).toBeInTheDocument();
  });

  it('饮品：品类 + 杯型 + 糖度一起被记住，重开后全部预选', () => {
    const { unmount } = renderTools();
    openTab('饮品计算');

    fireEvent.change(screen.getByLabelText('饮品'), { target: { value: 'latte' } });
    fireEvent.change(screen.getByLabelText('糖度'), { target: { value: 'half' } });
    fireEvent.change(screen.getByLabelText('杯型 ml'), { target: { value: '360' } });

    unmount();
    renderTools();
    openTab('饮品计算');

    expect((screen.getByLabelText('饮品') as HTMLSelectElement).value).toBe('latte');
    expect((screen.getByLabelText('糖度') as HTMLSelectElement).value).toBe('half');
    expect((screen.getByLabelText('杯型 ml') as HTMLInputElement).value).toBe('360');

    // 估算输出与「手动选到同一档位」完全一致（记忆不参与计算）
    const expected = estimateDrink('latte', 360, 'half');
    expect(document.body.textContent).toContain(`${expected.range.min}–${expected.range.max}`);
  });

  it('没有记忆 → 回落默认档位，且不显示预选提示', () => {
    renderTools();
    expect((screen.getByLabelText('常点的品类') as HTMLSelectElement).value).toBe('malatang');
    expect(screen.queryByText('按你常点的先选好了，换一个也随时可以')).toBeNull();

    openTab('饮品计算');
    expect((screen.getByLabelText('饮品') as HTMLSelectElement).value).toBe('milk_tea');
    expect((screen.getByLabelText('糖度') as HTMLSelectElement).value).toBe('regular');
  });

  it('本地缓存被改坏（非 JSON / 结构不对）→ 不崩，回落默认档位', () => {
    window.localStorage.setItem(CACHE_KEYS.toolChoices, '{not-json');
    renderTools();
    expect((screen.getByLabelText('常点的品类') as HTMLSelectElement).value).toBe('malatang');

    // 结构对但内容脏（缺 days / values 类型不对）→ 该条丢弃，页面照常
    seedMemory({ version: 1, tools: { takeout: [{ key: 'kind=burger' }, { key: 2, days: ['2026-09-12'] }] } });
    renderTools();
    expect((screen.getByLabelText('常点的品类') as HTMLSelectElement).value).toBe('malatang');
  });

  it('记忆里已经不存在的品类（库里下架）不会被拿去预选', () => {
    seedMemory({
      version: 1,
      tools: { takeout: [{ key: 'kind=unknown_kind', values: { kind: 'unknown_kind' }, days: ['2026-09-01', '2026-09-02'] }] },
    });
    renderTools();
    expect((screen.getByLabelText('常点的品类') as HTMLSelectElement).value).toBe('malatang');
    // 仍然是合法品类之一，不会渲染出一个空选项
    expect(TAKEOUT_LIBRARY.map((item) => item.kind)).toContain('malatang');
  });

  it('只记忆不评判：预选提示出现，页面不出现推荐 / 更健康 / 超标类措辞', () => {
    seedMemory({
      version: 1,
      tools: {
        drink: [
          {
            key: 'kind=milk_tea&size=500&sugar=regular',
            values: { kind: 'milk_tea', size: '500', sugar: 'regular' },
            days: ['2026-09-01', '2026-09-02'],
          },
        ],
      },
    });
    renderTools();
    openTab('饮品计算');

    const text = document.body.textContent ?? '';
    expect(text).toContain('按你常点的先选好了');
    expect(text).not.toMatch(/推荐你|更健康|超标|少喝点|不该喝/);
    // 换成别的饮品也照常估算，不因为「常点的是奶茶」而多说一句
    fireEvent.change(screen.getByLabelText('饮品'), { target: { value: 'cola' } });
    const expected = estimateDrink('cola', 500, 'regular');
    expect(document.body.textContent).toContain(`${expected.range.min}–${expected.range.max}`);
    expect(DRINK_LIBRARY.map((item) => item.kind)).toContain('cola');
  });
});
