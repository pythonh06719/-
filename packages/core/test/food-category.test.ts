/**
 * 食物分类唯一口径单测（`packages/core/src/food/category.ts`，「食物库数据质量」T1）。
 *
 * 覆盖：
 * - 9 类枚举与 `schema.prisma` 一致、类型守卫；
 * - `mapFoodCategory` 四级判定（已是合法类 / 直接值映射 / 关键词兜底 / other）；
 * - 关键去歧义案例（零食 vs 奶茶、调味 vs 蔬菜、外卖、复合「蛋白 + 主食」名）；
 * - 旧的 OFF 口径 `饮料` 现统一为 `奶茶`（回归防漂移）。
 */

import { describe, expect, it } from 'vitest';

import {
  CFCD_CATEGORY_BY_PATH,
  DEFAULT_FOOD_CATEGORY,
  FOOD_CATEGORIES,
  FOOD_CATEGORY_BY_NAME,
  FOOD_CATEGORY_LABELS,
  classifyCategoryByKeywords,
  foodCategoryLabel,
  isFoodCategory,
  mapFoodCategory,
  resolveCfcdCategory,
} from '../src/index';

/** 权威 9 类（与 apps/api/prisma/schema.prisma 的注释/枚举一致）。 */
const EXPECTED = ['主食', '家常菜', '外卖', '奶茶', '零食', '水果', '蔬菜', '蛋白', 'other'] as const;

describe('FOOD_CATEGORIES：权威 9 类', () => {
  it('枚举恰为 9 类且顺序稳定', () => {
    expect([...FOOD_CATEGORIES]).toEqual([...EXPECTED]);
    expect(FOOD_CATEGORIES).toHaveLength(9);
  });

  it('默认兜底为 other', () => {
    expect(DEFAULT_FOOD_CATEGORY).toBe('other');
  });
});

describe('FOOD_CATEGORY_LABELS / foodCategoryLabel：展示名', () => {
  it('label 表覆盖 FOOD_CATEGORIES 全集且值均为非空字符串（防将来加类漏补 label）', () => {
    for (const category of FOOD_CATEGORIES) {
      const label = FOOD_CATEGORY_LABELS[category];
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
    // 不多不少：键集合与枚举集合完全一致
    expect(Object.keys(FOOD_CATEGORY_LABELS).sort()).toEqual([...FOOD_CATEGORIES].sort());
  });

  it('只有 other 被翻译成「其他」，8 个中文类的 label 等于其自身', () => {
    expect(FOOD_CATEGORY_LABELS.other).toBe('其他');
    for (const category of FOOD_CATEGORIES) {
      if (category === 'other') continue;
      expect(FOOD_CATEGORY_LABELS[category]).toBe(category);
    }
  });

  it('foodCategoryLabel 对枚举内取值正确', () => {
    expect(foodCategoryLabel('主食')).toBe('主食');
    expect(foodCategoryLabel('other')).toBe('其他');
  });

  it('枚举外的未知值原样返回（不丢信息、不归到「其他」、不抛错）', () => {
    expect(foodCategoryLabel('未来新类')).toBe('未来新类');
    expect(foodCategoryLabel('')).toBe('');
    // 与 `DEFAULT_FOOD_CATEGORY` 的兜底语义不同：这里不做归类，只做展示
    expect(foodCategoryLabel('other')).not.toBe(DEFAULT_FOOD_CATEGORY);
  });
});

describe('isFoodCategory：类型守卫', () => {
  it('9 类均判为合法', () => {
    for (const category of EXPECTED) {
      expect(isFoodCategory(category)).toBe(true);
    }
  });

  it('脏值 / 非字符串一律非法', () => {
    for (const bad of ['饮料', '饮品', '包装食品', '菌菇', 'beverages', '', 'other ', null, undefined, 123, {}]) {
      expect(isFoodCategory(bad)).toBe(false);
    }
  });
});

describe('mapFoodCategory：四级判定', () => {
  it('① 已是合法类 → 原样返回（不看名字）', () => {
    for (const category of EXPECTED) {
      expect(mapFoodCategory(category, '随便什么名字')).toBe(category);
    }
  });

  it('② 直接值映射（USDA 中文归类）', () => {
    expect(mapFoodCategory('菌菇', '香菇（干）')).toBe('蔬菜');
    expect(mapFoodCategory('蔬菜', '毛豆（生）')).toBe('蔬菜');
    expect(mapFoodCategory('豆制品', '北豆腐（卤水）')).toBe('蛋白');
    expect(mapFoodCategory('豆类', '黄豆（干）')).toBe('蛋白');
    expect(mapFoodCategory('水产', '淡水鲈鱼')).toBe('蛋白');
    expect(mapFoodCategory('肉禽蛋', '火腿（去骨）')).toBe('蛋白');
    expect(mapFoodCategory('坚果', '腰果')).toBe('零食');
    expect(mapFoodCategory('酒饮', '清酒（米酒）')).toBe('奶茶');
    expect(mapFoodCategory('米面制品', '粉丝（干）')).toBe('主食');
    expect(mapFoodCategory('食用油', '大豆油')).toBe('other');
  });

  it('② 直接值映射（OFF 原始 tag）', () => {
    expect(mapFoodCategory('beverages', '可口可乐')).toBe('奶茶');
    expect(mapFoodCategory('dairies', '纯牛奶')).toBe('奶茶');
    expect(mapFoodCategory('Sports drink', 'Aquarus')).toBe('奶茶');
    expect(mapFoodCategory('snacks', '茎わかめ')).toBe('零食');
    expect(mapFoodCategory('Gum', '丸川彩球')).toBe('零食');
    expect(mapFoodCategory('meats', '泡翅')).toBe('蛋白');
    expect(mapFoodCategory('condiments', '精选老抽')).toBe('other');
    // 「銀耳露」是饮品（P3-③ 修正原误映射：蔬菜 → 奶茶）
    expect(mapFoodCategory('銀耳露', '某冷饮')).toBe('奶茶');
  });

  it('③ 关键词兜底（按食物名，覆盖「包装食品」等粗值）', () => {
    expect(mapFoodCategory('包装食品', '康师傅 冰红茶')).toBe('奶茶');
    expect(mapFoodCategory('包装食品', '雞胸肉')).toBe('蛋白');
    expect(mapFoodCategory('包装食品', '義大利香料')).toBe('other');
    expect(mapFoodCategory('plant', '烘烤混合坚果仁')).toBe('零食');
    expect(mapFoodCategory('plant', '高纤维全麦切片面包')).toBe('主食');
    expect(mapFoodCategory('包装食品', '洋香瓜')).toBe('水果');
    expect(mapFoodCategory('包装食品', '一日野菜活力彩蔬')).toBe('蔬菜');
  });

  it('③ 关键词兜底（原值本身含关键词）', () => {
    // 旧 OFF 口径「饮料」已从枚举移除 → 应落到「奶茶」
    expect(mapFoodCategory('饮料', undefined)).toBe('奶茶');
    expect(mapFoodCategory('饮品', undefined)).toBe('奶茶');
  });

  it('④ 判不出 → other（绝不硬塞）', () => {
    expect(mapFoodCategory('包装食品', '生粉')).toBe('other');
    expect(mapFoodCategory('包装食品', '十三香')).toBe('other');
    expect(mapFoodCategory('', '')).toBe('other');
    expect(mapFoodCategory(null, null)).toBe('other');
    expect(mapFoodCategory(undefined, undefined)).toBe('other');
    expect(mapFoodCategory('包装食品', undefined)).toBe('other');
  });
});

describe('FOOD_CATEGORY_BY_NAME：精确名定点覆盖（P3-③）', () => {
  it('覆盖优先于「已是合法类」的短路（锁定条目也能纠偏）', () => {
    // 出前一丁：原为 other，名无品类词；即便传入合法值也应被覆盖为「主食」
    expect(mapFoodCategory('other', '出前一丁')).toBe('主食');
    expect(mapFoodCategory('other', '香草烤雞腿時蔬餐')).toBe('外卖');
    // 含「蝦/魚/豬」的薄脆零食，曾被蛋白规则抢走
    expect(mapFoodCategory('蛋白', '櫻花蝦味薄脆豬')).toBe('零食');
    expect(mapFoodCategory('蛋白', '海苔味薄脆魚')).toBe('零食');
    expect(mapFoodCategory('蛋白', '香辣小龍蝦味')).toBe('零食');
    // 「銀耳露」是饮品（直映射 + 名覆盖双重保障）
    expect(mapFoodCategory('蔬菜', '有機紅棗枸杞銀耳露')).toBe('奶茶');
    expect(mapFoodCategory('蔬菜', '菊花枸杞銀耳露')).toBe('奶茶');
    // 同型补漏：饭团（零食 → 主食）、品牌名乳品（other → 奶茶）
    expect(mapFoodCategory('零食', '炭燒雞肉藜麥飯團')).toBe('主食');
    expect(mapFoodCategory('other', '完达山')).toBe('奶茶');
  });

  it('覆盖表值恒为 9 类之一', () => {
    for (const value of Object.values(FOOD_CATEGORY_BY_NAME)) {
      expect(EXPECTED).toContain(value);
    }
  });
});

describe('classifyCategoryByKeywords：顺序去歧义', () => {
  it('零食高区分度词先于奶茶（牛奶巧克力 → 零食）', () => {
    expect(classifyCategoryByKeywords('牛奶巧克力')).toBe('零食');
    expect(classifyCategoryByKeywords('Premium特濃抹茶巧克力雪糕')).toBe('零食');
  });

  it('零食形态词（薄脆/脆片）先于蛋白（P3-③）', () => {
    expect(classifyCategoryByKeywords('櫻花蝦味薄脆豬')).toBe('零食');
    expect(classifyCategoryByKeywords('海苔味薄脆魚')).toBe('零食');
  });

  it('奶茶词（黑糖奶茶 → 奶茶）', () => {
    expect(classifyCategoryByKeywords('黑糖奶茶 Pro')).toBe('奶茶');
    expect(classifyCategoryByKeywords('Beverages, Sparkling waters')).toBe('奶茶');
  });

  it('调味/酱料先于蔬菜/蛋白（番茄沙司 / 干贝酱 → other）', () => {
    expect(classifyCategoryByKeywords('亨氏番茄沙司')).toBe('other');
    expect(classifyCategoryByKeywords('干貝醬')).toBe('other');
    expect(classifyCategoryByKeywords('薄盐生抽')).toBe('other');
  });

  it('外卖先于主食/蛋白（烤鸡便当 → 外卖）', () => {
    expect(classifyCategoryByKeywords('香草烤雞便當')).toBe('外卖');
  });

  it('主食先于蛋白/蔬菜（复合名 → 主食）', () => {
    expect(classifyCategoryByKeywords('酸菜牛肉麵')).toBe('主食');
    expect(classifyCategoryByKeywords('麻婆豆腐飯')).toBe('主食');
    expect(classifyCategoryByKeywords('豬肉水餃')).toBe('主食');
  });

  it('奶茶先于水果（苹果牛奶 → 奶茶）', () => {
    expect(classifyCategoryByKeywords('蘋果牛奶')).toBe('奶茶');
  });

  it('未命中 / 空输入 → null', () => {
    expect(classifyCategoryByKeywords('')).toBeNull();
    expect(classifyCategoryByKeywords('   ')).toBeNull();
    expect(classifyCategoryByKeywords(null)).toBeNull();
    expect(classifyCategoryByKeywords(undefined)).toBeNull();
    expect(classifyCategoryByKeywords('zzz')).toBeNull();
  });

  it('输出恒为 9 类之一', () => {
    const samples = ['薯片', '牛奶', '牛肉面', '番茄', '苹果', '鸡胸肉', '酱', '便当', 'xyz'];
    for (const sample of samples) {
      const result = classifyCategoryByKeywords(sample);
      if (result !== null) {
        expect(EXPECTED).toContain(result);
      }
    }
  });
});

describe('resolveCfcdCategory：CFCD 二级分类映射（T2）', () => {
  it('按「一级/二级」路径精确命中', () => {
    expect(resolveCfcdCategory('谷类及制品', '稻米', '稻米(均值)')).toBe('主食');
    expect(resolveCfcdCategory('蛋类及制品', '鸡蛋', '鸡蛋(白皮)')).toBe('蛋白');
    expect(resolveCfcdCategory('蔬菜类及制品', '嫩茎、叶、花菜类', '菠菜')).toBe('蔬菜');
    expect(resolveCfcdCategory('水果类及制品', '仁果类', '苹果')).toBe('水果');
    expect(resolveCfcdCategory('饮料类', '碳酸饮料', '可乐')).toBe('奶茶');
    expect(resolveCfcdCategory('饮料类', '棒冰、冰淇凌', '雪糕')).toBe('零食');
    expect(resolveCfcdCategory('速食食品', '快餐食品', '汉堡')).toBe('外卖');
    expect(resolveCfcdCategory('调味品类', '酱油', '生抽')).toBe('other');
  });

  it('多个「其它」按路径消歧（仅凭二级名无法区分）', () => {
    expect(resolveCfcdCategory('谷类及制品', '其它', 'X')).toBe('主食');
    expect(resolveCfcdCategory('干豆类及制品', '其它', 'X')).toBe('蛋白');
    expect(resolveCfcdCategory('畜肉类及制品', '其它', 'X')).toBe('蛋白');
    expect(resolveCfcdCategory('饮料类', '其它', 'X')).toBe('奶茶');
  });

  it('未覆盖路径退回关键词（按食物名）', () => {
    expect(resolveCfcdCategory('未知一级', '未知二级', '雞胸肉')).toBe('蛋白');
    expect(resolveCfcdCategory('未知一级', '未知二级', 'zzz')).toBe('other');
  });

  it('映射表值恒为 9 类之一，且键均为「一级/二级」', () => {
    for (const [key, value] of Object.entries(CFCD_CATEGORY_BY_PATH)) {
      expect(EXPECTED).toContain(value);
      expect(key.split('/')).toHaveLength(2);
    }
  });
});
