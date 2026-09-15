import { IsOptional, Matches } from 'class-validator';

import { LOCAL_DATE_PATTERN_STRICT } from '../../common/utils/date.util';

/** `GET /api/dashboard` 查询参数。 */
export class DashboardQueryDto {
  /** 看板日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @Matches(LOCAL_DATE_PATTERN_STRICT, { message: '日期格式应为 YYYY-MM-DD' })
  date?: string;
}
