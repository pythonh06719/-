import { Injectable } from '@nestjs/common';

import { round1 } from '@qsh/core';
import type {
  FoodItem,
  ListMealsResponse,
  MealCombo,
  MealComboItem,
  MealGroup,
  MealLog,
  MealType,
} from '@qsh/shared-types';

import { ERROR_CODES } from '../common/constants/error-codes';
import { ApiException } from '../common/exceptions/api.exception';
import { toFoodItem, toMealCombo, toMealLog } from '../common/mappers/entity.mapper';
import { todayLocalKey } from '../common/utils/date.util';
import { FoodsService } from '../foods/foods.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyComboDto, ComboItemDto, CreateComboDto } from './dto/combo.dto';
import { CreateMealDto } from './dto/create-meal.dto';
import { ListMealsDto } from './dto/list-meals.dto';
import { QuickAddDto } from './dto/quick-add.dto';

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
      },
    });

    return { entry: toMealLog(row), dayTotals: await this.dayTotals(userId, loggedDate) };
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

    const created = await this.prisma.$transaction(
      items.map((item) =>
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
            sortOrder: item.sortOrder,
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
