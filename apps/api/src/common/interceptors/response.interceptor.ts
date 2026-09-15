import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';

import { map, Observable } from 'rxjs';

/**
 * 统一成功响应包装（ARCHITECTURE §7 K2）：
 * `{ data: <控制器返回值>, error: null }`。
 *
 * 失败路径由 `AllExceptionsFilter` 负责，二者共同保证响应恒为 `{ data, error }`。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, { data: T | null; error: null }> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<{ data: T | null; error: null }> {
    return next.handle().pipe(map((data: T) => ({ data: data === undefined ? null : data, error: null })));
  }
}
