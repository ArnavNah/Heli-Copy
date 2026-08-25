import type * as THREE from "three";
import type * as CANNON from "cannon-es";
import type { SamState } from "./sam";
import type { MissionType } from "./mission";

/** Structural type compatible with both CANNON.Vec3 and THREE.Vector3.
 *  Used to avoid `as any` casts when copying physics positions to render meshes. */
export interface Vec3Like { x: number; y: number; z: number }

/** Copy a cannon-es Vec3 (or any {x,y,z}) into a Three.js Object3D position. */
export function copyPhysicsPos(mesh: THREE.Object3D, pos: Vec3Like): void {
  mesh.position.set(pos.x, pos.y, pos.z);
}

// Coastal warzone art direction: crisp tropical sunny sky over a sunlit warzone.
// Saturated cyan-blue zenith with bright sunny horizon and crystal clear visibility.
export const SKY_CLEAR_COLOR = 0x6caee2;
export const SKY_STORM_COLOR = 0x485868;
export const FOG_CLEAR_COLOR = 0xdaf0fc;
export const FOG_STORM_COLOR = 0x303840;

export const HUD_COLORS = {
  CYAN: '#50ebff',
  CYAN_LIGHT: '#7df9ff',
  CYAN_DIM: '#9bf1ff',
  DANGER_RED: '#ef233c',
  DANGER_RED_BRIGHT: '#ff3344',
  WARNING_GOLD: '#ffd43b',
  WARNING_GOLD_LIGHT: '#ffe66d',
  SUCCESS_GREEN: '#55f2a2',
  SUCCESS_GREEN_BRIGHT: '#2bd66f',
  SHIELD_BLUE: '#4dabf7',
  BOSS_MAGENTA: '#ff3366',
} as const;

/**
 * 3e: CANNON.js collision groups — bitmask-based filtering so unrelated
 * physics objects (e.g. player vs. distant debris, enemies vs. enemies)
 * are never tested against each other.
 */
export const COLLISION = {
  PLAYER: 1,
  ENEMY: 2,
  BUILDING: 4,
  PLAYER_PROJECTILE: 8,
  ENEMY_PROJECTILE: 16,
  DEBRIS: 32,
  PICKUP: 64,
  /** Player collides with buildings + enemy projectiles. */
  PLAYER_MASK: 4 | 16,
  /** Enemies collide with buildings + player projectiles. */
  ENEMY_MASK: 4 | 8,
  /** Player projectiles collide with enemies + buildings. */
  PLAYER_PROJ_MASK: 2 | 4,
  /** Enemy projectiles collide with player + buildings. */
  ENEMY_PROJ_MASK: 1 | 4,
  /** Debris collides with buildings only (bounces off walls). */
  DEBRIS_MASK: 4,
} as const;

/**
 * Linear fog band (low-poly pass): near-field combat stays completely clear,
 * the midground builds depth, and the far skyline melts into the horizon.
 * FOG_NEAR is where fog starts (nothing before it), FOG_FAR is full fog.
 * Widened from (80, 340) so typical combat range (~150-250u) reads clearly
 * instead of sitting in heavy haze.
 */
export const FOG_NEAR = 120;
export const FOG_FAR = 440;
export const TARGET_RENDER_FPS = 60;
export const MAX_RENDER_PIXEL_RATIO = 1.0;

export type RooftopSpot = {
  x: number;
  y: number;
  z: number;
  /** True when this spot is a rooftop helipad pad (extraction LZ candidate). */
  helipad?: boolean;
};

export type CityBlock = {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  chunkId: number;
  meshes: THREE.Mesh[];
  body?: CANNON.Body;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  collapseProgress?: number;
  initialHeights?: number[];
  /** Per-mesh crumble delay (seconds) — roof tier falls first, base last. */
  collapseDelays?: number[];
  /** Total collapse duration in seconds (max delay + per-tier fall time). */
  collapseDuration?: number;
  /** Lateral shear direction the building slides toward while crumbling. */
  collapseShearX?: number;
  collapseShearZ?: number;
  /** True once the collapse-out sequence has finished (fires onBuildingDestroyed once). */
  collapseFinished?: boolean;
  /** Camera-occlusion ghost factor 0..1 (0 = fully visible, 1 = fully ghosted). */
  occlusionFactor?: number;
  /** Target occlusion factor the per-frame interpolation eases toward. */
  occlusionTarget?: number;
  /** District landmark kind (e.g. "HELIPAD_TOWER") — used to place extraction pads on real LZs. */
  landmarkKind?: string;
};

export type EnemyLock = {
  body: CANNON.Body;
  active: boolean;
};

// --- Tactical minimap snapshot (engine → HUD, ~12 Hz) ---
// Positions only — full entity objects never cross into React. The player is
// always centered; world markers are drawn relative to the player position.
export type MinimapEnemy = {
  x: number;
  z: number;
  type: EnemyType;
  variant?: EnemyVariant;
  elite: boolean;
  boss: boolean;
};

export type MinimapDelivery = {
  origin: { x: number; z: number };
  destination: { x: number; z: number };
  carrying: boolean;
  state: string;
};

export type MinimapObjective = {
  type: ObjectiveType;
  x: number;
  z: number;
  samState?: SamState;
  detectionRange?: number;
};

export type MinimapThreat = {
  x: number;
  z: number;
  kind: "HOMING_MISSILE";
  target: "PLAYER" | "DECOY" | "NONE";
};

export type MinimapExtraction = {
  x: number;
  z: number;
  active: boolean;
  /** World-space radius of the extraction zone (units). */
  radius: number;
  /** Pad surface elevation (world Y) — tells the player if the LZ is a rooftop. */
  elevation: number;
};

export type MinimapMission = {
  x: number;
  z: number;
  type: MissionType;
  targetKind?: "SAM" | "RADAR" | "DELIVERY" | "ELITE" | "AREA" | "CONVOY" | "CRASH_SITE";
};

export interface MinimapSnapshot {
  player: { x: number; y: number; z: number; heading: number };
  enemies: MinimapEnemy[];
  delivery: MinimapDelivery | null;
  objectives: MinimapObjective[];
  threats: MinimapThreat[];
  extraction: MinimapExtraction | null;
  mission: MinimapMission | null;
  range: number;
}

export type WorldChunk = {
  id: number;
  group: THREE.Group;
  bodies: CANNON.Body[];
  blocks: CityBlock[];
  spots: RooftopSpot[];
};

export type StickInput = {
  x: number;
  y: number;
  active: boolean;
};

export type QualityPreset = 'low' | 'medium' | 'high';
/** Graphics mode: SP1 = chunky low-res PS1-style pixels; HD = crisp full-res render. */
export type GraphicsMode = 'sp1' | 'hd';
export type Difficulty = 'casual' | 'normal' | 'hard';
/** Flight handling preset: Arcade = snappy default, Simulation = heavier inertia. */
export type MovementPreset = 'arcade' | 'simulation';
/** Camera shake strength. 'off' fully disables gameplay impulses. */
export type ScreenShakeLevel = 'off' | 'low' | 'full';

export interface GameSettings {
  invertedY: boolean;
  gamepadSensitivity: number;
  quality: QualityPreset;
  graphics: GraphicsMode;
  /** Master output level (0..1). Music/SFX buses sit under it. */
  volume: number;
  /** Music bus level (0..1), relative to master. */
  musicVolume: number;
  /** Sound-effects bus level (0..1), relative to master. */
  sfxVolume: number;
  touchMode: boolean;
  difficulty: Difficulty;
  /** Auto-lock guns onto the nearest enemy; the gun turret tracks, not the body. */
  autoAim: boolean;
  /** Handling preset — arcade (default) or simulation (heavier, more drift). */
  movement: MovementPreset;
  /** Camera shake strength for impacts and explosions. */
  screenShake: ScreenShakeLevel;
  /** Tones down hit flashes and strobing warning pulses (photosensitivity aid). */
  reduceFlash: boolean;
  /** When true the quality governor may step effects down to hold frame rate. */
  adaptiveQuality: boolean;
}

export enum EnemyMovementClass {
  GROUND = "GROUND",
  STATIC_GROUND = "STATIC_GROUND",
  FLYING = "FLYING",
}

export enum EnemyType {
  BASIC, // Infantry Cluster in Phase 1
  SHOOTER,
  TANK,
  DRONE,
  BOSS,
}

/**
 * Combat variants built on top of the five base EnemyTypes. Each variant
 * reuses the base movement/hull/avoidance machinery and adds a distinct role,
 * visual accent and attack telegraph. STANDARD keeps the classic behavior.
 */
export enum EnemyVariant {
  STANDARD = "STANDARD",
  SCOUT_DRONE = "SCOUT_DRONE",
  KAMIKAZE_DRONE = "KAMIKAZE_DRONE",
  ATTACK_GUNSHIP = "ATTACK_GUNSHIP",
  ROCKET_GUNSHIP = "ROCKET_GUNSHIP",
  FLAK_TANK = "FLAK_TANK",
  MISSILE_CARRIER = "MISSILE_CARRIER",
  SHIELD_DRONE = "SHIELD_DRONE",
  REPAIR_DRONE = "REPAIR_DRONE",
  HEAVY_GUNSHIP = "HEAVY_GUNSHIP",
  SIEGE_TANK = "SIEGE_TANK",
  /** Fast jet — strafes in with short bursts, then peels off to re-attack. */
  INTERCEPTOR = "INTERCEPTOR",
  /** Slow hover platform that lobs slow, homing proximity mines. */
  MINELAYER = "MINELAYER",
  /** Armored gunship with a wind-up tracking gatling stream. */
  GATLING_HEAVY = "GATLING_HEAVY",
}

export enum EnemyModifier {
  NONE = 0,
  SHIELDED = 1, // Absorbs first N hits with an energy shield
  REGENERATING = 2, // Slowly heals when not recently damaged
  ELITE = 4, // Miniboss-tier: bigger, tougher, worth more
  EXPLOSIVE = 8, // Detonates on death — the blast hurts EVERYTHING nearby
  SPLITTER = 16, // Breaks into drone escorts on death
  VAMPIRIC = 32, // Heals itself when its shots connect with the player
}

/** Elemental status effects the player can inflict (burn DoT / EMP silence / shock slow). */
export type StatusEffectKind = 'burn' | 'emp' | 'shock';

export enum AttackPattern {
  CHASE = 0, // Default: approach and strafe
  CIRCLE = 1, // Circle-strafing runs around the player
  KAMIKAZE = 2, // Dive straight at the player
  ARTILLERY = 3, // Sit at range and lob arcing shells
}

export enum ObjectiveType {
  SAM_SITE = 0, // Enemy accuracy buff while alive; destroys to debuff
  RADAR_TOWER = 1, // Reveals/damages all enemies on destroy
  AMMO_DEPOT = 2, // Drops a bomb power-up on destroy
}

export enum WeaponType {
  MACHINE_GUN,
  MISSILE,
  ROCKET,
  SHOTGUN,
}

export enum HelicopterModel {
  APACHE = 0, // Default military attack helicopter
  NIGHTHAWK = 1, // Stealth gunship — angular, dark, twin tails
  WARLOCK = 2, // Heavy gunship — bulky, wide wings, twin rotors
}

export interface WeaponConfig {
  name: string;
  damage: number;
  fireRate: number; // seconds between shots
  ammo: number;
  maxAmmo: number;
  reloadTime: number; // seconds to reload
  speed: number; // projectile speed
  count: number; // projectiles per shot
  spread: number; // spread angle for shotguns
  blastRadius: number;
  color: number;
  homing: boolean;
}

export const WEAPON_CONFIGS: Record<WeaponType, WeaponConfig> = {
  [WeaponType.MACHINE_GUN]: {
    name: 'Machine Gun',
    damage: 13,
    fireRate: 0.055,
    ammo: 300,
    maxAmmo: 300,
    reloadTime: 1.5,
    speed: 430,
    count: 2,
    spread: 0.015,
    blastRadius: 0,
    color: 0xff2a2a,
    homing: false,
  },
  [WeaponType.MISSILE]: {
    name: 'Missile',
    damage: 55,
    fireRate: 0.95,
    ammo: 20,
    maxAmmo: 20,
    reloadTime: 2.5,
    speed: 260,
    count: 1,
    spread: 0,
    blastRadius: 16,
    color: 0x44ff44,
    homing: true,
  },
  [WeaponType.ROCKET]: {
    name: 'Rocket',
    damage: 80,
    fireRate: 1.45,
    ammo: 12,
    maxAmmo: 12,
    reloadTime: 3.2,
    speed: 235,
    count: 1,
    spread: 0,
    blastRadius: 28,
    color: 0xffaa00,
    homing: false,
  },
  [WeaponType.SHOTGUN]: {
    name: 'Shotgun',
    damage: 10,
    fireRate: 0.45,
    ammo: 40,
    maxAmmo: 40,
    reloadTime: 2.0,
    speed: 280,
    count: 6,
    spread: 0.3,
    blastRadius: 0,
    color: 0xffdd22,
    homing: false,
  },
};

export enum PowerUpType {
  HEALTH,
  DAMAGE_BOOST,
  SHIELD,
  AMMO,
  SPEED_BOOST,
  BOMB,
  FUEL,
  XP_GEM,
  SALVAGE,
  COUNTERMEASURE,
}

export enum PowerUpState {
  IDLE,
  COLLECTING,
  COLLECTED,
}
