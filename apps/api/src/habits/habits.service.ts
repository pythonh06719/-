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
  doneToday: boolean;
  /** 当前连续（含今天若已打卡；断签不清零、不惩罚 —— R7.4 无负罪感设计） */
  currentStreak: number;
  /** 历史最佳连续 */
  bestStreak: number;
}

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
          doneToday: dates.has(today),
          currentStreak: streak.current,
          bestStreak: streak.best,
        };
      }),
    };
  }

  /** 创建自定义习惯（挂到当前用户名下）。 */
  async create(userId: number, dto: CreateHabitDto): Promise<HabitWithStats> {
    const habit = await this.prisma.habitDefinition.create({
      data: {
        userId,
        code: dto.code,
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
      doneToday: false,
      currentStreak: 0,
      bestStreak: 0,
    };
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
