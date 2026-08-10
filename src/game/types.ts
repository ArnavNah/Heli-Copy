import type * as THREE from "three";
import type * as CANNON from "cannon-es";

// Pass 8 art direction: the scene used to stack cyan sky + cyan fog + icy
// lighting into one blue wash that drowned gameplay. Fog is now a warm neutral
// haze (distant buildings fade into the horizon instead of turning cyan) and
// the clear sky is a muted steel blue. Storm colors stay dark/moody so
// silhouettes remain readable.
export const SKY_CLEAR_COLOR = 0x8fb0c9;
export const SKY_STORM_COLOR = 0x51647f;
export const FOG_CLEAR_COLOR = 0xb5b2a4;
export const FOG_STORM_COLOR = 0x29364f;
/** Exponential fog density — tuned so mid-distance reads as depth, not haze. */
export const FOG_DENSITY = 0.004;
export const TARGET_RENDER_FPS = 60;
export const MAX_RENDER_PIXEL_RATIO = 1.0;

export type RooftopSpot = {
  x: number;
  y: number;
  z: number;
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
  /** True once the collapse-out sequence has finished (fires onBuildingDestroyed once). */
  collapseFinished?: boolean;
  /** Camera-occlusion ghost factor 0..1 (0 = fully visible, 1 = fully ghosted). */
  occlusionFactor?: number;
  /** Target occlusion factor the per-frame interpolation eases toward. */
  occlusionTarget?: number;
};

export type EnemyLock = {
  body: CANNON.Body;
  active: boolean;
};

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

export type QualityPreset = 'low' | 'high';
export type Difficulty = 'casual' | 'normal' | 'hard';

export interface GameSettings {
  invertedY: boolean;
  gamepadSensitivity: number;
  quality: QualityPreset;
  volume: number;
  touchMode: boolean;
  difficulty: Difficulty;
  /** Auto-lock guns onto the nearest enemy; the gun turret tracks, not the body. */
  autoAim: boolean;
}

export enum EnemyType {
  BASIC,
  SHOOTER,
  TANK,
  DRONE,
  BOSS,
}

export enum EnemyModifier {
  NONE = 0,
  SHIELDED = 1, // Absorbs first N hits with an energy shield
  REGENERATING = 2, // Slowly heals when not recently damaged
  ELITE = 4, // Miniboss-tier: bigger, tougher, worth more
}

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
}

export enum PowerUpState {
  IDLE,
  COLLECTING,
  COLLECTED,
}
