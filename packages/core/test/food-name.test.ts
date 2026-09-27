/**
 * 食物名归一化 / 区分词单测（`packages/core/src/food/name.ts`）。
 *
 * 覆盖：
 * - `isMeaninglessQualifier`：无区分意义的四类（统计标记 / 纯数值 / 品牌后缀 / 品牌产地）
 *   与**有区分意义**的形态、口味、部位规格（不得被误丢）；
 * - `foodQualifiers`：区分词提取（含中文/英文分隔符拆分、空括号、无括号）；
 * - `foodDisplayQualifiers` / `isDisplayNoiseQualifier`：**展示口径** —— 在去重口径之上再滤掉
 *   品牌 / 营养声称 / 产地补充（`力多精1` / `无糖` / `高钙` / `日本种`），保留规格形态（`袋装`/`脱脂`/`干`）；
 * - `foodDedupKey`：跨源去重比对键 —— 「干 vs 鲜」**不归一**（P2-2 回归）、真同名**仍归一**、
 *   同物异写法归一、去空白/标点、转小写；**品牌保留**（品牌不同 → 不归一，避免误合并丢数据）。
 *
 * ⚠️ 这里是**单一真源**：种子合并（`merge-seeds.ts`）与搜索区分（`/api/foods/search`）
 * 共用同一份规则，改规则必须同步改这里。
 */

import { describe, expect, it } from 'vitest';

import {
  foodDedupKey,
  foodDisplayQualifiers,
  foodQualifiers,
  isDisplayNoiseQualifier,
  isMeaninglessQualifier,
} from '../src/food/name';

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

describe('isDisplayNoiseQualifier / foodDisplayQualifiers（展示口径）', () => {
  it('品牌（含型号后缀）属于展示噪声', () => {
    expect(isDisplayNoiseQualifier('力多精1')).toBe(true);
    expect(isDisplayNoiseQualifier('爱力大2')).toBe(true);
    expect(isDisplayNoiseQualifier('美素力H')).toBe(true);
    expect(isDisplayNoiseQualifier('安儿宝A+')).toBe(true);
    expect(isDisplayNoiseQualifier('安儿健A+')).toBe(true);
    expect(isDisplayNoiseQualifier('帕玛拉特')).toBe(true);
    expect(isDisplayNoiseQualifier('美素高')).toBe(true);
    expect(isDisplayNoiseQualifier('适体健')).toBe(true);
  });

  it('营养声称 / 强化属于展示噪声', () => {
    expect(isDisplayNoiseQualifier('无糖')).toBe(true);
    expect(isDisplayNoiseQualifier('無加糖')).toBe(true);
    expect(isDisplayNoiseQualifier('高钙')).toBe(true);
    expect(isDisplayNoiseQualifier('高蛋白')).toBe(true);
    expect(isDisplayNoiseQualifier('高钙高铁')).toBe(true);
    expect(isDisplayNoiseQualifier('强化锌')).toBe(true);
    expect(isDisplayNoiseQualifier('低钠')).toBe(true);
  });

  it('产地补充属于展示噪声', () => {
    expect(isDisplayNoiseQualifier('日本种')).toBe(true);
  });

  it('空 / 纯空白 token → 展示噪声（不留无意义标签）', () => {
    expect(isDisplayNoiseQualifier('')).toBe(true);
    expect(isDisplayNoiseQualifier('   ')).toBe(true);
  });

  it('形态 / 口味 / 部位规格**不是**展示噪声（不得过度收紧）', () => {
    expect(isDisplayNoiseQualifier('干')).toBe(false);
    expect(isDisplayNoiseQualifier('鲜')).toBe(false);
    expect(isDisplayNoiseQualifier('煮')).toBe(false);
    expect(isDisplayNoiseQualifier('罐头')).toBe(false);
    expect(isDisplayNoiseQualifier('香辣味')).toBe(false);
    // 配方规格（脱脂 vs 全脂热量差异大）：保留
    expect(isDisplayNoiseQualifier('脱脂')).toBe(false);
    expect(isDisplayNoiseQualifier('部分脱脂')).toBe(false);
    expect(isDisplayNoiseQualifier('加糖')).toBe(false);
    // 包装规格：保留
    expect(isDisplayNoiseQualifier('袋装')).toBe(false);
    expect(isDisplayNoiseQualifier('简装')).toBe(false);
  });

  it('品牌当区分词（P3-1 回归）：奶粉条目不再标品牌', () => {
    expect(foodDisplayQualifiers('婴儿配方奶粉(力多精1，雀巢)')).toEqual([]);
    expect(foodDisplayQualifiers('幼儿奶粉(美素高)')).toEqual([]);
    expect(foodDisplayQualifiers('较大婴儿配方奶粉(美素乐2)')).toEqual([]);
    expect(foodDisplayQualifiers('婴儿配方奶粉(美素力H)')).toEqual([]);
    expect(foodDisplayQualifiers('婴儿配方奶粉(爱儿乐，惠氏，简装)')).toEqual(['简装']);
    expect(foodDisplayQualifiers('幼儿奶粉(美素高，袋装)')).toEqual(['袋装']);
  });

  it('营养声称 / 产地当区分词（P3-1 回归）：不再展示但去重口径不受影响', () => {
    expect(foodDisplayQualifiers('美式咖啡（无糖）')).toEqual([]);
    expect(foodDisplayQualifiers('速溶茶（无糖）')).toEqual([]);
    expect(foodDisplayQualifiers('柿子（日本种）')).toEqual([]);
    expect(foodDisplayQualifiers('婴儿奶粉(高钙，圣元牌)')).toEqual([]);
    // 但去重口径（foodQualifiers）仍保留营养声称与品牌型号：dedup key 不变
    expect(foodQualifiers('美式咖啡（无糖）')).toEqual(['无糖']);
    expect(foodQualifiers('婴儿配方奶粉(力多精1，雀巢)')).toEqual(['力多精1']);
  });

  it('品牌 + 规格混排：只去品牌，规格保留', () => {
    expect(foodDisplayQualifiers('牛乳(脱脂，帕玛拉特)')).toEqual(['脱脂']);
    expect(foodDisplayQualifiers('牛乳(部分脱脂，帕玛拉特)')).toEqual(['部分脱脂']);
    expect(foodDisplayQualifiers('牛乳(强化锌、钙，帕玛拉特)')).toEqual([]);
  });

  it('形态词必须保留（这个功能的全部价值）', () => {
    expect(foodDisplayQualifiers('蘑菇(干)')).toEqual(['干']);
    expect(foodDisplayQualifiers('蘑菇（鲜蘑）')).toEqual(['鲜蘑']);
    expect(foodDisplayQualifiers('蘑菇（罐头）')).toEqual(['罐头']);
    expect(foodDisplayQualifiers('苹果')).toEqual([]);
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

  it('品牌保留在去重键里：不同品牌奶粉**不**归一（展示口径与去重口径分离）', () => {
    expect(foodDedupKey('婴儿配方奶粉(力多精1，雀巢)')).not.toBe(
      foodDedupKey('婴儿配方奶粉(爱儿乐，惠氏)'),
    );
    // 展示口径会把这个品牌滤掉，但去重键仍带品牌 → 不误合并
    expect(foodDisplayQualifiers('婴儿配方奶粉(力多精1，雀巢)')).toEqual([]);
  });
});
