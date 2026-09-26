/**
 * 食物分类唯一口径（「食物库数据质量」修复 T1）。
 *
 * 背景：`food_items.category` 的**权威枚举**是 `apps/api/prisma/schema.prisma`
 * 里的 9 类：`主食 / 家常菜 / 外卖 / 奶茶 / 零食 / 水果 / 蔬菜 / 蛋白 / other`。
 * 但历史数据里出现了 **59 种**取值，根因是三处口径各写一份、互不相等：
 *
 * - 种子合并脚本 `infra/db/seed/merge-seeds.mjs` 原样透传来源侧的分类；
 * - 采集脚本 `infra/db/seed/fetch-off-items.mjs` 把 OFF 原始 tag 截断入库；
 * - 在线兜底 `apps/api/src/foods/external/off.client.ts` 的 `CATEGORY_RULES`
 *   又会产出 schema 里根本没有的 `饮料`。
 *
 * 修复策略：**把分类映射收敛到本模块，作为前后端 / 脚本的唯一真源**（K12：零 IO
 * 纯函数；项目已吃过「两处各写一份导致漂移」的教训）。`off.client.ts`、
 * `merge-seeds` / 数据修复脚本、`prisma/seed.ts` 的校验一律引用这里。
 *
 * 判定顺序（`mapFoodCategory`）：
 *   1. 值本身已是合法类 → 原样返回；
 *   2. **直接值映射表** `FOOD_CATEGORY_BY_RAW`（USDA 人工归类 / OFF 明确的英文 tag）；
 *   3. **关键词兜底** `classifyCategoryByKeywords`（按食物名，覆盖 `包装食品` 等粗值）；
 *   4. 仍判不出 → `other`（**绝不硬塞**到不相干的类）。
 */

/** 权威分类枚举（与 `schema.prisma` 的 9 类严格一致，顺序即展示顺序）。 */
export const FOOD_CATEGORIES = [
  '主食',
  '家常菜',
  '外卖',
  '奶茶',
  '零食',
  '水果',
  '蔬菜',
  '蛋白',
  'other',
] as const;

/** 分类联合类型。 */
export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

/** 兜底分类。 */
export const DEFAULT_FOOD_CATEGORY: FoodCategory = 'other';

/** 枚举集合（用于 O(1) 判定）。 */
const FOOD_CATEGORY_SET: ReadonlySet<string> = new Set<string>(FOOD_CATEGORIES);

/** 值是否为合法分类（类型守卫）。 */
export function isFoodCategory(value: unknown): value is FoodCategory {
  return typeof value === 'string' && FOOD_CATEGORY_SET.has(value);
}

/**
 * 直接值映射表：原始分类文本（小写化后）→ 9 类。
 *
 * 仅收录**判定明确**的来源值；含义模糊、需按名字再判的值（如 `包装食品` / `plant`）
 * 一律不进表，交由关键词兜底，避免把不相干的条目硬塞进某类。
 */
export const FOOD_CATEGORY_BY_RAW: Readonly<Record<string, FoodCategory>> = {
  // ---- 中文值（USDA 精选人工归类 + 本地样例历史口径）----
  蔬菜: '蔬菜',
  菌菇: '蔬菜',
  水果: '水果',
  豆制品: '蛋白',
  豆类: '蛋白',
  水产: '蛋白',
  肉禽蛋: '蛋白',
  酒饮: '奶茶',
  饮品: '奶茶',
  主食: '主食',
  米面制品: '主食',
  零食: '零食',
  坚果: '零食',
  食用油: 'other',
  // ---- OFF 原始 tag（英文 / 日文 / 繁体，判定明确者）----
  beverages: '奶茶',
  beverage: '奶茶',
  dairies: '奶茶',
  dairy: '奶茶',
  'sports drink': '奶茶',
  'sugar cane drink': '奶茶',
  経口補水液: '奶茶',
  飲み物: '奶茶',
  'tea drinks': '奶茶',
  茶饮料: '奶茶',
  全脂灭菌纯牛奶: '奶茶',
  全脂灭菌乳: '奶茶',
  牛奶: '奶茶',
  'bottled oriental bea': '奶茶',
  snacks: '零食',
  snack: '零食',
  desserts: '零食',
  dessert: '零食',
  gum: '零食',
  'spicy crisps': '零食',
  膨化食品: '零食',
  夾心餅乾: '零食',
  夹心饼干: '零食',
  銅鑼燒: '零食',
  腰果: '零食',
  果冻: '零食',
  月饼: '零食',
  condiments: 'other',
  fats: 'other',
  'light soy sauce': 'other',
  酿造酱油: 'other',
  meats: '蛋白',
  酱卤肉制品: '蛋白',
  'dried fish': '蛋白',
  'pork jerky': '蛋白',
  meals: '主食',
  meal: '主食',
  'tremella fuciformis': '蔬菜',
  銀耳露: '蔬菜',
};

/**
 * 关键词规则（**顺序敏感，先具体后笼统**；首个命中即返回）。
 *
 * 说明：
 * - 规则按食物名匹配，关键词一律小写（匹配前会先 `toLowerCase()`）；
 * - **调味/酱料（other）排最前**：否则「番茄沙司」「辣椒酱」「干贝酱」会被
 *   蔬菜的 `番茄/辣椒`、蛋白的 `贝` 抢走；
 * - 高区分度零食（巧克力 / 雪糕 / 薯片…）排在外卖/主食之前、奶茶之前，
 *   避免被奶茶的 `奶`/`茶` 类词误抢（如「牛奶巧克力」应判零食而非奶茶）；
 * - 外卖先于主食/蛋白（「香草烤鸡便当」应判外卖）；主食先于蛋白/蔬菜，
 *   处理「牛肉面」「鸡肉饭」这类「蛋白 + 主食」复合名；但**不含**裸 `粉`，
 *   以免「生粉 / 蛋白粉」被误判为主食。
 */
const CATEGORY_KEYWORD_RULES: ReadonlyArray<{ keywords: readonly string[]; category: FoodCategory }> = [
  // 1) 调味 / 酱料 / 油脂 / 淀粉 / 补充剂 → other
  //    必须先于蔬菜/蛋白，否则「番茄沙司」「辣椒酱」「干贝酱」会被「番茄/辣椒/贝」抢走。
  {
    keywords: [
      '酱', '醬', '沙司', '酱油', '醬油', '老抽', '生抽', '香料', '香辛', '生粉',
      '淀粉', '澱粉', 'sauce', 'seasoning', 'spice', 'starch', 'condiment', 'supplement',
    ],
    category: 'other',
  },
  // 2) 高区分度零食（先于奶茶，防止「牛奶巧克力」「酸奶沙琪玛」被奶茶规则抢走）
  {
    keywords: [
      '薯片', '薯條', '薯条', '薯卷', '虾条', '蝦條', '爆米花',
      '巧克力', '雪糕', '冰淇淋', '布丁', '大福', '銅鑼燒', '铜锣烧',
      '沙琪玛', '沙琪瑪', '口香糖', '泡泡糖', '軟糖', '软糖', '奶糖',
      'potato chips', 'baumkuchen',
    ],
    category: '零食',
  },
  // 3) 外卖（成品餐 → 先于主食/蛋白，处理「烤鸡便当」等）
  {
    keywords: ['外卖', '外賣', '快餐', '盒饭', '盒飯', '便当', '便當', '餐盒', 'takeaway', 'fast food'],
    category: '外卖',
  },
  // 4) 主食（含「蛋白 + 主食」复合名，故先于蛋白/蔬菜）
  {
    keywords: [
      '米饭', '米飯', '饭', '飯', '粥', '糯', '面', '麵', '麺', '拉面', '拉麵',
      '乌冬', '烏冬', '米粉', '粉絲', '粉丝', '水饺', '水餃', '饺', '餃',
      '包子', '肉包', '馒头', '饅頭', '吐司', '面包', '麵包', '贝果', '貝果', '排包',
      '麦片', '麥片', '燕麦', '燕麥', '饭团', '飯糰', '寿司', '壽司', '三明治',
      'rice', 'noodle', 'pasta', 'cereal', 'toast', 'bread',
    ],
    category: '主食',
  },
  // 5) 奶茶 / 饮料（饮品与「饮料」统一归入「奶茶」）
  {
    keywords: [
      '奶茶', '奶蓋', '奶盖', '拿铁', '拿鐵', '咖啡', '可乐', '可樂', '汽水',
      '气泡水', '氣泡水', '气泡', '氣泡', '饮料', '飲料', '飲品', '果汁', '橙汁',
      '柳橙汁', '苹果汁', '蘋果汁', '桃汁', '芭樂汁', '芭乐汁', '紅茶', '红茶',
      '綠茶', '绿茶', '乌龙', '烏龍', '铁观音', '鐵觀音', '凉茶', '涼茶',
      '豆漿', '豆浆', '豆奶', '米乳', '椰子水', '椰汁', '椰奶', '电解', '電解',
      '运动饮料', '運動飲料', '能量饮料', '乳酸菌', '酸奶', '優格', '優酪',
      '发酵乳', '發酵乳', '鮮乳', '鲜乳', '鮮奶', '鲜奶', '牛奶', '乳飲', '乳饮',
      '堅果飲', '乳清', '维他命水', '維他命水',
      'tea', 'coffee', 'milk', 'drink', 'beverage', 'juice', 'soda', 'yogurt', 'vitamin water',
    ],
    category: '奶茶',
  },
  // 6) 零食（笼统词）
  {
    keywords: [
      '饼干', '餅乾', '曲奇', '酥', '糕', '点心', '點心', '脆', '坚果', '堅果',
      '花生', '瓜子', '栗子', '板栗', '果冻', '果凍', '零食', '米果', '锅巴', '鍋巴',
      'snack', 'chocolate', 'candy', 'crisp', 'chips', 'biscuit', 'cookie',
      'dessert', 'cake', 'ポテト', 'ゼリー',
    ],
    category: '零食',
  },
  // 7) 蔬菜
  {
    keywords: [
      '蔬菜', '时蔬', '時蔬', '野菜', '沙拉', '沙律', '海藻', '紫菜', '海带', '海帶',
      '毛豆', '四季豆', '黄瓜', '黃瓜', '冬瓜', '南瓜', '茄子', '番茄', '西紅柿',
      '西红柿', '萝卜', '蘿蔔', '白菜', '菠菜', '西兰花', '西蘭花', '菌', '菇',
      '蘑菇', '木耳', '银耳', '銀耳', '竹笋', '竹筍', '莲藕', '蓮藕', '山药', '山藥',
      '芦笋', '蘆筍', '秋葵', '豌豆', '青豆', '玉米', '甜椒', '辣椒', '洋葱', '洋蔥',
      '大蒜', '姜', '薑', '蔥', '葱', '香菜', '生菜', '油菜', '芥蓝', '芥藍', '豆芽',
      'vegetable', 'veg', 'salad',
    ],
    category: '蔬菜',
  },
  // 8) 蛋白
  {
    keywords: [
      '鸡', '雞', '牛肉', '牛', '猪', '豬', '羊', '肉', '排骨', '火腿', '香肠', '香腸',
      '魚', '鱼', '虾', '蝦', '蟹', '贝', '貝', '蛋', '豆腐', '豆干', '豆乾', '腐乳',
      '起司', '芝士', '奶酪', '納豆', '纳豆', '黄豆', '黃豆', '黑豆', '绿豆', '綠豆',
      '红豆', '紅豆', '鹰嘴豆', 'さば',
      'egg', 'meat', 'fish', 'cheese', 'natto', 'seafood', 'pork', 'beef', 'chicken',
    ],
    category: '蛋白',
  },
  // 9) 水果
  {
    keywords: [
      '苹果', '蘋果', '香蕉', '橙', '橘子', '桔', '西瓜', '葡萄', '蓝莓', '藍莓',
      '草莓', '梨', '桃', '芒果', '菠萝', '鳳梨', '凤梨', '木瓜', '芭樂', '芭乐',
      '猕猴桃', '奇異果', '奇异果', '火龙果', '火龍果', '香瓜', '哈密瓜', '柠檬',
      '檸檬', '柚子', '石榴', '樱桃', '櫻桃', '枣', '棗', '柿', '荔枝', '龙眼', '龍眼',
      '杨桃', '楊桃', '桑葚', '无花果', 'fruit',
    ],
    category: '水果',
  },
];

/** 归一化文本：去首尾空白 + 转小写。 */
function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 按**关键词**判定分类（顺序敏感，首个命中即返回）。
 *
 * @param text 待判定文本（食物名 / 分类文本，大小写不敏感）
 * @returns 命中的分类；全部未命中返回 `null`（由调用方决定兜底）
 */
export function classifyCategoryByKeywords(text: string | null | undefined): FoodCategory | null {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }
  const haystack = normalizeText(text);
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return rule.category;
    }
  }
  return null;
}

/**
 * 把任意来源分类文本映射到 9 类（唯一入口）。
 *
 * @param rawCategory 原始分类值（来源侧，可能为脏值 / 空）
 * @param name 食物名（用于关键词兜底，可空）
 * @returns 合法分类（判不出时 `other`）
 */
export function mapFoodCategory(
  rawCategory: string | null | undefined,
  name?: string | null,
): FoodCategory {
  // 1. 已是合法类
  if (isFoodCategory(rawCategory)) {
    return rawCategory;
  }
  // 2. 直接值映射
  if (typeof rawCategory === 'string') {
    const direct = FOOD_CATEGORY_BY_RAW[normalizeText(rawCategory)];
    if (direct !== undefined) {
      return direct;
    }
  }
  // 3. 关键词兜底（先按名字，再退回按原值文本，覆盖「值本身含关键词」的情况）
  const byName = classifyCategoryByKeywords(name);
  if (byName !== null) {
    return byName;
  }
  const byRaw = classifyCategoryByKeywords(rawCategory);
  if (byRaw !== null) {
    return byRaw;
  }
  // 4. 兜底
  return DEFAULT_FOOD_CATEGORY;
}
