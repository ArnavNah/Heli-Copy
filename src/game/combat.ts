export type PlayerDamageType = "BULLET" | "EXPLOSIVE" | "MISSILE" | "COLLISION";

export interface PlayerDamageResolution {
  requested: number;
  mitigation: number;
  applied: number;
  health: number;
  blocked: boolean;
}

/** Permanent + run armor is deliberately capped below near-invulnerability. */
export function armorMitigation(permanentRank: number, runRanks = 0): number {
  const permanent = Math.max(0, Math.floor(Number.isFinite(permanentRank) ? permanentRank : 0)) * 0.05;
  const temporary = Math.max(0, Math.floor(Number.isFinite(runRanks) ? runRanks : 0)) * 0.06;
  return Math.min(0.24, permanent + temporary);
}

export function resolvePlayerDamage(
  currentHealth: number,
  maxHealth: number,
  amount: number,
  mitigation: number,
  blocked = false,
): PlayerDamageResolution {
  const max = Number.isFinite(maxHealth) ? Math.max(1, maxHealth) : 1;
  const current = Number.isFinite(currentHealth) ? Math.max(0, Math.min(max, currentHealth)) : max;
  const requested = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const reduction = Math.max(0, Math.min(0.24, Number.isFinite(mitigation) ? mitigation : 0));
  const applied = blocked ? 0 : Math.max(0, Math.round(requested * (1 - reduction) * 10) / 10);
  return {
    requested,
    mitigation: reduction,
    applied,
    health: Math.max(0, Math.min(max, current - applied)),
    blocked,
  };
}

export function resolveRepair(currentHealth: number, maxHealth: number, amount: number, efficiency = 1): number {
  const max = Number.isFinite(maxHealth) ? Math.max(1, maxHealth) : 1;
  const current = Number.isFinite(currentHealth) ? Math.max(0, Math.min(max, currentHealth)) : max;
  const repair = Math.max(0, Number.isFinite(amount) ? amount : 0) * Math.max(0, Number.isFinite(efficiency) ? efficiency : 1);
  return Math.min(max, current + repair);
}
