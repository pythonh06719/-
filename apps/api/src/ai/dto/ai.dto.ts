import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** `POST /api/ai/daily-summary` 请求体（R9.1）。 */
export class DailySummaryDto {
  /** 复盘日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @IsString({ message: '日期需为文本' })
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  date?: string;
}

/** `POST /api/ai/today-plan` 请求体（R9.2）。 */
export class TodayPlanDto {
  /** 方案日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @IsString({ message: '日期需为文本' })
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  date?: string;
}

/** `POST /api/ai/free-ask` 请求体（R9.3）。 */
export class FreeAskDto {
  /** 用户问题（1~200 字；空 / 纯空白在服务层报 `E_VALID_AI_EMPTY`） */
  @IsString({ message: '问题需为文本' })
  @MaxLength(200, { message: '问题请控制在 200 字以内' })
  question!: string;

  /** 提问日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @IsString({ message: '日期需为文本' })
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  date?: string;
}

/** `POST /api/ai/recognize-food` 请求体（R3.7）。 */
export class RecognizeFoodDto {
  /** 文字描述（1~200 字；空 / 纯空白在服务层报 `E_VALID_AI_EMPTY`） */
  @IsString({ message: '描述需为文本' })
  @MaxLength(200, { message: '描述请控制在 200 字以内' })
  description!: string;
}
