import { PowerUpType } from "./types";

export type LootTier = "BASIC" | "SPECIAL" | "ELITE" | "BOSS" | "MISSION";

export interface LootPlan {
  salvage: number;
  powerup: PowerUpType | null;
  countermeasure: boolean;
}

const USEFUL_POWERUPS = [PowerUpType.HEALTH, PowerUpType.AMMO, PowerUpType.FUEL, PowerUpType.SHIELD] as const;

/** Pure weighted loot decision. Callers provide rolls so tests and replays stay deterministic. */
export function rollLoot(tier: LootTier, chanceRoll: number, typeRoll: number): LootPlan {
  const chance = Math.max(0, Math.min(0.999999, chanceRoll));
  const typeIndex = Math.floor(Math.max(0, Math.min(0.999999, typeRoll)) * USEFUL_POWERUPS.length);
  if (tier === "BOSS") return { salvage: 6, powerup: USEFUL_POWERUPS[typeIndex], countermeasure: true };
  if (tier === "MISSION") return { salvage: 3, powerup: chance < 0.5 ? USEFUL_POWERUPS[typeIndex] : null, countermeasure: chance >= 0.8 };
  if (tier === "ELITE") return { salvage: 2 + (chance < 0.35 ? 1 : 0), powerup: chance < 0.78 ? USEFUL_POWERUPS[typeIndex] : null, countermeasure: chance >= 0.78 };
  if (tier === "SPECIAL") return { salvage: chance < 0.28 ? 1 : 0, powerup: chance >= 0.28 && chance < 0.42 ? USEFUL_POWERUPS[typeIndex] : null, countermeasure: false };
  return { salvage: chance < 0.08 ? 1 : 0, powerup: chance >= 0.08 && chance < 0.14 ? USEFUL_POWERUPS[typeIndex] : null, countermeasure: false };
}

export function salvageCreditValue(salvage: number): number {
  return Math.max(0, Math.floor(salvage)) * 5;
}

export function collectSalvage(current: number, pickupValue: number): number {
  const held = Number.isFinite(current) ? Math.max(0, Math.floor(current)) : 0;
  const collected = Number.isFinite(pickupValue) ? Math.max(0, Math.floor(pickupValue)) : 0;
  return held + collected;
}

export function canUseDepotService(distance: number, cooldown: number, needsService: boolean): boolean {
  return Number.isFinite(distance) && distance <= 18 && cooldown <= 0 && needsService;
}
