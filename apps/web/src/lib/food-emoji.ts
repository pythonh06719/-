/**
 * 食物 emoji 映射（lib/food-emoji.ts）——「零图片成本」的生活化视觉。
 *
 * 目标：让食物库的分类与名称，在前端变成一眼能认出的图形（🍚 / 🥬 / 🍎 …），
 * 避免页面全是文字与数字而显得像「数据表格」。
 *
 * 设计：
 * - 规则表按「优先级顺序」匹配（先具体后笼统），命中即返回；
 * - 分类词 / 食物名共用同一套关键词，因此 `emojiForCategory` 与 `emojiForFoodName` 行为一致；
 * - 未知分类 / 空值一律兜底为 🍴，**绝不返回空串**（保证 UI 稳定）。
 */

/** 单条匹配规则：`keywords` 命中任一即返回 `emoji`。 */
interface EmojiRule {
  /** 关键词（分类名或食物名包含其一即命中） */
  keywords: readonly string[];
  /** 对应的 emoji */
  emoji: string;
}

/**
 * 匹配规则（顺序敏感）：
 * 先匹配更具体的品类（汤粥 / 水产 / 水果 …），再匹配笼统的（家常菜）。
 */
const EMOJI_RULES: readonly EmojiRule[] = [
  { keywords: ['汤', '粥'], emoji: '🍲' },
  { keywords: ['水产', '海鲜', '鱼', '虾', '蟹', '贝', '鱿', '海带', '紫菜'], emoji: '🦐' },
  { keywords: ['水果', '苹', '香蕉', '橙', '橘', '莓', '桃', '葡萄', '梨', '西瓜', '芒果', '菠'], emoji: '🍎' },
  { keywords: ['蔬菜', '蔬', '青菜', '菜花', '西兰花', '番茄', '西红柿', '黄瓜', '菌', '菇', '木耳', '萝卜', '茄子', '土豆'], emoji: '🥬' },
  { keywords: ['乳', '奶', 'dair', '芝士', '奶酪', '酸奶'], emoji: '🥛' },
  { keywords: ['豆', '腐竹', '豆浆', '豆腐', '豆皮'], emoji: '🫘' },
  { keywords: ['坚果', '花生', '核桃', '杏仁', '腰果', '瓜子', '开心果'], emoji: '🥜' },
  { keywords: ['主食', '米饭', '米面', '面食', '面条', '面包', '馒头', '饺子', '包子', '米粉', '挂面', '饭', '饼'], emoji: '🍚' },
  { keywords: ['肉', '猪', '牛', '鸡', '鸭', '羊', '蛋', '火腿', '香肠', '培根', '蛋白', 'meat'], emoji: '🍗' },
  { keywords: ['零食', '薯片', '糖', '巧克力', '果冻', '膨化', 'snack', 'crisps', 'dessert', '甜点', '甜品', '蛋糕', '布丁', '冰淇淋', '雪糕'], emoji: '🍪' },
  { keywords: ['饮料', '饮品', '茶', '咖啡', '汁', '酒', '奶昔', '奶茶', '汽水', 'beverage', 'drink'], emoji: '🥤' },
  { keywords: ['外卖', '快餐', '便当', '盒饭', 'meal'], emoji: '🍱' },
  { keywords: ['调味', '酱', '盐', '醋', '味精', '鸡精', 'condiment', 'sauce', '油', 'fats'], emoji: '🧂' },
  { keywords: ['家常菜', '炒', '烧', '炖', '蒸', '菜'], emoji: '🍽️' },
];

/** 兜底 emoji（未知分类 / 空值）。 */
export const DEFAULT_FOOD_EMOJI = '🍴';

/**
 * 把任意文本（分类名或食物名）映射为 emoji。
 *
 * @param text 分类名 / 食物名（可为 `null` / `undefined`）
 * @returns 命中规则的 emoji，未命中返回兜底 `🍴`
 */
function matchEmoji(text: string | null | undefined): string {
  if (typeof text !== 'string') {
    return DEFAULT_FOOD_EMOJI;
  }
  const normalized = text.trim().toLowerCase();
  if (normalized === '') {
    return DEFAULT_FOOD_EMOJI;
  }
  for (const rule of EMOJI_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
      return rule.emoji;
    }
  }
  return DEFAULT_FOOD_EMOJI;
}

/**
 * 按食物分类取 emoji（如 `主食` → 🍚）。
 *
 * @param category 食物分类（可空）
 * @returns 对应 emoji，含兜底
 */
export function emojiForCategory(category?: string | null): string {
  return matchEmoji(category);
}

/**
 * 按食物名取 emoji（用于日记条目——记录里没有分类字段时的兜底猜测）。
 *
 * @param name 食物名称（可空）
 * @returns 对应 emoji，含兜底
 */
export function emojiForFoodName(name?: string | null): string {
  return matchEmoji(name);
}
