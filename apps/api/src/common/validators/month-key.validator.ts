import { registerDecorator } from 'class-validator';
import type { ValidationArguments, ValidationOptions } from 'class-validator';

import { isValidMonthKey } from '../utils/date.util';

/**
 * `@IsMonthKey()` —— 校验「本地月份键」`YYYY-MM`（C-1）。
 *
 * 与 `@Matches(/^\d{4}-\d{2}$/)` 的关键区别：**月份必须在 `01~12`**。
 * 月份参数直接决定查询区间，`2026-13` 这类满足正则但不是真实月份的值
 * 会被静默算到别的区间（缺陷模式同 `endDate`），故在此拦死。
 *
 * 实现复用 `date.util.ts` 的 `isValidMonthKey`，口径唯一。
 */
export function IsMonthKey(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isMonthKey',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isValidMonthKey(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} 应为 YYYY-MM 格式的月份`;
        },
      },
    });
  };
}
