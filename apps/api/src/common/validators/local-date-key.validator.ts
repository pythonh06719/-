import { registerDecorator } from 'class-validator';
import type { ValidationArguments, ValidationOptions } from 'class-validator';

import { isValidLocalDateKey } from '../utils/date.util';

/**
 * `@IsLocalDateKey()` —— 校验「本地日期键」`YYYY-MM-DD`。
 *
 * 与 `@Matches(LOCAL_DATE_PATTERN_STRICT)` 的关键区别：**除了格式，还校验日期真实存在**。
 * `2026-02-31` 满足 `^\d{4}-\d{2}-\d{2}$`，但不是一个真实日期 —— 若只做正则，
 * 它会一路流到业务层被 `new Date` 静默进位成 3 月 3 日（缺陷根因）。
 *
 * 实现复用 `date.util.ts` 的 `isValidLocalDateKey`（严格正则 + 回环比对），口径唯一。
 */
export function IsLocalDateKey(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isLocalDateKey',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isValidLocalDateKey(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} 应为合法的 YYYY-MM-DD 日期`;
        },
      },
    });
  };
}
