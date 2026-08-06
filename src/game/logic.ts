// Pure game logic — no THREE/CANNON/DOM dependencies, unit-testable.

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
  if (type === 0) return { hp: 260, points: 300, radius: 4.2, label: 'SAM SITE' };
  if (type === 1) return { hp: 320, points: 250, radius: 4.6, label: 'RADAR TOWER' };
  return { hp: 300, points: 200, radius: 4.4, label: 'AMMO DEPOT' };
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
