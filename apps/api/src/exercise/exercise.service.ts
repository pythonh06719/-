import { Injectable } from '@nestjs/common';

import { MET_ACTIVITY_LIBRARY, calcExerciseKcal, findMetActivity } from '@qsh/core';

import { PrismaService } from '../prisma/prisma.service';
import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { todayLocalKey } from '../common/utils/date.util';
import { CreateExerciseDto, EstimateExerciseDto } from './dto/create-exercise.dto';

/** 单条运动记录（对外形态 = 契约 `ExerciseLog`）。 */
export interface ExerciseLogDto {
  id: number;
  loggedDate: string;
  activityCode: string;
  activityName: string;
  met: number;
  minutes: number;
  kcalBurned: number;
  note: string | null;
}

/** 运动模块服务（R6.1 / R6.2）：MET 表查询、记录、删除、试算。 */
@Injectable()
export class ExerciseService {
  constructor(private readonly prisma: PrismaService) {}

  /** 内置 MET 表（供前端下拉渲染）。 */
  listActivities(): Array<{ code: string; name: string; category: string; intensity: string; met: number }> {
    return MET_ACTIVITY_LIBRARY.map((activity) => ({ ...activity }));
  }

  /** 查询某日（缺省今天）运动记录 + 当日合计。 */
  async listByDate(userId: number, date?: string): Promise<{ date: string; logs: ExerciseLogDto[]; totalKcal: number }> {
    const day = date ?? todayLocalKey();
    const rows = await this.prisma.exerciseLog.findMany({
      where: { userId, loggedDate: day },
      orderBy: { id: 'asc' },
    });
    const logs = rows.map((row) => this.toDto(row));
    return {
      date: day,
      logs,
      totalKcal: this.round1(logs.reduce((sum, log) => sum + log.kcalBurned, 0)),
    };
  }

  /** 记录一条运动（消耗按记录当日体重计算，保证可复算）。 */
  async create(userId: number, dto: CreateExerciseDto): Promise<ExerciseLogDto> {
    const activity = findMetActivity(dto.activityCode);
    if (!activity) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_ACTIVITY, '未找到该运动类型');
    }
    const day = dto.loggedDate ?? todayLocalKey();
    const weightKg = await this.currentWeight(userId);

    const kcalBurned = calcExerciseKcal(activity.met, weightKg, dto.minutes);
    const created = await this.prisma.exerciseLog.create({
      data: {
        userId,
        loggedDate: day,
        activityCode: activity.code,
        activityName: activity.name,
        met: activity.met,
        minutes: dto.minutes,
        weightKgAtLog: weightKg,
        kcalBurned,
        note: dto.note ?? null,
      },
    });
    return this.toDto(created);
  }

  /** 删除一条运动记录（仅本人，越权返回 404）。 */
  async remove(userId: number, id: number): Promise<{ deleted: true }> {
    const row = await this.prisma.exerciseLog.findFirst({ where: { id, userId } });
    if (!row) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_EXERCISE, '没有找到这条运动记录');
    }
    await this.prisma.exerciseLog.delete({ where: { id } });
    return { deleted: true };
  }

  /** 试算（不落库）：优先用档案体重。 */
  async estimate(userId: number, dto: EstimateExerciseDto): Promise<{ met: number; weightKg: number; minutes: number; kcalBurned: number }> {
    const activity = findMetActivity(dto.activityCode);
    if (!activity) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_ACTIVITY, '未找到该运动类型');
    }
    const weightKg = dto.weightKg ?? (await this.currentWeight(userId));
    return {
      met: activity.met,
      weightKg,
      minutes: dto.minutes,
      kcalBurned: calcExerciseKcal(activity.met, weightKg, dto.minutes),
    };
  }

  /**
   * 当前体重：`user_goals.start_weight_kg`（随每次记体重联动更新）优先，
   * 其次最近一次体重记录，最后 60kg 兜底。
   */
  private async currentWeight(userId: number): Promise<number> {
    const goal = await this.prisma.userGoal.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'desc' },
      select: { startWeightKg: true },
    });
    if (goal?.startWeightKg && goal.startWeightKg > 0) {
      return goal.startWeightKg;
    }
    const latest = await this.prisma.weightLog.findFirst({
      where: { userId },
      orderBy: { loggedAt: 'desc' },
      select: { weightKg: true },
    });
    return latest?.weightKg ?? 60;
  }

  /** 实体 → 对外 DTO（快照字段保留，便于复算）。 */
  private toDto(row: {
    id: number;
    loggedDate: string;
    activityCode: string;
    activityName: string;
    met: number;
    minutes: number;
    kcalBurned: number;
    note: string | null;
  }): ExerciseLogDto {
    return {
      id: row.id,
      loggedDate: row.loggedDate,
      activityCode: row.activityCode,
      activityName: row.activityName,
      met: row.met,
      minutes: row.minutes,
      kcalBurned: this.round1(row.kcalBurned),
      note: row.note,
    };
  }

  private round1(value: number): number {
    return Math.round(value * 10) / 10;
  }
}
