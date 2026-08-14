// Barrel entry — the game engine was split into src/game/* modules.
export { GameEngine } from "./game/engine";
export { CityEnvironment } from "./game/city";
export { Entity, Enemy, Helicopter, Objective, PowerUp, Projectile, ProjectilePool } from "./game/entities";
export { GPUParticleSystem, RainSystem, VolumetricExplosions, WeatherSystem } from "./game/particles";
export {
  AttackPattern,
  EnemyModifier,
  EnemyType,
  EnemyVariant,
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
  MinimapDelivery,
  MinimapEnemy,
  MinimapObjective,
  MinimapSnapshot,
  MinimapThreat,
  QualityPreset,
  RooftopSpot,
  StickInput,
  WeaponConfig,
  WorldChunk,
} from "./game/types";
export { pickUpgrades, riskMultiplier, multikillTier, weaponLevelForXp, weaponLevelBonus, weaponXpForLevel } from "./game/logic";
export type { MultikillInfo, UpgradeId, UpgradeOption, WeaponLevelBonus } from "./game/logic";
export {
  CargoState,
  CargoType,
  DeliveryState,
  HANGAR_UPGRADE_INFO,
  buyHangarUpgrade,
  readDeliveryCredits,
  readHangarUpgrades,
} from "./game/delivery";
export {
  CountermeasureState,
  countermeasureConfig,
  settleExtraction,
  THREAT_NAMES,
  THREAT_REWARD_MULTIPLIERS,
  THREAT_THRESHOLDS,
  threatBonusFor,
  threatLevelForPoints,
  threatRewardMultiplier,
} from "./game/mechanics";
export type { CountermeasureConfig, ThreatLevel } from "./game/mechanics";
export {
  SamState,
  SamStateMachine,
  SAM_DETECTION_RANGE,
  SAM_FIRE_RANGE,
  SAM_MIN_FIRE_RANGE,
} from "./game/sam";
export type {
  ContractDifficulty,
  DeliveryContract,
  DeliveryHudSnapshot,
  DepotHub,
  HangarUpgradeId,
  HangarUpgrades,
} from "./game/delivery";
