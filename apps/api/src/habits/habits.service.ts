import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { todayLocalKey } from '../common/utils/date.util';
import { CheckinDto, CreateHabitDto } from './dto/habits.dto';

/** 单个习惯的查询/统计形态。 */
export interface HabitWithStats {
  id: number;
  code: string;
  name: string;
  icon: string | null;
  targetPerDay: number;
  isActive: boolean;
  /**
   * 是否**内置全局模板**（= 数据库 `HabitDefinition.userId === null`，GAP-11）。
   *
   * 前端据此决定「能不能停用」：内置模板的 `userId` 为 `null`，停用会命中别的用户
   * （全局模板不可停用，`setActive` 天然返回 404），所以前端不该给它显示停用按钮。
   *
   * ⚠️ 刻意**不把裸 `userId` 暴露给前端**：前端不需要 DB 字段，派生的布尔语义更清晰，
   * 也能避免前端误用 `userId` 自行做归属判断。
   */
  isBuiltin: boolean;
  doneToday: boolean;
  /** 当前连续（含今天若已打卡；断签不清零、不惩罚 —— R7.4 无负罪感设计） */
  currentStreak: number;
  /** 历史最佳连续 */
  bestStreak: number;
  /**
   * 近 {@link RECENT_WINDOW_DAYS} 天内**已打卡**的日期（`YYYY-MM-DD`，升序）。
   *
   * 供前端渲染「连续日历」网格：只列**打过卡**的日子，窗口内没打卡的日期不在此数组里
   * （前端按 35 天窗口自行补空心）—— 与 streak 一样只做陈述，不做惩罚性标注。
   */
  recentDates: string[];
}

/** 「连续日历」向后看的自然日窗口长度（7×5 网格 = 35 天）。 */
export const RECENT_WINDOW_DAYS = 35;

/**
 * 习惯服务（R7.3 / R7.4）。
 *
 * **无负罪感 streak 设计（PRD 硬性）**：只展示「当前连续 / 历史最佳」两个数字；
 * 断签**不归零告警、不发惩罚性提醒**，文案由前端用「休息一下没关系，随时回来」表达。
 */
@Injectable()
export class HabitsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 查询用户全部习惯（内置 + 自定义）+ 今日状态 + 连续天数。 */
  async list(userId: number): Promise<{ today: string; habits: HabitWithStats[] }> {
    const today = todayLocalKey();
    const habits = await this.prisma.habitDefinition.findMany({
      where: { OR: [{ userId }, { userId: null }] },
      orderBy: [{ userId: 'asc' }, { id: 'asc' }],
    });
    const checkins = await this.prisma.habitCheckin.findMany({
      where: { userId },
      orderBy: [{ loggedDate: 'asc' }, { id: 'asc' }],
    });

    const byHabit = new Map<number, Set<string>>();
    for (const checkin of checkins) {
      if (!checkin.done) {
        continue;
      }
      const bucket = byHabit.get(checkin.habitId) ?? new Set<string>();
      bucket.add(checkin.loggedDate);
      byHabit.set(checkin.habitId, bucket);
    }

    // 「连续日历」窗口：最近 35 天（含今天）。数据已在上面一次查出，这里只做切片，不新增查询。
    const windowStart = this.shiftDays(today, -(RECENT_WINDOW_DAYS - 1));

    return {
      today,
      habits: habits.map((habit) => {
        const dates = byHabit.get(habit.id) ?? new Set<string>();
        const streak = this.calcStreak(dates, today);
        return {
          id: habit.id,
          code: habit.code,
          name: habit.name,
          icon: habit.icon,
          targetPerDay: habit.targetPerDay,
          isActive: habit.isActive,
          isBuiltin: habit.userId === null,
          doneToday: dates.has(today),
          currentStreak: streak.current,
          bestStreak: streak.best,
          recentDates: this.recentDates(dates, windowStart, today),
        };
      }),
    };
  }

  /** 创建自定义习惯（挂到当前用户名下）。 */
  /**
   * ## 为什么 `code` 由服务端最终裁决（而不是全靠前端传什么）
   *
   * ### `code` 不是给人看的，是**备份里的外键**
   *
   * `packages/shared-types/src/export.ts:93` 写得很明确：`ExportHabitRow.habitId ← code`。
   * 也就是说导出时「用 `code` 冒充 habitId」，恢复时（`data.service.ts:482`）再拿 `code`
   * 反查 `habitDefinition`。**`code` 是备份文件里识别一个习惯的唯一钥匙**。
   *
   * ### 重复 `code` 的真实后果（已实测，非推演）
   *
   * `packages/core/src/export/payload.ts:309` 对 `habits[]` 断言唯一键是
   * **`日期|habitId`**。当自建习惯与内置习惯 `code` 同名、且同一天都打了卡，
   * 导出文件里就会出现两行完全一样的 `date|habitId` → **用户自己的备份文件从此
   * 再也恢复不回来**（`E_VALID_RESTORE_PAYLOAD`「这份内容与轻生活备份的格式不一致」）。
   * 实测：
   *   - 单条 `{date, habitId:'water'}` → 解析 OK
   *   - 同日两条 `habitId:'water'` → 解析失败
   * 这不是「UI 不好看」，是**用户的数字被锁在门外**。
   *
   * 另外恢复侧还有个次生问题：`code` 重复时 `findFirst(orderBy: userId desc)`
   * 会把内置与自建折叠成同一个 `habitId`，两边打卡合并成一条历史。
   *
   * ### 为什么在**服务端**兜底，而不是靠数据库唯一索引
   *
   * 1. **现有索引根本拦不住**：`schema.prisma:402` 已有 `@@unique([userId, code])`，
   *    但内置模板 `userId` 是 `NULL`，而 **SQLite 的唯一索引认为 NULL 与 NULL 互不相等**
   *    （已实测：`(NULL,'water')` 连插两条都成功）。所以 `(NULL,'water')` 与
   *    `(840,'water')` 是两个不同的键，索引形同虚设。要靠索引表达「内置 + 本人」
   *    这个合并作用域，得靠 `COALESCE(userId, 0)` 之类的表达式索引 ——
   *    那属于 **schema 改动**，需明确立项（见报告），本次不擅自做。
   * 2. **前端拦不住**：前端已经用 `custom_${Date.now()}` 自己生成 code（`HabitsPage.tsx:97`），
   *    但那只是**当前 UI 的做法**，不是接口契约。任何客户端（含 QA 脚本、将来的
   *    小程序 / 第三方调用）都能直接 `POST {code:'water'}`。把正确性押在调用方自觉上，
   *    就是本次缺陷的成因。
   *
   * ### 处置口径：**保留用户的 code，不报错、不拦人**（无负罪感）
   *
   * 命中冲突时**不抛错、不弹窗**，而是把 `code` 收敛成一个「肯定不撞」的派生值
   * （`code + '__' + 原 id` 风格的确定性后缀），让创建照常成功。理由：
   * - 用户在 UI 上填的是**名字**，不是 `code`（前端从不暴露 code 概念）。
   *   为一个用户根本没填过的字段拦下他「想加个自己的喝水」的真实诉求，
   *   是**替用户做决定**，且带一点说教感 —— 与「无负罪感、不指责」相悖。
   * - 名字重复是**产品允许**的：内置「喝水达标」是通用模板，用户想建
   *   「上午一杯」是完全正当的需求，不该被当成错误。
   * - 真正的完整性风险在 `code`（数据层），所以在数据层静默收敛、
   *   把**展示层**留给 UI 去区分（见报告方案 c），两者互不打架。
   *
   * 这样用户侧的结果是：创建永远成功、名字永远是他自己写的那个，
   * 而备份文件永远恢复得回来。
   */
  async create(userId: number, dto: CreateHabitDto): Promise<HabitWithStats> {
    const habit = await this.prisma.habitDefinition.create({
      data: {
        userId,
        code: await this.resolveCode(userId, dto.code),
        name: dto.name,
        icon: dto.icon ?? null,
        targetPerDay: dto.targetPerDay ?? 1,
        isActive: true,
      },
    });
    return {
      id: habit.id,
      code: habit.code,
      name: habit.name,
      icon: habit.icon,
      targetPerDay: habit.targetPerDay,
      isActive: habit.isActive,
      isBuiltin: false, // create() 挂到当前用户名下 → userId 为 number，必然是自建
      doneToday: false,
      currentStreak: 0,
      bestStreak: 0,
      recentDates: [],
    };
  }

  /**
   * 把请求里的 `code` 收敛成一个在该作用域内**确定不冲突**的值。
   *
   * 作用域 = 「`userId = null` 的内置模板」∪「`userId = 当前用户` 的自建习惯」——
   * 正是 `list()` 会同时返回、且 `data.service.ts` 备份恢复会按 `code` 相互折叠的那一组。
   *
   * 判定用 `findFirst({ where: { code, OR: [{ userId }, { userId: null }] } })`：
   * - **不能**用 `findUnique({ userId_code })`：`userId=null` 在 SQLite 唯一索引里查不出来
   *   （NULL 互不相等），会漏判内置冲突；而内置冲突恰恰是本次缺陷的主要形态。
   * - 也**不能**只查内置：两个自建习惯撞名同样会让备份产生重复 `日期|habitId`。
   *
   * 后缀用**确定性**的 `__n`（n 从 2 起）而非随机串：同一个 code 反复提交得到同一个结果，
   * 便于测试断言与问题排查；`__` 前缀与内置 code（`water` / `early_sleep` …）不可能撞。
   *
   * @param userId 当前登录用户 id
   * @param requested 客户端请求的 code（原样保留，不做 trim 之外的改写）
   * @returns 可安全落库的 code；无冲突时**原样返回**（含内置冲突但当前用户域内无同名自建的情况）
   */
  private async resolveCode(userId: number, requested: string): Promise<string> {
    const taken = async (code: string): Promise<boolean> =>
      (await this.prisma.habitDefinition.findFirst({
        where: { code, OR: [{ userId }, { userId: null }] },
        select: { id: true },
      })) !== null;

    if (!(await taken(requested))) {
      return requested;
    }

    // 已冲突：加确定性后缀直到找到空位。上限足够大（远大于任何真实习惯数），
    // 正常路径只会走 1~2 轮。
    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const candidate = `${requested}__${suffix}`;
      if (!(await taken(candidate))) {
        return candidate;
      }
    }

    // 理论上不可达（100 个后缀位都被占满）。仍给出确定性兜底，不抛错 ——
    // 与本方法「绝不拦下用户」的处置口径一致。
    return `${requested}__${userId}_${Date.now()}`;
  }

  /** 打卡 / 取消（幂等：同日同习惯唯一）。 */
  async checkin(userId: number, habitId: number, dto: CheckinDto): Promise<{ checked: boolean; date: string }> {
    const habit = await this.prisma.habitDefinition.findFirst({
      where: { id: habitId, OR: [{ userId }, { userId: null }] },
    });
    if (!habit) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_HABIT, '没有找到这个习惯');
    }
    const day = dto.loggedDate ?? todayLocalKey();
    const existing = await this.prisma.habitCheckin.findUnique({
      where: { userId_habitId_loggedDate: { userId, habitId, loggedDate: day } },
    });

    if (dto.done) {
      if (existing) {
        await this.prisma.habitCheckin.update({
          where: { id: existing.id },
          data: { done: true, value: dto.value ?? existing.value },
        });
      } else {
        await this.prisma.habitCheckin.create({
          data: { userId, habitId, loggedDate: day, done: true, value: dto.value ?? null },
        });
      }
      return { checked: true, date: day };
    }

    if (existing) {
      await this.prisma.habitCheckin.delete({ where: { id: existing.id } });
    }
    return { checked: false, date: day };
  }

  /**
   * 停用 / 恢复自定义习惯（GAP-11）—— **不是删除**，且**可以恢复**。
   *
   * ## 为什么停用而不是删除（务必保留此注释，避免后人"顺手改成 delete"）
   *
   * `prisma/schema.prisma` 中 `HabitCheckin.habitId` 的外键是 `onDelete: Cascade`。
   * 一旦真删除 `HabitDefinition`，该习惯的**全部历史打卡记录会被级联删除且不可恢复**：
   * 1. 用户过去数十天的打卡数据凭空消失；
   * 2. 周报的 `habitsDone` / `habitsTotal` 基数随之变化 → **历史周报的数字会被改写**；
   * 3. 违背本项目「无负罪感」原则 —— 用户说「我不想继续做这个了」，并不意味着
   *    「把过去一笔勾销」。
   *
   * 因此本方法只切换 `isActive`：
   * - `HabitCheckin` 完全不动，历史数据与历史周报口径保持稳定；
   * - `report.service.ts` 的 `where: { ..., isActive: true }` 过滤会在停用后自动让该习惯退出统计，
   *   恢复后又自动重新计入（**恢复是真的**，不是前端假象）；
   * - 用户随时可以在同一 `PATCH /habits/:id` 路由上「重新开始」。
   *
   * ## 为什么 PATCH 要接受 body（既能停用也能恢复）
   *
   * 停用只是「这个阶段先不做」，而不是「永远不要了」——「这个月先不做，下个月再做」
   * 是习惯类功能的真实场景。若只允许单向停用，用户一次误点就会**永久失去**这个习惯，
   * 与「无负罪感、随时可以回来」的产品调性相悖。故由 `isActive` 参数决定方向：
   * `false` = 停用、`true` = 恢复，两者共用同一路由，无需新增端点。
   *
   * ## 归属与内置保护
   *
   * 查询条件 `where: { id: habitId, userId }` 中 `userId` 是 `number`，而内置模板的
   * `userId` 是 `null`，因此**天然只命中当前用户自己的记录**：他人的习惯、以及
   * `userId=null` 的全局内置模板都会查不到 → 统一返回 404（不泄露资源是否存在）。
   * 这里用 `findFirst` 做归属校验是**显式**的，测试也显式锁定了这两条边界，
   * 不依赖隐式行为。内置模板**绝不能**停用（会影响所有用户），这层保护不可移除。
   *
   * ## 幂等
   *
   * 目标状态与当前一致时不再写库，直接返回当前状态（停用后再停用、恢复后再恢复均安全）。
   *
   * @param userId 当前登录用户（取自 JWT）
   * @param habitId 目标习惯 id
   * @param isActive 目标状态：`false` 停用 / `true` 恢复
   * @returns 更新后的习惯（与 `list()` 元素同形；自建习惯 `isBuiltin` 恒为 `false`）
   * @throws ApiException 404 `E_NOTFOUND_HABIT` 当习惯不存在 / 属于他人 / 为内置模板
   */
  async setActive(userId: number, habitId: number, isActive: boolean): Promise<HabitWithStats> {
    // 显式归属校验：userId 为 number → 不会命中 userId 为 null 的内置模板，也不会命中他人的行
    const habit = await this.prisma.habitDefinition.findFirst({
      where: { id: habitId, userId },
    });
    if (!habit) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_HABIT, '没有找到这个习惯');
    }

    // 幂等：目标状态与当前一致则不再写库，直接返回当前状态
    const updated =
      habit.isActive === isActive
        ? habit
        : await this.prisma.habitDefinition.update({
            where: { id: habit.id },
            data: { isActive, updatedAt: new Date().toISOString() },
          });

    const dates = new Set<string>();
    const streak = this.calcStreak(dates, todayLocalKey());
    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      icon: updated.icon,
      targetPerDay: updated.targetPerDay,
      isActive: updated.isActive,
      isBuiltin: updated.userId === null, // 只可能命中本人自建 → 这里恒为 false，但仍按口径派生
      doneToday: false,
      currentStreak: streak.current,
      bestStreak: streak.best,
      recentDates: [],
    };
  }

  /** 计算连续天数：从今天（或最近一次打卡日）往前数连续日。 */
  private calcStreak(dates: Set<string>, today: string): { current: number; best: number } {
    const sorted = [...dates].sort();
    if (sorted.length === 0) {
      return { current: 0, best: 0 };
    }

    // 历史最佳：按日历连续段计算
    let best = 1;
    let run = 1;
    for (let index = 1; index < sorted.length; index += 1) {
      const prev = sorted[index - 1]!;
      const current = sorted[index]!;
      if (this.diffDays(prev, current) === 1) {
        run += 1;
      } else {
        run = 1;
      }
      best = Math.max(best, run);
    }

    // 当前连续：若今天未打卡，从昨天开始数（断签不清零为 0 之前允许补看）
    let cursor = dates.has(today) ? today : this.shiftDays(today, -1);
    let current = 0;
    while (dates.has(cursor) && current < 3650) {
      current += 1;
      cursor = this.shiftDays(cursor, -1);
    }

    return { current, best: Math.max(best, current) };
  }

  /**
   * 取 `[windowStart, today]` 内已打卡的日期（升序）。
   *
   * 断签**不填、不标注** —— 只如实列出打过卡的日子，把「没记」留白给前端渲染成空心格。
   */
  private recentDates(dates: Set<string>, windowStart: string, today: string): string[] {
    return [...dates].filter((date) => date >= windowStart && date <= today).sort();
  }

  /** 两个 `YYYY-MM-DD` 之间的天数差（本地时区）。 */
  private diffDays(from: string, to: string): number {
    const a = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
    const b = new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  /** 日期键加减天数。 */
  private shiftDays(dateKey: string, delta: number): string {
    const date = new Date(
      Number(dateKey.slice(0, 4)),
      Number(dateKey.slice(5, 7)) - 1,
      Number(dateKey.slice(8, 10)),
    );
    date.setDate(date.getDate() + delta);
    const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}
