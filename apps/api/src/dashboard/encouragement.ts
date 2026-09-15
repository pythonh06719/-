/**
 * 看板鼓励语（PRD §7 / K4 硬性语气规范）。
 *
 * **禁止**出现「失败」「超标」「请反思」「坚持就是胜利」等负向 / 指责性表述。
 */

/**
 * 依当日进度生成一句鼓励语。
 *
 * @param progressRatio 进度比 = 已摄入 ÷ 建议摄入（可为 0~1+）
 * @param hasGoal 是否已有生效目标
 */
export function buildEncouragement(progressRatio: number, hasGoal: boolean): string {
  if (!hasGoal) {
    return '今天也照顾好自己';
  }
  if (progressRatio > 1) {
    return '今天吃得丰富一些，明天照常就好';
  }
  if (progressRatio >= 0.85) {
    return '今天的分量刚刚好，放松一点也没关系';
  }
  if (progressRatio >= 0.4) {
    return '节奏刚刚好，继续保持';
  }
  return '慢慢来，今天也照顾好自己';
}
