/**
 * 单位换算（零依赖纯函数，ARCHITECTURE §7 K6）。
 *
 * 换算基准：1 kcal = 4.184 kJ；1 kg = 1000 g；1 l = 1000 ml。
 */

/** 1 千卡（kcal）对应的千焦（kJ）数。 */
export const KJ_PER_KCAL = 4.184;

/** 千卡 → 千焦。 */
export function kcalToKj(kcal: number): number {
  return kcal * KJ_PER_KCAL;
}

/** 千焦 → 千卡。 */
export function kjToKcal(kj: number): number {
  return kj / KJ_PER_KCAL;
}

/** 克 → 千克。 */
export function gToKg(grams: number): number {
  return grams / 1000;
}

/** 千克 → 克。 */
export function kgToG(kilograms: number): number {
  return kilograms * 1000;
}

/** 毫升 → 升。 */
export function mlToL(milliliters: number): number {
  return milliliters / 1000;
}

/** 升 → 毫升。 */
export function lToMl(liters: number): number {
  return liters * 1000;
}
