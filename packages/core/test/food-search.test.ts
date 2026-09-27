import { describe, expect, it } from 'vitest';

import {
  FOOD_SEARCH_DEFAULT_PAGE_SIZE,
  ORDER_RANK,
  foodQualifierLabel,
  matchFoodRank,
  pageFoodSearch,
  rankFoodSearch,
} from '../src/food/search';
import type { FoodSearchCandidate } from '../src/food/search';

/**
 * 食物搜索排序单测（阶段 2）。
 *
 * 覆盖率目标：三档相关度 + 稳定二级键 + 区分词标注 + 分页切片。
 * 这里同时**锁死红线**：排序函数**不接收任何营养字段**（类型上就排除了按热量排序）。
 */

function candidate(
  id: number,
  name: string,
  namePinyin: string | null = null,
  aliases: readonly string[] = [],
): FoodSearchCandidate {
  return { id, name, namePinyin, aliases };
}

describe('foodQualifierLabel 区分词标注', () => {
  it('有区分意义的括号限定词 → 拼成标注串', () => {
    expect(foodQualifierLabel('蘑菇(干)')).toBe('干');
    expect(foodQualifierLabel('豆腐（南豆腐）')).toBe('南豆腐');
    expect(foodQualifierLabel('牛肉干（香辣味）')).toBe('香辣味');
  });

  it('多个限定词用 · 连接（保留顺序）', () => {
    expect(foodQualifierLabel('花生(炒, 带壳)')).toBe('炒·带壳');
  });

  it('无括号 / 括号内容无区分意义 → null（UI 不渲染标签）', () => {
    expect(foodQualifierLabel('苹果')).toBeNull();
    expect(foodQualifierLabel('米饭(均值)')).toBeNull();
    expect(foodQualifierLabel('牛奶(38％)')).toBeNull();
  });

  it('方括号别名不标注（展示口径只看圆括号），圆括号仍标注', () => {
    expect(foodQualifierLabel('带鱼[白带鱼，刀鱼]')).toBeNull();
    expect(foodQualifierLabel('鲅鱼[马鲛鱼，燕鲅鱼，巴鱼]')).toBeNull();
    expect(foodQualifierLabel('豌豆(带荚,鲜)[回回豆]')).toBe('带荚·鲜');
    expect(foodQualifierLabel('黑豆[黑大豆](干)')).toBe('干');
  });
});

describe('matchFoodRank 相关度档位', () => {
  it('名称前缀 → prefix', () => {
    expect(matchFoodRank(candidate(1, '番茄炒蛋'), '番茄')).toBe(ORDER_RANK.prefix);
  });

  it('名称子串（非前缀）→ substring', () => {
    expect(matchFoodRank(candidate(1, '番茄炒蛋'), '炒蛋')).toBe(ORDER_RANK.substring);
  });

  it('拼音前缀 / 子串也算名称档位（拼音搜索同样要相关度优先）', () => {
    expect(matchFoodRank(candidate(1, '番茄', 'fanqie'), 'fanqie')).toBe(ORDER_RANK.prefix);
    expect(matchFoodRank(candidate(1, '番茄', 'fanqie'), 'qie')).toBe(ORDER_RANK.substring);
  });

  it('仅别名命中 → alias（排在名称命中之后）', () => {
    expect(matchFoodRank(candidate(1, '西红柿', 'xihongshi', ['番茄']), '番茄')).toBe(ORDER_RANK.alias);
  });

  it('别名是前缀命中也只给 alias 档：「番茄炒蛋」不能输给「西红柿」', () => {
    const egg = matchFoodRank(candidate(1, '番茄炒蛋'), '番茄');
    const xi = matchFoodRank(candidate(2, '西红柿', 'xihongshi', ['番茄']), '番茄');
    expect(egg).toBe(ORDER_RANK.prefix);
    expect(xi).toBe(ORDER_RANK.alias);
    expect(egg).toBeLessThan(xi);
  });

  it('取最好的一档：别名 + 名称前缀 → prefix', () => {
    expect(matchFoodRank(candidate(1, '番茄', 'fanqie', ['西红柿']), '番茄')).toBe(ORDER_RANK.prefix);
  });

  it('空关键词（浏览全部）→ 全部同档，交给 id 兜底', () => {
    expect(matchFoodRank(candidate(1, '苹果'), '')).toBe(ORDER_RANK.substring);
    expect(matchFoodRank(candidate(2, '香蕉'), '   ')).toBe(ORDER_RANK.substring);
  });

  it('匹配忽略大小写与空白', () => {
    expect(matchFoodRank(candidate(1, 'Oat Milk', 'oatmilk'), 'OAT')).toBe(ORDER_RANK.prefix);
    expect(matchFoodRank(candidate(1, 'Oat Milk', 'oat milk'), 'oatmilk')).toBe(ORDER_RANK.prefix);
  });

  it('全不命中 → 落到 alias 档（排最后，不丢条目）', () => {
    expect(matchFoodRank(candidate(1, '苹果'), '牛肉')).toBe(ORDER_RANK.alias);
  });
});

describe('rankFoodSearch 排序', () => {
  it('前缀 > 子串 > 仅别名：顺序按档位而非入库顺序', () => {
    const ranked = rankFoodSearch(
      [
        candidate(11, '西红柿', 'xihongshi', ['番茄']), // alias
        candidate(12, '鸡蛋番茄汤'), // substring
        candidate(13, '番茄炒蛋'), // prefix
      ],
      '番茄',
    );
    expect(ranked.map((hit) => hit.id)).toEqual([13, 12, 11]);
    expect(ranked.map((hit) => hit.rank)).toEqual([
      ORDER_RANK.prefix,
      ORDER_RANK.substring,
      ORDER_RANK.alias,
    ]);
  });

  it('同档内按 id 升序 —— 稳定分页的前提', () => {
    const ranked = rankFoodSearch(
      [candidate(30, '番茄酱'), candidate(10, '番茄'), candidate(20, '番茄汁')],
      '番茄',
    );
    expect(ranked.map((hit) => hit.id)).toEqual([10, 20, 30]);
  });

  it('输入顺序不影响输出顺序（纯函数、确定性）', () => {
    const a = rankFoodSearch([candidate(2, '番茄酱'), candidate(1, '番茄')], '番茄');
    const b = rankFoodSearch([candidate(1, '番茄'), candidate(2, '番茄酱')], '番茄');
    expect(a).toEqual(b);
  });

  it('排序结果带区分词：跨来源同物异名靠标注区分，不合并', () => {
    const ranked = rankFoodSearch(
      [
        candidate(1, '蘑菇（鲜蘑）', 'mogu'),
        candidate(2, '蘑菇(干)', 'mogu'),
        candidate(3, '蘑菇（罐头）', 'mogu'),
      ],
      '蘑菇',
    );
    expect(ranked.map((hit) => hit.qualifier)).toEqual(['鲜蘑', '干', '罐头']);
  });

  it('空关键词 → 全部同档、按 id 升序（浏览全部不出乱序）', () => {
    const ranked = rankFoodSearch([candidate(5, '苹果'), candidate(3, '香蕉'), candidate(4, '梨')], '');
    expect(ranked.map((hit) => hit.id)).toEqual([3, 4, 5]);
  });

  it('空候选 → 空数组', () => {
    expect(rankFoodSearch([], '番茄')).toEqual([]);
  });
});

describe('pageFoodSearch 稳定分页', () => {
  const ranked = rankFoodSearch(
    Array.from({ length: 7 }, (_, index) => candidate(index + 1, `番茄${index + 1}`)),
    '番茄',
  );

  it('按页切片且顺序与排序一致', () => {
    expect(pageFoodSearch(ranked, 1, 3)).toEqual([1, 2, 3]);
    expect(pageFoodSearch(ranked, 2, 3)).toEqual([4, 5, 6]);
    expect(pageFoodSearch(ranked, 3, 3)).toEqual([7]);
  });

  it('越界页 → 空数组（不报错）', () => {
    expect(pageFoodSearch(ranked, 99, 3)).toEqual([]);
  });

  it('非法页码 / 条数 → 兜底为第 1 页与默认条数（默认 20 > 7，故返回全部）', () => {
    expect(pageFoodSearch(ranked, 0, 3)).toEqual([1, 2, 3]);
    expect(pageFoodSearch(ranked, 1, 0)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 默认条数常量确实是 20（前后端分页步长的单一真源）
    expect(FOOD_SEARCH_DEFAULT_PAGE_SIZE).toBe(20);
  });
});
