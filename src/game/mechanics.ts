export const THREAT_THRESHOLDS = [0, 30, 80, 150, 240] as const;
export const THREAT_NAMES = ["LOW", "ELEVATED", "HIGH", "CRITICAL", "EXTREME"] as const;
export const THREAT_REWARD_MULTIPLIERS = [1, 1.1, 1.25, 1.45, 1.7] as const;
export const SALVAGE_CREDIT_VALUE = 5;

export type ThreatLevel = 1 | 2 | 3 | 4 | 5;

export function threatLevelForPoints(points: number): ThreatLevel {
  const safe = Number.isFinite(points) ? Math.max(0, points) : 0;
  for (let i = THREAT_THRESHOLDS.length - 1; i >= 0; i--) {
    if (safe >= THREAT_THRESHOLDS[i]) return (i + 1) as ThreatLevel;
  }
  return 1;
}

export function threatRewardMultiplier(level: ThreatLevel): number {
  return THREAT_REWARD_MULTIPLIERS[level - 1];
}

export function threatBonusFor(baseReward: number, level: ThreatLevel): number {
  return Math.max(0, Math.round(Math.max(0, baseReward) * (threatRewardMultiplier(level) - 1)));
}

export function salvageCreditsFor(amount: number): number {
  const salvage = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  return salvage * SALVAGE_CREDIT_VALUE;
}

export function securedObjectiveReward(type: number): number {
  if (type === 0) return 55; // SAM
  if (type === 1) return 45; // Radar
  return 35; // Ammo depot
}

export function securedEnemyBounty(type: number, elite: boolean): number {
  if (type === 4) return 320; // Boss
  if (elite) return 70;
  return 0;
}

export function salvageForEnemy(type: number, elite: boolean): number {
  if (type === 4) return 16;
  if (elite) return 6;
  if (type === 2) return 2;
  return 0;
}

export function salvageForObjective(type: number): number {
  if (type === 0) return 5;
  if (type === 1) return 4;
  return 3;
}

export interface ThreatDirectorConfig {
  directorWaveBonus: number;
  squadChanceBonus: number;
  eliteChanceBonus: number;
  activeEnemyCapBonus: number;
  spawnIntervalMult: number;
}

export function threatDirectorConfig(level: ThreatLevel): ThreatDirectorConfig {
  const idx = level - 1;
  return {
    directorWaveBonus: idx * 2,
    squadChanceBonus: idx * 0.055,
    eliteChanceBonus: idx * 0.018,
    activeEnemyCapBonus: idx * 2,
    spawnIntervalMult: Math.max(0.78, 1 - idx * 0.045),
  };
}

export interface CountermeasureConfig {
  maxCharges: number;
  cooldown: number;
  activeWindow: number;
  effectiveness: number;
}

export function countermeasureConfig(rank: number): CountermeasureConfig {
  const level = Math.max(0, Math.min(5, Math.floor(Number.isFinite(rank) ? rank : 0)));
  return {
    maxCharges: 3 + (level >= 3 ? 1 : 0),
    cooldown: level >= 5 ? 5.2 : level >= 2 ? 6 : 6.5,
    activeWindow: level >= 4 ? 1.25 : 1.05,
    effectiveness: level >= 5 ? 0.96 : 0.9,
  };
}

export class CountermeasureState {
  charges: number;
  readonly maxCharges: number;
  readonly cooldown: number;
  cooldownRemaining = 0;
  activeTimer = 0;
  lastDeployTime = -Infinity;

  constructor(public readonly config: CountermeasureConfig) {
    this.maxCharges = config.maxCharges;
    this.charges = config.maxCharges;
    this.cooldown = config.cooldown;
  }

  update(delta: number) {
    const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    this.activeTimer = Math.max(0, this.activeTimer - dt);
  }

  deploy(time: number): boolean {
    if (this.charges <= 0 || this.cooldownRemaining > 0) return false;
    this.charges--;
    this.cooldownRemaining = this.cooldown;
    this.activeTimer = this.config.activeWindow;
    this.lastDeployTime = time;
    return true;
  }

  replenish(amount = 1): number {
    const before = this.charges;
    this.charges = Math.min(this.maxCharges, this.charges + Math.max(0, Math.floor(amount)));
    return this.charges - before;
  }
}

export function settleExtraction(wallet: number, unsecured: number, salvage = 0) {
  const salvageCredits = salvageCreditsFor(salvage);
  const securedBonus = Math.max(0, Math.round(unsecured)) + salvageCredits;
  return { wallet: Math.max(0, Math.round(wallet)) + securedBonus, securedBonus, unsecured: 0 };
}
