// Pure game logic — no THREE/CANNON/DOM dependencies, unit-testable.
// EnemyType is imported as a value but types.ts only uses type-only imports
// for THREE/CANNON, so it stays dependency-free at runtime.
import { EnemyType, WeaponType } from "./types";

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

export type Difficulty = 'casual' | 'normal' | 'hard';

export interface DifficultyConfig {
  /** Enemy hull HP multiplier. */
  enemyHp: number;
  /** Enemy projectile damage multiplier. */
  enemyDamage: number;
  /** Active-enemy cap multiplier (higher = denser swarms). */
  spawnRate: number;
  /** Max bonus from the Risky Rendezvous low-health multiplier. */
  maxRisk: number;
  /** Objective HP multiplier. */
  objectiveHp: number;
  /** Threat-budget multiplier for special composition pressure. */
  threatBudget: number;
  /** Extra elite probability added by difficulty. */
  eliteChance: number;
  /** Extra special/squad probability added by difficulty. */
  specialChance: number;
  /** SAM lock-time multiplier (<1 = faster). */
  samLock: number;
  /** Extraction hold-time multiplier (>1 = more forgiving). */
  extractionHold: number;
  /** Enemy projectile speed multiplier (<1 = slower, easier to read). */
  enemyProjectileSpeed: number;
  /** Enemy fire-interval multiplier (>1 = fires less often). */
  enemyFireInterval: number;
  /** Collision/building damage multiplier taken by the player. */
  collisionDamage: number;
  /** Homing strength multiplier for enemy missiles. */
  homingStrength: number;
  /** One automatic emergency repair when hull first drops to critical. */
  emergencyRepair: boolean;
  /** Seconds of post-GO spawn protection. */
  openingGraceSeconds: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  casual: { enemyHp: 0.75, enemyDamage: 0.45, spawnRate: 0.65, maxRisk: 0.5, objectiveHp: 0.8, threatBudget: 0.75, eliteChance: -0.02, specialChance: -0.05, samLock: 1.3, extractionHold: 1.18, enemyProjectileSpeed: 0.78, enemyFireInterval: 1.45, collisionDamage: 0.25, homingStrength: 0.7, emergencyRepair: true, openingGraceSeconds: 2.5 },
  normal: { enemyHp: 1, enemyDamage: 1, spawnRate: 1, maxRisk: 0.75, objectiveHp: 1, threatBudget: 1, eliteChance: 0, specialChance: 0, samLock: 1, extractionHold: 1, enemyProjectileSpeed: 1, enemyFireInterval: 1, collisionDamage: 1, homingStrength: 1, emergencyRepair: false, openingGraceSeconds: 2 },
  hard: { enemyHp: 1.25, enemyDamage: 1.25, spawnRate: 1.12, maxRisk: 1.0, objectiveHp: 1.2, threatBudget: 1.24, eliteChance: 0.035, specialChance: 0.06, samLock: 0.88, extractionHold: 0.94, enemyProjectileSpeed: 1.1, enemyFireInterval: 0.9, collisionDamage: 1, homingStrength: 1.08, emergencyRepair: false, openingGraceSeconds: 1.5 },
};

/** Wave-1 onboarding ramp: teach the loop before the pressure arrives. */
export const WAVE1_CONFIG = {
  /** Seconds after wave 1 starts before enemies may fire. */
  fireDelaySeconds: 8,
  /** First N wave-1 spawns are plain BASIC hulls (no variants/affixes). */
  basicOnlySpawns: 6,
  /** Waves <= this never roll SAM sites (depots instead). */
  noSamWaves: 2,
} as const;

/** Total enemies to spawn for a given wave number. */
export function waveEnemyCount(wave: number): number {
  return 8 + Math.floor(wave * 6.5);
}

/**
 * Procedural HP multiplier that grows with the wave — the core of the
 * "enemies keep getting harder" curve. +18% HP per wave, capped at 9x
 * (wave ~46) so late runs stay challenging without becoming sponges.
 */
export function waveEnemyPower(wave: number): number {
  return Math.min(4.5, 1 + Math.max(0, wave - 1) * 0.12);
}

export const SPAWN_CONFIG = {
  minDistance: 70,
  maxDistance: 245,
  separation: 12,
  maxQueue: 24,
  maxPerTick: 1,
} as const;

/** Total composition cost the normal horde director may spend this wave. */
export function waveThreatBudget(wave: number, threatLevel = 1): number {
  const safeWave = Math.max(1, Math.floor(wave));
  const safeThreat = Math.max(1, Math.min(5, Math.floor(threatLevel)));
  return Math.round((16 + safeWave * 7) * (1 + (safeThreat - 1) * 0.12));
}

// ---------------------------------------------------------------------------
// Public wave API — the plan contract: budget → composition → stat scaling.
// These wrap the threat-budget director so gameplay code can drive a wave from
// one surface without reaching into the pickers below.
// ---------------------------------------------------------------------------

/** Total spawn budget the horde director may spend this wave. */
export function waveSpawnBudget(wave: number, threatLevel = 1): number {
  return waveThreatBudget(wave, threatLevel);
}

/**
 * Pick the next composition member within the remaining budget, preferring a
 * wave-gated squad template (arrives as a staggered stream) before falling
 * back to an individual variant. Returns STANDARD when nothing heavier fits.
 */
export function waveComposition(
  wave: number,
  remainingBudget: number,
  rng: () => number = Math.random,
): EnemyVariant {
  const squad = pickSquadForWave(wave, () => Math.max(0, rng() - 0.1));
  if (squad && squad.length > 0 && compositionFitsBudget(squad, remainingBudget)) {
    return squad[0];
  }
  const v = pickEnemyVariant(wave, rng);
  return ENEMY_VARIANTS[v].threat <= remainingBudget ? v : EnemyVariant.STANDARD;
}

/** Unified stat scaling for a wave: hp, shot damage, and fire-rate multipliers. */
export function waveStatScale(wave: number): { hp: number; damage: number; fireRate: number } {
  return {
    hp: waveEnemyPower(wave),
    damage: waveEnemyDamage(wave),
    fireRate: waveEnemyFireRate(wave),
  };
}

/**
 * Procedural damage multiplier for enemy shots, +7% per wave capped at 3.2x.
 * Grows slower than HP so late waves hurt without one-shotting the player.
 */
export function waveEnemyDamage(wave: number): number {
  return Math.min(3.2, 1 + (wave - 1) * 0.07);
}

/**
 * Procedural fire-rate multiplier for enemies (<1 = faster). +4% faster per
 * wave, capped at 2.2x the base rate.
 */
export function waveEnemyFireRate(wave: number): number {
  return Math.max(0.45, 1 - (wave - 1) * 0.04);
}

/**
 * Enemy aim skill 0..~0.96 — how tight each enemy's shot cone is. Enemies
 * start loose and sloppy (~61% on wave 1) and sharpen as waves rise, so the
 * battlefield grows measurably deadlier late-run without the shots becoming a
 * perfect aimbot. This feeds the angular aim error in `Enemy.applyAimError`.
 */
export function enemyAimAccuracy(wave: number): number {
  const w = Math.max(1, Math.floor(Number.isFinite(wave) ? wave : 1));
  return Math.min(0.96, 0.6 + (w - 1) * 0.03);
}

// ---------------------------------------------------------------------------
// Procedural wave themes ("hands") — roguelite variety on top of the ramp.
// Every non-milestone wave rolls a theme that reshapes that wave's pressure:
// swarms flood the field cheap, armor throws tougher hulls, frenzy speeds the
// cadence, storm surge thickens the weather. The labels surface in the banner.
// ---------------------------------------------------------------------------

export type WaveThemeKey = "SWARM" | "ARMORED" | "FRENZY" | "STORM" | "NIGHT_SURGE";

export interface WaveThemeConfig {
  key: WaveThemeKey;
  /** Banner title. */
  label: string;
  /** Extra horde head-count for this wave (×wave enemy budget). */
  enemyCountMult: number;
  /** Hull-HP multiplier applied to this wave's enemies. */
  enemyHpMult: number;
  /** Spawn-cadence gap multiplier (<1 = faster flooders). */
  spawnGapMult: number;
  /** Flat elite-probability bonus for this wave. */
  eliteBonus: number;
  /** Extra storm intensity pushed into this wave. */
  stormBonus: number;
}

const WAVE_THEME_SUBS: Record<WaveThemeKey, string> = {
  SWARM: "numbers over strength",
  ARMORED: "thick hulls inbound",
  FRENZY: "everything faster",
  STORM: "weather rolls in",
  NIGHT_SURGE: "darkness and speed",
};

export const WAVE_THEMES: Record<WaveThemeKey, WaveThemeConfig> = {
  SWARM: { key: "SWARM", label: "SWARM TIDE", enemyCountMult: 1.6, enemyHpMult: 0.85, spawnGapMult: 0.85, eliteBonus: 0, stormBonus: 0 },
  ARMORED: { key: "ARMORED", label: "ARMORED COLUMN", enemyCountMult: 0.85, enemyHpMult: 1.45, spawnGapMult: 0.95, eliteBonus: 0.05, stormBonus: 0 },
  FRENZY: { key: "FRENZY", label: "FRENZY", enemyCountMult: 1.2, enemyHpMult: 1, spawnGapMult: 0.6, eliteBonus: 0.01, stormBonus: 0 },
  STORM: { key: "STORM", label: "STORM SURGE", enemyCountMult: 1, enemyHpMult: 1, spawnGapMult: 0.9, eliteBonus: 0, stormBonus: 0.4 },
  NIGHT_SURGE: { key: "NIGHT_SURGE", label: "NIGHT SURGE", enemyCountMult: 1.35, enemyHpMult: 1.18, spawnGapMult: 0.7, eliteBonus: 0.03, stormBonus: 0.15 },
};

/** Roll the procedural theme for a non-milestone wave. Milestone waves (%5 =
 *  boss/miniboss) return null so those battles stay distinct. The pool skews
 *  harder as waves rise (late runs can roll the tough NIGHT_SURGE/FRENZY). */
export function waveThemeFor(wave: number, rng: () => number = Math.random): WaveThemeConfig | null {
  const w = Math.max(1, Math.floor(Number.isFinite(wave) ? wave : 1));
  if (w % 5 === 0) return null;
  const roll = Math.max(0, Math.min(1, rng()));
  const late = w >= 24;
  const mid = w >= 10;
  if (late && roll < 0.45) return WAVE_THEMES["NIGHT_SURGE"];
  if (roll < 0.34) return WAVE_THEMES["SWARM"];
  if (roll < 0.58) return WAVE_THEMES["STORM"];
  if (roll < 0.76) return mid ? WAVE_THEMES["FRENZY"] : WAVE_THEMES["SWARM"];
  return WAVE_THEMES["ARMORED"];
}

/** Banner text for a theme config (or a plain "WAVE n" for milestone/null). */
export function waveThemeBanner(theme: WaveThemeConfig | null, wave: number): string {
  if (!theme) return `WAVE ${wave}`;
  return `WAVE ${wave}\n${theme.label}\n${WAVE_THEME_SUBS[theme.key]}`;
}

/**
 * Vampire Survivors-style time-driven waves: each wave lasts a fixed duration
 * (seconds) before the next milestone hits, regardless of how many enemies are
 * still alive. Shrinks from 45s toward a 30s floor so pressure keeps building.
 */
export function waveDuration(wave: number): number {
  return Math.max(30, 45 - (wave - 1) * 1.5);
}

/** Combo score multiplier, capped at 6x. */
export function comboMultiplier(count: number): number {
  return 1 + Math.min(count * 0.1, 5.0);
}

/** Coins awarded for a score (1 coin per 100 points). */
export function coinsForScore(score: number): number {
  return Math.floor(score / 100);
}

/** Shooting accuracy as 0..1, or 0 when no shots were fired. */
export function accuracyFor(shotsHit: number, shotsFired: number): number {
  if (shotsFired <= 0) return 0;
  return Math.min(1, Math.max(0, shotsHit / shotsFired));
}

/** Clamp a value into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Format a duration in seconds as m:ss. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Weapon XP & levels
// ---------------------------------------------------------------------------

/** XP required to reach a given weapon level (level 1 = 0 XP). */
export function weaponXpForLevel(level: number): number {
  if (level <= 1) return 0;
  // 4, 10, 18, 28 ... each level costs +2 more than the last
  let total = 0;
  for (let l = 2; l <= level; l++) {
    total += 2 + l * 2;
  }
  return total;
}

/** Highest weapon level reachable with the given XP (capped at MAX_WEAPON_LEVEL). */
export function weaponLevelForXp(xp: number, maxLevel = 5): number {
  let level = 1;
  for (let l = 2; l <= maxLevel; l++) {
    if (xp >= weaponXpForLevel(l)) level = l;
    else break;
  }
  return level;
}

// ---------------------------------------------------------------------------
// Run-level XP (Vampire-Survivors style)
// ---------------------------------------------------------------------------

/** Highest run level reachable in a single run. */
export const MAX_RUN_LEVEL = 15;

/**
 * Cumulative run XP required to REACH a given run level (level 1 = 0 XP).
 * Escalating cost per level: 10, 15, 20, 25 ... so early levels come fast
 * and later levels demand real farming — the "one more run" curve.
 */
export function runXpForLevel(level: number): number {
  if (level <= 1) return 0;
  let total = 0;
  for (let l = 2; l <= level; l++) {
    total += 10 + (l - 2) * 5;
  }
  return total;
}

/** Highest run level reachable with the given XP (capped at MAX_RUN_LEVEL). */
export function runLevelForXp(xp: number, maxLevel = MAX_RUN_LEVEL): number {
  let level = 1;
  for (let l = 2; l <= maxLevel; l++) {
    if (xp >= runXpForLevel(l)) level = l;
    else break;
  }
  return level;
}

/**
 * XP gem value dropped by an enemy kill, by enemy type. Tanks and bosses are
 * XP jackpots; the swarm is steady pocket change.
 */
export function xpForEnemyType(type: EnemyType, isElite: boolean, variant: EnemyVariant = EnemyVariant.STANDARD): number {
  if (type === EnemyType.BOSS) return 50;
  if (isElite) return 15; // elite miniboss
  if (variant !== EnemyVariant.STANDARD) return Math.max(3, Math.min(8, Math.round(ENEMY_VARIANTS[variant].threat * 2.5)));
  if (type === EnemyType.TANK) return 5;
  if (type === EnemyType.DRONE) return 3;
  if (type === EnemyType.SHOOTER) return 2;
  return 1; // BASIC
}

export interface WeaponLevelBonus {
  /** Damage multiplier at this level. */
  damageMult: number;
  /** Fire-rate multiplier (lower = faster). */
  fireRateMult: number;
  /** Reload-time multiplier (lower = faster). */
  reloadMult: number;
  /** Additional projectiles per shot at this level. */
  extraProjectiles: number;
}

/** Stat bonuses granted by a weapon level. */
export function weaponLevelBonus(level: number): WeaponLevelBonus {
  const lvl = Math.max(1, Math.floor(level));
  return {
    damageMult: 1 + (lvl - 1) * 0.18,
    fireRateMult: Math.max(0.55, 1 - (lvl - 1) * 0.09),
    reloadMult: Math.max(0.5, 1 - (lvl - 1) * 0.12),
    extraProjectiles: lvl >= 4 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Risk / reward
// ---------------------------------------------------------------------------

/**
 * Score multiplier from low health ("Risky Rendezvous").
 * Full multiplier at 1 HP, 1.0 at 40% HP and above.
 * `maxBonus` is the ceiling at 1 HP (difficulty-scaled).
 */
export function riskMultiplier(
  health: number,
  maxHealth: number,
  maxBonus: number = 0.75,
): number {
  const ratio = clamp(health / Math.max(1, maxHealth), 0, 1);
  if (ratio >= 0.4) return 1;
  const danger = 1 - ratio / 0.4; // 0 → 1 as health drops toward 0
  return 1 + danger * Math.max(0, maxBonus); // up to x(1+maxBonus) at 1 HP
}

// ---------------------------------------------------------------------------
// Multi-kill announcements
// ---------------------------------------------------------------------------

export interface MultikillInfo {
  label: string;
  color: string;
}

/** Classify a kill streak into an arcade announcement. */
export function multikillTier(streak: number): MultikillInfo | null {
  if (streak >= 8) return { label: 'RAMPAGE!', color: '#ff3344' };
  if (streak >= 6) return { label: 'KILLING SPREE', color: '#ff6677' };
  if (streak >= 4) return { label: 'QUAD KILL', color: '#ffaa22' };
  if (streak >= 3) return { label: 'TRIPLE KILL', color: '#ffdd44' };
  if (streak >= 2) return { label: 'DOUBLE KILL', color: '#ffee88' };
  return null;
}

// ---------------------------------------------------------------------------
// Boss phases
// ---------------------------------------------------------------------------

/**
 * Boss phase from remaining HP ratio.
 *   phase 3 = 100%–66%, phase 2 = 66%–33%, phase 1 = <33%
 */
export function bossPhaseForRatio(ratio: number): 1 | 2 | 3 {
  if (ratio > 0.66) return 3;
  if (ratio > 0.33) return 2;
  return 1;
}

/** Seconds the boss telegraphs before firing (phase 1/2 attacks). */
export const BOSS_TELEGRAPH_DURATION = 0.8;

/** Shot count + spread for each boss phase's primary volley. */
export function bossVolleyConfig(phase: 1 | 2 | 3): { shots: number; spread: number; speed: number } {
  if (phase === 1) return { shots: 9, spread: 0.14, speed: 135 };
  if (phase === 2) return { shots: 7, spread: 0.12, speed: 115 };
  return { shots: 5, spread: 0.17, speed: 115 };
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export interface ObjectiveConfig {
  hp: number;
  points: number;
  radius: number;
  label: string;
}

export function objectiveConfig(type: number): ObjectiveConfig {
  // HP tuned so objectives die in ~1-2s of focused fire (MG DPS ~470)
  if (type === 0) return { hp: 170, points: 300, radius: 4.2, label: 'SAM SITE' };
  if (type === 1) return { hp: 220, points: 250, radius: 4.6, label: 'RADAR TOWER' };
  return { hp: 190, points: 200, radius: 4.4, label: 'AMMO DEPOT' };
}

// ---------------------------------------------------------------------------
// Enemy variants (combat roles on top of the five base EnemyTypes)
// ---------------------------------------------------------------------------

import { EnemyVariant, type StatusEffectKind } from "./types";

export interface EnemyVariantConfig {
  variant: EnemyVariant;
  /** Base hull reused by this variant. */
  baseType: EnemyType;
  /** Threat budget cost — the director spends this instead of raw counts. */
  threat: number;
  /** Earliest wave this variant may appear. */
  minWave: number;
  hpMult: number;
  speedMult: number;
  /** Damage multiplier for its projectiles. */
  damageMult: number;
  pointsMult: number;
  /** Signature accent color (telegraphs / lights / minimap). */
  accent: number;
  /** Rare variants are hard-capped per battlefield. */
  rare?: boolean;
  /** Soft cap on simultaneously-active count of this variant. */
  maxActive?: number;
}

export const ENEMY_VARIANTS: Record<EnemyVariant, EnemyVariantConfig> = {
  [EnemyVariant.STANDARD]: {
    variant: EnemyVariant.STANDARD,
    baseType: EnemyType.BASIC,
    threat: 1.0,
    minWave: 1,
    hpMult: 1,
    speedMult: 1,
    damageMult: 1,
    pointsMult: 1,
    accent: 0xff3b22,
  },
  [EnemyVariant.SCOUT_DRONE]: {
    variant: EnemyVariant.SCOUT_DRONE,
    baseType: EnemyType.DRONE,
    threat: 1.0,
    minWave: 2,
    hpMult: 0.75,
    speedMult: 1.5,
    damageMult: 0.8,
    pointsMult: 1.1,
    accent: 0xff3344,
    maxActive: 10,
  },
  [EnemyVariant.KAMIKAZE_DRONE]: {
    variant: EnemyVariant.KAMIKAZE_DRONE,
    baseType: EnemyType.DRONE,
    threat: 1.25,
    minWave: 3,
    hpMult: 0.9,
    speedMult: 1.9,
    damageMult: 1.4,
    pointsMult: 1.2,
    accent: 0xff2244,
    maxActive: 6,
  },
  [EnemyVariant.ATTACK_GUNSHIP]: {
    variant: EnemyVariant.ATTACK_GUNSHIP,
    baseType: EnemyType.SHOOTER,
    threat: 1.75,
    minWave: 3,
    hpMult: 1.7,
    speedMult: 1.1,
    damageMult: 1.25,
    pointsMult: 1.5,
    accent: 0xff5533,
    maxActive: 8,
  },
  [EnemyVariant.ROCKET_GUNSHIP]: {
    variant: EnemyVariant.ROCKET_GUNSHIP,
    baseType: EnemyType.SHOOTER,
    threat: 2.0,
    minWave: 5,
    hpMult: 1.9,
    speedMult: 0.9,
    damageMult: 1.1,
    pointsMult: 1.7,
    accent: 0xffaa33,
    maxActive: 5,
  },
  [EnemyVariant.FLAK_TANK]: {
    variant: EnemyVariant.FLAK_TANK,
    baseType: EnemyType.TANK,
    threat: 1.5,
    minWave: 4,
    hpMult: 1.2,
    speedMult: 1.2,
    damageMult: 0.7,
    pointsMult: 1.3,
    accent: 0xff8833,
    maxActive: 6,
  },
  [EnemyVariant.MISSILE_CARRIER]: {
    variant: EnemyVariant.MISSILE_CARRIER,
    baseType: EnemyType.TANK,
    threat: 2.0,
    minWave: 5,
    hpMult: 1.5,
    speedMult: 0.8,
    damageMult: 1.3,
    pointsMult: 1.8,
    accent: 0xffc23f,
    maxActive: 2,
  },
  [EnemyVariant.SHIELD_DRONE]: {
    variant: EnemyVariant.SHIELD_DRONE,
    baseType: EnemyType.DRONE,
    threat: 2.0,
    minWave: 6,
    hpMult: 1.0,
    speedMult: 0.9,
    damageMult: 0.5,
    pointsMult: 1.6,
    accent: 0x55eeff,
    maxActive: 2,
  },
  [EnemyVariant.REPAIR_DRONE]: {
    variant: EnemyVariant.REPAIR_DRONE,
    baseType: EnemyType.DRONE,
    threat: 2.25,
    minWave: 7,
    hpMult: 1.0,
    speedMult: 0.9,
    damageMult: 0.5,
    pointsMult: 1.7,
    accent: 0x55ff99,
    maxActive: 1,
  },
  [EnemyVariant.HEAVY_GUNSHIP]: {
    variant: EnemyVariant.HEAVY_GUNSHIP,
    baseType: EnemyType.SHOOTER,
    threat: 3.0,
    minWave: 7,
    hpMult: 3.6,
    speedMult: 0.7,
    damageMult: 1.5,
    pointsMult: 2.4,
    accent: 0xd84cff,
    rare: true,
    maxActive: 1,
  },
  [EnemyVariant.SIEGE_TANK]: {
    variant: EnemyVariant.SIEGE_TANK,
    baseType: EnemyType.TANK,
    threat: 2.5,
    minWave: 8,
    hpMult: 2.3,
    speedMult: 0.7,
    damageMult: 1.5,
    pointsMult: 2.2,
    accent: 0xff7744,
    rare: true,
    maxActive: 1,
  },
  [EnemyVariant.INTERCEPTOR]: {
    variant: EnemyVariant.INTERCEPTOR,
    baseType: EnemyType.DRONE,
    threat: 2.0,
    minWave: 10,
    hpMult: 1.3,
    speedMult: 2.2,
    damageMult: 1.2,
    pointsMult: 1.8,
    accent: 0x55aaff,
    maxActive: 4,
  },
  [EnemyVariant.MINELAYER]: {
    variant: EnemyVariant.MINELAYER,
    baseType: EnemyType.SHOOTER,
    threat: 2.25,
    minWave: 11,
    hpMult: 1.6,
    speedMult: 0.7,
    damageMult: 1.0,
    pointsMult: 1.9,
    accent: 0xff44aa,
    maxActive: 2,
  },
  [EnemyVariant.GATLING_HEAVY]: {
    variant: EnemyVariant.GATLING_HEAVY,
    baseType: EnemyType.TANK,
    threat: 2.5,
    minWave: 9,
    hpMult: 2.6,
    speedMult: 0.6,
    damageMult: 1.35,
    pointsMult: 2.1,
    accent: 0xffd92e,
    maxActive: 2,
  },
};

/** Pick a random variant available at the given wave (weighted toward newer, spicier units). */
export function pickEnemyVariant(wave: number, rng: () => number = Math.random): EnemyVariant {
  const candidates = Object.values(ENEMY_VARIANTS).filter((c) => c.minWave <= wave && !c.rare);
  const available = candidates.map((c) => c.variant);
  if (available.length === 0) return EnemyVariant.STANDARD;
  // Late-wave weight shift: newer variants get slightly heavier weights so the
  // battlefield naturally diversifies without ever becoming all-elite.
  const weights = available.map((v) => {
    const cfg = ENEMY_VARIANTS[v];
    const waveBonus = Math.min(1.6, 1 + (wave - cfg.minWave) * 0.06);
    return cfg.threat * waveBonus;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < available.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return available[i];
  }
  return available[available.length - 1];
}

/** Soft-cap check: is this variant already at its battlefield limit? */
export function variantAtCap(config: EnemyVariantConfig, activeCounts: Partial<Record<EnemyVariant, number>>): boolean {
  const max = config.maxActive ?? Infinity;
  return (activeCounts[config.variant] ?? 0) >= max;
}

/** Squad templates — small procedural encounter compositions, wave-gated. */
export interface SquadTemplate {
  members: EnemyVariant[];
  minWave: number;
  weight: number;
}

export const SQUAD_TEMPLATES: SquadTemplate[] = [
  { members: [EnemyVariant.SCOUT_DRONE, EnemyVariant.SCOUT_DRONE, EnemyVariant.FLAK_TANK], minWave: 4, weight: 1 }, // Harassment
  { members: [EnemyVariant.SHIELD_DRONE, EnemyVariant.STANDARD, EnemyVariant.STANDARD, EnemyVariant.STANDARD], minWave: 6, weight: 1 }, // Protected shooters
  { members: [EnemyVariant.MISSILE_CARRIER, EnemyVariant.ATTACK_GUNSHIP, EnemyVariant.ATTACK_GUNSHIP], minWave: 5, weight: 0.8 }, // Missile pressure
  { members: [EnemyVariant.REPAIR_DRONE, EnemyVariant.FLAK_TANK, EnemyVariant.FLAK_TANK, EnemyVariant.STANDARD, EnemyVariant.STANDARD], minWave: 7, weight: 0.8 }, // Repair group
  { members: [EnemyVariant.KAMIKAZE_DRONE, EnemyVariant.KAMIKAZE_DRONE, EnemyVariant.MISSILE_CARRIER, EnemyVariant.ATTACK_GUNSHIP, EnemyVariant.ATTACK_GUNSHIP], minWave: 6, weight: 0.6 }, // High pressure
  { members: [EnemyVariant.HEAVY_GUNSHIP, EnemyVariant.SHIELD_DRONE, EnemyVariant.SCOUT_DRONE, EnemyVariant.SCOUT_DRONE], minWave: 8, weight: 0.5 }, // Heavy assault
  { members: [EnemyVariant.SIEGE_TANK, EnemyVariant.STANDARD, EnemyVariant.STANDARD, EnemyVariant.SCOUT_DRONE], minWave: 9, weight: 0.4 }, // Siege push
  { members: [EnemyVariant.GATLING_HEAVY, EnemyVariant.ATTACK_GUNSHIP, EnemyVariant.SHIELD_DRONE], minWave: 9, weight: 0.6 }, // Gatling guard
  { members: [EnemyVariant.INTERCEPTOR, EnemyVariant.INTERCEPTOR, EnemyVariant.SCOUT_DRONE], minWave: 10, weight: 0.7 }, // Interceptor sweep
  { members: [EnemyVariant.MINELAYER, EnemyVariant.FLAK_TANK, EnemyVariant.STANDARD, EnemyVariant.STANDARD], minWave: 11, weight: 0.5 }, // Minefield escort
];

export function compositionThreatCost(members: readonly EnemyVariant[]): number {
  return members.reduce((sum, variant) => sum + (ENEMY_VARIANTS[variant]?.threat ?? 1), 0);
}

export function compositionFitsBudget(members: readonly EnemyVariant[], remaining: number): boolean {
  return compositionThreatCost(members) <= Math.max(0, remaining) + 1e-6;
}

/** Pick a squad template for the wave, or null for an individual spawn. */
export function pickSquadForWave(wave: number, rng: () => number = Math.random): EnemyVariant[] | null {
  const eligible = SQUAD_TEMPLATES.filter((s) => s.minWave <= wave);
  if (eligible.length === 0) return null;
  const total = eligible.reduce((a, s) => a + s.weight, 0);
  if (rng() > Math.min(0.3, 0.08 + wave * 0.02)) return null; // most spawns stay individual
  let roll = rng() * total;
  for (const squad of eligible) {
    roll -= squad.weight;
    if (roll <= 0) return squad.members.slice();
  }
  return eligible[eligible.length - 1].members.slice();
}

// ---------------------------------------------------------------------------
// Weapon mastery (persistent meta-progression)
// ---------------------------------------------------------------------------

export const MAX_WEAPON_LEVEL = 5;

/** Highest weapon level ever reached, per WeaponType index. */
export function readMastery(storage: Pick<Storage, 'getItem'> = window.localStorage): number[] {
  try {
    const raw = storage.getItem('helistrike:mastery');
    if (!raw) return [0, 0, 0, 0];
    const parsed = JSON.parse(raw) as number[];
    return [0, 1, 2, 3].map((i) => clamp(Math.floor(parsed[i] ?? 0), 0, MAX_WEAPON_LEVEL));
  } catch {
    return [0, 0, 0, 0];
  }
}

/** Persist a weapon's mastered level (max across runs). */
export function writeMastery(
  weaponIndex: number,
  level: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): number[] {
  const current = readMastery(storage);
  current[weaponIndex] = Math.max(current[weaponIndex], clamp(Math.floor(level), 0, MAX_WEAPON_LEVEL));
  try {
    storage.setItem('helistrike:mastery', JSON.stringify(current));
  } catch {
    // storage unavailable — ignore
  }
  return current;
}

// ---------------------------------------------------------------------------
// Upgrade roulette
// ---------------------------------------------------------------------------

export type UpgradeId =
  | 'damage'
  | 'fireRate'
  | 'ammo'
  | 'reload'
  | 'salvoCooldown'
  | 'maxHealth'
  | 'fuelEfficiency'
  | 'shield'
  | 'speed'
  | 'armor'
  | 'repair'
  | 'xpMagnet'
  | 'dashCooldown'
  | 'bomb'
  | 'incendiary'
  | 'empPayload'
  | 'shockCoils';

export type UpgradeCategory = 'OFFENSE' | 'DEFENSE' | 'MOBILITY' | 'UTILITY' | 'WEAPON';

export interface UpgradeOption {
  id: UpgradeId;
  title: string;
  desc: string;
  icon: string;
  category: UpgradeCategory;
}

export const UPGRADE_POOL: UpgradeOption[] = [
  { id: 'damage', title: 'Overclock Rounds', desc: '+25% weapon damage (all weapons)', icon: '⚡', category: 'OFFENSE' },
  { id: 'fireRate', title: 'Hair Trigger', desc: '+18% fire rate (all weapons)', icon: '🔥', category: 'WEAPON' },
  { id: 'ammo', title: 'Extended Mag', desc: '+30% max ammo (all weapons)', icon: '📦', category: 'WEAPON' },
  { id: 'reload', title: 'Speed Loader', desc: 'Reload 25% faster', icon: '🔧', category: 'WEAPON' },
  { id: 'salvoCooldown', title: 'Salvo Overclock', desc: 'Multi-salvo cooldown -35%', icon: '🎯', category: 'WEAPON' },
  { id: 'maxHealth', title: 'Reinforced Hull', desc: '+20 max health and heal 20', icon: '🛡️', category: 'DEFENSE' },
  { id: 'armor', title: 'Reactive Armor', desc: '+6% damage mitigation (24% cap)', icon: '🧱', category: 'DEFENSE' },
  { id: 'repair', title: 'Field Repair', desc: 'Repair 25 hull and improve future repairs', icon: '🔩', category: 'DEFENSE' },
  { id: 'fuelEfficiency', title: 'Turbine Tune', desc: 'Fuel drain -30%', icon: '⛽', category: 'UTILITY' },
  { id: 'xpMagnet', title: 'Magnetic Winch', desc: '+30% XP pickup range', icon: '🧲', category: 'UTILITY' },
  { id: 'shield', title: 'Aegis Field', desc: 'Immediate 8s energy shield', icon: '🔮', category: 'DEFENSE' },
  { id: 'speed', title: 'Afterburners', desc: '+20% move speed for 12s', icon: '💨', category: 'MOBILITY' },
  { id: 'dashCooldown', title: 'Vector Jets', desc: 'Dash cooldown -15%', icon: '💨', category: 'MOBILITY' },
  { id: 'bomb', title: 'Airstrike', desc: 'Instantly clear the screen', icon: '💣', category: 'OFFENSE' },
  { id: 'incendiary', title: 'Incendiary Rounds', desc: '+6% burn chance per stack (all weapons)', icon: '🔥', category: 'OFFENSE' },
  { id: 'empPayload', title: 'EMP Payload', desc: '+7% EMP chance per stack (blast weapons)', icon: '📡', category: 'OFFENSE' },
  { id: 'shockCoils', title: 'Shock Coils', desc: '+5% shock chance per stack (all weapons)', icon: '⚡', category: 'OFFENSE' },
];

/** Pick `count` distinct random upgrades (clamped to the pool size). */
export function pickUpgrades(count: number, rng: () => number = Math.random): UpgradeOption[] {
  const n = Math.max(1, Math.min(count, UPGRADE_POOL.length));
  const pool = [...UPGRADE_POOL];
  const picks: UpgradeOption[] = [];
  const usedCategories = new Set<UpgradeCategory>();
  for (let i = 0; i < n; i++) {
    const diverse = pool.filter((option) => !usedCategories.has(option.category));
    const source = diverse.length > 0 ? diverse : pool;
    const choice = source[Math.floor(rng() * source.length)];
    const idx = pool.indexOf(choice);
    picks.push(pool.splice(idx, 1)[0]);
    usedCategories.add(choice.category);
  }
  return picks;
}

// ---------------------------------------------------------------------------
// City districts (environment generation — pure data, unit-tested)
// ---------------------------------------------------------------------------

export type DistrictName =
  | 'downtown'
  | 'midtown'
  | 'industrial'
  | 'residential'
  | 'waterfront'
  | 'base'
  | 'desert'
  | 'forest'
  | 'ruins';

export type DistrictLandmark =
  | 'centralTower'
  | 'observationTower'
  | 'coolingTowers'
  | 'helipadTower'
  | 'clockTower'
  | 'marina'
  | 'radarBase'
  | 'mesa'
  | 'giantTree'
  | 'fallenTower';

/** Rooftop prop flavors a district can spawn (weight 0 = never). */
export type RooftopPropType =
  | 'helipad'
  | 'antenna'
  | 'acUnit'
  | 'mast'
  | 'waterTank'
  | 'smokeStack'
  | 'vent'
  | 'maintenanceHut';

export interface DistrictConfig {
  name: DistrictName;
  /** Building body palette (hex colors). */
  palette: number[];
  /** Ground slab color. */
  ground: number;
  /** Road shoulder color. */
  shoulder: number;
  /** Sidewalk strip color. */
  sidewalk: number;
  /** Lit facade window band color. */
  windowColor: number;
  /** Unlit trim / accent color (also used by billboards). */
  trimColor: number;
  /** Chance a cell builds (0..1). */
  density: number;
  /** Weighted footprint-tier distribution [SMALL, MEDIUM, LARGE] (sums to 1). */
  footprintWeights: [number, number, number];
  /** Normal building height band [min, max]. */
  heightBand: [number, number];
  /** Chance a qualifying cell becomes a tall building (0..1). */
  skyscraperChance: number;
  /** Tall building height band [min, max]. */
  skyscraperHeight: [number, number];
  /** Ground-patch detail palette. */
  detailPalette: number[];
  /** Signature landmark spawned once per chunk. */
  landmark: DistrictLandmark;

  // --- District identity (Pass 4) ---
  /** Probability an eligible rooftop gets props at all (0..1). */
  rooftopClutter: number;
  /** Weighted rooftop prop types (weight 0 = never). */
  rooftopProps: Record<RooftopPropType, number>;
  /** District accent color for props, tanks, signs and lot dressing. */
  accentColor: number;
  /** Signage palette for billboards (subdued pops, never a recolor). */
  signColors: number[];
  /** Billboard count on the grand-avenue shoulders. */
  billboardCount: number;
  /** Probability an empty cell becomes a themed open lot (0..1). */
  openSpaceChance: number;
  /** Landmark spawn probability per chunk (0..1). */
  landmarkChance: number;
  /** Cross-street half width — the seam-safe road width tendency. */
  crossStreetHalf: number;
  /** Street/ground prop density multiplier (0..1) — scales Pass 5 props. */
  propDensity: number;
}

/**
 * Footprint category for a building cell: 0 = SMALL, 1 = MEDIUM, 2 = LARGE.
 * Rolled from a deterministic 0..1 hash against the district's weights so
 * most buildings are SMALL/MEDIUM and LARGE stays uncommon.
 */
export function footprintTier(roll: number, weights: [number, number, number]): 0 | 1 | 2 {
  if (roll < weights[0]) return 0;
  if (roll < weights[0] + weights[1]) return 1;
  return 2;
}

/**
 * Camera-occlusion ghost strength for a building, from the entry point
 * `tEntry` (0..1) where the camera→player view segment enters its AABB.
 *
 * A building right in front of the camera (tEntry → 0) hides the player
 * completely → strength 1. A building only clipped near the far end of the
 * view line (tEntry → 1) barely hides them → strength tapering to 0.
 */
export function occlusionStrength(tEntry: number): number {
  if (!(tEntry > 0 && tEntry < 1)) return 0;
  return clamp(Math.min(1, (1 - tEntry) * 1.25), 0, 1);
}

/**
 * Deterministic repeating district schedule — 18 chunks of mostly desert and
 * military base terrain (~2,376 units of flight ≈ ~45s at cruise speed), so
 * the battlefield reads as a desert warzone. All 10 districts still appear
 * (tests enforce coverage + no back-to-back repeats); the dense city zones
 * become rare outposts in the sand.
 */
export const DISTRICT_SCHEDULE: DistrictName[] = [
  'desert',
  'base',
  'desert',
  'industrial',
  'desert',
  'forest',
  'base',
  'desert',
  'midtown',
  'desert',
  'ruins',
  'desert',
  'waterfront',
  'base',
  'desert',
  'residential',
  'desert',
  'downtown',
];

/** District for a chunk id — stable for a given id (the world never shifts). */
export function districtForChunk(chunkId: number): DistrictName {
  const n = DISTRICT_SCHEDULE.length;
  const idx = ((Math.abs(chunkId) % n) + n) % n;
  return DISTRICT_SCHEDULE[idx];
}

export const DISTRICT_CONFIGS: Record<DistrictName, DistrictConfig> = {
  downtown: {
    name: 'downtown',
    palette: [0x48556f, 0x57657f, 0x3e4b63, 0x62718b, 0x39465e],
    ground: 0x60646b,
    shoulder: 0x4d5156,
    sidewalk: 0x9ba0a5,
    windowColor: 0xbcd6de,
    trimColor: 0x8fb4c8,
    density: 0.84,
    footprintWeights: [0.42, 0.42, 0.16],
    heightBand: [10, 20],
    skyscraperChance: 0.5,
    skyscraperHeight: [22, 46],
    detailPalette: [0x5a6a80, 0x4c5a70, 0x68788e, 0x56667c],
    landmark: 'centralTower',
    rooftopClutter: 0.72,
    rooftopProps: { helipad: 2, antenna: 3, acUnit: 1, mast: 2, waterTank: 0, smokeStack: 0, vent: 1, maintenanceHut: 1 },
    accentColor: 0x8fb4c8,
    signColors: [0x75b8ff, 0xffe66d, 0xff5f8f, 0x56e6ff],
    billboardCount: 4,
    openSpaceChance: 0.08,
    landmarkChance: 1,
    crossStreetHalf: 10,
    propDensity: 0.9,
  },
  midtown: {
    name: 'midtown',
    palette: [0x6b6f74, 0x7d8184, 0x585d62, 0x8a7d68, 0x6d7071],
    ground: 0x676b6f,
    shoulder: 0x52565a,
    sidewalk: 0xa8a49a,
    windowColor: 0xf2d48a,
    trimColor: 0xc9a35f,
    density: 0.8,
    footprintWeights: [0.5, 0.38, 0.12],
    heightBand: [8, 18],
    skyscraperChance: 0.15,
    skyscraperHeight: [20, 34],
    detailPalette: [0x7a7f8c, 0x6b707e, 0x8a8577, 0x66707e],
    landmark: 'observationTower',
    rooftopClutter: 0.6,
    rooftopProps: { helipad: 1, antenna: 1, acUnit: 3, mast: 1, waterTank: 1, smokeStack: 0, vent: 2, maintenanceHut: 2 },
    accentColor: 0xc9a35f,
    signColors: [0xc9a35f, 0xffd97a, 0x9fd0e8],
    billboardCount: 3,
    openSpaceChance: 0.1,
    landmarkChance: 0.9,
    crossStreetHalf: 10,
    propDensity: 0.8,
  },
  industrial: {
    name: 'industrial',
    palette: [0x5c4a3a, 0x6d5c4a, 0x4a3f35, 0x7a6a55, 0x3f3a34],
    ground: 0x4a4f57,
    shoulder: 0x3a4048,
    sidewalk: 0x8f8a80,
    windowColor: 0xff8f2a,
    trimColor: 0xd97b4a,
    density: 0.72,
    footprintWeights: [0.48, 0.4, 0.12],
    heightBand: [4, 11],
    skyscraperChance: 0.08,
    skyscraperHeight: [16, 24],
    detailPalette: [0x5c5147, 0x6d5c4a, 0x4a443d, 0x7a6a55],
    landmark: 'coolingTowers',
    rooftopClutter: 0.55,
    rooftopProps: { helipad: 0, antenna: 0, acUnit: 1, mast: 0, waterTank: 2, smokeStack: 3, vent: 2, maintenanceHut: 1 },
    accentColor: 0xd97b4a,
    signColors: [0xd97b4a, 0xff8f2a, 0x9aa3b3],
    billboardCount: 2,
    openSpaceChance: 0.22,
    landmarkChance: 1,
    crossStreetHalf: 14,
    propDensity: 0.85,
  },
  residential: {
    name: 'residential',
    palette: [0x9a6b4f, 0x8a5f42, 0xb07c57, 0x7d543d, 0xae8a63],
    ground: 0x7d7a72,
    shoulder: 0x6d6a60,
    sidewalk: 0xc0b4a0,
    windowColor: 0xffd9b0,
    trimColor: 0xd9b08a,
    density: 0.8,
    footprintWeights: [0.62, 0.3, 0.08],
    heightBand: [5, 11],
    skyscraperChance: 0,
    skyscraperHeight: [18, 24],
    detailPalette: [0x8a7a6a, 0x9a8a72, 0x7d7466, 0xae9a80],
    landmark: 'clockTower',
    rooftopClutter: 0.5,
    rooftopProps: { helipad: 0, antenna: 2, acUnit: 4, mast: 0, waterTank: 2, smokeStack: 0, vent: 2, maintenanceHut: 3 },
    accentColor: 0xd9b08a,
    signColors: [0xd9b08a, 0xffd9b0, 0x93a99a],
    billboardCount: 2,
    openSpaceChance: 0.25,
    landmarkChance: 0.55,
    crossStreetHalf: 8,
    propDensity: 0.7,
  },
  waterfront: {
    name: 'waterfront',
    palette: [0x45655f, 0x52726c, 0x3b5752, 0x62807a, 0x334d49],
    ground: 0x556a66,
    shoulder: 0x4a5f5b,
    sidewalk: 0x9fb0ab,
    windowColor: 0xaad4cc,
    trimColor: 0x8fbdb5,
    density: 0.38,
    footprintWeights: [0.66, 0.28, 0.06],
    heightBand: [5, 12],
    skyscraperChance: 0.05,
    skyscraperHeight: [16, 24],
    detailPalette: [0x4a6a64, 0x58786f, 0x3e5d57, 0x6b837c],
    landmark: 'marina',
    rooftopClutter: 0.42,
    rooftopProps: { helipad: 1, antenna: 0, acUnit: 1, mast: 1, waterTank: 1, smokeStack: 0, vent: 1, maintenanceHut: 2 },
    accentColor: 0x8fbdb5,
    signColors: [0x6fd6c9, 0x7ff7e0, 0xffd97a],
    billboardCount: 2,
    openSpaceChance: 0.7,
    landmarkChance: 0.7,
    crossStreetHalf: 12,
    propDensity: 0.55,
  },
  base: {
    name: 'base',
    palette: [0x585d66, 0x6d727b, 0x41464d, 0x7a7f80, 0x50565e],
    ground: 0x5b5f64,
    shoulder: 0x4b4f54,
    sidewalk: 0x99a0a6,
    windowColor: 0xc4d6de,
    trimColor: 0xa8c2cf,
    density: 0.36,
    footprintWeights: [0.6, 0.32, 0.08],
    heightBand: [5, 10],
    skyscraperChance: 0,
    skyscraperHeight: [12, 18],
    detailPalette: [0x5d656b, 0x474d53, 0x6f7470, 0x343940],
    landmark: 'radarBase',
    rooftopClutter: 0.45,
    rooftopProps: { helipad: 3, antenna: 2, acUnit: 0, mast: 1, waterTank: 0, smokeStack: 0, vent: 1, maintenanceHut: 1 },
    accentColor: 0xa8c2cf,
    signColors: [0x9fd0e8, 0xb8f1ff, 0x93a4b3],
    billboardCount: 1,
    openSpaceChance: 0.5,
    landmarkChance: 1,
    crossStreetHalf: 10,
    propDensity: 0.9,
  },
  desert: {
    name: 'desert',
    palette: [0xc3a94e, 0xb78f42, 0x9b7841, 0xd2bf77, 0xa8894a],
    ground: 0xd6b55b,
    shoulder: 0xb99643,
    sidewalk: 0xd3bd82,
    windowColor: 0xf7d36f,
    trimColor: 0xf7d36f,
    density: 0.22,
    footprintWeights: [0.7, 0.24, 0.06],
    heightBand: [4, 9],
    skyscraperChance: 0,
    skyscraperHeight: [10, 16],
    detailPalette: [0xcaa84e, 0xb98e3f, 0xd0ba65, 0x98713d],
    landmark: 'mesa',
    rooftopClutter: 0.15,
    rooftopProps: { helipad: 0, antenna: 0, acUnit: 0, mast: 0, waterTank: 0, smokeStack: 1, vent: 0, maintenanceHut: 0 },
    accentColor: 0xf7d36f,
    signColors: [0xf7d36f, 0xc3a94e],
    billboardCount: 1,
    openSpaceChance: 0.8,
    landmarkChance: 0.6,
    crossStreetHalf: 8,
    propDensity: 0.25,
  },
  forest: {
    name: 'forest',
    palette: [0x224c38, 0x315f41, 0x4d6d4b, 0x20362f, 0x3a7a52],
    ground: 0x3f8c5d,
    shoulder: 0x2f744e,
    sidewalk: 0x93a99a,
    windowColor: 0x7fe09a,
    trimColor: 0x5cc47a,
    density: 0.26,
    footprintWeights: [0.72, 0.22, 0.06],
    heightBand: [4, 8],
    skyscraperChance: 0,
    skyscraperHeight: [10, 14],
    detailPalette: [0x2f7249, 0x24583f, 0x3f8559, 0x1f4634],
    landmark: 'giantTree',
    rooftopClutter: 0.2,
    rooftopProps: { helipad: 1, antenna: 0, acUnit: 0, mast: 0, waterTank: 0, smokeStack: 0, vent: 0, maintenanceHut: 0 },
    accentColor: 0x5cc47a,
    signColors: [0x5cc47a, 0x7fe09a],
    billboardCount: 1,
    openSpaceChance: 0.8,
    landmarkChance: 0.6,
    crossStreetHalf: 8,
    propDensity: 0.2,
  },
  ruins: {
    name: 'ruins',
    palette: [0x565a62, 0x6e6f6e, 0x454950, 0x7d7168, 0x5c5d5c],
    ground: 0x6b6d6f,
    shoulder: 0x505255,
    sidewalk: 0x8f8d8e,
    windowColor: 0xa9c4d8,
    trimColor: 0xa6aab2,
    density: 0.4,
    footprintWeights: [0.55, 0.35, 0.1],
    heightBand: [6, 14],
    skyscraperChance: 0.25,
    skyscraperHeight: [18, 30],
    detailPalette: [0x676978, 0x555967, 0x77736e, 0x454a57],
    landmark: 'fallenTower',
    rooftopClutter: 0.25,
    rooftopProps: { helipad: 0, antenna: 1, acUnit: 1, mast: 0, waterTank: 1, smokeStack: 1, vent: 1, maintenanceHut: 1 },
    accentColor: 0xaab0c9,
    signColors: [0xaab0c9, 0x8bd0ff],
    billboardCount: 1,
    openSpaceChance: 0.6,
    landmarkChance: 1,
    crossStreetHalf: 10,
    propDensity: 0.5,
  },
};

// --- Environment Pass 6: building archetypes ---
// A building's silhouette comes from a small set of compositional forms
// (stepped tower / slab / office / warehouse / factory / residential block /
// parking / communications). The picker is pure and deterministic: district +
// footprint tier + height band + a seeded roll decide the form, so every
// building still matches the district's character without any new randomness.

export type BuildingArchetype =
  | 'steppedTower'
  | 'slab'
  | 'office'
  | 'warehouse'
  | 'factory'
  | 'resBlock'
  | 'parking'
  | 'comm'
  | 'plain';

export interface ArchetypeRoll {
  district: DistrictName;
  /** Footprint tier: 0 SMALL / 1 MEDIUM / 2 LARGE. */
  tier: number;
  skyscraper: boolean;
  height: number;
  /** Seeded roll 0..1 (deterministic per building). */
  roll: number;
}

export function buildingArchetype(r: ArchetypeRoll): BuildingArchetype {
  if (r.skyscraper) return 'steppedTower';
  if (r.tier >= 2) {
    // LARGE footprints: industrial leans shed/factory, residential slabs.
    if (r.district === 'industrial' || r.district === 'ruins') return r.roll < 0.5 ? 'warehouse' : 'factory';
    if (r.district === 'residential') return 'resBlock';
    if (r.district === 'waterfront') return r.roll < 0.6 ? 'warehouse' : 'slab';
    return 'slab';
  }
  if (r.tier === 1) {
    if (r.district === 'industrial' || r.district === 'ruins') return r.roll < 0.55 ? 'warehouse' : 'factory';
    if (r.district === 'residential') return 'resBlock';
    if (r.district === 'downtown' || r.district === 'midtown') {
      if (r.roll < 0.35) return 'office';
      if (r.roll < 0.6) return 'comm';
      if (r.roll < 0.85) return 'slab';
      return 'parking';
    }
    if (r.district === 'base') return r.roll < 0.5 ? 'comm' : 'slab';
    if (r.district === 'waterfront') return 'slab';
    return 'plain';
  }
  // SMALL footprints stay plain boxes unless the district leans industrial
  // (small sheds) or residential (small apartment blocks).
  if (r.district === 'industrial' && r.roll < 0.4) return 'warehouse';
  if (r.district === 'residential' && r.roll > 0.75) return 'resBlock';
  return 'plain';
}

// --- Environment Pass 10: procedural massing ------------------------------
// Two buildings with the same archetype still differ in how their volume is
// composed: the classic single box plus podium+tower, L-wing, twin-tower and
// asymmetric setback massings. The roll is pure and deterministic (seeded per
// cell), and SMALL footprints always stay single boxes so the combat corridor
// keeps its clean low-rise walls.

export type BuildingMassing = 'mono' | 'podium' | 'lshape' | 'twins' | 'stepped';

export function buildingMassing(roll: number, tier: number): BuildingMassing {
  if (tier === 0) return 'mono';
  if (roll < 0.52) return 'mono';
  if (roll < 0.7) return 'podium';
  if (roll < 0.83) return 'lshape';
  if (roll < 0.92) return 'twins';
  return 'stepped';
}

// --- Environment Pass 9: procedural scene rhythm ---------------------------
// Chunks alternate visual intensity along the flight path instead of reading
// as one uniform grid: dense blocks → plazas/open space → airier objective
// clearings → a rare landmark. All functions are pure and deterministic on the
// chunk id, so streaming chunks always agree on the rhythm at any seam.

export type SceneRhythm = 'dense' | 'medium' | 'open' | 'objective' | 'landmark';

/** Deterministic 0..1 roll for a chunk id (stable across sessions). */
function rhythmRoll(chunkId: number): number {
  let h = Math.imul(chunkId + 7, 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

/**
 * Scene rhythm for a chunk. Landmarks are ~1 in 7 chunks, and the 6-chunk
 * look-back memory guarantees they stay spaced out (never clustered, never
 * starved) so rare structures double as navigation memory. The rest of the
 * band alternates dense blocks, medium streets, open plazas and airier
 * objective clearings. Pure and deterministic on the chunk id alone.
 */
export function sceneRhythmForChunk(chunkId: number): SceneRhythm {
  const roll = rhythmRoll(chunkId);
  const wantsLandmark = roll > 0.82;
  // Recent-memory guard: a landmark chunk only forms if no landmark-wanting
  // chunk rolled in the previous 6 — prevents both back-to-back landmarks and
  // long landmark-free stretches along the flight path.
  let recentLandmark = false;
  for (let i = 1; i <= 6; i++) {
    if (rhythmRoll(chunkId - i) > 0.82) {
      recentLandmark = true;
      break;
    }
  }
  if (wantsLandmark && !recentLandmark) return 'landmark';
  if (roll > 0.72) return 'objective'; // airier combat clearing
  if (roll > 0.5) return 'open'; // park / plaza breathing room
  if (roll > 0.27) return 'medium';
  return 'dense';
}

/** Density multiplier for a rhythm — drives alternating visual intensity. */
export function rhythmDensity(rhythm: SceneRhythm): number {
  switch (rhythm) {
    case 'dense':
      return 1.2;
    case 'medium':
      return 1.0;
    case 'objective':
      return 0.62;
    case 'open':
      return 0.5;
    case 'landmark':
      return 0.85;
  }
}

// ---------------------------------------------------------------------------
// Status effects (Burn / EMP / Shock)
// ---------------------------------------------------------------------------

/** How long each status effect lasts once applied (seconds). */
export const STATUS_DURATIONS: Record<StatusEffectKind, number> = {
  burn: 3.0,
  emp: 2.0,
  shock: 2.5,
};

/** Burn damage per second while ignited. */
export const BURN_DPS = 14;
/** Movement-speed multiplier while shocked (lower = slower). */
export const SHOCK_SPEED_MULT = 0.55;

/** Clamp a status proc chance (base + perk/upgrade bonuses) to a sane ceiling. */
export function statusProcChance(base: number, bonus = 0): number {
  return clamp(base + Math.max(0, bonus), 0, 0.95);
}

// ---------------------------------------------------------------------------
// Elite affixes (new EnemyModifier bitflags)
// ---------------------------------------------------------------------------

export interface AffixChances {
  explosive: number;
  splitter: number;
  vampiric: number;
}

/** Per-spawn affix roll chances by wave — all zero before their debut wave. */
export function affixChancesForWave(wave: number): AffixChances {
  const w = Math.max(1, Math.floor(wave));
  return {
    explosive: w >= 6 ? Math.min(0.18, 0.06 + (w - 6) * 0.01) : 0,
    splitter: w >= 8 ? Math.min(0.14, 0.04 + (w - 8) * 0.008) : 0,
    vampiric: w >= 9 ? Math.min(0.12, 0.03 + (w - 9) * 0.008) : 0,
  };
}

/** Drones released when a SPLITTER enemy dies. */
export const SPLITTER_DRONE_COUNT = 3;
/** Death-detonation radius / damage for EXPLOSIVE enemies. */
export const EXPLOSIVE_AFFIX_RADIUS = 26;
export const EXPLOSIVE_AFFIX_DAMAGE = 30;
/** Fraction of dealt damage a VAMPIRIC enemy heals back. */
export const VAMPIRIC_HEAL_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Devastation super meter
// ---------------------------------------------------------------------------

export const SUPER_MAX_CHARGE = 100;
/** Seconds the Devastation overcharge lasts once triggered. */
export const SUPER_DURATION = 5;
/** Seconds before the meter can charge again after an overcharge ends. */
export const SUPER_COOLDOWN = 8;

/** Charge granted per kill — combo accelerates it, elites/bosses are jackpots. */
export function superChargeForKill(comboCount: number, isElite: boolean, isBoss: boolean): number {
  if (isBoss) return 40;
  const base = isElite ? 12 : 4;
  return base + Math.min(6, Math.floor(Math.max(0, comboCount) / 4));
}

// ---------------------------------------------------------------------------
// Adaptive quality governor (pure — the engine feeds it FPS windows)
// ---------------------------------------------------------------------------

export interface QualityGovernorState {
  /** 0 = full quality .. GOVERNOR_MAX_LEVEL = maximum degradation. */
  level: number;
  /** Consecutive measurement windows below GOVERNOR_LOW_FPS. */
  lowWindows: number;
  /** Consecutive measurement windows above GOVERNOR_HIGH_FPS. */
  highWindows: number;
  /** Timestamp (s) of the last level change — enforces the cooldown. */
  lastChangeAt: number;
}

export const GOVERNOR_MAX_LEVEL = 3;
export const GOVERNOR_LOW_FPS = 50;
export const GOVERNOR_HIGH_FPS = 57;
/** Minimum seconds between level changes (prevents oscillation). */
export const GOVERNOR_COOLDOWN_SECONDS = 5;
/** Pixel-ratio multiplier applied on top of the user's quality preset. */
export const GOVERNOR_PIXEL_SCALE = [1, 0.85, 0.7, 0.55] as const;
/** Particle spawn-count multiplier per governor level. */
export const GOVERNOR_PARTICLE_SCALE = [1, 0.8, 0.6, 0.45] as const;

export function createQualityGovernor(): QualityGovernorState {
  return { level: 0, lowWindows: 0, highWindows: 0, lastChangeAt: -999 };
}

/**
 * Advance the governor with one measurement window. Two consecutive windows
 * below LOW_FPS step down; four above HIGH_FPS step back up; the band in
 * between is a hysteresis dead zone. Level changes respect a cooldown.
 */
export function updateQualityGovernor(
  state: QualityGovernorState,
  avgFps: number,
  now: number,
): QualityGovernorState {
  if (!Number.isFinite(avgFps) || !Number.isFinite(now)) return state;
  let { level, lowWindows, highWindows, lastChangeAt } = state;
  if (avgFps < GOVERNOR_LOW_FPS) {
    lowWindows += 1;
    highWindows = 0;
  } else if (avgFps > GOVERNOR_HIGH_FPS) {
    highWindows += 1;
    lowWindows = 0;
  } else {
    lowWindows = 0;
    highWindows = 0;
  }
  const cooldownOk = now - lastChangeAt >= GOVERNOR_COOLDOWN_SECONDS;
  if (cooldownOk && lowWindows >= 2 && level < GOVERNOR_MAX_LEVEL) {
    level += 1;
    lowWindows = 0;
    highWindows = 0;
    lastChangeAt = now;
  } else if (cooldownOk && highWindows >= 4 && level > 0) {
    level -= 1;
    lowWindows = 0;
    highWindows = 0;
    lastChangeAt = now;
  }
  if (
    level === state.level &&
    lowWindows === state.lowWindows &&
    highWindows === state.highWindows
  ) {
    return state;
  }
  return { level, lowWindows, highWindows, lastChangeAt };
}

export function governorPixelScale(level: number): number {
  return GOVERNOR_PIXEL_SCALE[clamp(Math.floor(level), 0, GOVERNOR_MAX_LEVEL)];
}

export function governorParticleScale(level: number): number {
  return GOVERNOR_PARTICLE_SCALE[clamp(Math.floor(level), 0, GOVERNOR_MAX_LEVEL)];
}

/** Bloom survives light degradation but is the first heavy effect cut. */
export function governorBloomAllowed(level: number, userWantsHigh: boolean): boolean {
  return userWantsHigh && level < 2;
}

// ---------------------------------------------------------------------------
// Pilot perks (persistent meta-progression, bought with salvage credits)
// ---------------------------------------------------------------------------

export type PerkId =
  | 'magnet'
  | 'dash'
  | 'salvageLuck'
  | 'crashResist'
  | 'xpGain'
  | 'fuelSaver'
  | 'superCharge'
  | 'procChance';

export const MAX_PERK_RANK = 3;

export interface PerkInfo {
  name: string;
  desc: string;
  /** Salvage-credit cost per rank (index 0 = rank 1). */
  costs: [number, number, number];
  /** Numeric effect granted per rank (meaning depends on the perk). */
  perRank: number;
}

export const PERK_INFO: Record<PerkId, PerkInfo> = {
  magnet: { name: 'Salvage Magnet', desc: '+20% pickup & gem magnet radius per rank', costs: [100, 280, 600], perRank: 0.2 },
  dash: { name: 'Vector Thrusters', desc: 'Dash cooldown -8% per rank', costs: [110, 300, 640], perRank: 0.08 },
  salvageLuck: { name: 'Scavenger Rig', desc: '+10% salvage from all sources per rank', costs: [120, 320, 680], perRank: 0.1 },
  crashResist: { name: 'Crash Plating', desc: 'Collision damage -12% per rank', costs: [105, 290, 620], perRank: 0.12 },
  xpGain: { name: 'Combat Computer', desc: '+8% run XP per rank', costs: [130, 340, 700], perRank: 0.08 },
  fuelSaver: { name: 'Lean Burn', desc: 'Fuel drain -6% per rank', costs: [100, 280, 600], perRank: 0.06 },
  superCharge: { name: 'Devastator Core', desc: '+15% Devastation charge rate per rank', costs: [140, 380, 760], perRank: 0.15 },
  procChance: { name: 'Elemental Coils', desc: '+5% status proc chance per rank', costs: [135, 360, 720], perRank: 0.05 },
};

export type PerkRanks = Record<PerkId, number>;

export function defaultPerks(): PerkRanks {
  return { magnet: 0, dash: 0, salvageLuck: 0, crashResist: 0, xpGain: 0, fuelSaver: 0, superCharge: 0, procChance: 0 };
}

export function readPerks(storage: Pick<Storage, 'getItem'> = window.localStorage): PerkRanks {
  const ranks = defaultPerks();
  try {
    const raw = storage.getItem('helistrike:perks');
    if (!raw) return ranks;
    const parsed = JSON.parse(raw) as Partial<Record<PerkId, number>>;
    for (const id of Object.keys(ranks) as PerkId[]) {
      ranks[id] = clamp(Math.floor(parsed?.[id] ?? 0), 0, MAX_PERK_RANK);
    }
  } catch {
    // storage unavailable — defaults
  }
  return ranks;
}

export function writePerkRank(
  id: PerkId,
  rank: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): PerkRanks {
  const ranks = readPerks(storage);
  ranks[id] = clamp(Math.floor(rank), 0, MAX_PERK_RANK);
  try {
    storage.setItem('helistrike:perks', JSON.stringify(ranks));
  } catch {
    // storage unavailable — ignore
  }
  return ranks;
}

/** Numeric effect of a perk at a rank (e.g. magnet rank 2 = 0.4 → +40% radius). */
export function perkEffect(id: PerkId, rank: number): number {
  return PERK_INFO[id].perRank * clamp(Math.floor(rank), 0, MAX_PERK_RANK);
}

// ---------------------------------------------------------------------------
// Weapon mods (one per weapon, chosen in the Hangar — persisted)
// ---------------------------------------------------------------------------

/** 0 = factory config, 1 = mod A, 2 = mod B. */
export type WeaponModChoice = 0 | 1 | 2;

export interface WeaponModInfo {
  name: string;
  desc: string;
}

export const WEAPON_MODS: Record<number, [WeaponModInfo, WeaponModInfo]> = {
  [WeaponType.MACHINE_GUN]: [
    { name: 'Incendiary Rounds', desc: '18% chance to ignite targets (burn 3s)' },
    { name: 'Piercing Rounds', desc: '+35% damage vs TANK & BOSS hulls' },
  ],
  [WeaponType.MISSILE]: [
    { name: 'EMP Warheads', desc: 'Blast disables enemy weapons for 2s' },
    { name: 'Cluster Warheads', desc: 'Impact splits into 3 mini-blasts' },
  ],
  [WeaponType.ROCKET]: [
    { name: 'Napalm Payload', desc: '+30% blast radius, ignites survivors' },
    { name: 'Shaped Charge', desc: '+45% damage vs BOSS & elite targets' },
  ],
  [WeaponType.SHOTGUN]: [
    { name: 'Shock Shells', desc: '25% chance to slow enemies (2.5s)' },
    { name: 'Slug Barrel', desc: '+30% damage, tighter spread' },
  ],
};

export function readWeaponMods(storage: Pick<Storage, 'getItem'> = window.localStorage): number[] {
  try {
    const raw = storage.getItem('helistrike:weaponMods');
    if (!raw) return [0, 0, 0, 0];
    const parsed = JSON.parse(raw) as number[];
    return [0, 1, 2, 3].map((i) => clamp(Math.floor(parsed[i] ?? 0), 0, 2));
  } catch {
    return [0, 0, 0, 0];
  }
}

export function writeWeaponMod(
  weaponIndex: number,
  choice: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): number[] {
  const mods = readWeaponMods(storage);
  if (weaponIndex >= 0 && weaponIndex < mods.length) {
    mods[weaponIndex] = clamp(Math.floor(choice), 0, 2);
  }
  try {
    storage.setItem('helistrike:weaponMods', JSON.stringify(mods));
  } catch {
    // storage unavailable — ignore
  }
  return mods;
}

// ---------------------------------------------------------------------------
// Extraction run structure
// ---------------------------------------------------------------------------

export const EXTRACTION_MIN_WAVE = 6;
export const EXTRACTION_MIN_OBJECTIVES = 2;
/** Seconds the player must hold the LZ while the evac rides in. */
export const EXTRACTION_HOLD_SECONDS = 12;

// ---------------------------------------------------------------------------
// Night ops (wave-scoped palette swap — seeded so a run is reproducible)
// ---------------------------------------------------------------------------

export const NIGHT_OPS_MIN_WAVE = 8;
export const NIGHT_OPS_CHANCE = 0.25;

/** Deterministic per-wave night-op roll: same (wave, seed) always agrees. */
export function nightOpForWave(wave: number, seed: number): boolean {
  if (!Number.isFinite(wave) || !Number.isFinite(seed)) return false;
  if (wave < NIGHT_OPS_MIN_WAVE) return false;
  let h = (Math.floor(wave) * 374761393 + Math.floor(seed) * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % 1000 < Math.round(NIGHT_OPS_CHANCE * 1000);
}

/** An LZ evac may be offered once per run, after the player has proven themselves. */
export function canOfferExtraction(
  wave: number,
  objectivesDestroyed: number,
  alreadyHandled: boolean,
): boolean {
  return (
    !alreadyHandled &&
    wave >= EXTRACTION_MIN_WAVE &&
    objectivesDestroyed >= EXTRACTION_MIN_OBJECTIVES
  );
}

// ---------------------------------------------------------------------------
// Run history & shareable scorecard
// ---------------------------------------------------------------------------

export interface RunRecord {
  score: number;
  wave: number;
  kills: number;
  accuracy: number;
  survivalTime: number;
  victory: boolean;
  /** Epoch milliseconds when the run ended. */
  at: number;
}

export const RUN_HISTORY_LIMIT = 10;

export function readRunHistory(storage: Pick<Storage, 'getItem'> = window.localStorage): RunRecord[] {
  try {
    const raw = storage.getItem('helistrike:history');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is RunRecord =>
        !!r &&
        Number.isFinite(r.score) &&
        Number.isFinite(r.wave) &&
        Number.isFinite(r.kills),
      )
      .slice(0, RUN_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Prepend a run to the persisted history (most recent first, capped). */
export function recordRun(
  rec: RunRecord,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): RunRecord[] {
  const history = [rec, ...readRunHistory(storage)].slice(0, RUN_HISTORY_LIMIT);
  try {
    storage.setItem('helistrike:history', JSON.stringify(history));
  } catch {
    // storage unavailable — ignore
  }
  return history;
}

/** Plain-text scorecard for clipboard sharing. */
export function formatScorecard(rec: RunRecord, best: number): string {
  const lines = [
    `HELI-STRIKE ${rec.victory ? '— MISSION COMPLETE' : '— RUN REPORT'}`,
    `Score: ${rec.score}${rec.score >= best && rec.score > 0 ? ' (NEW BEST!)' : ''}`,
    `Wave reached: ${rec.wave}`,
    `Kills: ${rec.kills}`,
    `Accuracy: ${Math.round(rec.accuracy * 100)}%`,
    `Survived: ${formatDuration(rec.survivalTime)}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Progression pacing — starter grant, combat pay, first-time achievements
// ---------------------------------------------------------------------------

export const PROGRESS_SAVE_KEY = 'helistrike:progress';
export const PROGRESS_SAVE_VERSION = 1;
/** One-time welcome grant for brand-new profiles — guarantees a first purchase. */
export const STARTER_CREDITS = 150;

export interface ProgressSave {
  version: number;
  /** Starter credit grant already paid out. */
  starterGranted: boolean;
  /** One-time achievement ids already paid out (prevents restart farming). */
  achievements: string[];
}

export function defaultProgress(): ProgressSave {
  return { version: PROGRESS_SAVE_VERSION, starterGranted: false, achievements: [] };
}

/** Versioned, migration-friendly read. Corrupt or missing data degrades to
 *  defaults instead of crashing; unknown future versions are kept intact. */
export function readProgress(storage: Pick<Storage, 'getItem'> = window.localStorage): ProgressSave {
  try {
    const raw = storage.getItem(PROGRESS_SAVE_KEY);
    if (!raw) return defaultProgress();
    const parsed = JSON.parse(raw) as Partial<ProgressSave>;
    const achievements = Array.isArray(parsed.achievements)
      ? parsed.achievements.filter((a): a is string => typeof a === 'string')
      : [];
    // Future migration hooks key off `parsed.version` — v1 is the baseline.
    return {
      version: PROGRESS_SAVE_VERSION,
      starterGranted: Boolean(parsed.starterGranted),
      achievements,
    };
  } catch {
    return defaultProgress();
  }
}

export function writeProgress(
  save: ProgressSave,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
) {
  try {
    storage.setItem(PROGRESS_SAVE_KEY, JSON.stringify(save));
  } catch {
    // storage unavailable — progression stays in-memory for this session
  }
}

export interface AchievementInfo {
  id: string;
  label: string;
  credits: number;
}

/** One-time milestones — paid once per profile, never farmable by restarting. */
export const FIRST_TIME_ACHIEVEMENTS: AchievementInfo[] = [
  { id: 'firstKill', label: 'First Kill', credits: 20 },
  { id: 'firstWaveClear', label: 'Wave 1 Cleared', credits: 40 },
  { id: 'firstDelivery', label: 'First Delivery', credits: 60 },
  { id: 'firstSam', label: 'SAM Site Destroyed', credits: 50 },
  { id: 'firstExtraction', label: 'Clean Extraction', credits: 80 },
];

export interface CombatPayInput {
  kills: number;
  /** Wave the run reached (waves cleared = wave - 1). */
  wave: number;
  /** SAM + radar + depot objectives destroyed. */
  objectives: number;
  survivalTime: number;
}

/** Guaranteed end-of-run pay so an honest early run never ends at zero
 *  credits. Doing nothing earns nothing: time pay requires at least one kill. */
export function computeCombatPay(input: CombatPayInput): number {
  const kills = Math.max(0, Math.floor(input.kills));
  const wavesCleared = Math.max(0, Math.floor(input.wave) - 1);
  const objectives = Math.max(0, Math.floor(input.objectives));
  const time = Math.max(0, input.survivalTime);
  const timePay = kills > 0 ? Math.floor(time / 30) * 4 : 0;
  return kills * 2 + wavesCleared * 12 + objectives * 15 + timePay;
}
