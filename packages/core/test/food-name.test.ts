/**
 * 食物名归一化 / 区分词单测（`packages/core/src/food/name.ts`）。
 *
 * 覆盖：
 * - `isMeaninglessQualifier`：无区分意义的四类（统计标记 / 纯数值 / 品牌后缀 / 品牌产地）
 *   与**有区分意义**的形态、口味、部位规格（不得被误丢）；
 * - `foodQualifiers`：区分词提取（含中文/英文分隔符拆分、空括号、无括号）；
 * - `foodDedupKey`：跨源去重比对键 —— 「干 vs 鲜」**不归一**（P2-2 回归）、真同名**仍归一**、
 *   同物异写法归一、去空白/标点、转小写。
 *
 * ⚠️ 这里是**单一真源**：种子合并（`merge-seeds.ts`）与搜索区分（`/api/foods/search`）
 * 共用同一份规则，改规则必须同步改这里。
 */

import { describe, expect, it } from 'vitest';

import { foodDedupKey, foodQualifiers, isMeaninglessQualifier } from '../src/food/name';

describe('isMeaninglessQualifier', () => {
  it('统计标记类属于「无区分意义」', () => {
    expect(isMeaninglessQualifier('均值')).toBe(true);
    expect(isMeaninglessQualifier('代表值')).toBe(true);
    expect(isMeaninglessQualifier('平均')).toBe(true);
    expect(isMeaninglessQualifier('MEAN')).toBe(true);
    expect(isMeaninglessQualifier('avg')).toBe(true);
    expect(isMeaninglessQualifier('约')).toBe(true);
  });

  it('纯数值 / 百分比 / 温度 / 时长 / 度数属于「无区分意义」', () => {
    expect(isMeaninglessQualifier('38％')).toBe(true);
    expect(isMeaninglessQualifier('150℃')).toBe(true);
    expect(isMeaninglessQualifier('10分')).toBe(true);
    expect(isMeaninglessQualifier('55度')).toBe(true);
    expect(isMeaninglessQualifier('4.3％')).toBe(true);
  });

  it('品牌 / 产地补充说明属于「无区分意义」', () => {
    expect(isMeaninglessQualifier('可淇牌')).toBe(true);
    expect(isMeaninglessQualifier('三元牌')).toBe(true);
    expect(isMeaninglessQualifier('雀巢')).toBe(true);
    expect(isMeaninglessQualifier('中国')).toBe(true);
    expect(isMeaninglessQualifier('台湾')).toBe(true);
  });

  it('形态 / 口味 / 部位规格是「有区分意义」，不得丢弃', () => {
    // 形态
    expect(isMeaninglessQualifier('干')).toBe(false);
    expect(isMeaninglessQualifier('鲜')).toBe(false);
    expect(isMeaninglessQualifier('罐头')).toBe(false);
    expect(isMeaninglessQualifier('油浸')).toBe(false);
    expect(isMeaninglessQualifier('煮')).toBe(false);
    // 口味
    expect(isMeaninglessQualifier('烧烤味')).toBe(false);
    expect(isMeaninglessQualifier('香辣')).toBe(false);
    expect(isMeaninglessQualifier('草莓味')).toBe(false);
    // 部位 / 规格
    expect(isMeaninglessQualifier('北')).toBe(false);
    expect(isMeaninglessQualifier('南')).toBe(false);
    expect(isMeaninglessQualifier('内酯')).toBe(false);
    expect(isMeaninglessQualifier('白皮')).toBe(false);
    expect(isMeaninglessQualifier('干切面')).toBe(false);
  });
});

describe('foodQualifiers', () => {
  it('提取单个形态区分词', () => {
    expect(foodQualifiers('蘑菇(干)')).toEqual(['干']);
    expect(foodQualifiers('蘑菇(鲜蘑)')).toEqual(['鲜蘑']);
    expect(foodQualifiers('蘑菇（罐头）')).toEqual(['罐头']);
  });

  it('无括号 → 无区分词', () => {
    expect(foodQualifiers('苹果')).toEqual([]);
    expect(foodQualifiers('牛肉干')).toEqual([]);
  });

  it('括号内多个限定词按分隔符拆分，丢弃无区分意义的', () => {
    // 「草莓味」保留（口味），「卡夫牌」丢弃（品牌后缀）
    expect(foodQualifiers('牛奶(草莓味，卡夫牌)')).toEqual(['草莓味']);
    // 「中国」丢弃（产地），「干」保留（形态）
    expect(foodQualifiers('栗子（中国，干）')).toEqual(['干']);
    // 方括号同样识别
    expect(foodQualifiers('蘑菇[干]')).toEqual(['干']);
  });

  it('空括号 / 纯无区分意义 → 空数组', () => {
    expect(foodQualifiers('鸡(代表值)')).toEqual([]);
    expect(foodQualifiers('鸡()')).toEqual([]);
  });
});

describe('foodDedupKey', () => {
  it('🔴 形态不同 → 不归一（P2-2 回归：干紫菜曾被鲜紫菜误杀）', () => {
    expect(foodDedupKey('紫菜(干)')).not.toBe(foodDedupKey('紫菜（鲜）'));
    expect(foodDedupKey('海带(干)')).not.toBe(foodDedupKey('海带(鲜)'));
    expect(foodDedupKey('豆腐(北)')).not.toBe(foodDedupKey('豆腐(南)'));
    expect(foodDedupKey('鸡蛋(白皮)')).not.toBe(foodDedupKey('鸡蛋(红皮)'));
  });

  it('真同名 → 归一（放宽后不得把真重复也收进来）', () => {
    expect(foodDedupKey('苹果')).toBe(foodDedupKey('苹果'));
    expect(foodDedupKey('牛肉干')).toBe(foodDedupKey('牛肉干'));
    expect(foodDedupKey('蘑菇(干)')).toBe(foodDedupKey('蘑菇(干)'));
  });

  it('同物异写法（全/半角括号、空格、标点）→ 归一', () => {
    expect(foodDedupKey('绿豆(干)')).toBe(foodDedupKey('绿豆（干）'));
    expect(foodDedupKey('栗子 (干)')).toBe(foodDedupKey('栗子(干)'));
    expect(foodDedupKey('包子(猪肉馅)')).toBe(foodDedupKey('包子（猪肉馅）'));
  });

  it('去空白与常用标点、转小写', () => {
    expect(foodDedupKey(' 番茄 · 炒蛋 ')).toBe('番茄炒蛋');
    expect(foodDedupKey('Milk Tea')).toBe('milktea');
    expect(foodDedupKey('玉米(白，干)')).toBe('玉米白干');
  });

  it('与 identity 的显示名归一化是两套语义（本函数处理括号区分词）', () => {
    // 「紫菜(干)」的比对键带区分词；去括号主体仍是「紫菜」
    expect(foodDedupKey('紫菜(干)')).toBe('紫菜干');
    expect(foodDedupKey('紫菜')).toBe('紫菜');
  });
});
