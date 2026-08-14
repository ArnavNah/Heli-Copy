export const THREAT_THRESHOLDS = [0, 30, 80, 150, 240] as const;
export const THREAT_NAMES = ["LOW", "ELEVATED", "HIGH", "CRITICAL", "EXTREME"] as const;
export const THREAT_REWARD_MULTIPLIERS = [1, 1.1, 1.25, 1.45, 1.7] as const;

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

export function settleExtraction(wallet: number, unsecured: number) {
  const securedBonus = Math.max(0, Math.round(unsecured));
  return { wallet: Math.max(0, Math.round(wallet)) + securedBonus, securedBonus, unsecured: 0 };
}
