#!/usr/bin/env node
/**
 * Schema 漂移门禁（P0 防复发，**三层**比较）：比较两套 Prisma schema 是否「同构」。
 *
 * 背景：本项目同时维护两份「同一模型、两套 provider」的 schema：
 *   - prisma/schema.prisma      —— SQLite（本地 MVP / 开发 / e2e）
 *   - prisma/schema.pg.prisma   —— PostgreSQL（生产；`render.yaml` 用 `prisma db push` 建表）
 * 二者若某次只改了其中一份，就会出现「代码引用了一个生产库不存在的 model/表/列」——
 * 线上直接 500（例如 AiTrace 曾缺失；Json↔String 列类型曾漂移）。
 *
 * 比较三层（纯 Node、零依赖）：
 *   ① model 集合：两侧 model 名称集合必须一致；
 *   ② 字段名集合：每个 model 的字段名集合必须一致（含缺失/多余）；
 *   ③ 字段签名：每个字段的「原始类型 + 数组性[] + 可选性?」必须一致。
 *
 * 类型等价白名单（provider 映射，视为相同，双向）：
 *   Int ↔ BigInt      （SQLite Int / PG BigInt）
 *   String ↔ DateTime （SQLite 文本存日期 / PG 原生时间）
 *   Float ↔ Decimal
 *   ⚠️ 白名单**不含** `Json ↔ String` —— 本项目已把「JSON 语义列」统一为 `String`
 *      （应用层 JSON.parse/stringify），任何一侧变回 `Json` 都应被拦下。
 *
 * 忽略（不属本门禁目标）：`@default(...)` / `@map` / `@db.*` / `@relation(...)` 参数、
 *   注释、`@@index` / `@@unique` / `@@map` 的差异。
 *
 * 退出码：0 = 一致；1 = 存在漂移（打印逐条差异，可直接用于 CI 阻断）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE_SQLITE = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const FILE_PG = fileURLToPath(new URL('../prisma/schema.pg.prisma', import.meta.url));

/** Prisma 标量类型（用于区分「标量字段」与「关系字段」）。 */
const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'BigInt',
  'Boolean',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

/**
 * provider 映射等价白名单（双向）。
 * 只放「同一语义、两 provider 写法不同」的映射；**不放** Json↔String。
 */
const TYPE_EQUIVALENTS = [
  ['Int', 'BigInt'],
  ['String', 'DateTime'],
  ['Float', 'Decimal'],
];

/** 单行 model 头：`model Name {`。 */
const MODEL_HEAD_RE = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
/** 单行字段：`name Type[]? ...`（类型后必须紧跟 `[]`/`?`/空白/行尾之一）。 */
const FIELD_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?(?:\s|$)/;

/**
 * 解析一份 schema 文件 → `Map<modelName, Map<fieldName, {type, optional, array, line}>>`。
 *
 * @param {string} filePath 绝对路径
 * @returns {Map<string, Map<string, { type: string; optional: boolean; array: boolean; line: number }>>}
 */
function parseSchema(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`❌ 无法读取 schema 文件：${filePath}\n   ${error.message}`);
    process.exit(1);
  }

  const models = new Map();
  const lines = raw.split(/\r?\n/);
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    const modelHead = MODEL_HEAD_RE.exec(line);
    if (modelHead) {
      current = new Map();
      models.set(modelHead[1], current);
      continue;
    }

    if (current === null) {
      continue;
    }

    // model 结束
    if (/^\s*\}/.test(line)) {
      current = null;
      continue;
    }

    const trimmed = line.trim();
    // 跳过空行 / 注释 / 块属性（@@index / @@unique / @@map ...）
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('@@')) {
      continue;
    }

    const field = FIELD_RE.exec(trimmed);
    if (!field) {
      // 理论上不会发生（Prisma 字段均为单行）；保守跳过，不误报。
      continue;
    }

    const [, name, type, arrayMark, optionalMark] = field;
    current.set(name, {
      type,
      optional: optionalMark === '?',
      array: arrayMark === '[]',
      line: index + 1,
    });
  }

  return models;
}

/** 类型是否等价（相等或命中白名单，双向）。 */
function typesEquivalent(a, b) {
  if (a === b) {
    return true;
  }
  return TYPE_EQUIVALENTS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** 字段签名（用于展示）：`Type[]?`。 */
function signature(field) {
  return `${field.type}${field.array ? '[]' : ''}${field.optional ? '?' : ''}`;
}

/** 排序后的差集 A\\B（入参可为 Set 或任意可迭代对象）。 */
function difference(a, b) {
  const aSet = a instanceof Set ? a : new Set(a);
  const bSet = b instanceof Set ? b : new Set(b);
  return [...aSet].filter((key) => !bSet.has(key)).sort();
}

/**
 * 校验某份 schema 中所有字段类型可识别（标量或本文件内已知 model）。
 * @returns {string[]} 问题描述数组（空 = 通过）
 */
function findUnrecognizedTypes(filePath, models) {
  const problems = [];
  for (const [modelName, fields] of models) {
    for (const [fieldName, field] of fields) {
      if (SCALAR_TYPES.has(field.type) || models.has(field.type)) {
        continue;
      }
      problems.push(
        `${filePath} 中的 ${modelName}.${fieldName}（第 ${field.line} 行）类型 "${field.type}" 无法识别：既不是标量类型，也不是本 schema 内的 model。`,
      );
    }
  }
  return problems;
}

const sqliteModels = parseSchema(FILE_SQLITE);
const pgModels = parseSchema(FILE_PG);

if (sqliteModels.size === 0 || pgModels.size === 0) {
  console.error('❌ 未从某个 schema 中解析出任何 model —— 请检查文件格式（正则只识别行首 `model X {`）。');
  process.exit(1);
}

// 层 0：类型可识别性（防止拼写错误/非法类型被静默放过）
const unrecognized = [
  ...findUnrecognizedTypes('schema.prisma', sqliteModels),
  ...findUnrecognizedTypes('schema.pg.prisma', pgModels),
];
if (unrecognized.length > 0) {
  console.error('❌ 存在无法识别的字段类型：');
  for (const problem of unrecognized) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

// 层 ①：model 集合
const modelsOnlySqlite = difference(sqliteModels.keys(), pgModels.keys());
const modelsOnlyPg = difference(pgModels.keys(), sqliteModels.keys());
if (modelsOnlySqlite.length > 0 || modelsOnlyPg.length > 0) {
  console.error('❌ 两个 Prisma schema 的 model 集合不一致（存在漂移），拒绝通过：');
  if (modelsOnlySqlite.length > 0) {
    console.error(`  只在 schema.prisma（SQLite）有：${modelsOnlySqlite.join(', ')}`);
  }
  if (modelsOnlyPg.length > 0) {
    console.error(`  只在 schema.pg.prisma（PG）有：${modelsOnlyPg.join(', ')}`);
  }
  console.error('  请让两套 schema 的 model 集合保持一致后再提交（PG 版按生产 provider 改写类型）。');
  process.exit(1);
}

// 层 ②③：逐个 model 比字段名集合与字段签名
const diffs = [];
let fieldCount = 0;

for (const modelName of [...sqliteModels.keys()].sort()) {
  const left = sqliteModels.get(modelName);
  const right = pgModels.get(modelName);
  fieldCount += left.size;

  const fieldsOnlyLeft = difference(left.keys(), right.keys());
  const fieldsOnlyRight = difference(right.keys(), left.keys());

  for (const fieldName of fieldsOnlyLeft) {
    diffs.push(`${modelName}.${fieldName}   左(schema.prisma)=${signature(left.get(fieldName))}   右(schema.pg.prisma)=<缺失>`);
  }
  for (const fieldName of fieldsOnlyRight) {
    diffs.push(`${modelName}.${fieldName}   左(schema.prisma)=<缺失>   右(schema.pg.prisma)=${signature(right.get(fieldName))}`);
  }

  for (const fieldName of [...left.keys()].sort()) {
    if (!right.has(fieldName)) {
      continue;
    }
    const l = left.get(fieldName);
    const r = right.get(fieldName);
    const sameShape = l.optional === r.optional && l.array === r.array;
    if (sameShape && typesEquivalent(l.type, r.type)) {
      continue;
    }
    diffs.push(
      `${modelName}.${fieldName}   左(schema.prisma)=${signature(l)}   右(schema.pg.prisma)=${signature(r)}`,
    );
  }
}

if (diffs.length > 0) {
  console.error('❌ 两个 Prisma schema 存在字段级漂移，拒绝通过（模型.字段  左  vs  右）：');
  for (const diff of diffs) {
    console.error(`  - ${diff}`);
  }
  console.error('  提示：类型白名单仅含 Int↔BigInt / String↔DateTime / Float↔Decimal；Json↔String 属漂移。');
  process.exit(1);
}

console.log(`✅ 两个 schema 一致（${sqliteModels.size} 个 model / ${fieldCount} 个字段）`);
