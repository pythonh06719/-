/**
 * 拼音生成（食物库 seed 的 `namePinyin` **统一入口**）。
 *
 * 背景：`namePinyin` 是拼音搜索字段（`schema.prisma` 有 `ix_food_pinyin` 索引）。
 * 本模块把生成规则收敛到一处，供两个调用方复用、避免各写一套：
 * - `merge-seeds.ts`：每次合并种子后**自动补全**拼音（防止「记得单独跑一次」的人为遗漏）；
 * - `fill-pinyin.ts`：独立 CLI（仅用于修复**已存在**种子的拼音，不重新合并）。
 *
 * 约定（与既有 57 条本地样例一致，先看样例总结而来）：
 * - 取「食物名去掉括号限定词」后的主体（如「米饭（白，蒸）」→「米饭」→ `mifan`）；
 * - 全小写、无音调、无分隔符；`ü` 写作 `v`（如「圣女果」→ `shengnvguo`）；
 * - 主体不含中文（纯日文/英文名）→ **留空（宁缺勿错）**；
 *   例外（P3-②）：若主体为英文但**括号内有中文译名**（如 `Yak Milk Coffee (氂牛奶咖啡)`），
 *   则取括号内中文生成拼音（→ `maoniunakafei`）。
 *
 * 多音字准确性依赖 `pinyin-pro` 的词语词典（实测「重庆」→ chongqing、
 * 「干贝」→ ganbei、「猕猴桃」→ mihoutao 均正确）。
 */

import { pinyin } from 'pinyin-pro';

/** 含中日韩表意文字（汉字）。 */
const HAN = /[\u4e00-\u9fff]/;
/** 日文假名音节（平假名 / 片假名字母；**不含**中点「・」U+30FB 与长音符「ー」U+30FC，避免误判含「・」的中文名）。 */
const KANA = /[\u3041-\u3096\u30a1-\u30fa\u30fd-\u30ff]/;

/** 取括号限定词之前的主体（与既有样例约定一致）。 */
export function baseName(name: string): string {
  return name.split(/[（(]/)[0].trim();
}

/** 取第一个括号组内的内容（中/英文括号皆可）。 */
export function parenContent(name: string): string {
  const match = name.match(/[（(]([^）)]*)[）)]/);
  return match ? match[1].trim() : '';
}

/**
 * 生成拼音（无音调、小写、`ü`→`v`）；无法判定（名称含日文假名、或中英文主体均无中文）返回 `null`。
 *
 * 约定（与既有 57 条一致）：**优先取括号前主体**的中文（如「米饭（白，蒸）」→ `mifan`）；
 * 若主体无中文（如英文商品名 `Gaozi Sweet Chilli Sauce (高仔辣椒醬)`），则**退回括号内的
 * 中文译名**生成拼音（→ `gaozailajiaojiang`）——这是 P3-② 补的形态。
 *
 * @param name 食物名
 * @returns 拼音字符串；无法判定时为 `null`（调用方保持 `namePinyin` 为空）
 */
export function toPinyin(name: string): string | null {
  if (KANA.test(name)) {
    return null; // 日文商品名（如「茎わかめ」「さばみそ煮」）→ 宁缺勿错
  }
  const base = baseName(name) || name.trim();
  let source = base;
  if (!HAN.test(source)) {
    // 主体无中文 → 退回括号内中文译名；仍无中文则放弃（宁缺勿错）
    const inside = parenContent(name);
    if (!inside || !HAN.test(inside)) {
      return null; // 纯英文/数字名 → 宁缺勿错
    }
    source = inside;
  }
  const parts = pinyin(source, { toneType: 'none', type: 'array', nonZh: 'removed' });
  const joined = parts
    .join('')
    .toLowerCase()
    .replace(/ü/g, 'v')
    .replace(/[^a-z]/g, '');
  return joined.length > 0 ? joined : null;
}

/** 可补拼音的最小条目形状。 */
export interface PinyinTarget {
  name: string;
  namePinyin?: string | null;
  [key: string]: unknown;
}

/** 补拼音的结果统计。 */
export interface FillPinyinResult {
  /** 原本已有拼音、保持不变的数量。 */
  kept: number;
  /** 本次新补的数量。 */
  filled: number;
  /** 无法判定（纯日文/英文名）而保持为空的数量。 */
  skipped: string[];
}

/**
 * 就地为缺少 `namePinyin` 的条目补拼音（已有值不动）。
 *
 * @param items 条目数组（原地修改其 `namePinyin` 字段）
 * @returns 统计（原有 / 新补 / 跳过名称清单）
 */
export function fillPinyin<T extends PinyinTarget>(items: T[]): FillPinyinResult {
  let kept = 0;
  let filled = 0;
  const skipped: string[] = [];
  for (const item of items) {
    if (typeof item.namePinyin === 'string' && item.namePinyin.trim() !== '') {
      kept += 1;
      continue;
    }
    const py = toPinyin(item.name);
    if (py === null) {
      skipped.push(item.name);
      continue;
    }
    item.namePinyin = py;
    filled += 1;
  }
  return { kept, filled, skipped };
}
