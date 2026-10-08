import { IsOptional } from 'class-validator';

import { IsLocalDateKey } from '../../common/validators/local-date-key.validator';

/** `GET /api/dashboard` 查询参数。 */
export class DashboardQueryDto {
  /** 看板日期 `YYYY-MM-DD`（缺省 = 服务端本地今天） */
  @IsOptional()
  @IsLocalDateKey({ message: '日期格式应为 YYYY-MM-DD' })
  date?: string;
}
