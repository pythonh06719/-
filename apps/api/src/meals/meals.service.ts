import { Injectable } from '@nestjs/common';

import { applyReorder, round1 } from '@qsh/core';
import type {
  FoodItem,
  ListMealsResponse,
  MealCombo,
  MealComboItem,
  MealGroup,
  MealLog,
  MealType,
  ReorderMealsResponse,
} from '@qsh/shared-types';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { toFoodItem, toMealCombo, toMealLog } from '../common/mappers/entity.mapper';
import { isValidLocalDateKey, todayLocalKey } from '../common/utils/date.util';
import { FoodsService } from '../foods/foods.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyComboDto, ComboItemDto, CreateComboDto } from './dto/combo.dto';
import { CreateMealDto } from './dto/create-meal.dto';
import { ListMealsDto } from './dto/list-meals.dto';
import { QuickAddDto } from './dto/quick-add.dto';
import { ReorderMealsDto } from './dto/reorder-meals.dto';

/** 当日营养合计。 */
export interface DayTotals {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

/** 餐次固定顺序（契约 `ListMealsResponse.groups` 依赖固定四项，前端按此渲染）。 */
const MEAL_TYPE_ORDER: readonly MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** 单条写入结果（含实时反馈所需 `dayTotals`，R3.10 / TC-25）。 */
export interface MealWriteResult {
  entry: MealLog;
  dayTotals: DayTotals;
}

/** 套餐一键应用结果。 */
export interface ComboApplyResult {
  entries: MealLog[];
  dayTotals: DayTotals;
}

/**
 * `PATCH /meals/reorder` 的最小输入行（供 `applyReorder` 消费）。
 *
 * 只投影 `id / mealType / sortOrder` —— 不把整行拉进内存。
 */
interface ReorderRow {
  id: number;
  mealType: string;
  sortOrder: number;
}

/** 份量解析结果。 */
interface ResolvedAmount {
  grams: number;
  servingUnit: string | null;
  servingQty: number | null;
}

/** 套餐明细写入载荷（Prisma 输入）。 */
interface PreparedComboItem {
  foodItemId: number | null;
  customName: string;
  grams: number | null;
  servingUnit: string | null;
  servingQty: number | null;
  kcal: number;
  proteinG: number | null;
  fatG: number | null;
  carbG: number | null;
  sortOrder: number;
}

/**
 * 饮食记录服务（R3.4 / R3.5 / R3.8 / R3.9 / R3.10）。
 *
 * - 自然份量输入 → 按 `serving_units` 克数换算（每 100g 营养 × 选定克数 ÷ 100）；
 * - 快速加卡**不写 `food_items`**，仅写 `meal_logs` 的 custom 快照字段（TC-19）；
 * - 每次写操作返回 `dayTotals`，支撑前端「记录后实时反馈」（R3.10）。
 */
@Injectable()
export class MealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly foodsService: FoodsService,
  ) {}

  /**
   * 按日（或区间）+ 按餐查询，返回**权威契约形态**的 `ListMealsResponse`：
   * `{ date, groups: MealGroup[], totalKcal }`，`groups` 为数组且**固定包含四个餐次**
   * （`breakfast → lunch → dinner → snack`，空餐次也返回 `{ mealType, logs: [], totalKcal: 0 }`，
   * 前端依赖固定四项渲染 —— QA BUG-01）。
   */
  async listByDate(userId: number, dto: ListMealsDto): Promise<ListMealsResponse> {
    const date = dto.date ?? dto.from ?? todayLocalKey();
    const rows = await this.prisma.mealLog.findMany({
      where: {
        userId,
        ...(dto.from && dto.to ? { loggedDate: { gte: dto.from, lte: dto.to } } : { loggedDate: date }),
        ...(dto.mealType ? { mealType: dto.mealType } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    const logs = rows.map(toMealLog);

    const byType = new Map<MealType, MealLog[]>();
    for (const log of logs) {
      const bucket = byType.get(log.mealType);
      if (bucket) {
        bucket.push(log);
      } else {
        byType.set(log.mealType, [log]);
      }
    }

    const groups: MealGroup[] = MEAL_TYPE_ORDER.map((mealType) => {
      const mealLogs = byType.get(mealType) ?? [];
      return { mealType, logs: mealLogs, totalKcal: this.sumKcal(mealLogs) };
    });

    return {
      date,
      groups,
      totalKcal: round1(groups.reduce((sum, group) => sum + group.totalKcal, 0)),
    };
  }

  /** 当日营养合计（供看板与写操作反馈复用）。 */
  async dayTotals(userId: number, date: string): Promise<DayTotals> {
    const rows = await this.prisma.mealLog.findMany({
      where: { userId, loggedDate: date },
      select: { kcal: true, proteinG: true, fatG: true, carbG: true },
    });

    let kcal = 0;
    let proteinG = 0;
    let fatG = 0;
    let carbG = 0;
    for (const row of rows) {
      kcal += row.kcal;
      proteinG += row.proteinG ?? 0;
      fatG += row.fatG ?? 0;
      carbG += row.carbG ?? 0;
    }
    return {
      kcal: round1(kcal),
      proteinG: round1(proteinG),
      fatG: round1(fatG),
      carbG: round1(carbG),
    };
  }

  /** 新增一条记录（食物库来源 / 自定义来源）。 */
  async create(userId: number, dto: CreateMealDto): Promise<MealWriteResult> {
    const loggedDate = dto.loggedDate ?? todayLocalKey();
    const explicitGrams = dto.grams ?? dto.amountG;

    if (typeof dto.foodId === 'number') {
      const foodRow = await this.foodsService.requireVisibleFood(userId, dto.foodId);
      const food = toFoodItem(foodRow);
      const amount = this.resolveAmount(food, {
        grams: explicitGrams,
        servingUnit: dto.servingUnit,
        servingQty: dto.servingQty,
      });
      const nutrients = this.computeNutrients(food, amount.grams);
      // AC-3.8.5：sortOrder 一律由服务端分配（本用户·本日·本餐 max + 1），排在最后。
      const sortOrder = await this.nextSortOrder(userId, loggedDate, dto.mealType);

      const row = await this.prisma.mealLog.create({
        data: {
          userId,
          loggedDate,
          mealType: dto.mealType,
          foodItemId: food.id,
          customName: dto.customName ?? null,
          grams: amount.grams,
          servingUnit: amount.servingUnit,
          servingQty: amount.servingQty,
          kcal: nutrients.kcal,
          proteinG: nutrients.proteinG,
          fatG: nutrients.fatG,
          carbG: nutrients.carbG,
          fiberG: nutrients.fiberG,
          sodiumMg: nutrients.sodiumMg,
          source: dto.source ?? 'search',
          note: dto.note ?? null,
          sortOrder,
        },
      });

      return { entry: toMealLog(row), dayTotals: await this.dayTotals(userId, loggedDate) };
    }

    const customName = dto.customName?.trim();
    if (customName && customName.length > 0) {
      if (typeof dto.customKcal !== 'number') {
        throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请填写这项的热量', {
          customKcal: '请填写热量',
        });
      }
      // AC-3.8.5：同上，服务端分配 sortOrder。
      const sortOrder = await this.nextSortOrder(userId, loggedDate, dto.mealType);
      const row = await this.prisma.mealLog.create({
        data: {
          userId,
          loggedDate,
          mealType: dto.mealType,
          foodItemId: null,
          customName,
          grams: typeof explicitGrams === 'number' ? round1(explicitGrams) : null,
          servingUnit: null,
          servingQty: null,
          kcal: round1(dto.customKcal),
          proteinG: null,
          fatG: null,
          carbG: null,
          source: 'quick_add',
          note: dto.note ?? null,
          sortOrder,
        },
      });
      return { entry: toMealLog(row), dayTotals: await this.dayTotals(userId, loggedDate) };
    }

    throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请选择食物，或填写名称与热量', {
      foodId: '请选择食物，或填写名称与热量',
    });
  }

  /** 快速加卡（跳过搜索，仅名称 + 热量，TC-19）。 */
  async quickAdd(userId: number, dto: QuickAddDto): Promise<MealWriteResult> {
    const loggedDate = dto.loggedDate ?? todayLocalKey();
    const name = (dto.customName ?? dto.name ?? '').trim();
    const kcal = dto.customKcal ?? dto.kcal;

    const fields: Record<string, string> = {};
    if (name.length === 0) {
      fields.customName = '请填写名称';
    }
    if (typeof kcal !== 'number') {
      fields.customKcal = '请填写热量';
    }
    if (Object.keys(fields).length > 0) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请填写名称与热量', fields);
    }

    // AC-3.8.5：同上，服务端分配 sortOrder。
    const sortOrder = await this.nextSortOrder(userId, loggedDate, dto.mealType);
    const row = await this.prisma.mealLog.create({
      data: {
        userId,
        loggedDate,
        mealType: dto.mealType,
        foodItemId: null,
        customName: name,
        grams: null,
        servingUnit: null,
        servingQty: null,
        kcal: round1(kcal as number),
        proteinG: dto.proteinG ?? null,
        fatG: dto.fatG ?? null,
        carbG: dto.carbG ?? null,
        source: 'quick_add',
        note: dto.note ?? null,
        sortOrder,
      },
    });

    return { entry: toMealLog(row), dayTotals: await this.dayTotals(userId, loggedDate) };
  }

  /**
   * 餐内排序 / 跨餐移动（R3.8 / AC-3.8.3 / AC-3.8.4）。
   *
   * 语义：`orderedIds` = **目标餐次的完整期望顺序**，列出的记录被置为 `mealType`
   * 并按序赋 `sortOrder = index`。上移 / 下移 / 跨餐 / 拖拽四种操作共用本接口（D-1）。
   *
   * 错误分支（**顺序固定，不可调换**）：
   * - 完全不存在的 id → 400 `E_VALID_INPUT`，`fields.orderedIds` 列出具体 id；
   * - 存在但属于他人 → 404 `E_NOTFOUND_MEAL`（不暴露他人资源存在性）；
   * - 存在且属于本人但不在这一天 → 400 `E_VALID_INPUT`。
   *
   * 幂等：同一 payload 重复提交结果一致（compact 归零归一，D-2）。
   */
  async reorder(userId: number, dto: ReorderMealsDto): Promise<ReorderMealsResponse> {
    if (!isValidLocalDateKey(dto.loggedDate)) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '日期格式应为 YYYY-MM-DD', {
        loggedDate: '日期格式应为 YYYY-MM-DD',
      });
    }

    const uniqueIds: number[] = [...new Set(dto.orderedIds ?? [])];
    if (uniqueIds.length === 0) {
      return { updated: [] };
    }

    // 4. 本人 · 本日的行（三要素同时约束）
    const mine = await this.prisma.mealLog.findMany({
      where: { userId, loggedDate: dto.loggedDate, id: { in: uniqueIds } },
      select: { id: true },
    });
    const mineIds = new Set(mine.map((row) => row.id));

    // 5a. 全表都查不到的 id → 400（列出具体 id）
    const missing = uniqueIds.filter((id) => !mineIds.has(id));
    if (missing.length > 0) {
      const existing = await this.prisma.mealLog.findMany({
        where: { id: { in: missing } },
        select: { id: true, userId: true, loggedDate: true },
      });
      const existingById = new Map(existing.map((row) => [row.id, row]));

      // 5b. 存在但属于他人 → 404（不暴露他人资源）
      const foreign = missing.filter((id) => {
        const row = existingById.get(id);
        return row !== undefined && row.userId !== userId;
      });
      if (foreign.length > 0) {
        throw new ApiException(404, ERROR_CODES.NOTFOUND_MEAL, '没有找到这条记录');
      }

      // 5c. 属于本人但不在这一天 → 400，说明该条不在这一天
      const otherDay = missing.filter((id) => {
        const row = existingById.get(id);
        return row !== undefined && row.userId === userId && row.loggedDate !== dto.loggedDate;
      });
      if (otherDay.length > 0) {
        throw new ApiException(400, ERROR_CODES.VALID_INPUT, '有几条记录不在这一天', {
          orderedIds: `id 为 ${otherDay.join('、')} 的记录不在这一天`,
        });
      }

      // 剩下的是「全表都不存在」的 id
      const absent = missing.filter((id) => !existingById.has(id));
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '没有找到这几条记录', {
        orderedIds: `没有找到 id 为 ${absent.join('、')} 的记录`,
      });
    }

    // 6. 取出该用户该日**全部**记录（供 compact 用；单日数据量恒定很小）
    const allRows = await this.prisma.mealLog.findMany({
      where: { userId, loggedDate: dto.loggedDate },
      select: { id: true, mealType: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    // 7. 纯函数计算新映射（core 是唯一真源，前端乐观更新用同一个函数）
    const items = allRows.map(
      (row): { id: number; mealType: MealType; sortOrder: number } => ({
        id: row.id,
        mealType: row.mealType as MealType,
        sortOrder: row.sortOrder,
      }),
    );
    const next = applyReorder(items, dto.mealType, uniqueIds, { compact: true });

    // 8. 只把**实际发生变化**的行放进事务（避免无谓写入与 updatedAt 抖动）
    const currentById = new Map(allRows.map((row) => [row.id, row]));
    const changed = next.filter((row) => {
      const current = currentById.get(row.id);
      return current === undefined || current.mealType !== row.mealType || current.sortOrder !== row.sortOrder;
    });

    if (changed.length > 0) {
      await this.prisma.$transaction(
        changed.map((row) =>
          this.prisma.mealLog.update({
            where: { id: row.id },
            data: { mealType: row.mealType, sortOrder: row.sortOrder },
          }),
        ),
      );
    }

    // 9. 返回全部受影响行的新映射（含被 compact 牵连的其它餐次）
    return {
      updated: changed.map((row) => ({
        id: row.id,
        mealType: row.mealType,
        sortOrder: row.sortOrder,
      })),
    };
  }

  /** 删除一条记录（越权 = 404，不泄露存在性）。 */
  async remove(userId: number, id: number): Promise<{ deleted: true; dayTotals: DayTotals }> {
    const row = await this.prisma.mealLog.findUnique({ where: { id } });
    if (!row || row.userId !== userId) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_MEAL, '没有找到这条记录');
    }
    await this.prisma.mealLog.delete({ where: { id } });
    return { deleted: true, dayTotals: await this.dayTotals(userId, row.loggedDate) };
  }

  // -------------------------------------------------------------------------
  // 套餐模板
  // -------------------------------------------------------------------------

  /** 套餐模板列表（含明细）。 */
  async listCombos(userId: number): Promise<Array<MealCombo & { items: MealComboItem[] }>> {
    const rows = await this.prisma.mealCombo.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toMealCombo);
  }

  /** 新建套餐模板。 */
  async createCombo(userId: number, dto: CreateComboDto): Promise<MealCombo & { items: MealComboItem[] }> {
    const name = dto.name.trim();
    if (name.length === 0) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '请填写套餐名称', { name: '请填写套餐名称' });
    }

    const existing = await this.prisma.mealCombo.findFirst({ where: { userId, name } });
    if (existing) {
      throw new ApiException(409, ERROR_CODES.VALID_DUPLICATE, '已经有一个同名套餐了，换个名字试试');
    }

    const prepared: PreparedComboItem[] = [];
    for (let index = 0; index < dto.items.length; index += 1) {
      const item = dto.items[index] as ComboItemDto;
      prepared.push(await this.prepareComboItem(userId, item, index));
    }

    const combo = await this.prisma.mealCombo.create({
      data: {
        userId,
        name,
        mealType: dto.mealType ?? 'breakfast',
        items: { create: prepared },
      },
      include: { items: true },
    });

    return toMealCombo(combo);
  }

  /** 一键用套餐记一餐（一次性写入多条 `meal_logs`）。 */
  async applyCombo(userId: number, comboId: number, dto: ApplyComboDto): Promise<ComboApplyResult> {
    const combo = await this.prisma.mealCombo.findFirst({
      where: { id: comboId, userId },
      include: { items: true },
    });
    if (!combo) {
      throw new ApiException(404, ERROR_CODES.NOTFOUND_COMBO, '没有找到这个套餐');
    }

    const loggedDate = dto.loggedDate ?? todayLocalKey();
    const mealType = dto.mealType ?? (combo.mealType as MealType);
    const items = [...combo.items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

    // AC-3.8.5：套餐从「本餐当前最大值 + 1」起按明细顺序编号，
    // **不再直接用模板的 `item.sortOrder`**（模板序号与当日实际序列无关，会把新记录插到最前）。
    const baseSortOrder = await this.nextSortOrder(userId, loggedDate, mealType);

    const created = await this.prisma.$transaction(
      items.map((item, index) =>
        this.prisma.mealLog.create({
          data: {
            userId,
            loggedDate,
            mealType,
            foodItemId: item.foodItemId,
            customName: item.customName,
            grams: item.grams,
            servingUnit: item.servingUnit,
            servingQty: item.servingQty,
            kcal: item.kcal,
            proteinG: item.proteinG,
            fatG: item.fatG,
            carbG: item.carbG,
            source: 'combo',
            comboId: combo.id,
            sortOrder: baseSortOrder + index,
          },
        }),
      ),
    );

    return {
      entries: created.map(toMealLog),
      dayTotals: await this.dayTotals(userId, loggedDate),
    };
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  /**
   * **服务端单一入口**：取「本用户 · 本日 · 本餐」当前最大 `sortOrder` + 1（AC-3.8.5 / K14）。
   *
   * ⚠️ 这是本轮最容易漏的一处：`sort_order` 列、实体字段、读取时的双层 `orderBy`
   * 全都是现成的，看起来"已经支持排序了"，但服务端新增时从不分配（Prisma `@default(0)`），
   * 前端 `DiaryPage.tsx` 也硬编码 `sortOrder: 0`。只要漏掉这一改，
   * 用户**拖完顺序之后**新记的一条就会插到最前面 —— 全新用户测试完全测不出来。
   *
   * `create()` / `quickAdd()` / `applyCombo()` **三处**都必须调用本方法。
   *
   * @returns 新的排序值（空餐时为 0）
   */
  private async nextSortOrder(userId: number, loggedDate: string, mealType: MealType | string): Promise<number> {
    const agg = await this.prisma.mealLog.aggregate({
      where: { userId, loggedDate, mealType },
      _max: { sortOrder: true },
    });
    return (agg._max.sortOrder ?? -1) + 1;
  }

  /** 解析份量：显式克数 > 份量单位换算 > 默认份量 > 100g。 */
  private resolveAmount(
    food: FoodItem,
    input: { grams?: number; servingUnit?: string; servingQty?: number },
  ): ResolvedAmount {
    if (typeof input.grams === 'number' && input.grams > 0) {
      return { grams: round1(input.grams), servingUnit: null, servingQty: null };
    }

    if (
      input.servingUnit &&
      typeof input.servingQty === 'number' &&
      input.servingQty > 0
    ) {
      const unit = food.servingUnits.find((item) => item.unit === input.servingUnit);
      if (unit) {
        return {
          grams: round1(unit.grams * input.servingQty),
          servingUnit: unit.unit,
          servingQty: input.servingQty,
        };
      }
    }

    if (typeof food.defaultServingGrams === 'number' && food.defaultServingGrams > 0) {
      return { grams: round1(food.defaultServingGrams), servingUnit: null, servingQty: 1 };
    }

    return { grams: 100, servingUnit: null, servingQty: null };
  }

  /** 按选定克数换算营养（每 100g × 克数 ÷ 100）。 */
  private computeNutrients(
    food: FoodItem,
    grams: number,
  ): {
    kcal: number;
    proteinG: number;
    fatG: number;
    carbG: number;
    fiberG: number | null;
    sodiumMg: number | null;
  } {
    const factor = grams / 100;
    return {
      kcal: round1(food.kcalPer100g * factor),
      proteinG: round1(food.proteinGPer100g * factor),
      fatG: round1(food.fatGPer100g * factor),
      carbG: round1(food.carbGPer100g * factor),
      fiberG: food.fiberGPer100g === null ? null : round1(food.fiberGPer100g * factor),
      sodiumMg: food.sodiumMgPer100g === null ? null : round1(food.sodiumMgPer100g * factor),
    };
  }

  /** 归一单条套餐明细（食物库条目自动换算热量；自定义条目需显式热量）。 */
  private async prepareComboItem(
    userId: number,
    item: ComboItemDto,
    index: number,
  ): Promise<PreparedComboItem> {
    const label = (item.customName ?? item.name ?? '').trim();
    const explicitGrams = item.grams ?? item.amountG;

    if (typeof item.foodId === 'number') {
      const foodRow = await this.foodsService.requireVisibleFood(userId, item.foodId);
      const food = toFoodItem(foodRow);
      const grams =
        typeof explicitGrams === 'number' && explicitGrams > 0
          ? round1(explicitGrams)
          : round1(food.defaultServingGrams ?? 100);
      const nutrients = this.computeNutrients(food, grams);

      return {
        foodItemId: food.id,
        customName: label.length > 0 ? label : food.name,
        grams,
        servingUnit: item.servingUnit ?? null,
        servingQty: item.servingQty ?? null,
        kcal: typeof item.kcal === 'number' ? round1(item.kcal) : nutrients.kcal,
        proteinG: typeof item.proteinG === 'number' ? round1(item.proteinG) : nutrients.proteinG,
        fatG: typeof item.fatG === 'number' ? round1(item.fatG) : nutrients.fatG,
        carbG: typeof item.carbG === 'number' ? round1(item.carbG) : nutrients.carbG,
        sortOrder: item.sortOrder ?? index,
      };
    }

    if (label.length === 0) {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '套餐里有条目缺少名称', {
        items: `第 ${index + 1} 项缺少名称`,
      });
    }
    if (typeof item.kcal !== 'number') {
      throw new ApiException(400, ERROR_CODES.VALID_INPUT, '自定义条目需要填写热量', {
        items: `第 ${index + 1} 项缺少热量`,
      });
    }

    return {
      foodItemId: null,
      customName: label,
      grams: typeof explicitGrams === 'number' ? round1(explicitGrams) : null,
      servingUnit: item.servingUnit ?? null,
      servingQty: item.servingQty ?? null,
      kcal: round1(item.kcal),
      proteinG: typeof item.proteinG === 'number' ? round1(item.proteinG) : null,
      fatG: typeof item.fatG === 'number' ? round1(item.fatG) : null,
      carbG: typeof item.carbG === 'number' ? round1(item.carbG) : null,
      sortOrder: item.sortOrder ?? index,
    };
  }

  /** 汇总一组记录的热量 kcal（保留 1 位小数）。 */
  private sumKcal(logs: MealLog[]): number {
    let kcal = 0;
    for (const log of logs) {
      kcal += log.kcal;
    }
    return round1(kcal);
  }
}
