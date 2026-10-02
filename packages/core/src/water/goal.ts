/**
 * 每日饮水目标的口径（core/water/goal.ts）—— GAP-3。
 *
 * ## 为什么需要这块纯口径
 *
 * `waterGoalMl` 是「每天想喝多少」的用户偏好。后端已有两条写入通道
 * （`PATCH /water/goal` 与 `PATCH /users/settings`），但前端一直没有输入入口 ——
 * 用户永远看到默认 2000ml，改不了。补入口的同时，把**合法区间**与**宽容归一化**
 * 这两条口径收敛到唯一真源：
 *
 * - 前端输入校验（先拦，避免提交一个必被 400 的值）；
 * - 导出备份的兼容读取（旧备份没有这个键时回退默认，而不是把整份文件判为「格式不一致」）。
 *
 * ## 与后端的对齐（不许漂移）
 *
 * 合法区间必须与后端两条通道保持一致（`UpdateWaterGoalDto` 与 `UpdateSettingsDto`
 * 的 `@Min(500) @Max(8000)`）；默认值与后端 `water.service.ts` 的 `?? 2000`、
 * `schema.prisma` 的 `@default(2000)` 一致。
 *
 * ⚠️ core 不 import shared-types（K12），故此处自带常量，不做任何类型依赖。
 */

/** 每日饮水目标下限（ml）—— 与后端两条通道一致。 */
export const WATER_GOAL_MIN_ML = 500;

/** 每日饮水目标上限（ml）—— 与后端两条通道一致。 */
export const WATER_GOAL_MAX_ML = 8000;

/** 默认每日饮水目标（ml）—— 与后端 `?? 2000` / DDL `@default(2000)` 一致。 */
export const DEFAULT_WATER_GOAL_ML = 2000;

/**
 * 是否为合法的每日饮水目标（整数毫升，落在 500–8000）。
 *
 * 用作输入校验的类型守卫：`true` 时 `value` 被收窄为 `number`。
 */
export function isValidWaterGoalMl(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= WATER_GOAL_MIN_ML &&
    value <= WATER_GOAL_MAX_ML
  );
}

/**
 * 宽容归一化：合法则原样返回，否则回退默认值 2000。
 *
 * 用于**兼容读取**旧备份（v1/v2 均无 `settings.waterGoalMl`）—— 缺失 / 非数字 /
 * 越界的值一律当作「未设置」，取默认，绝不因此使整份备份解析失败。
 */
export function normalizeWaterGoalMl(value: unknown): number {
  return isValidWaterGoalMl(value) ? value : DEFAULT_WATER_GOAL_ML;
}
