import { Injectable } from '@nestjs/common';

import type { DeleteWinResponse, ListWinsResponse, WinLog } from '@qsh/shared-types';
import { checkWinText, WIN_TEXT_MAX_LENGTH } from '@qsh/core';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { addDays, todayLocalKey } from '../common/utils/date.util';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateWinDto } from './dto/create-win.dto';

/** 回看时间线的条数上限（K23：任何 win 列表的窗口语义都是「最近」）。 */
export const WINS_LIST_LIMIT = 200;

/** 追溯天数的默认值与边界（AC-11.4.3）。 */
export const WINS_DEFAULT_DAYS = 90;
export const WINS_MIN_DAYS = 1;
export const WINS_MAX_DAYS = 365;

/**
 * 「体重之外的变化」服务（R11.4）。
 *
 * ⚠️ `loggedDate` **只能**由服务端生成本地今天（K21 / QR-5）—— 本服务没有任何
 * 接受日期入参的写入口，类型上也传不进来。
 *
 * ⚠️ `win_logs` 刻意无 (userId, loggedDate) 唯一约束：同一天多条是设计行为（随手记），
 * 由 e2e 用例显式保护（r11-new.e2e.test.ts）。
 */
@Injectable()
export class WinsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 记一条「体重之外的变化」（只记今天）。 */
  async create(userId: number, dto: CreateWinDto): Promise<WinLog> {
    // 清洗 + 校验同源（core 的 checkWinText 是唯一校验点，Q-8）：
    // 清洗后为空 → 400（前端已静默忽略，这里只是兜底）；超限 → 400 **不截断不入库**（AC-11.4.2）
    const checked = checkWinText(dto?.text ?? '');
    if (!checked.ok) {
      if (checked.reason === 'empty') {
        throw new ApiException(400, ERROR_CODES.VALID_INPUT, '想写点什么再记下来也行');
      }
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, `最多能写 ${WIN_TEXT_MAX_LENGTH} 个字`, {
        text: `最多能写 ${WIN_TEXT_MAX_LENGTH} 个字`,
      });
    }

    return this.prisma.winLog.create({
      data: {
        userId,
        loggedDate: todayLocalKey(),
        text: checked.text,
      },
    });
  }

  /**
   * 回看时间线：返回**最新 200 条**，按 `createdAt` **升序**呈现（D-5 / K23）。
   *
   * ⚠️ 实现必须 `desc + take + reverse`：直接 ASC + take 会拿到**最老的** 200 条，
   * 历史一长新记录就永远看不到了 —— 这是最容易写反的一处。
   */
  async list(userId: number, days: number = WINS_DEFAULT_DAYS): Promise<ListWinsResponse> {
    const windowDays = Math.floor(days);
    if (!Number.isFinite(windowDays) || windowDays < WINS_MIN_DAYS || windowDays > WINS_MAX_DAYS) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '回看天数应在 1 到 365 之间', {
        days: '回看天数应在 1 到 365 之间',
      });
    }

    const to = todayLocalKey();
    const from = addDays(to, -(windowDays - 1));

    const latest = await this.prisma.winLog.findMany({
      where: { userId, loggedDate: { gte: from, lte: to } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: WINS_LIST_LIMIT,
    });

    // desc 取「最新 200 条」→ reverse 成 ASC 返回（同日多条自然按写入顺序，AC-11.4.3）
    return latest.reverse();
  }

  /** 删除一条（他人资源或不存在 → 404 `E_NOTFOUND_WIN`，不泄露存在性，K7）。 */
  async remove(userId: number, id: number): Promise<DeleteWinResponse> {
    const existing = await this.prisma.winLog.findFirst({ where: { id, userId }, select: { id: true } });
    if (existing === null) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_WIN, '没有找到这一条');
    }
    await this.prisma.winLog.delete({ where: { id: existing.id } });
    return { deleted: true };
  }
}
