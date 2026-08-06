// Barrel entry — the game engine was split into src/game/* modules.
export { GameEngine } from "./game/engine";
export { CityEnvironment } from "./game/city";
export { Entity, Enemy, Helicopter, Objective, PowerUp, Projectile, ProjectilePool } from "./game/entities";
export { GPUParticleSystem, RainSystem, VolumetricExplosions, WeatherSystem } from "./game/particles";
export {
  AttackPattern,
  EnemyModifier,
  EnemyType,
  HelicopterModel,
  FOG_CLEAR_COLOR,
  FOG_STORM_COLOR,
  MAX_RENDER_PIXEL_RATIO,
  ObjectiveType,
  PowerUpState,
  PowerUpType,
  SKY_CLEAR_COLOR,
  SKY_STORM_COLOR,
  TARGET_RENDER_FPS,
  WEAPON_CONFIGS,
  WeaponType,
} from "./game/types";
export type {
  CityBlock,
  EnemyLock,
  GameSettings,
  QualityPreset,
  RooftopSpot,
  StickInput,
  WeaponConfig,
  WorldChunk,
} from "./game/types";
export { pickUpgrades, riskMultiplier, multikillTier, weaponLevelForXp, weaponLevelBonus, weaponXpForLevel } from "./game/logic";
export type { MultikillInfo, UpgradeId, UpgradeOption, WeaponLevelBonus } from "./game/logic";
