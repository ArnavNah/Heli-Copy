// Pure game logic — no THREE/CANNON/DOM dependencies, unit-testable.
// EnemyType is imported as a value but types.ts only uses type-only imports
// for THREE/CANNON, so it stays dependency-free at runtime.
import { EnemyType } from "./types";

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
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  casual: { enemyHp: 0.75, enemyDamage: 0.7, spawnRate: 0.8, maxRisk: 0.5, objectiveHp: 0.8 },
  normal: { enemyHp: 1, enemyDamage: 1, spawnRate: 1, maxRisk: 0.75, objectiveHp: 1 },
  hard: { enemyHp: 1.45, enemyDamage: 1.35, spawnRate: 1.25, maxRisk: 1.0, objectiveHp: 1.35 },
};

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
  return Math.min(9, 1 + (wave - 1) * 0.18);
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
export function xpForEnemyType(type: EnemyType, isElite: boolean): number {
  if (type === EnemyType.BOSS) return 50;
  if (isElite) return 15; // elite miniboss
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
  | 'bomb';

export interface UpgradeOption {
  id: UpgradeId;
  title: string;
  desc: string;
  icon: string;
}

export const UPGRADE_POOL: UpgradeOption[] = [
  { id: 'damage', title: 'Overclock Rounds', desc: '+25% weapon damage (all weapons)', icon: '⚡' },
  { id: 'fireRate', title: 'Hair Trigger', desc: '+18% fire rate (all weapons)', icon: '🔥' },
  { id: 'ammo', title: 'Extended Mag', desc: '+30% max ammo (all weapons)', icon: '📦' },
  { id: 'reload', title: 'Speed Loader', desc: 'Reload 25% faster', icon: '🔧' },
  { id: 'salvoCooldown', title: 'Salvo Overclock', desc: 'Multi-salvo cooldown -35%', icon: '🎯' },
  { id: 'maxHealth', title: 'Reinforced Hull', desc: '+20 max health and heal 20', icon: '🛡️' },
  { id: 'fuelEfficiency', title: 'Turbine Tune', desc: 'Fuel drain -30%', icon: '⛽' },
  { id: 'shield', title: 'Aegis Field', desc: 'Immediate 8s energy shield', icon: '🔮' },
  { id: 'speed', title: 'Afterburners', desc: '+20% move speed for 12s', icon: '💨' },
  { id: 'bomb', title: 'Airstrike', desc: 'Instantly clear the screen', icon: '💣' },
];

/** Pick `count` distinct random upgrades (clamped to the pool size). */
export function pickUpgrades(count: number, rng: () => number = Math.random): UpgradeOption[] {
  const n = Math.max(1, Math.min(count, UPGRADE_POOL.length));
  const pool = [...UPGRADE_POOL];
  const picks: UpgradeOption[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
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
 * Deterministic repeating district schedule — 14 chunks ≈ 1,850 units of
 * flight ≈ ~35s at cruise speed, so every zone cycles regularly instead of
 * lumping together by random chance.
 */
export const DISTRICT_SCHEDULE: DistrictName[] = [
  'downtown',
  'midtown',
  'industrial',
  'residential',
  'midtown',
  'waterfront',
  'downtown',
  'residential',
  'desert',
  'industrial',
  'forest',
  'midtown',
  'base',
  'ruins',
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
    density: 0.48,
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
    openSpaceChance: 0.35,
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
    density: 0.44,
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
    openSpaceChance: 0.4,
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
    density: 0.4,
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
    openSpaceChance: 0.55,
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
    density: 0.46,
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
    openSpaceChance: 0.6,
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
