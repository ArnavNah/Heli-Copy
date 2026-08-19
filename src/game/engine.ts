import * as THREE from "three";
import * as CANNON from "cannon-es";
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** PS1-style post pass: quantizes the final image to a coarse palette with a
 *  4x4 ordered (Bayer-ish) dither, recreating the console's limited color
 *  depth and characteristic dithered gradients. Runs after OutputPass. */
const RetroDitherShader = {
  name: 'RetroDitherShader',
  uniforms: {
    tDiffuse: { value: null },
    uLevels: { value: 24 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uLevels;
    varying vec2 vUv;

    // 16-value ordered dither pattern built from two nested 2x2 patterns.
    float orderedDither(vec2 p) {
      p = floor(mod(p, 4.0));
      float base = mod(p.x, 2.0) + 2.0 * mod(p.y, 2.0);        // 0..3
      float quad = floor(p.x / 2.0) + 2.0 * floor(p.y / 2.0);  // 0..3
      return fract(base / 4.0 + quad / 16.0);
    }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float n = orderedDither(gl_FragCoord.xy) - 0.5;
      vec3 col = floor(c.rgb * uLevels + n + 0.5) / uLevels;
      gl_FragColor = vec4(col, c.a);
    }`,
};
import { AudioManager } from "../audio";
import { createBlobShadow, createGlowMaterial, createSkyDome, disposeObject3D } from "./materials";
import { Enemy, Helicopter, MOVEMENT_CONFIG, Objective, PowerUp, Projectile, ProjectilePool } from "./entities";
import { CityEnvironment } from "./city";
import {
  DeliveryState,
  DeliverySystem,
  cargoMovementMultiplier,
  readHangarUpgrades,
} from "./delivery";
import type { HangarUpgrades } from "./delivery";
import { MissionManager, MissionType, convoyPositionAt, type Mission, type MissionRuntimeSnapshot } from "./mission";
import { canUseDepotService, collectSalvage, rollLoot } from "./loot";
import {
  SAM_DETECTION_RANGE,
  SAM_MIN_SPACING,
  SAM_MISSILE_TURN_RATE,
  SamState,
} from "./sam";
import { GPUParticleSystem, RainSystem, ShockwaveRings, VolumetricExplosions, WeatherSystem } from "./particles";
import { DebrisSystem } from "./debris";
import {
  AttackPattern,
  EnemyModifier,
  copyPhysicsPos,
  EnemyType,
  EnemyVariant,
  FOG_CLEAR_COLOR,
  FOG_NEAR,
  FOG_FAR,
  GameSettings,
  HelicopterModel,
  MAX_RENDER_PIXEL_RATIO,
  ObjectiveType,
  SKY_CLEAR_COLOR,
  StickInput,
  WEAPON_CONFIGS,
  WeaponConfig,
  WeaponType,
  PowerUpType,
  type MinimapSnapshot,
} from "./types";
import {
  accuracyFor,
  BOSS_TELEGRAPH_DURATION,
  bossPhaseForRatio,
  bossVolleyConfig,
  comboMultiplier,
  DIFFICULTIES,
  ENEMY_VARIANTS,
  MAX_RUN_LEVEL,
  MAX_WEAPON_LEVEL,
  objectiveConfig,
  pickEnemyVariant,
  pickSquadForWave,
  pickUpgrades,
  riskMultiplier,
  variantAtCap,
  waveEnemyCount,
  waveEnemyDamage,
  waveEnemyFireRate,
  waveEnemyPower,
  waveDuration,
  weaponLevelBonus,
  weaponLevelForXp,
  multikillTier,
  runLevelForXp,
  runXpForLevel,
  xpForEnemyType,
  writeMastery,
  compositionFitsBudget,
  SPAWN_CONFIG,
  waveThreatBudget,
  affixChancesForWave,
  canOfferExtraction,
  createQualityGovernor,
  defaultPerks,
  EXPLOSIVE_AFFIX_DAMAGE,
  EXPLOSIVE_AFFIX_RADIUS,
  EXTRACTION_HOLD_SECONDS,
  governorBloomAllowed,
  governorParticleScale,
  governorPixelScale,
  nightOpForWave,
  perkEffect,
  readPerks,
  readWeaponMods,
  recordRun,
  SPLITTER_DRONE_COUNT,
  statusProcChance,
  SUPER_COOLDOWN,
  SUPER_DURATION,
  SUPER_MAX_CHARGE,
  superChargeForKill,
  updateQualityGovernor,
  VAMPIRIC_HEAL_FRACTION,
} from "./logic";
import type { Difficulty as DifficultySetting, PerkRanks, QualityGovernorState, UpgradeId, UpgradeOption } from "./logic";
import { armorMitigation, resolvePlayerDamage, resolveRepair, type PlayerDamageType } from "./combat";
import {
  CountermeasureState,
  countermeasureConfig,
  settleExtraction,
  salvageCreditsFor,
  salvageForObjective,
  securedEnemyBounty,
  securedObjectiveReward,
  THREAT_NAMES,
  threatDirectorConfig,
  threatBonusFor,
  threatLevelForPoints,
  threatRewardMultiplier,
  type ThreatLevel,
} from "./mechanics";

type DashState = "READY" | "DASHING" | "COOLDOWN";

export class GameEngine {
  private static readonly MAX_SIMULATION_DT = 0.05;

  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cameraLookAtTarget: THREE.Vector3 = new THREE.Vector3();
  skyDome: THREE.Mesh;
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
    retroPass: ShaderPass;
  world: CANNON.World;
  city: CityEnvironment;
  delivery: DeliverySystem;
  missionManager = new MissionManager();
  hangarUpgrades: HangarUpgrades = readHangarUpgrades();

  helicopter: Helicopter;
  enemies: Enemy[] = [];

  playerProjectiles: ProjectilePool;
  enemyProjectiles: ProjectilePool;

  particles: GPUParticleSystem;
  volumetricExplosions: VolumetricExplosions;
  rain: RainSystem;
  weather: WeatherSystem;
  audio: AudioManager;
  lastTime: number = 0;

  settings: GameSettings = {
    invertedY: false,
    gamepadSensitivity: 1.5,
    quality: 'low',
    graphics: 'sp1',
    volume: 0.8,
    touchMode: false,
    difficulty: 'normal',
    autoAim: false,
  };

  get difficulty() {
    return DIFFICULTIES[this.settings.difficulty];
  }

  gamepadIndex: number | null = null;
  isMouseActive: boolean = true;
  playerModel: HelicopterModel = HelicopterModel.APACHE;
  movementKeys: Set<string> = new Set();
  leftStick: StickInput = { x: 0, y: 0, active: false };
  rightStick: StickInput = { x: 0, y: 0, active: false };
  movementTarget: THREE.Vector3 = new THREE.Vector3(0, 26, 0);
  keyboardVelocity: THREE.Vector2 = new THREE.Vector2(0, 0);
  hasInputThisFrame: boolean = false;

  // Phase 2: vertical input -1..1 (Space/Alt) with lerp smoothing; gamepad stick
  // movement (non-touch) fed into updateKeyboardMovement for consistant normalization.
  verticalInput: number = 0;
  gamepadMove: { x: number; z: number } = { x: 0, z: 0 };
  aimPoint: THREE.Vector3 = new THREE.Vector3(0, 26, -35);
  mouseAimPoint: THREE.Vector3 = new THREE.Vector3(0, 26, -55);
  mouseAimValid: boolean = false;
  autoAimTarget: Enemy | Objective | null = null;
  lastCollisionDamageTime = 0;
  // Trailing smoke column after a hard building crash
  crashSmokeTimer: number = 0;
  crashSmokePos: { x: number; y: number; z: number } | null = null;

  raycaster: THREE.Raycaster = new THREE.Raycaster();
  mousePlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -26);
  mouseNDC: THREE.Vector2 = new THREE.Vector2(0, 0);
  private worldUp = new THREE.Vector3(0, 1, 0);
  private mouseAimScratch = new THREE.Vector3();
  private muzzlePositionScratch = new THREE.Vector3();
  private muzzleDirectionScratch = new THREE.Vector3();

  targetGroup: THREE.Group;
  innerRing: THREE.Mesh;
  outerRing: THREE.Mesh;

  private animationFrameId: number | null = null;
  private frameCount = 0;
  private running = false;
  lightningTimeout: number | null = null;
  disposed = false;
  isPlaying = false;
  gameOverDispatched = false;

  // Perf overlay support (Pass 10 cleanup): a cheap rolling FPS counter and a
  // public getPerfStats() so the HUD can show renderer.info without polling GL.
  fpsFrames = 0;
  fpsAccum = 0;
  fps = 60;

  // A1/A2: rigid-body destruction debris + pooled dust shockwave rings.
  private debris: DebrisSystem | null = null;
  private shockwaves: ShockwaveRings | null = null;

  // Fake blob shadows (shadowMap stays disabled for perf): one decal under
  // the player, one pooled per active enemy, faded out with altitude.
  private playerShadow: THREE.Mesh;
  private enemyShadows = new Map<Enemy, THREE.Mesh>();

  // A4: adaptive quality governor — degrades pixel ratio/bloom/particles in
  // 1.5s FPS windows, never above the user's chosen quality preset.
  private governor: QualityGovernorState = createQualityGovernor();
  private governorWindowFrames = 0;
  private governorWindowTime = 0;

  // C3: Night ops — wave-scoped palette swap. The blend eases between the
  // desert-day baseline and a deep-navy night rig over a couple of seconds.
  private ambientLight!: THREE.HemisphereLight;
  private keyLight!: THREE.DirectionalLight;
  private nightOpsActive = false;
  private nightBlend = 0;
  private nightBlendTarget = 0;
  private nightSeed = Math.floor(Math.random() * 0x7fffffff);
  private nightBeams: THREE.Group | null = null;
  private readonly dayFogColor = new THREE.Color(FOG_CLEAR_COLOR);
  private readonly nightFogColor = new THREE.Color(0x0b1226);
  private readonly daySkyColor = new THREE.Color(SKY_CLEAR_COLOR);
  private readonly nightSkyColor = new THREE.Color(0x070d1c);
  private readonly dayHemiSky = new THREE.Color(0xf6ecd8);
  private readonly nightHemiSky = new THREE.Color(0x22314f);
  private readonly dayHemiGround = new THREE.Color(0x8a7a58);
  private readonly nightHemiGround = new THREE.Color(0x0d1220);
  private readonly dayKeyColor = new THREE.Color(0xffe3b0);
  private readonly nightKeyColor = new THREE.Color(0x7f9fd8);

  // B3: Devastation super meter — kills/combos charge it; F unleashes a 5s overcharge.
  superCharge = 0;
  private superActiveUntil = 0;
  private superCooldownUntil = 0;

  // C5/C6: persistent pilot perks + per-weapon mod choices (loaded from storage).
  private perks: PerkRanks = defaultPerks();
  private weaponMods: number[] = [0, 0, 0, 0];

  // C1: extraction gating — objectives destroyed this run + once-per-run offer.
  objectivesDestroyedThisRun = 0;
  private extractionOfferedThisRun = false;

  // Phase 1: reused wind vector — was allocated every frame in tick().
  private windCannon = new CANNON.Vec3();

  // Phase 1: dev-only memory monitor (Step 9). Opt-in via
  // localStorage 'helistrike:memmon' = '1'; compile-time stripped in prod
  // builds. Logs a resource snapshot every 2s.
  private memMon = import.meta.env.DEV
    && typeof localStorage !== "undefined"
    && localStorage.getItem("helistrike:memmon") === "1";
  private memMonTimer = 0;
  isFiringMouse = false;
  isFiringGamepad = false;
  score = 0;
  totalKills = 0;
  shotsFired = 0;
  shotsHit = 0;
  health = 100;
  maxHealth = 100;
  currentFuel = 100;
  maxFuel = 100;
  fuelDrainPerSecond = 0.85;

  // Stable camera state. No random or impulse offset is ever composed onto it.
  private baseCamPos = new THREE.Vector3(0, 62, 46);
  lastStatsHealth = -1;
  lastStatsFuel = -1;
  lastUiUpdateTime = -Infinity;
  survivalTime = 0;
  combatIntensity = 0;
  directorTimer = 0;
  battlefieldEventTimer = 18;
  lastSpawnSoundTime = 0;
  lastBuildingHitSoundTime = 0;
  /** Cooldown for volatile-prop explosion audio — prevents clipping during chain reactions. */
  private lastPropExplosionSoundTime = 0;
  lastEnemyFireSoundTime = 0;

  // Wave System
  currentWave: number = 0;
  enemiesSpawnedInWave: number = 0;
  totalEnemiesInWave: number = 0;
  spawnTimer: number = 0;
  waveTransitionTimer: number = 3.0; // Wait 3s before starting wave 1
  waveTimer: number = 0; // Seconds elapsed in the current time-driven wave
  waveMessage: string = "GET READY";
  minibossSpawnedThisWave: boolean = false;

  // Phase 3: bounded spawn queue — horde bursts drain ONE enemy per cadence
  // tick (frame budget = 1) so large groups stream in instead of constructing
  // several full procedural models in a single frame.
  private pendingSpawns = 0;
  private waveThreatBudgetRemaining = 0;
  private processedEnemyDeaths = new WeakSet<Enemy>();
  /** Variant requests queued for the current burst — squads push several,
   *  drained one per cadence tick (bounded, cleared on restart). */
  private pendingVariantQueue: EnemyVariant[] = [];
  /** Phase 3: lightweight event/escort spawn descriptors (no Enemy is
   *  constructed until drained) so convoy ambushes, air raids and boss escorts
   *  stagger across frames instead of spiking one frame. */
  private pendingEventSpawns: Array<{
    type: EnemyType;
    x: number;
    z: number;
    y: number;
    modifier?: EnemyModifier;
    pattern?: AttackPattern;
    variant?: EnemyVariant;
  }> = [];

  // Destroyable combat objectives. Cargo depots live in DeliverySystem instead.
  objectives: Objective[] = [];
  samSuppressionTimer: number = 0; // enemy fire-rate debuff while > 0
  samActive: boolean = false; // any SAM site alive boosts enemy fire rate
  radarActive: boolean = false; // modest enemy acquisition + nearby SAM uplink

  // Weapon XP & levels
  weaponXp: Map<WeaponType, number> = new Map();
  weaponLevels: Map<WeaponType, number> = new Map();
  lastFiredWeapon: WeaponType = WeaponType.MACHINE_GUN;
  lastFireTimestamp: number = 0;

  // Permanent run upgrades (from the roulette)
  runUpgrades: Record<UpgradeId, number> = {
    damage: 0,
    fireRate: 0,
    ammo: 0,
    reload: 0,
    salvoCooldown: 0,
    maxHealth: 0,
    fuelEfficiency: 0,
    shield: 0,
    speed: 0,
    armor: 0,
    repair: 0,
    xpMagnet: 0,
    dashCooldown: 0,
    bomb: 0,
    incendiary: 0,
    empPayload: 0,
    shockCoils: 0,
  };
  pendingUpgradeOffer: UpgradeOption[] = [];
  upgradePaused: boolean = false;

  // Kill streaks & announcements
  killStreakCount: number = 0;
  lastKillTime: number = 0;
  announceQueue: { text: string; sub: string; color: string }[] = [];

  // Afterburner (risk/reward)
  afterburnerActive: boolean = false;
  afterburnerDrainPerSecond: number = 3.2;
  private afterburnerEffectTimer = 0;

  // Run-scoped tactical systems. These never round-trip through React per frame.
  countermeasures = new CountermeasureState(countermeasureConfig(0));
  private decoyTarget: { body: CANNON.Body; active: boolean } | null = null;
  private flareEffectTimer = 0;
  private lastMissileWarningTime = -Infinity;
  threatPoints = 0;
  threatLevel: ThreatLevel = 1;
  unsecuredCredits = 0;
  runSalvage = 0;
  deliveriesCompleted = 0;
  samSitesDestroyed = 0;
  radarSitesDestroyed = 0;
  bossesDestroyed = 0;
  missionsCompleted = 0;
  missionBonusesCompleted = 0;
  private extractionMarker: THREE.Group | null = null;
  private extractionPosition: THREE.Vector3 | null = null;
  private extractionProgress = 0;
  private extractionOfferLevel = 1;
  private extractionOfferTime = 0;
  private extractionPressure = false;
  /** Brief green radar-sweep rings that ping outward when the LZ offer
   *  appears, so the pad draws the eye from far away. Owned by the marker
   *  group (disposed by clearExtraction); this array just drops the refs. */
  private extractionPulseRings: THREE.Mesh[] = [];
  private extractionPulseTimer = 0;
  private depotServiceCooldown = 0;
  private static readonly EXTRACTION_PULSE_DURATION = 2.0;
  private static readonly EXTRACTION_PULSE_RADIUS = 130;
  /** Horizontal radius of the extraction zone (must match the inside check). */
  private static readonly EXTRACTION_ZONE_RADIUS = 26;

  // Power-up System
  powerups: PowerUp[] = [];
  powerupSpawnTimer: number = 0;

  spawnPeriodicPowerUp() {
    let type: PowerUpType;
    const rand = Math.random();
    
    const weapon = this.weapons.get(this.currentWeapon);
    const lowHealth = this.health < 40;
    const lowFuel = this.currentFuel < 35;
    const lowAmmo = weapon && (weapon.ammo / weapon.maxAmmo) < 0.25;
    
    if (lowHealth && Math.random() < 0.55) {
      type = PowerUpType.HEALTH;
    } else if (lowFuel && Math.random() < 0.55) {
      type = PowerUpType.FUEL;
    } else if (lowAmmo && Math.random() < 0.55) {
      type = PowerUpType.AMMO;
    } else {
      if (rand < 0.22) type = PowerUpType.HEALTH;
      else if (rand < 0.38) type = PowerUpType.FUEL;
      else if (rand < 0.52) type = PowerUpType.AMMO;
      else if (rand < 0.68) type = PowerUpType.DAMAGE_BOOST;
      else if (rand < 0.82) type = PowerUpType.SHIELD;
      else if (rand < 0.92) type = PowerUpType.SPEED_BOOST;
      else type = PowerUpType.BOMB;
    }
    
    const player = this.helicopter.body.position;
    const lanes = [-52, -24, 0, 24, 52];
    const laneX = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 8;
    const spawnZ = player.z - 75 - Math.random() * 45;
    const spawnY = Math.max(3.0, this.city.getHeightAt(laneX, spawnZ, 3) + 2.0);
    
    const pu = new PowerUp(this.scene, laneX, spawnY, spawnZ, type);
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  }

  // Combo System
  comboCount: number = 0;
  comboTimer: number = 0;
  comboMultiplier: number = 1;
  maxCombo: number = 0;

  // Run-level XP (Vampire-Survivors style): collect XP gems dropped by enemies
  // to fill a run level bar; each level-up opens the 1-of-3 upgrade roulette.
  runLevel: number = 1;
  runXp: number = 0;
  /** Level-ups queued when one gem crosses several thresholds (boss gems). */
  pendingLevelUps: number = 0;

  // Damage Boost & Shield
  damageBoostTimer: number = 0;
  shieldTimer: number = 0;
  speedBoostTimer: number = 0;

  // Time dilation & Hit-Stop
  timeScale: number = 1.0;
  hitStopTimer: number = 0;

  triggerHitStop(duration: number, scale: number = 0.05) {
    this.hitStopTimer = duration;
    this.timeScale = scale;
  }

  // Dash variables
  dashState: DashState = "READY";
  dashCooldownTimer: number = 0;
  dashActiveTimer: number = 0;
  dashDirection: CANNON.Vec3 = new CANNON.Vec3();
  lastTapTime: { [key: string]: number } = {};

  // Hit marker for visual feedback
  hitMarkerTimer: number = 0;
  hitMarkerPosition: THREE.Vector3 = new THREE.Vector3();

  // Weapon System
  currentWeapon: WeaponType = WeaponType.MACHINE_GUN;
  weapons: Map<WeaponType, WeaponConfig> = new Map();
  lastFireTime: number = 0;
  muzzleFlip: number = 1;
  reloadTimer: number = 0;
  isReloading: boolean = false;
  isPaintingLocks: boolean = false;
  salvoLocks: Enemy[] = [];
  salvoCooldownTimer: number = 0;
  lastLockPaintTime: number = 0;
  salvoCooldown: number = 5.0;
  lockPaintInterval: number = 0.18;
  lockSearchRadius: number = 38;
  salvoLockIndicators: Map<Enemy, THREE.Group> = new Map();

  getEffectiveSalvoCooldown() {
    return Math.max(1.5, this.salvoCooldown * (1 - this.runUpgrades.salvoCooldown * 0.35));
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO));
    this.renderer.setClearColor(SKY_CLEAR_COLOR);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Low-poly pass: ACES filmic tone mapping was crushing the muted city
    // palette into a dark night haze. Stylized low-poly art wants flat colors
    // to stay flat and bright, so tone mapping is off (NoToneMapping).
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_CLEAR_COLOR);
    this.scene.fog = new THREE.Fog(FOG_CLEAR_COLOR, FOG_NEAR, FOG_FAR);
    this.skyDome = createSkyDome();
    this.scene.add(this.skyDome);

    // far must exceed FOG_FAR (440) and the sky dome radius (340), otherwise
    // the horizon band is clipped to the clear color instead of the haze.
    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      500,
    );
    this.camera.position.set(0, 62, 46);
    this.camera.lookAt(0, 0, 0);

    // EffectComposer Setup
    this.composer = new EffectComposer(this.renderer);
    
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    // Toned-down bloom: subtler glow so the scene doesn't wash out.
    this.bloomPass.threshold = 0.88;
    this.bloomPass.strength = 0.32;
    this.bloomPass.radius = 0.35;
    this.bloomPass.enabled = this.settings.graphics === 'hd';
    this.composer.addPass(this.bloomPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    // PS1-style finish: quantize colors to a coarse palette with ordered
    // (Bayer) dithering, mimicking the console's limited color depth.
    this.retroPass = new ShaderPass(RetroDitherShader);
    this.composer.addPass(this.retroPass);

    this.world = new CANNON.World();
    // Player altitude is controlled explicitly; zero world gravity keeps hover
    // deterministic across Cannon's variable number of fixed substeps.
    this.world.gravity.set(0, 0, 0);
    // NaiveBroadphase recomputes AABB pairs every step, so it never misses
    // contacts between the heli and static bodies added mid-run (chunks) or
    // teleported (debris pool). SAPBroadphase's sorted-axis cache goes stale
    // in exactly those cases and the heli phased through buildings.
    this.world.broadphase = new CANNON.NaiveBroadphase();
    this.world.defaultContactMaterial.friction = 0;
    this.world.defaultContactMaterial.restitution = 0;

    // Desert sun: strong warm key + sandy ambient so the toon gradient bands
    // pop on every facade (lit face / midtone / shadow face).
    const ambient = new THREE.HemisphereLight(0xf6ecd8, 0x8a7a58, 1.25);
    this.ambientLight = ambient;
    this.scene.add(ambient);

    const softKey = new THREE.DirectionalLight(0xffe3b0, 1.7);
    this.keyLight = softKey;
    softKey.position.set(-48, 86, 54);
    softKey.castShadow = true;
    softKey.shadow.camera.left = -180;
    softKey.shadow.camera.right = 180;
    softKey.shadow.camera.top = 180;
    softKey.shadow.camera.bottom = -180;
    softKey.shadow.camera.near = 0.5;
    softKey.shadow.camera.far = 340;
    softKey.shadow.mapSize.width = 2048;
    softKey.shadow.mapSize.height = 2048;
    softKey.shadow.bias = -0.00018;
    this.scene.add(softKey);

    const rimLight = new THREE.DirectionalLight(0x9fc4e8, 0.4);
    rimLight.position.set(65, 50, -85);
    this.scene.add(rimLight);

    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(8, 10, 6),
      createGlowMaterial(0xffdd7a, 0.58),
    );
    sunCore.position.set(-116, 118, -178);
    sunCore.renderOrder = -2;
    this.scene.add(sunCore);

    this.city = new CityEnvironment(this.scene, this.world);
    this.city.onHonk = () => {
      if (this.audio) this.audio.playHonk();
    };
    this.city.onBuildingDestroyed = (x, y, z) => {
      const now = performance.now() / 1000;
      // Building collapse — dust cloud + debris chunks + fireball at the base
      // (the collapsed block sits at ground level, so the burst hugs the ground).
      if (this.volumetricExplosions) {
        this.volumetricExplosions.spawn(x, y, z, 28, 8.0);
      }
      if (this.particles) {
        this.particles.spawnExplosion(x, y, z, 70, now, 26);
        this.particles.spawnDebris(x, y, z, now, 30, 36);
        this.particles.spawnSmoke(x, y + 1, z, now);
        this.particles.spawnSmoke(x + 2, y + 3, z - 1, now);
        this.particles.spawnSmoke(x - 2, y + 5, z + 1, now);
        this.particles.spawnSparks(x, y, z, now, 12, 30);
      }
      if (this.audio) {
        this.audio.playBigExplosion(1.2);
      }
      // Major building collapse — allowed heavy impulse.
      this.addCameraImpulse(3.5);
      this.addExplosionImpulse(x, y, z, 3.5, 110);
      this.score += Math.floor(50 * this.comboMultiplier);
      this.triggerHitStop(0.12, 0.04); // Crunchy freeze on building collapse
    };

    this.playerModel = this.readPlayerModel();
    this.helicopter = new Helicopter(this.scene, this.world, this.playerModel);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);

    this.playerProjectiles = new ProjectilePool(this.scene, 150, 0xff2a2a);
    this.enemyProjectiles = new ProjectilePool(this.scene, 100, 0xffe94a);

    this.particles = new GPUParticleSystem(5000);
    this.scene.add(this.particles.mesh);
    this.city.particles = this.particles;
    
    this.volumetricExplosions = new VolumetricExplosions(this.scene);

    // A1/A2: physical debris chunks (single InstancedMesh) + shockwave rings.
    // Debris bodies are collision-filtered away from gameplay (groups 4/8).
    this.debris = new DebrisSystem(this.scene);
    this.debris.attachWorld(this.world);
    this.shockwaves = new ShockwaveRings(this.scene);
    this.city.debris = this.debris;
    this.city.shockwaves = this.shockwaves;
    // C4: volatile street props detonate through the engine for fx + damage.
    this.city.onPropExplosion = (x, z) => this.explodeVolatileProp(x, z);

    // C5/C6: load persistent pilot perks and weapon mod choices.
    this.perks = readPerks();
    this.weaponMods = readWeaponMods();

    this.rain = new RainSystem(5000);
    this.scene.add(this.rain.mesh);
    this.rain.mesh.visible = false;

    this.weather = new WeatherSystem();
    this.audio = new AudioManager();
    this.applySettings();

    this.delivery = new DeliverySystem(
      this.scene,
      this.city.chunkDepth,
      (chunkId) => this.city.getDepotHub(chunkId),
      {
        announce: (text, sub, color) => this.announce(text, sub, color),
        creditsChanged: () => this.updateUI(performance.now() / 1000),
        settleRewards: (contract, earnedTimeBonus) => {
          const extras = (earnedTimeBonus ? contract.bonusReward : 0) + contract.samRiskBonus;
          return {
            secured: contract.rewardCredits,
            unsecured: extras + threatBonusFor(contract.rewardCredits, this.threatLevel),
          };
        },
        completed: (contract, _secured, unsecured) => {
          this.unsecuredCredits += unsecured;
          this.deliveriesCompleted++;
          this.addThreat(contract.difficulty === "HIGH_VALUE" ? 14 : contract.difficulty === "RISKY" ? 9 : 6);
          if (contract.cargoType === "AMMUNITION") this.countermeasures.replenish(1);
          this.missionManager.reportDeliveryComplete(
            contract.id,
            performance.now() / 1000,
            this.getMissionRuntimeSnapshot(),
          );
        },
      },
    );
    this.delivery.setCarrierRoot(this.helicopter.mesh);

    // Dynamic Crosshair Reticle
    this.targetGroup = new THREE.Group();
    this.targetGroup.position.set(this.aimPoint.x, 26.2, this.aimPoint.z);
    this.targetGroup.visible = false;

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.58,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.innerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.3, 16),
      ringMat,
    );
    this.innerRing.rotation.x = -Math.PI / 2;
    this.outerRing = new THREE.Mesh(
      new THREE.RingGeometry(1.8, 2.0, 32),
      ringMat,
    );
    this.outerRing.rotation.x = -Math.PI / 2;

    const pipMat = createGlowMaterial(0xffffff, 0.58);
    for (let i = 0; i < 4; i++) {
      const pip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 1.5), pipMat);
      pip.position.z = 2.9;
      const pivot = new THREE.Group();
      pivot.rotation.y = (Math.PI / 2) * i;
      pivot.add(pip);
      this.targetGroup.add(pivot);
    }

    this.targetGroup.add(this.innerRing, this.outerRing);
    this.scene.add(this.targetGroup);
    this.renderer.domElement.style.cursor = "crosshair";

    // Fake blob shadow under the player so the hull reads grounded in the
    // desert light (real shadowMap stays disabled for perf).
    this.playerShadow = createBlobShadow(7);
    this.scene.add(this.playerShadow);

    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("helistrike:left-stick", this.onLeftStick);
    window.addEventListener("helistrike:right-stick", this.onRightStick);
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.addEventListener("helistrike:settings", this.onSettingsChanged);
    window.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("helistrike:fire", this.onFireChange);
    window.addEventListener("helistrike:upgrade-choice", this.onUpgradeChosen);
    window.addEventListener("helistrike:player-model", this.onPlayerModelChanged);
    window.addEventListener("helistrike:env-debug", this.onEnvDebug);
    window.addEventListener("helistrike:countermeasure", this.onCountermeasureEvent);
    window.addEventListener("helistrike:super", this.onSuperEvent);

    this.lastTime = performance.now() / 1000;

    // Initialize weapon system
    this.resetWeaponsFromHangar();

    this.cameraLookAtTarget.set(0, 28, -9);
    this.updateUI(this.lastTime); // Init UI
    this.start();
  }

  private resetWeaponsFromHangar(damageBoost = false) {
    const weaponRank = this.hangarUpgrades.weaponSystem ?? 0;
    const ammoMult = 1 + weaponRank * 0.045;
    const reloadMult = Math.max(0.86, 1 - weaponRank * 0.028);
    for (const wt of Object.values(WeaponType).filter((v) => typeof v === "number") as WeaponType[]) {
      const base = WEAPON_CONFIGS[wt];
      const config = {
        ...base,
        damage: base.damage * (damageBoost ? 2 : 1),
        maxAmmo: Math.round(base.maxAmmo * ammoMult),
        ammo: Math.round(base.maxAmmo * ammoMult),
        reloadTime: base.reloadTime * reloadMult,
      };
      this.weapons.set(wt, config);
    }
  }

  /** Start the one authoritative RAF loop. Safe under React StrictMode/remounts. */
  start() {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.animationFrameId = requestAnimationFrame(this.tick);
  }

  startGame() {
    this.resetGame();
    this.isPlaying = true;
    try {
      this.audio.resume();
      this.audio.startMusic();
    } catch {
      // Some browsers delay audio startup until the first canvas press.
    }
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    this.emitStatsIfChanged(true);
  }

  setPaused(paused: boolean) {
    this.isPlaying = !paused;
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.movementKeys.clear();
    this.keyboardVelocity.set(0, 0);
    this.verticalInput = 0;
    this.afterburnerActive = false;
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    if (paused) {
      this.audio.stopMusic();
    } else {
      this.audio.startMusic();
    }
  }

  resetGame() {
    this.clearExtraction();
    if (this.decoyTarget) this.decoyTarget.active = false;
    this.delivery.reset();
    this.missionManager.reset();
    this.city.reset(this.world);
    for (const enemy of this.enemies) {
      enemy.destroy();
    }
    this.enemies = [];
    for (const shadow of this.enemyShadows.values()) {
      this.scene.remove(shadow);
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
    }
    this.enemyShadows.clear();
    if (this.playerShadow) this.scene.remove(this.playerShadow);
    for (const pu of this.powerups) {
      pu.destroy(this.scene);
    }
    this.powerups = [];
    for (const obj of this.objectives) {
      obj.destroy();
    }
    this.objectives = [];
    this.playerProjectiles.deactivateAll();
    this.enemyProjectiles.deactivateAll();

    this.helicopter.reset();
    this.movementTarget.set(0, 26, 0);
    this.keyboardVelocity.set(0, 0);
    this.hasInputThisFrame = false;
    this.aimPoint.set(0, 26, -35);
    this.mouseAimPoint.set(0, 26, -55);
    this.mouseAimValid = false;
    this.targetGroup.position.set(this.aimPoint.x, 26.2, this.aimPoint.z);
    this.targetGroup.visible = false;
    this.autoAimTarget = null;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.baseCamPos.set(0, 62, 46);
    this.camera.position.copy(this.baseCamPos);
    this.cameraLookAtTarget.set(0, 28, -9);
    this.hangarUpgrades = readHangarUpgrades();
    this.resetWeaponsFromHangar();
    this.countermeasures = new CountermeasureState(
      countermeasureConfig(this.hangarUpgrades.countermeasures),
    );
    this.decoyTarget = null;
    this.flareEffectTimer = 0;
    this.lastMissileWarningTime = -Infinity;
    this.threatPoints = 0;
    this.threatLevel = 1;
    this.unsecuredCredits = 0;
    this.runSalvage = 0;
    this.depotServiceCooldown = 0;
    this.deliveriesCompleted = 0;
    this.samSitesDestroyed = 0;
    this.radarSitesDestroyed = 0;
    this.bossesDestroyed = 0;
    this.missionsCompleted = 0;
    this.missionBonusesCompleted = 0;
    this.extractionProgress = 0;
    this.extractionOfferLevel = 1;
    this.extractionOfferTime = 0;
    this.extractionPressure = false;
    this.maxHealth = 100 + this.hangarUpgrades.armor * 10;
    this.maxFuel = 100 + this.hangarUpgrades.fuel * 4;
    this.score = 0;
    this.totalKills = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.health = this.maxHealth;
    this.currentFuel = this.maxFuel;
    this.lastStatsHealth = -1;
    this.lastStatsFuel = -1;
    this.survivalTime = 0;
    this.combatIntensity = 0;
    this.directorTimer = 0.6;
    this.battlefieldEventTimer = 16;
    this.lastSpawnSoundTime = 0;
    this.lastBuildingHitSoundTime = 0;
    this.lastPropExplosionSoundTime = 0;
    this.crashSmokeTimer = 0;
    this.crashSmokePos = null;
    this.lastEnemyFireSoundTime = 0;
    this.currentWave = 0;
    this.enemiesSpawnedInWave = 0;
    this.totalEnemiesInWave = 0;
    this.spawnTimer = 0;
    this.waveTimer = 0;
    this.waveTransitionTimer = 2.2;
    this.waveMessage = "GET READY";
    // Phase 3: pending spawns must not survive a restart.
    this.pendingSpawns = 0;
    this.waveThreatBudgetRemaining = 0;
    this.processedEnemyDeaths = new WeakSet<Enemy>();
    this.pendingVariantQueue.length = 0;
    this.pendingEventSpawns.length = 0;
    this.weather.stormIntensity = 0;
    this.weather.targetIntensity = 0;
    this.rain.mesh.visible = false;
    this.gameOverDispatched = false;
    this.isPlaying = false;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboMultiplier = 1;
    this.maxCombo = 0;
    this.runLevel = 1;
    this.runXp = 0;
    this.pendingLevelUps = 0;
    this.muzzleFlip = 1;
    this.damageBoostTimer = 0;
    this.shieldTimer = 0;
    this.speedBoostTimer = 0;
    this.hitMarkerTimer = 0;
    this.powerupSpawnTimer = 0;
    this.verticalInput = 0;
    this.gamepadMove.x = 0;
    this.gamepadMove.z = 0;
    this.dashState = "READY";
    this.dashCooldownTimer = 0;
    this.dashActiveTimer = 0;
    this.dashDirection.set(0, 0, 0);
    this.lastTapTime = {};

    this.isPaintingLocks = false;
    this.salvoLocks = [];
    this.salvoCooldownTimer = 0;
    this.lastLockPaintTime = 0;
    this.clearSalvoIndicators();

    // Reset progression systems
    this.minibossSpawnedThisWave = false;
    this.samSuppressionTimer = 0;
    this.samActive = false;
    this.radarActive = false;
    this.weaponXp = new Map();
    this.weaponLevels = new Map();
    this.lastFiredWeapon = WeaponType.MACHINE_GUN;
    this.runUpgrades = {
      damage: 0,
      fireRate: 0,
      ammo: 0,
      reload: 0,
      salvoCooldown: 0,
      maxHealth: 0,
      fuelEfficiency: 0,
      shield: 0,
      speed: 0,
      armor: 0,
      repair: 0,
      xpMagnet: 0,
      dashCooldown: 0,
      bomb: 0,
      incendiary: 0,
      empPayload: 0,
      shockCoils: 0,
    };
    this.pendingUpgradeOffer = [];
    this.upgradePaused = false;
    this.killStreakCount = 0;
    this.lastKillTime = 0;
    this.announceQueue = [];
    this.afterburnerActive = false;
    this.afterburnerEffectTimer = 0;
    this.bossIntroActive = false;
    this.bossIntroStage = 0;

    // Mega-pack run state: super meter, governor, extraction gate, fresh perks/mods.
    this.superCharge = 0;
    this.superActiveUntil = 0;
    this.superCooldownUntil = 0;
    this.governor = createQualityGovernor();
    this.governorWindowFrames = 0;
    this.governorWindowTime = 0;
    this.objectivesDestroyedThisRun = 0;
    this.extractionOfferedThisRun = false;
    this.perks = readPerks();
    this.weaponMods = readWeaponMods();
    this.applyGovernorQuality();

    // C3: every run starts in daylight with a fresh night-op seed.
    this.nightOpsActive = false;
    this.nightBlend = 0;
    this.nightBlendTarget = 0;
    this.nightSeed = Math.floor(Math.random() * 0x7fffffff);
    this.applyNightPalette(0);
    if (this.nightBeams) this.nightBeams.visible = false;
    // Clear debris pool so old chunks don't persist into the new run.
    this.debris?.reset();

    this.updateUI(performance.now() / 1000);
    this.emitStatsIfChanged(true);
  }

  dispose() {
    this.destroy();
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("helistrike:left-stick", this.onLeftStick);
    window.removeEventListener("helistrike:right-stick", this.onRightStick);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.removeEventListener("helistrike:settings", this.onSettingsChanged);
    window.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("helistrike:fire", this.onFireChange);
    window.removeEventListener("helistrike:upgrade-choice", this.onUpgradeChosen);
    window.removeEventListener("helistrike:player-model", this.onPlayerModelChanged);
    window.removeEventListener("helistrike:env-debug", this.onEnvDebug);
    window.removeEventListener("helistrike:countermeasure", this.onCountermeasureEvent);
    window.removeEventListener("helistrike:super", this.onSuperEvent);
    this.clearExtraction();
    this.clearSalvoIndicators();
    this.helicopter.body.removeEventListener(
      "collide",
      this.onHelicopterCollide,
    );
    if (this.lightningTimeout !== null) {
      window.clearTimeout(this.lightningTimeout);
      this.lightningTimeout = null;
    }
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.renderer.setAnimationLoop(null);
    this.audio.dispose();
    this.city.onHonk = null;
    this.city.onBuildingDestroyed = null;
    for (const enemy of this.enemies) enemy.destroy();
    for (const objective of this.objectives) objective.destroy();
    for (const powerup of this.powerups) powerup.destroy(this.scene);
    this.delivery.dispose();
    this.helicopter.destroy();
    this.debris?.dispose();
    this.debris = null;
    this.nightBeams = null;
    disposeObject3D(this.scene);
    this.scene.clear();
    this.composer.dispose();
    this.renderer.dispose();
  }

  onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.applyComposerQuality();
  };

  getMaxPixelRatio() {
    const dpr = window.devicePixelRatio;
    // HD: crisp full-resolution render (adaptive governor sheds pixels under load).
    if (this.settings.graphics === 'hd') return Math.min(dpr, 2);
    // SP1: PS1-style — render at a fraction of display resolution; the canvas CSS
    // upscales with nearest-neighbor (image-rendering: pixelated) for the
    // chunky-pixel console look.
    return Math.min(dpr, MAX_RENDER_PIXEL_RATIO) * 0.34;
  }

  /** A4: user preset ceiling scaled by the adaptive governor's degradation level. */
  getEffectivePixelRatio() {
    return this.getMaxPixelRatio() * governorPixelScale(this.governor.level);
  }

  /** Particle counts scale down with the governor (heavy FX shed first). */
  private fxCount(count: number): number {
    return Math.max(1, Math.round(count * governorParticleScale(this.governor.level)));
  }

  /** A4: push the governor's current level into renderer settings. */
  private applyGovernorQuality() {
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.bloomPass.enabled = governorBloomAllowed(this.governor.level, this.settings.graphics === 'hd');
    this.applyComposerQuality();
  }

  /** Re-anchors the composer's pixel ratio so governor changes apply there.
   *  SP1 keeps 0 MSAA (the console had none — the low-res pixelated upscale is
   *  the aesthetic); HD enables 4x MSAA for a clean, crisp image. */
  private applyComposerQuality() {
    const samples = this.settings.graphics === 'hd' ? 4 : 0;
    if (this.composer.renderTarget1.samples !== samples) {
      this.composer.renderTarget1.samples = samples;
      this.composer.renderTarget2.samples = samples;
    }
    this.composer.setPixelRatio(this.getEffectivePixelRatio());
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Live renderer stats for the on-screen perf overlay (zero GL cost — reads three's counters). */
  getPerfStats() {
    const info = this.renderer.info;
    return {
      fps: this.fps,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      graphics: this.settings.graphics,
      enemies: this.enemies.length,
      powerups: this.powerups.length,
      objectives: this.objectives.length,
    };
  }

  /**
   * Phase 1 dev memory monitor (Step 9). Called at a 2s cadence from tick()
   * when enabled (DEV + localStorage 'helistrike:memmon'). Counts active
   * runtime objects and reads renderer.info to spot unbounded growth while
   * flying/streaming. Objects/geometries should plateau, never climb forever.
   */
  private monitorMemory(time: number) {
    const info = this.renderer.info;
    let sceneObjects = 0;
    this.scene.traverse(() => {
      sceneObjects++;
    });
    let traffic = 0;
    for (const cars of this.city.chunkTraffic.values()) traffic += cars.length;
    let playerProj = 0;
    let enemyProj = 0;
    for (const p of this.playerProjectiles.pool) if (p.active) playerProj++;
    for (const p of this.enemyProjectiles.pool) if (p.active) enemyProj++;
    let particles = 0;
    const startAttr = this.particles.startTimeAttr;
    for (let i = 0; i < this.particles.maxParticles; i++) {
      if (startAttr.getX(i) > -9000) particles++;
    }
    console.info(
      `[Heli-Strike mem] t=${time.toFixed(1)}s fps=${this.fps} ` +
        `chunks=${this.city.chunks.size} sceneObj=${sceneObjects} blocks=${this.city.blocks.length} ` +
        `enemies=${this.enemies.length} proj=${playerProj}/${enemyProj} particles=${particles} ` +
        `powerups=${this.powerups.length} traffic=${traffic} turrets=${this.city.turrets.length} ` +
        `geoms=${info.memory.geometries} textures=${info.memory.textures} ` +
        `calls=${info.render.calls} tris=${info.render.triangles}`,
    );
  }

  applySettings() {
    // Manual quality change re-anchors the governor at the new ceiling.
    this.governor = createQualityGovernor();
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.applyComposerQuality();
    if (this.bloomPass) {
      this.bloomPass.enabled = governorBloomAllowed(0, this.settings.graphics === 'hd');
    }
    // HD is a clean, modern render: skip the PS1 color quantizer/dither entirely.
    if (this.retroPass) this.retroPass.enabled = false;
    this.audio.setVolume(this.settings.volume);
  }

  private renderFrame() {
    // Keep the horizon centered on the player so the dome never strands
    // behind the streaming city chunks.
    this.skyDome.position.set(this.camera.position.x, 0, this.camera.position.z);
    if (this.settings.graphics === 'sp1') {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.composer.render();
  }

  /** Position the fake blob shadows under the player and every active enemy,
   *  fading them out with altitude. Shadows are pooled per enemy instance. */
  private syncBlobShadows() {
    const hp = this.helicopter.body.position;
    const groundY = this.helicopter.smoothedHoverFloor;
    const alt = Math.max(0, hp.y - groundY);
    const playerFade = THREE.MathUtils.clamp(1 - alt / 140, 0, 1);
    this.playerShadow.visible = playerFade > 0.03;
    (this.playerShadow.material as THREE.MeshBasicMaterial).opacity = 0.9 * playerFade;
    this.playerShadow.scale.setScalar(1 + alt * 0.012);
    this.playerShadow.position.set(hp.x, groundY + 0.08, hp.z);

    const seen = new Set<Enemy>();
    for (const e of this.enemies) {
      if (!e.active) continue;
      seen.add(e);
      let shadow = this.enemyShadows.get(e);
      if (!shadow) {
        shadow = createBlobShadow(Math.max(3, e.radius * 1.6));
        this.enemyShadows.set(e, shadow);
        this.scene.add(shadow);
      }
      const p = e.body.position;
      const fade = THREE.MathUtils.clamp(1 - Math.max(0, p.y) / 120, 0, 1) * 0.85;
      shadow.visible = fade > 0.03;
      (shadow.material as THREE.MeshBasicMaterial).opacity = fade;
      shadow.position.set(p.x, 0.06, p.z);
    }
    for (const [e, shadow] of this.enemyShadows) {
      if (seen.has(e)) continue;
      this.scene.remove(shadow);
      shadow.geometry.dispose();
      (shadow.material as THREE.Material).dispose();
      this.enemyShadows.delete(e);
    }
  }

  private getFallbackFireDirection() {
    if (this.mouseAimValid) {
      const dx = this.mouseAimPoint.x - this.helicopter.body.position.x;
      const dz = this.mouseAimPoint.z - this.helicopter.body.position.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) return { x: dx / len, z: dz / len };
    }
    return { x: 0, z: -1 };
  }

  private autoAimPosition(target: Enemy | Objective) {
    return target instanceof Objective ? target.targetPoint : target.body.position;
  }

  private findAutoAimTarget(maxDistance = 245, useMouseCone = false) {
    let bestTarget: Enemy | Objective | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;
    const forward = this.getFallbackFireDirection();

    for (const enemy of this.enemies) {
      if (
        !enemy.active ||
        !Number.isFinite(enemy.body.position.x) ||
        !Number.isFinite(enemy.body.position.y) ||
        !Number.isFinite(enemy.body.position.z)
      ) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const dy = Math.abs(enemy.body.position.y - origin.y);
      const distSq = dx * dx + dz * dz;
      if (distSq < 12 || distSq > maxDistance * maxDistance) continue;

      const dist = Math.sqrt(distSq);
      const aheadBias = (dx / dist) * forward.x + (dz / dist) * forward.z;
      if (useMouseCone && aheadBias < 0.28) continue;
      const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
      if (useMouseCone && lateralDistance > 46 + dist * 0.12) continue;
      const lanePenalty = useMouseCone ? lateralDistance * 14 : Math.abs(dx) * 1.9;
      const behindPenalty = aheadBias < -0.25 ? 9000 : 0;
      const typeBonus =
        enemy.type === EnemyType.DRONE
          ? 1800
          : enemy.type === EnemyType.SHOOTER
            ? 1200
            : enemy.type === EnemyType.TANK
              ? 700
              : 0;
      const cursorDistance =
        this.mouseAimValid
          ? Math.hypot(enemy.body.position.x - this.mouseAimPoint.x, enemy.body.position.z - this.mouseAimPoint.z)
          : 0;
      const score =
        distSq * (useMouseCone ? 0.3 : 1) +
        lanePenalty +
        cursorDistance * (useMouseCone ? 4.5 : 0) +
        behindPenalty -
        typeBonus;

      if (score < bestScore) {
        bestScore = score;
        bestTarget = enemy;
      }
    }

    // SAM sites are deliberate high-value targets, but normal enemies retain
    // priority unless the launcher is actively tracking or locking the player.
    for (const objective of this.objectives) {
      if (!objective.active || objective.type !== ObjectiveType.SAM_SITE) continue;
      const targetPos = objective.targetPoint;
      const dx = targetPos.x - origin.x;
      const dz = targetPos.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 12 || distSq > maxDistance * maxDistance) continue;
      const dist = Math.sqrt(distSq);
      const aheadBias = (dx / dist) * forward.x + (dz / dist) * forward.z;
      if (useMouseCone && aheadBias < 0.28) continue;
      const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
      if (useMouseCone && lateralDistance > 46 + dist * 0.12) continue;
      const cursorDistance = this.mouseAimValid
        ? Math.hypot(targetPos.x - this.mouseAimPoint.x, targetPos.z - this.mouseAimPoint.z)
        : 0;
      const threatening = objective.samState === SamState.LOCKING || objective.samState === SamState.TRACKING;
      const score = distSq * (useMouseCone ? 0.3 : 1)
        + lateralDistance * (useMouseCone ? 14 : 1.9)
        + cursorDistance * (useMouseCone ? 4.5 : 0)
        + (aheadBias < -0.25 ? 9000 : 0)
        + (threatening ? -2600 : 1800);
      if (score < bestScore) {
        bestScore = score;
        bestTarget = objective;
      }
    }

    return bestTarget;
  }

  private isAutoAimTargetValid(enemy: Enemy | Objective | null, maxDistance: number, useMouseCone: boolean) {
    const targetPos = enemy ? this.autoAimPosition(enemy) : null;
    if (
      !enemy?.active ||
      !targetPos ||
      !Number.isFinite(targetPos.x) ||
      !Number.isFinite(targetPos.y) ||
      !Number.isFinite(targetPos.z)
    ) return false;
    const dx = targetPos.x - this.helicopter.body.position.x;
    const dz = targetPos.z - this.helicopter.body.position.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    const distSq = dx * dx + dz * dz;
    const retainedRange = maxDistance * 1.08;
    if (distSq < 12 || distSq > retainedRange * retainedRange) return false;
    if (!useMouseCone) return true;
    const distance = Math.sqrt(distSq);
    const forward = this.getFallbackFireDirection();
    const aheadBias = (dx / distance) * forward.x + (dz / distance) * forward.z;
    const lateralDistance = Math.abs(dx * forward.z - dz * forward.x);
    return aheadBias >= 0.12 && lateralDistance <= 60 + distance * 0.16;
  }

  private updateAutoAim() {
    const aimHeight = this.helicopter.body.position.y;
    const targetingBonus = (this.hangarUpgrades.targeting ?? 0) * 10;
    const maxDistance = (this.settings.autoAim ? 255 : this.mouseAimValid ? 225 : 235) + targetingBonus;
    const useMouseCone = !this.settings.autoAim && this.mouseAimValid;
    if (!this.isAutoAimTargetValid(this.autoAimTarget, maxDistance, useMouseCone)) {
      this.autoAimTarget = this.findAutoAimTarget(maxDistance, useMouseCone);
    }

    if (this.autoAimTarget) {
      const targetPos = this.autoAimPosition(this.autoAimTarget);
      if (this.autoAimTarget instanceof Objective) this.autoAimTarget.setTargeted(true);
      this.aimPoint.set(targetPos.x, aimHeight, targetPos.z);
      this.helicopter.setGunAim(targetPos.x, targetPos.y, targetPos.z, true);
      this.targetGroup.visible = true;
      this.targetGroup.position.set(targetPos.x, targetPos.y + 1.2, targetPos.z);
      const scale = this.autoAimTarget instanceof Objective
        ? 1.35
        : this.autoAimTarget.type === EnemyType.TANK || this.autoAimTarget.type === EnemyType.BOSS ? 1.5 : 1.0;
      this.targetGroup.scale.setScalar(scale);
    } else if (this.mouseAimValid) {
      // No enemy in range — the chin gun physically tracks the mouse aim
      // point instead of the body swinging around twin-stick style.
      this.aimPoint.copy(this.mouseAimPoint);
      this.aimPoint.y = aimHeight;
      this.helicopter.setGunAim(this.aimPoint.x, aimHeight, this.aimPoint.z, true);
      this.targetGroup.visible = true;
      this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
      this.targetGroup.scale.setScalar(0.82);
    } else {
      // No aim source at all — gun eases back to neutral, fire falls back to
      // the travel direction.
      this.helicopter.setGunAim(0, 0, 0, false);
      const fallback = this.getFallbackFireDirection();
      this.aimPoint.set(
        this.helicopter.body.position.x + fallback.x * 65,
        aimHeight,
        this.helicopter.body.position.z + fallback.z * 65,
      );
      this.targetGroup.visible = true;
      this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
      this.targetGroup.scale.setScalar(0.78);
    }
  }

  private updateMouseAimFromEvent(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    this.mouseNDC.set(
      THREE.MathUtils.clamp(x, 0, 1) * 2 - 1,
      -(THREE.MathUtils.clamp(y, 0, 1) * 2 - 1),
    );

    const aimHeight = this.helicopter.body.position.y;
    this.mousePlane.set(this.worldUp, -aimHeight);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);

    const target = this.mouseAimScratch;
    if (!this.raycaster.ray.intersectPlane(this.mousePlane, target)) return;

    let dx = target.x - this.helicopter.body.position.x;
    let dz = target.z - this.helicopter.body.position.z;
    let distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.001) return;

    const minAimDistance = 22;
    const maxAimDistance = 280;
    const clampedDistance = THREE.MathUtils.clamp(distance, minAimDistance, maxAimDistance);
    dx /= distance;
    dz /= distance;
    this.mouseAimPoint.set(
      this.helicopter.body.position.x + dx * clampedDistance,
      aimHeight,
      this.helicopter.body.position.z + dz * clampedDistance,
    );
    this.mouseAimValid = true;
    this.isMouseActive = true;
    this.updateAutoAim();
  }

  private updateStickAim() {
    if (!this.rightStick.active) return;

    const mag = Math.sqrt(
      this.rightStick.x * this.rightStick.x + this.rightStick.y * this.rightStick.y,
    );
    if (mag < 0.15) {
      this.isFiringMouse = false;
      return;
    }

    const aimDistance = 55;
    const dirX = this.rightStick.x / mag;
    const dirZ = this.rightStick.y / mag;
    const aimHeight = this.helicopter.body.position.y;
    this.aimPoint.set(
      this.helicopter.body.position.x + dirX * aimDistance,
      aimHeight,
      this.helicopter.body.position.z + dirZ * aimDistance,
    );
    // The chin gun tracks the stick aim — the body flies on course and never
    // swings toward where the player is aiming.
    this.helicopter.setGunAim(this.aimPoint.x, aimHeight, this.aimPoint.z, true);
    this.targetGroup.visible = false;
    this.isFiringMouse = true;
  }

  onPointerMove = (e: PointerEvent) => {
    if (e.target !== this.renderer.domElement) return;
    if (this.settings.touchMode && e.pointerType === 'touch') return;
    this.updateMouseAimFromEvent(e);
  };

  onPointerDown = (e: PointerEvent) => {
    if (!this.isPlaying) return;
    if (e.target !== this.renderer.domElement) return;
    if (this.settings.touchMode && e.pointerType === 'touch') return;
    e.preventDefault();
    this.audio.resume();

    if (e.button === 2) {
      this.startPaintingLocks();
    } else {
      this.isFiringMouse = true;
      this.isMouseActive = true;
      this.updateMouseAimFromEvent(e);
      this.updateAutoAim();
      if (this.health > 0) {
        this.fireWeapons(performance.now() / 1000);
      }
    }
  };

  onPointerUp = (e: PointerEvent) => {
    if (e.button === 2 || this.isPaintingLocks) {
      this.releaseSalvo();
    } else {
      this.isFiringMouse = false;
    }
  };

  onWheel = (e: WheelEvent) => {
    if (!this.isPlaying) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    const weaponTypes = [
      WeaponType.MACHINE_GUN,
      WeaponType.MISSILE,
      WeaponType.ROCKET,
      WeaponType.SHOTGUN,
    ];
    const currentIdx = weaponTypes.indexOf(this.currentWeapon);
    const nextIdx =
      (currentIdx + delta + weaponTypes.length) % weaponTypes.length;
    this.switchWeapon(weaponTypes[nextIdx]);
  };

  private resetTransientInput() {
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.isPaintingLocks = false;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.keyboardVelocity.set(0, 0);
    this.verticalInput = 0;
    this.gamepadMove.x = 0;
    this.gamepadMove.z = 0;
    this.afterburnerActive = false;
  }

  onWindowBlur = () => {
    this.resetTransientInput();
    this.lastTime = performance.now() / 1000;
    if (this.isPlaying) window.dispatchEvent(new CustomEvent("helistrike:autopause"));
  };

  onVisibilityChange = () => {
    this.resetTransientInput();
    this.lastTime = performance.now() / 1000;
    if (document.hidden && this.isPlaying) {
      window.dispatchEvent(new CustomEvent("helistrike:autopause"));
    }
  };

  onCountermeasureEvent = () => {
    if (this.isPlaying) this.deployCountermeasure(performance.now() / 1000);
  };

  private deployCountermeasure(time: number) {
    if (!this.countermeasures.deploy(time)) {
      this.announce(
        this.countermeasures.charges <= 0 ? "FLARES EMPTY" : "FLARES RECHARGING",
        this.countermeasures.charges <= 0 ? "Find ammunition supplies" : `${this.countermeasures.cooldownRemaining.toFixed(1)}s`,
        "#ffbd3f",
      );
      return false;
    }

    const player = this.helicopter.body.position;
    const velocity = this.helicopter.body.velocity;
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const backX = horizontalSpeed > 2 ? -velocity.x / horizontalSpeed : Math.sin(this.helicopter.mesh.rotation.y);
    const backZ = horizontalSpeed > 2 ? -velocity.z / horizontalSpeed : Math.cos(this.helicopter.mesh.rotation.y);
    const body = new CANNON.Body({ mass: 0 });
    body.position.set(player.x + backX * 9, player.y - 2.5, player.z + backZ * 9);
    if (this.decoyTarget) this.decoyTarget.active = false;
    this.decoyTarget = { body, active: true };
    this.flareEffectTimer = this.countermeasures.config.activeWindow;

    let decoyed = 0;
    for (const missile of this.enemyProjectiles.pool) {
      if (!missile.active || missile.homingStrength <= 0 || missile.target?.body !== this.helicopter.body) continue;
      const distance = Math.hypot(missile.pos.x - player.x, missile.pos.y - player.y, missile.pos.z - player.z);
      if (distance > 190) continue; // an early flare does not guarantee safety
      const closeEnough = distance <= 135;
      const outerChance = this.countermeasures.config.effectiveness * (1 - (distance - 135) / 55);
      if (closeEnough || Math.random() < outerChance) {
        if (missile.retargetToDecoy(this.decoyTarget)) decoyed++;
      }
    }
    this.audio.playCountermeasure();
    if (decoyed > 0) {
      this.announce("MISSILE DECOYED", decoyed > 1 ? `${decoyed} threats diverted` : "Lock broken", "#55f2c2");
      this.audio.playLockBreak();
    }
    return true;
  }

  private updateCountermeasures(delta: number, time: number) {
    this.countermeasures.update(delta);
    if (!this.decoyTarget) return;
    if (this.countermeasures.activeTimer <= 0) this.decoyTarget.active = false;
    if (!this.decoyTarget.active) return;
    this.decoyTarget.body.position.y -= 4.5 * delta;
    this.flareEffectTimer = Math.max(0, this.flareEffectTimer - delta);
    if (this.frameCount % 2 === 0) {
      const p = this.decoyTarget.body.position;
      this.particles.spawnSparks(p.x + (Math.random() - 0.5) * 5, p.y, p.z + (Math.random() - 0.5) * 5, time);
      if (this.frameCount % 6 === 0) this.particles.spawnSmoke(p.x, p.y, p.z, time);
    }
  }

  private addThreat(points: number) {
    const previous = this.threatLevel;
    this.threatPoints = Math.max(0, this.threatPoints + Math.max(0, points));
    this.threatLevel = threatLevelForPoints(this.threatPoints);
    if (this.threatLevel > previous) {
      this.announce("THREAT LEVEL INCREASED", THREAT_NAMES[this.threatLevel - 1], this.threatLevel >= 4 ? "#ff3344" : "#ff9f43");
      this.audio.playThreatLevel();
    }
  }

  private addUnsecuredCredits(amount: number) {
    const award = Math.max(0, Math.round(amount));
    if (award > 0) this.unsecuredCredits += award;
  }

  private addSalvage(amount: number) {
    // C5 perk: salvageLuck multiplies every pickup's scrap yield.
    const boosted = amount * (1 + perkEffect("salvageLuck", this.perks.salvageLuck));
    this.runSalvage = collectSalvage(this.runSalvage, boosted);
  }

  private getMissionRuntimeSnapshot(): MissionRuntimeSnapshot {
    const player = this.helicopter.body.position;
    return {
      player: { x: player.x, y: player.y, z: player.z },
      healthRatio: this.health / Math.max(1, this.maxHealth),
      carryingCargo: this.delivery.isCarrying(),
    };
  }

  private objectiveMissionId(objective: Objective) {
    if (!objective.missionTargetId) {
      objective.missionTargetId = `objective-${objective.type}-${Math.round(objective.position.x)}-${Math.round(objective.position.z)}`;
    }
    return objective.missionTargetId;
  }

  private spawnMissionElite(mission: Mission, time: number) {
    if (!mission.targetId || !mission.destination) return;
    const target = new Enemy(
      this.scene,
      this.world,
      mission.destination.x,
      mission.destination.z,
      this.currentWave >= 5 ? EnemyType.SHOOTER : EnemyType.DRONE,
      Math.max(18, mission.destination.y ?? this.helicopter.body.position.y),
      {
        isElite: true,
        modifier: this.currentWave % 2 === 0 ? EnemyModifier.REGENERATING : EnemyModifier.SHIELDED,
        pattern: AttackPattern.CIRCLE,
      },
    );
    target.missionTargetId = mission.targetId;
    this.scaleEnemyForDifficulty(target);
    if (mission.type === MissionType.BOUNTY) {
      // C2: bounty targets are named aces — thicker hull plus a volatile affix.
      target.maxHp = Math.round(target.maxHp * 1.6);
      target.hp = target.maxHp;
      target.modifier |= EnemyModifier.EXPLOSIVE;
    }
    this.enemies.push(target);
    this.particles.spawnExplosion(target.body.position.x, target.body.position.y, target.body.position.z, 42, time, 18);
    this.announce(mission.type === MissionType.BOUNTY ? "BOUNTY TARGET" : "HIGH VALUE TARGET", "Elite contact marked", "#ff9b43");
  }

  private grantMissionReward(mission: Mission, time: number) {
    const claimed = this.missionManager.claimReward(mission);
    if (!claimed) return;
    const credits = claimed.main.credits + claimed.bonus.credits;
    const xp = claimed.main.xp + claimed.bonus.xp;
    const salvage = claimed.main.salvage + claimed.bonus.salvage;
    const countermeasures = (claimed.main.countermeasures ?? 0) + (claimed.bonus.countermeasures ?? 0);
    const repair = (claimed.main.repair ?? 0) + (claimed.bonus.repair ?? 0);
    this.delivery.awardCredits(credits);
    if (xp > 0) this.grantRunXp(xp, time);
    this.addSalvage(salvage);
    if (countermeasures > 0) this.countermeasures.replenish(countermeasures);
    if (repair > 0) {
      this.health = Math.min(this.maxHealth, this.health + repair);
      this.helicopter.repair(repair);
    }
    const bonusEarned = mission.bonusObjectives.some((item) => item.state === "COMPLETE");
    this.missionsCompleted++;
    this.missionBonusesCompleted += mission.bonusObjectives.filter((item) => item.state === "COMPLETE").length;
    this.announce(
      "MISSION COMPLETE",
      `+${credits} CR · +${salvage} salvage${bonusEarned ? " · BONUS" : ""}`,
      "#55f2c2",
    );
  }

  private updateMissions(time: number, delta: number) {
    const contract = this.delivery.activeContract;
    const generated = this.missionManager.tryGenerate(time, {
      wave: this.currentWave,
      threat: this.threatLevel,
      player: this.getMissionRuntimeSnapshot().player,
      sams: this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).map((o) => ({
        id: this.objectiveMissionId(o), x: o.position.x, y: o.position.y, z: o.position.z,
      })),
      radars: this.objectives.filter((o) => o.active && o.type === ObjectiveType.RADAR_TOWER).map((o) => ({
        id: this.objectiveMissionId(o), x: o.position.x, y: o.position.y, z: o.position.z,
      })),
      delivery: contract && contract.state !== DeliveryState.COMPLETED && contract.state !== DeliveryState.FAILED
        ? { id: contract.id, x: contract.destinationPosition.x, y: contract.destinationPosition.y, z: contract.destinationPosition.z }
        : null,
    });
    if (generated) {
      if (generated.type === MissionType.HIGH_VALUE_TARGET || generated.type === MissionType.BOUNTY) this.spawnMissionElite(generated, time);
      this.announce("NEW MISSION", generated.title, "#ffe66d");
    }
    this.missionManager.update(time, delta, this.getMissionRuntimeSnapshot());
    let completed = this.missionManager.takeCompleted();
    while (completed) {
      this.grantMissionReward(completed, time);
      completed = this.missionManager.takeCompleted();
    }
  }

  private updateDepotService(delta: number) {
    this.depotServiceCooldown = Math.max(0, this.depotServiceCooldown - delta);
    const contract = this.delivery.activeContract;
    if (!contract) return;
    const player = this.helicopter.body.position;
    const distance = Math.min(
      Math.hypot(player.x - contract.originPosition.x, player.z - contract.originPosition.z),
      Math.hypot(player.x - contract.destinationPosition.x, player.z - contract.destinationPosition.z),
    );
    const weapon = this.weapons.get(this.currentWeapon);
    const needsService = this.health < this.maxHealth || this.currentFuel < this.maxFuel || Boolean(weapon && weapon.ammo < weapon.maxAmmo);
    if (!canUseDepotService(distance, this.depotServiceCooldown, needsService)) return;
    this.health = Math.min(this.maxHealth, this.health + this.maxHealth * 0.18);
    this.currentFuel = Math.min(this.maxFuel, this.currentFuel + this.maxFuel * 0.2);
    this.helicopter.repair(18);
    if (weapon) weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + Math.ceil(weapon.maxAmmo * 0.25));
    this.depotServiceCooldown = 16;
    this.announce("DEPOT SERVICE", "Hull, fuel and ammunition restored", "#55f2c2");
  }

  /** Animate the extraction spawn ping: staggered rings expand outward and
   *  fade. Purely visual — never touches the pad's collision/zone logic. */
  private updateExtractionPulse(delta: number) {
    if (this.extractionPulseRings.length === 0) return;
    this.extractionPulseTimer += delta;
    let allDone = true;
    for (const ring of this.extractionPulseRings) {
      const local = this.extractionPulseTimer - ((ring.userData.pulseDelay as number) ?? 0);
      if (local < 0) continue;
      const t = Math.min(1, local / GameEngine.EXTRACTION_PULSE_DURATION);
      if (t >= 1) {
        ring.visible = false;
        continue;
      }
      allDone = false;
      const ease = 1 - Math.pow(1 - t, 3); // fast start, slow settle
      ring.scale.setScalar(1 + ease * (GameEngine.EXTRACTION_PULSE_RADIUS - 1));
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
    }
    if (allDone) this.extractionPulseRings.length = 0;
  }

  private updateThreatAndExtraction(delta: number, time: number) {
    this.updateExtractionPulse(delta);
    this.addThreat(delta * 0.18);
    if (!this.extractionPosition &&
        canOfferExtraction(this.currentWave, this.objectivesDestroyedThisRun, this.extractionOfferedThisRun)) {
      // C1: one LZ offer per run, gated by wave + objectives instead of raw time.
      this.extractionOfferedThisRun = true;
      this.spawnExtraction();
      this.extractionOfferLevel = this.threatLevel;
    }
    if (!this.extractionPosition) return;
    const player = this.helicopter.body.position;
    if (!this.extractionPressure && (time - this.extractionOfferTime > 90 || this.extractionPosition.z > player.z + 350)) {
      this.clearExtraction();
      return;
    }
    const dx = player.x - this.extractionPosition.x;
    const dz = player.z - this.extractionPosition.z;
    const inside =
      dx * dx + dz * dz <= GameEngine.EXTRACTION_ZONE_RADIUS * GameEngine.EXTRACTION_ZONE_RADIUS &&
      Math.abs(player.y - this.extractionPosition.y) < 48;
    if (inside) {
      if (!this.extractionPressure) {
        this.extractionPressure = true;
        this.announce("EXTRACTING", this.delivery.isCarrying() ? "ACTIVE DELIVERY WILL BE ABANDONED" : "Hold position", "#55f2c2");
        // C1: threat lock + spawn surge — the final hold-out is supposed to hurt.
        if (this.threatLevel < 3) this.threatLevel = 3;
        this.pendingSpawns = Math.min(this.pendingSpawns + 3, 6);
      }
      this.extractionProgress = Math.min(1, this.extractionProgress + (delta * this.difficulty.extractionHold) / EXTRACTION_HOLD_SECONDS);
      if (this.extractionProgress >= 1) this.completeExtraction(time);
    } else {
      this.extractionPressure = false;
      this.extractionProgress = Math.max(0, this.extractionProgress - delta * 0.18);
    }
  }

  private spawnExtraction() {
    this.clearExtraction();
    const player = this.helicopter.body.position;
    // Prefer a real rooftop LZ (helipad-tower deck, then a flat rooftop the
    // pad is painted on); fall back to the lowest open surface on the usual
    // lanes (waterfront / yards). Distance/safety rules are unchanged.
    const spot = this.city.findExtractionSpot(player.z);
    this.extractionPosition = new THREE.Vector3(spot.x, Math.max(1, spot.height + 1), spot.z);
    this.extractionOfferTime = performance.now() / 1000;
    const group = new THREE.Group();
    group.position.copy(this.extractionPosition);
    // Compact pad on rooftops, full-size pad on open ground.
    const rooftop = spot.kind !== "ground";
    const scale = rooftop ? 0.42 : 1;
    const ring = new THREE.Mesh(new THREE.RingGeometry(20 * scale, 23 * scale, 32), createGlowMaterial(0x55f2a2, 0.72));
    ring.rotation.x = -Math.PI / 2;
    const barA = new THREE.Mesh(new THREE.BoxGeometry(3 * scale, 0.25, 18 * scale), createGlowMaterial(0x55f2a2, 0.9));
    const barB = barA.clone();
    barA.position.x = -7 * scale;
    barB.position.x = 7 * scale;
    const cross = new THREE.Mesh(new THREE.BoxGeometry(14 * scale, 0.25, 3 * scale), createGlowMaterial(0x55f2a2, 0.9));
    group.add(ring, barA, barB, cross);
    if (rooftop) {
      // Painted landing deck + H marking so the roof reads as a real helipad.
      const deck = new THREE.Mesh(new THREE.BoxGeometry(9, 0.22, 9), new THREE.MeshLambertMaterial({ color: 0x1b2740 }));
      deck.position.y = -1.15;
      group.add(deck);
      // Vertical beacon so the rooftop LZ reads from street level.
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.6 * scale, 30, 1.6 * scale), createGlowMaterial(0x55f2a2, 0.16));
      beam.position.y = -12;
      group.add(beam);
    }
    // Brief green light-pulse sweep: two staggered rings ping outward from
    // the pad and fade, telegraphing the offer from far away. Fresh materials
    // (createGlowMaterial) so opacity animation never touches a shared cache.
    this.extractionPulseRings.length = 0;
    for (let i = 0; i < 2; i++) {
      const pulseRing = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 1.0, 48),
        createGlowMaterial(0x55f2a2, 0.85),
      );
      pulseRing.rotation.x = -Math.PI / 2;
      pulseRing.position.y = 1.6 + i * 0.06;
      pulseRing.userData.pulseDelay = i * 0.35;
      group.add(pulseRing);
      this.extractionPulseRings.push(pulseRing);
    }
    this.extractionPulseTimer = 0;
    this.scene.add(group);
    this.extractionMarker = group;
    this.announce(
      "EXTRACTION AVAILABLE",
      rooftop ? `Rooftop LZ · Secure +${this.unsecuredCredits} CR` : `Secure +${this.unsecuredCredits} CR`,
      "#55f2c2",
    );
  }

  private clearExtraction() {
    if (this.extractionMarker) {
      this.extractionMarker.parent?.remove(this.extractionMarker);
      disposeObject3D(this.extractionMarker);
    }
    this.extractionMarker = null;
    this.extractionPulseRings.length = 0;
    this.extractionPosition = null;
    this.extractionProgress = 0;
    this.extractionPressure = false;
  }

  private completeExtraction(time: number) {
    const before = this.unsecuredCredits;
    const extractedSalvage = this.runSalvage;
    const salvageCredits = salvageCreditsFor(this.runSalvage);
    const settlement = settleExtraction(this.delivery.credits, before, this.runSalvage);
    this.delivery.awardCredits(settlement.securedBonus);
    this.unsecuredCredits = settlement.unsecured;
    this.runSalvage = 0;
    this.delivery.fail("EXTRACTED");
    this.clearExtraction();
    this.announce("EXTRACTION SUCCESSFUL", `+${settlement.securedBonus} CR secured${salvageCredits > 0 ? ` · ${salvageCredits} salvage` : ""}`, "#55f2c2");
    this.dispatchGameOver(time, "EXTRACTED", before + salvageCredits, extractedSalvage);
  }

  onSuperEvent = () => {
    this.activateDevastation(performance.now() / 1000);
  };

  /** B3: unleash the Devastation overcharge when the meter is full. */
  private activateDevastation(time: number) {
    if (!this.isPlaying || this.health <= 0) return;
    if (this.superActiveUntil > time || this.superCooldownUntil > time) return;
    if (this.superCharge < SUPER_MAX_CHARGE) return;
    this.superCharge = 0;
    this.superActiveUntil = time + SUPER_DURATION;
    this.superCooldownUntil = this.superActiveUntil + SUPER_COOLDOWN;
    this.announce("DEVASTATION", "Overcharge engaged — invulnerable", "#ff5d3a");
    this.triggerHitStop(0.18, 0.1);
    // Radial shockwave: stagger every enemy within 240u with falloff damage.
    const hx = this.helicopter.body.position.x;
    const hy = this.helicopter.body.position.y;
    const hz = this.helicopter.body.position.z;
    this.shockwaves?.spawn(hx, 0.5, hz, time, 240, 0xff5d3a, 1.2);
    this.volumetricExplosions.spawn(hx, hy, hz, 30, 10);
    this.audio.playExplosion(1.6);
    for (const e of this.enemies) {
      if (!e.active) continue;
      const dx = e.body.position.x - hx;
      const dz = e.body.position.z - hz;
      const distSq = dx * dx + dz * dz;
      if (distSq <= 240 * 240) {
        const falloff = 1 - Math.sqrt(distSq) / 240;
        if (e.takeDamage(8 + 52 * falloff, time) === "destroyed") this.onEnemyDestroyed(e, time);
      }
    }
    this.updateUI(time);
  }

  onKeyDown = (e: KeyboardEvent) => {
    if (!this.isPlaying) return;
    const key = e.key.toLowerCase();

    // B3: E triggers the Devastation overcharge (Space/PageUp keep altitude-up).
    if (key === "e" && !e.repeat) {
      this.activateDevastation(performance.now() / 1000);
      return;
    }

    // Double tap dash triggers
    if (!e.repeat) {
      const doubleTapThreshold = 250;
      const now = performance.now();
      if (key === "a" || key === "arrowleft") {
        if (now - (this.lastTapTime["a"] || 0) < doubleTapThreshold) {
          this.triggerDash(-1, 0);
        }
        this.lastTapTime["a"] = now;
      } else if (key === "d" || key === "arrowright") {
        if (now - (this.lastTapTime["d"] || 0) < doubleTapThreshold) {
          this.triggerDash(1, 0);
        }
        this.lastTapTime["d"] = now;
      } else if (key === "w" || key === "arrowup") {
        if (now - (this.lastTapTime["w"] || 0) < doubleTapThreshold) {
          this.triggerDash(0, -1);
        }
        this.lastTapTime["w"] = now;
      } else if (key === "s" || key === "arrowdown") {
        if (now - (this.lastTapTime["s"] || 0) < doubleTapThreshold) {
          this.triggerDash(0, 1);
        }
        this.lastTapTime["s"] = now;
      }
    }

    if (
      [
        "w",
        "a",
        "s",
        "d",
        "arrowup",
        "arrowleft",
        "arrowdown",
        "arrowright",
        " ",
        "spacebar",
        "shift",
        "e",
        "pageup",
        "pagedown",
        "alt",
      ].includes(key)
    ) {
      e.preventDefault();
      this.movementKeys.add(key);
    }
    // Weapon switching (1-4 keys)
    if (key === "1") this.switchWeapon(WeaponType.MACHINE_GUN);
    if (key === "2") this.switchWeapon(WeaponType.MISSILE);
    if (key === "3") this.switchWeapon(WeaponType.ROCKET);
    if (key === "4") this.switchWeapon(WeaponType.SHOTGUN);
    if (key === "r") this.startReload();

    if (key === "c" && !e.repeat) this.deployCountermeasure(performance.now() / 1000);

    if (key === "q") {
      this.startPaintingLocks();
    }
  };

  onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    this.movementKeys.delete(key);
    if (key === "q") {
      this.releaseSalvo();
    }
  };

  triggerDash(dx: number, dz: number) {
    if (this.dashState !== "READY") return;
    this.dashState = "DASHING";
    this.dashCooldownTimer = 0;
    this.dashActiveTimer = MOVEMENT_CONFIG.dashDuration;
    this.dashDirection.set(dx, 0, dz).normalize();
    this.helicopter.body.velocity.x = this.dashDirection.x * MOVEMENT_CONFIG.dashSpeed;
    this.helicopter.body.velocity.z = this.dashDirection.z * MOVEMENT_CONFIG.dashSpeed;
    this.helicopter.triggerDash(dx, dz);
  }

  onLeftStick = (event: Event) => {
    const detail = (event as CustomEvent<StickInput>).detail;
    this.leftStick = {
      x: THREE.MathUtils.clamp(detail?.x ?? 0, -1, 1),
      y: THREE.MathUtils.clamp(detail?.y ?? 0, -1, 1),
      active: Boolean(detail?.active),
    };
    if (this.leftStick.active) this.audio.resume();
  };

  onRightStick = (event: Event) => {
    const detail = (event as CustomEvent<StickInput>).detail;
    this.rightStick = {
      x: THREE.MathUtils.clamp(detail?.x ?? 0, -1, 1),
      y: THREE.MathUtils.clamp(detail?.y ?? 0, -1, 1),
      active: Boolean(detail?.active),
    };
    this.isFiringMouse = this.rightStick.active;
    this.isMouseActive = !this.rightStick.active;
    if (this.rightStick.active) this.audio.resume();
  };

  private repairPlayer(amount: number) {
    const efficiency = 1 + this.runUpgrades.repair * 0.15;
    const before = this.health;
    this.health = resolveRepair(this.health, this.maxHealth, amount, efficiency);
    const applied = this.health - before;
    if (applied > 0) this.helicopter.repair(applied);
    return applied;
  }

  private applyPlayerDamage(
    amount: number,
    source: string,
    damageType: PlayerDamageType,
    time: number,
    feedback = true,
  ) {
    if (this.health <= 0 || this.gameOverDispatched) return 0;
    // B3: invulnerable during Devastation overcharge
    if (this.superActiveUntil > time) return 0;
    const blocked = this.shieldTimer > 0 || this.dashActiveTimer > 0;
    const mitigation = armorMitigation(this.hangarUpgrades.armor, this.runUpgrades.armor);
    const result = resolvePlayerDamage(this.health, this.maxHealth, amount, mitigation, blocked);
    if (result.applied <= 0) return 0;
    this.health = result.health;
    this.missionManager.reportPlayerDamage(source === "SAM MISSILE" ? "SAM_MISSILE" : "OTHER");
    this.helicopter.takeDamage(result.applied);
    if (feedback) this.audio.playHit();
    if ((damageType === "MISSILE" || damageType === "EXPLOSIVE" || damageType === "COLLISION") && result.applied >= 12) {
      this.addCameraImpulse(1.2);
    }
    if (feedback) {
      window.dispatchEvent(new CustomEvent("helistrike:player-hit", {
        detail: { amount: result.applied, source, damageType },
      }));
    }
    this.updateUI(time);
    return result.applied;
  }

  onHelicopterCollide = (e: { body?: CANNON.Body; contact?: CANNON.ContactEquation }) => {
    // Objectives are destructible targets, not obstacles.
    const isObjective =
      e.body && this.objectives.some((o) => o.active && o.body === e.body);
    if (isObjective) return;

    const body = this.helicopter.body;
    const velocity = body.velocity;
    const isBuilding = e.body && e.body.type === CANNON.Body.STATIC;
    let outwardX = 0;
    let outwardY = 0;
    let outwardZ = 0;
    let hasContactNormal = false;

    if (e.contact) {
      const normal = e.contact.ni;
      const direction = e.contact.bi === body ? -1 : 1;
      outwardX = normal.x * direction;
      outwardY = normal.y * direction;
      outwardZ = normal.z * direction;
      hasContactNormal =
        Number.isFinite(outwardX) &&
        Number.isFinite(outwardY) &&
        Number.isFinite(outwardZ);
    } else if (isBuilding && e.body) {
      const dx = body.position.x - e.body.position.x;
      const dz = body.position.z - e.body.position.z;
      const length = Math.hypot(dx, dz);
      if (length > 0.001) {
        outwardX = dx / length;
        outwardZ = dz / length;
        hasContactNormal = true;
      }
    }

    const outwardSpeed = hasContactNormal
      ? velocity.x * outwardX + velocity.y * outwardY + velocity.z * outwardZ
      : 0;
    const impact = hasContactNormal
      ? Math.max(0, -outwardSpeed)
      : Math.hypot(velocity.x, velocity.z);

    // Angle-aware severity: headOn is the fraction of total speed driven INTO
    // the surface (1 = dead-on slam, ~0 = glancing scrape). Clipping a wall
    // corner reads as a scrape — higher damage gate, reduced damage, sparks
    // only — while head-on hits keep their full penalty.
    const speedMag = Math.sqrt(
      velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
    );
    const headOn = speedMag > 0.001 ? impact / speedMag : 1;
    const isScrape = headOn < 0.35;

    if (isBuilding) {
      // Resolve every wall contact, not only damage ticks. Remove the inward
      // normal component while preserving tangential speed for controlled slides.
      const horizontalNormalLength = Math.hypot(outwardX, outwardZ);
      if (horizontalNormalLength > 0.1 && outwardSpeed < 0) {
        const nx = outwardX / horizontalNormalLength;
        const nz = outwardZ / horizontalNormalLength;
        const inwardHorizontalSpeed = velocity.x * nx + velocity.z * nz;
        if (inwardHorizontalSpeed < 0) {
          velocity.x -= nx * inwardHorizontalSpeed;
          velocity.z -= nz * inwardHorizontalSpeed;
        }
        body.position.x += nx * 0.025;
        body.position.z += nz * 0.025;
      }

      if (this.dashState === "DASHING") {
        this.dashState = "COOLDOWN";
        this.dashActiveTimer = 0;
        this.dashCooldownTimer = MOVEMENT_CONFIG.dashCooldown * Math.max(0.45, 1 - this.runUpgrades.dashCooldown * 0.15) * (1 - perkEffect("dash", this.perks.dash));
        this.helicopter.dashTimer = 0;
      }

      // Rooftop/street landings: damp the downward velocity so the hull
      // settles onto the pad instead of bouncing off the top of a building.
      if (Math.abs(outwardY) > 0.85 && velocity.y < 0) {
        velocity.y *= 0.25;
      }
    }

    const now = performance.now() / 1000;
    if (
      impact <= (isScrape ? 9 : 3.5) ||
      now - this.lastCollisionDamageTime <= 1.0 ||
      this.health <= 0
    ) return;

    // Glancing hits scale down with approach angle; head-on hits (~0.7+ of
    // speed into the surface) take the full severity.
    const angleFactor = isScrape ? 0.4 : 0.55 + 0.45 * Math.min(1, headOn / 0.7);
    const severity = impact * angleFactor;
    let dmg = Math.min(14, Math.max(3, severity * 1.1));
    if (isBuilding) {
      const isRoofContact = Math.abs(outwardY) > 0.85 && Math.abs(outwardX) < 0.5 && Math.abs(outwardZ) < 0.5;
      const isSlam = severity >= 12;
      dmg = isSlam
        ? Math.min(28, Math.round(10 + severity * 0.8))
        : Math.min(12, Math.round(3 + severity * 0.7));

      const horizontalNormalLength = Math.hypot(outwardX, outwardZ);
      const nx = horizontalNormalLength > 0.1 ? outwardX / horizontalNormalLength : 0;
      const nz = horizontalNormalLength > 0.1 ? outwardZ / horizontalNormalLength : 0;
      const spawnX = body.position.x + nx * 3.0;
      const spawnY = body.position.y;
      const spawnZ = body.position.z + nz * 3.0;

      if (isRoofContact) {
        // Hard rooftop/street landing: sparks + a thud, never an explosion or
        // slam shake — you're meant to land on LZ pads, and the damage is a
        // hard-landing penalty, not a crash.
        dmg = Math.min(8, Math.round(1 + impact * 0.35));
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
        this.audio.playHit();
      } else if (isSlam) {
        this.particles.spawnExplosion(spawnX, spawnY, spawnZ, 170, now, 48);
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
        this.particles.spawnSmoke(spawnX, spawnY, spawnZ, now);
        this.volumetricExplosions.spawn(spawnX, spawnY, spawnZ, 26, 8);
        this.audio.playExplosion(1.3);
        this.triggerHitStop(0.12, 0.2);
        this.crashSmokeTimer = 1.1;
        this.crashSmokePos = { x: spawnX, y: spawnY, z: spawnZ };
      } else if (isScrape) {
        // Corner scrape: sparks only, no smoke thump — it should feel minor.
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
      } else {
        this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
        this.particles.spawnSmoke(spawnX, spawnY, spawnZ, now);
        this.audio.playHit();
      }
    } else {
      this.audio.playHit();
    }

    // C5 perk: crashResist softens wall-slam and collision damage.
    const resistedDmg = dmg * (1 - perkEffect("crashResist", this.perks.crashResist));
    this.applyPlayerDamage(resistedDmg, isBuilding ? "BUILDING" : "COLLISION", "COLLISION", now, false);
    this.lastCollisionDamageTime = now;
    this.updateUI(now);
  };

  onGamepadConnected = (e: GamepadEvent) => {
    this.gamepadIndex = e.gamepad.index;
  };

  onGamepadDisconnected = () => {
    this.gamepadIndex = null;
    this.isFiringGamepad = false;
    this.isMouseActive = true;
  };

  onFireChange = (event: Event) => {
    const detail = (event as CustomEvent<{ active: boolean }>).detail;
    this.isFiringMouse = Boolean(detail?.active);
    if (this.isFiringMouse) this.audio.resume();
  };

  onSettingsChanged = (e: Event) => {
    const detail = (e as CustomEvent<Partial<GameSettings>>).detail;
    if (!detail) return;
    const next: GameSettings = { ...this.settings };
    if (detail.invertedY !== undefined) next.invertedY = detail.invertedY;
    if (detail.gamepadSensitivity !== undefined)
      next.gamepadSensitivity = THREE.MathUtils.clamp(detail.gamepadSensitivity, 0.4, 4);
    if (detail.quality !== undefined)
      next.quality =
        detail.quality === 'high'
          ? 'high'
          : detail.quality === 'medium'
            ? 'medium'
            : 'low';
    if (detail.graphics !== undefined)
      next.graphics = detail.graphics === 'hd' ? 'hd' : 'sp1';
    if (detail.volume !== undefined)
      next.volume = THREE.MathUtils.clamp(detail.volume, 0, 1);
    if (detail.touchMode !== undefined) next.touchMode = detail.touchMode;
    if (detail.autoAim !== undefined) next.autoAim = detail.autoAim;
    if (detail.difficulty !== undefined) {
      next.difficulty =
        detail.difficulty === 'casual' || detail.difficulty === 'hard'
          ? detail.difficulty
          : 'normal';
    }
    this.settings = next;
    this.applySettings();
  };

  /** Toggle the environment debug overlay (chunk/road/combat/landmark cells). */
  onEnvDebug = (e: Event) => {
    const detail = (e as CustomEvent<{ on?: boolean }>).detail;
    this.city.setEnvDebug(Boolean(detail?.on));
  };

  readPlayerModel(): HelicopterModel {
    try {
      const raw = window.localStorage.getItem('helistrike:playerModel');
      const n = Number(raw);
      return n === HelicopterModel.NIGHTHAWK || n === HelicopterModel.WARLOCK
        ? n
        : HelicopterModel.APACHE;
    } catch {
      return HelicopterModel.APACHE;
    }
  }

  onPlayerModelChanged = (e: Event) => {
    const detail = (e as CustomEvent<{ model: HelicopterModel }>).detail;
    if (detail?.model === undefined || detail.model === this.playerModel) return;
    this.playerModel = detail.model;
    try {
      window.localStorage.setItem('helistrike:playerModel', String(detail.model));
    } catch {
      // storage unavailable
    }
    // Rebuild only in the menu (wave 0, not playing) — never mid-run, not even paused
    if (this.currentWave === 0 && !this.isPlaying) {
      this.rebuildHelicopter();
    }
  };

  private rebuildHelicopter() {
    // Entity.destroy skips cached shared buffers, preventing remount/model-switch crashes.
    this.helicopter.body.removeEventListener("collide", this.onHelicopterCollide);
    this.helicopter.destroy();
    // Build the newly selected model
    this.helicopter = new Helicopter(this.scene, this.world, this.playerModel);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);
    this.delivery.setCarrierRoot(this.helicopter.mesh);
    this.movementTarget.set(0, 26, 0);
    this.updateUI(performance.now() / 1000);
  }

  onUpgradeChosen = (e: Event) => {
    const detail = (e as CustomEvent<{ id: UpgradeId }>).detail;
    if (!detail || !this.upgradePaused) return;
    this.applyRunUpgrade(detail.id);
    this.upgradePaused = false;
    this.isPlaying = true;
    // If a boss gem queued several level-ups, immediately offer the next pick
    this.offerNextLevelUp();
    this.updateUI(performance.now() / 1000);
  };

  /** Grant a picked upgrade and resume play. */
  private applyRunUpgrade(id: UpgradeId) {
    this.runUpgrades[id]++;
    switch (id) {
      case 'maxHealth':
        this.maxHealth += 20;
        this.repairPlayer(20);
        break;
      case 'repair':
        this.repairPlayer(25);
        break;
      case 'ammo':
        for (const [wt, cfg] of this.weapons.entries()) {
          cfg.maxAmmo = Math.round(cfg.maxAmmo * 1.3);
          cfg.ammo = cfg.maxAmmo;
        }
        break;
      case 'shield':
        this.shieldTimer = 8.0;
        break;
      case 'speed':
        this.speedBoostTimer = 12.0;
        break;
      case 'bomb':
        this.applyPowerUp(PowerUpType.BOMB, performance.now() / 1000);
        break;
      default:
        break; // multiplicative upgrades are applied at use-site
    }
    this.audio.playUpgrade();
  }

  /** Open the upgrade roulette: pause gameplay, dispatch 3 options. */
  private offerUpgrade() {
    this.pendingUpgradeOffer = pickUpgrades(3);
    this.upgradePaused = true;
    this.isPlaying = false;
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    window.dispatchEvent(
      new CustomEvent("helistrike:upgrade-offer", {
        detail: { options: this.pendingUpgradeOffer },
      }),
    );
  }

  /** Emit a transient arcade announcement (kill streaks, objectives, boss phases). */
  private announce(text: string, sub: string = "", color: string = "#ffe66d") {
    this.announceQueue.push({ text, sub, color });
  }

  private findLockTarget(dirX: number, dirZ: number, maxDistance = 190) {
    let bestEnemy: Enemy | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;

    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - origin.x;
      const dz = enemy.body.position.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < 16 || distSq > maxDistance * maxDistance) continue;

      const dist = Math.sqrt(distSq);
      const dot = (dx / dist) * dirX + (dz / dist) * dirZ;
      if (dot < 0.55) continue;

      const score = distSq * (1.45 - dot);
      if (score < bestScore) {
        bestScore = score;
        bestEnemy = enemy;
      }
    }

    return bestEnemy;
  }

  fireWeapons = (time: number) => {
    if (this.isReloading) return;

    const weapon = this.weapons.get(this.currentWeapon);
    if (!weapon) return;

    // Weapon level bonuses (permanent XP progression)
    const level = this.weaponLevels.get(this.currentWeapon) ?? 1;
    const lvlBonus = weaponLevelBonus(level);

    // Run upgrade multipliers
    const dmgUp = 1 + this.runUpgrades.damage * 0.25;
    // B3: Devastation overcharge doubles fire rate while active
    const rateUp = (1 + this.runUpgrades.fireRate * 0.18) * (this.superActiveUntil > time ? 2.2 : 1);
    const afterburnerDmg = this.afterburnerActive ? 1.35 : 1.0;

    // Check ammo
    if (weapon.ammo <= 0) {
      this.startReload();
      return;
    }

    // Check fire rate (level + upgrade + afterburner all apply)
    if (time - this.lastFireTime < weapon.fireRate * lvlBonus.fireRateMult / rateUp) return;
    this.lastFireTime = time;

    // Deduct ammo
    weapon.ammo--;
    this.shotsFired++;
    this.lastFiredWeapon = this.currentWeapon;
    this.lastFireTimestamp = time;

    // Machine-gun rounds always leave the rotating chin turret's real muzzle
    // and fly exactly where the physical barrel points. Missiles, rockets, and
    // shotgun payloads keep their existing wing/nose spawn behavior.
    const usingGun = this.currentWeapon === WeaponType.MACHINE_GUN;
    let originX: number, originY: number, originZ: number;
    let hDirX: number, hDirZ: number;
    let dirY = 0;
    if (usingGun) {
      const muzzlePos = this.helicopter.getMuzzlePosition(this.muzzlePositionScratch);
      const muzzleDir = this.helicopter.getMuzzleDirection(this.muzzleDirectionScratch);
      originX = muzzlePos.x;
      originY = muzzlePos.y;
      originZ = muzzlePos.z;
      hDirX = muzzleDir.x;
      dirY = muzzleDir.y;
      hDirZ = muzzleDir.z;
    } else {
      originX = this.helicopter.body.position.x;
      originY = this.helicopter.body.position.y -
        (this.currentWeapon === WeaponType.MISSILE || this.currentWeapon === WeaponType.ROCKET ? -0.75 : -0.45);
      originZ = this.helicopter.body.position.z;
      hDirX = this.aimPoint.x - originX;
      hDirZ = this.aimPoint.z - originZ;
    }
    const aimLen = Math.sqrt(hDirX * hDirX + hDirZ * hDirZ);
    if (!usingGun && aimLen > 0.001) {
      hDirX /= aimLen;
      hDirZ /= aimLen;
    } else if (
      !Number.isFinite(hDirX) || !Number.isFinite(dirY) || !Number.isFinite(hDirZ) ||
      aimLen <= 0.001
    ) {
      const fallback = this.getFallbackFireDirection();
      hDirX = fallback.x;
      dirY = 0;
      hDirZ = fallback.z;
    }
    const heading = Math.atan2(hDirX, hDirZ);
    const cursorLock =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? null
        : this.autoAimTarget?.active
          ? this.autoAimTarget
          : this.findAutoAimTarget(this.mouseAimValid ? 225 : 235, this.mouseAimValid);
    // Machine-gun rounds are ballistic along the physical barrel. Homing and
    // projectile steering remain exclusive to the existing non-MG weapon paths.
    const lockTarget =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? null
        : cursorLock ?? this.findLockTarget(hDirX, hDirZ, weapon.homing ? 230 : 170);
    const projectileAssist =
      weapon.homing
        ? 7.4
        : lockTarget
          ? this.currentWeapon === WeaponType.SHOTGUN
            ? 1.2
            : 2.8
          : 0;

    // Play appropriate sound
    switch (this.currentWeapon) {
      case WeaponType.MISSILE:      this.audio.playMissileLaunch();
      this.helicopter.triggerFirePitch(0.05); // salvo launch — tiny nose kick


        break;
      case WeaponType.ROCKET:
        this.audio.playRocketLaunch();
        // A3: backblast shove — heavy launches kick the hull backwards
        this.helicopter.addImpulse(-hDirX * 7, -hDirZ * 7);
        this.helicopter.triggerFirePitch(0.07);
        break;
      case WeaponType.SHOTGUN:
        this.audio.playShotgun(this.helicopter.body.position.x);
        this.helicopter.addImpulse(-hDirX * 3.5, -hDirZ * 3.5);
        break;
      default:
        this.audio.playMachineGun(this.helicopter.body.position.x);
    }

    const rightUnitX = Math.cos(heading);
    const rightUnitZ = -Math.sin(heading);
    const noseOffset = this.currentWeapon === WeaponType.SHOTGUN ? 3.1 : 2.55;
    const podSpacing =
      this.currentWeapon === WeaponType.MACHINE_GUN
        ? 0.0
        : this.currentWeapon === WeaponType.SHOTGUN
          ? 0.42
          : 3.0;
    const muzzleY =
      this.helicopter.body.position.y +
      (this.currentWeapon === WeaponType.MISSILE || this.currentWeapon === WeaponType.ROCKET ? -0.75 : -0.45);

    // Rank-5 signature alt-fires
    const mastered = level >= MAX_WEAPON_LEVEL;
    const altCountBonus =
      mastered && this.currentWeapon === WeaponType.MISSILE ? 1 : 0;

    // C6: hangar-selected weapon mod for this weapon (0 = factory config).
    const modChoice = this.weaponMods[this.currentWeapon] ?? 0;

    // Fire projectiles based on weapon config (level adds projectiles at rank 4+)
    const totalCount = weapon.count + lvlBonus.extraProjectiles + altCountBonus;
    for (let i = 0; i < totalCount; i++) {
      let dirX = hDirX;
      let dirZ = hDirZ;
      const side =
        totalCount === 1
          ? this.muzzleFlip
          : i - (totalCount - 1) / 2;

      // Apply spread for shotgun (and widened spread for leveled weapons)
      if (weapon.spread > 0) {
        // C6: Slug Barrel tightens the shotgun pattern
        const slugTighten = this.currentWeapon === WeaponType.SHOTGUN && modChoice === 2 ? 0.55 : 1;
        const spreadMul = (1 + (level - 1) * 0.1) * slugTighten;
        const angle = (i - (totalCount - 1) / 2) * weapon.spread * spreadMul;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        dirX = hDirX * cos - hDirZ * sin;
        dirZ = hDirX * sin + hDirZ * cos;
      }

      // Rank-5 alt-fire per weapon:
      // MG: tracer rounds ignore shields · Missile: double volley · Rocket: napalm blast
      // Shotgun: slug burst (tighter spread handled via spreadMul at max level)
      let damage = weapon.damage * lvlBonus.damageMult * dmgUp * afterburnerDmg;
      let blast = weapon.blastRadius;
      if (mastered) {
        if (this.currentWeapon === WeaponType.MACHINE_GUN) damage *= 1.25;
        if (this.currentWeapon === WeaponType.ROCKET) blast = Math.max(blast, 40);
        if (this.currentWeapon === WeaponType.SHOTGUN) damage *= 1.15;
      }
      // C6: weapon-mod stat changes (Slug +30% dmg, Napalm +30% blast)
      if (this.currentWeapon === WeaponType.SHOTGUN && modChoice === 2) damage *= 1.3;
      if (this.currentWeapon === WeaponType.ROCKET && modChoice === 1) blast *= 1.3;

      const spawnOffset = usingGun ? 0 : noseOffset;
      const shot = this.playerProjectiles.spawn(
        originX + hDirX * spawnOffset + rightUnitX * side * podSpacing,
        originY,
        originZ + hDirZ * spawnOffset + rightUnitZ * side * podSpacing,
        dirX,
        dirZ,
        time,
        weapon.speed,
        damage,
        blast,
        weapon.color,
        lockTarget,
        projectileAssist,
        usingGun ? dirY * weapon.speed : 0,
      );
      if (shot) this.tagProjectileWithMod(shot, modChoice);
    }
    if (totalCount === 1) this.muzzleFlip *= -1;

    // Weapon specific muzzle flash & shake (flash from the same origin as the bullets)
    const fxOffset = usingGun ? 0 : noseOffset;
    const fxX = originX + hDirX * fxOffset;
    const fxY = usingGun ? originY : muzzleY;
    const fxZ = originZ + hDirZ * fxOffset;
    
    // NOTE: MACHINE_GUN carries a small spread value (0.015 bullet spread), so
    // the shotgun branch must be keyed on the weapon TYPE, not spread > 0.
    if (this.currentWeapon === WeaponType.SHOTGUN) {
      // Shotgun Flash — no camera shake
      this.particles.spawnExplosion(fxX, fxY, fxZ, 15, time, 12);
    } else if (weapon.blastRadius > 0) {
      // Missile / Rocket backblast — tiny visual nose kick, no camera shake
      this.particles.spawnExplosion(fxX, fxY, fxZ, 8, time, 6);
      this.helicopter.triggerFirePitch(0.06);
    } else {
      // Machine Gun Sparks + barrel recoil (visual only — no camera shake)
      for(let s=0; s<2; s++) this.particles.spawnSparks(fxX, fxY, fxZ, time);
      this.helicopter.triggerRecoil(0.22);
    }

    // Auto-reload if out of ammo
    if (weapon.ammo <= 0) {
      this.startReload();
    }
  };

  /** C6/B1: stamp the active weapon mod onto a freshly spawned shot. */
  private tagProjectileWithMod(proj: Projectile, modChoice: number) {
    switch (this.currentWeapon) {
      case WeaponType.MACHINE_GUN:
        if (modChoice === 1) { proj.procKind = "burn"; proj.procChance = 0.18; } // Incendiary Rounds
        else if (modChoice === 2) proj.piercing = true;                            // Piercing Rounds
        break;
      case WeaponType.MISSILE:
        if (modChoice === 1) { proj.procKind = "emp"; proj.procChance = 1; }       // EMP Warheads
        else if (modChoice === 2) proj.cluster = true;                             // Cluster Warheads
        break;
      case WeaponType.ROCKET:
        if (modChoice === 1) { proj.procKind = "burn"; proj.procChance = 0.5; }    // Napalm Payload
        else if (modChoice === 2) proj.shaped = true;                              // Shaped Charge
        break;
      case WeaponType.SHOTGUN:
        if (modChoice === 1) { proj.procKind = "shock"; proj.procChance = 0.25; }  // Shock Shells
        break;
    }
  }

  /** B1/C6: roll a status proc for a hit. Mod-tagged shots roll their own
   *  chance; untagged shots can still proc from upgrade-pool picks. The
   *  procChance perk adds a bonus to every roll. */
  private tryApplyStatusProc(proj: Projectile, enemy: Enemy, time: number) {
    if (!enemy.active) return;
    const perkBonus = perkEffect("procChance", this.perks.procChance);
    if (proj.procKind && proj.procChance > 0) {
      const stacks = proj.procKind === "burn" ? this.runUpgrades.incendiary
        : proj.procKind === "emp" ? this.runUpgrades.empPayload
          : this.runUpgrades.shockCoils;
      if (Math.random() < statusProcChance(proj.procChance, perkBonus + stacks * 0.06)) {
        enemy.applyStatus(proj.procKind, time);
      }
      return;
    }
    if (this.runUpgrades.incendiary > 0 && Math.random() < statusProcChance(this.runUpgrades.incendiary * 0.06, perkBonus)) {
      enemy.applyStatus("burn", time);
    } else if (this.runUpgrades.shockCoils > 0 && Math.random() < statusProcChance(this.runUpgrades.shockCoils * 0.05, perkBonus)) {
      enemy.applyStatus("shock", time);
    } else if (this.runUpgrades.empPayload > 0 && proj.blastRadius > 0 && Math.random() < statusProcChance(this.runUpgrades.empPayload * 0.07, perkBonus)) {
      enemy.applyStatus("emp", time);
    }
  }

  /** C6: cluster warheads — 3 mini-blasts scatter around the impact point. */
  private spawnClusterBlasts(x: number, y: number, z: number, damage: number, time: number) {
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 8;
      const cx = x + Math.cos(angle) * dist;
      const cz = z + Math.sin(angle) * dist;
      this.particles.spawnExplosion(cx, y, cz, this.fxCount(45), time, 16);
      this.volumetricExplosions.spawn(cx, y, cz, 7, 4);
      this.shockwaves?.spawn(cx, 0.5, cz, time, 16, 0xffcc66, 0.5);
      for (const e of this.enemies) {
        if (!e.active) continue;
        const dx = e.body.position.x - cx;
        const dz = e.body.position.z - cz;
        if (dx * dx + dz * dz < 400) {
          if (e.takeDamage(damage * 0.4, time) === "destroyed") this.onEnemyDestroyed(e, time);
        }
      }
      this.city.damageNearby(cx, cz, 14, damage * 0.4);
    }
    this.audio.playExplosion(0.5);
  }

  /** B2: the nearest live VAMPIRIC enemy heals a fraction of confirmed damage. */
  private healVampiricEnemies(damageDealt: number, time: number) {
    let best: Enemy | null = null;
    let bestDistSq = 70 * 70;
    for (const e of this.enemies) {
      if (!e.active || !(e.modifier & EnemyModifier.VAMPIRIC)) continue;
      const d = e.body.position.distanceSquared(this.helicopter.body.position);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = e;
      }
    }
    if (!best) return;
    best.hp = Math.min(best.maxHp, best.hp + damageDealt * VAMPIRIC_HEAL_FRACTION);
    this.particles.spawnSparks(best.body.position.x, best.body.position.y, best.body.position.z, time, 2, 12);
  }

  /** B2: EXPLOSIVE affix — death detonation that hurts everything nearby
   *  (enemies, the player, and the city around the blast). */
  private detonateExplosiveAffix(enemy: Enemy, time: number) {
    const x = enemy.body.position.x;
    const y = enemy.body.position.y;
    const z = enemy.body.position.z;
    this.particles.spawnExplosion(x, y, z, this.fxCount(90), time, 28);
    this.volumetricExplosions.spawn(x, y, z, 14, 7);
    this.shockwaves?.spawn(x, 0.5, z, time, EXPLOSIVE_AFFIX_RADIUS * 1.5, 0xff7733, 0.6);
    this.audio.playExplosion(1.1);
    this.addExplosionImpulse(x, y, z, 2.2, EXPLOSIVE_AFFIX_RADIUS * 2.4);
    for (const other of this.enemies) {
      if (!other.active || other === enemy) continue;
      const d = Math.hypot(other.body.position.x - x, other.body.position.z - z);
      if (d < EXPLOSIVE_AFFIX_RADIUS) {
        const dmg = EXPLOSIVE_AFFIX_DAMAGE * (1 - d / EXPLOSIVE_AFFIX_RADIUS);
        if (other.takeDamage(dmg, time) === "destroyed") this.onEnemyDestroyed(other, time);
      }
    }
    const pd = Math.hypot(this.helicopter.body.position.x - x, this.helicopter.body.position.z - z);
    if (pd < EXPLOSIVE_AFFIX_RADIUS) {
      this.applyPlayerDamage(
        Math.round(EXPLOSIVE_AFFIX_DAMAGE * 0.5 * (1 - pd / EXPLOSIVE_AFFIX_RADIUS)),
        "EXPLOSIVE AFFIX", "EXPLOSIVE", time,
      );
    }
    this.city.damageNearby(x, z, EXPLOSIVE_AFFIX_RADIUS, 60);
  }

  /** B2: SPLITTER affix — death releases a ring of fragile kamikaze drones. */
  private spawnSplitterDrones(parent: Enemy) {
    const now = performance.now() / 1000;
    for (let i = 0; i < SPLITTER_DRONE_COUNT; i++) {
      const angle = (i / SPLITTER_DRONE_COUNT) * Math.PI * 2;
      const x = parent.body.position.x + Math.cos(angle) * 6;
      const z = parent.body.position.z + Math.sin(angle) * 6;
      const drone = new Enemy(
        this.scene,
        this.world,
        x,
        z,
        EnemyType.DRONE,
        Math.max(8, parent.body.position.y),
        { modifier: EnemyModifier.NONE, pattern: AttackPattern.KAMIKAZE, variant: EnemyVariant.STANDARD, isElite: false },
      );
      this.scaleEnemyForDifficulty(drone);
      drone.hp *= 0.5;
      drone.maxHp *= 0.5;
      this.enemies.push(drone);
      this.particles.spawnExplosion(x, drone.body.position.y, z, 20, now, 12);
    }
    this.announce("SPLITTER", "Drone swarm released", "#ffb84d");
  }

  /**
   * Full kill processing: XP, kill streaks, risk multiplier scoring,
   * hit-stop, power-up drops, and the death explosion.
   */
  private onEnemyDestroyed(enemy: Enemy, time: number, source: "WEAPON" | "BOMB" | "ENVIRONMENT" = "WEAPON") {
    if (this.processedEnemyDeaths.has(enemy)) return;
    this.processedEnemyDeaths.add(enemy);
    enemy.active = false;
    this.totalKills++;
    // B3: kills charge the Devastation meter (combo tiers accelerate it)
    if (this.superCooldownUntil <= time) {
      const chargeGain = superChargeForKill(this.comboCount, enemy.isElite, enemy.type === EnemyType.BOSS)
        * (1 + perkEffect("superCharge", this.perks.superCharge));
      this.superCharge = Math.min(SUPER_MAX_CHARGE, this.superCharge + chargeGain);
    }
    this.missionManager.reportEnemyDestroyed(
      enemy.missionTargetId,
      enemy.isElite,
      time,
      this.getMissionRuntimeSnapshot(),
      { x: enemy.body.position.x, y: enemy.body.position.y, z: enemy.body.position.z },
    );
    this.addThreat(enemy.type === EnemyType.BOSS ? 28 : enemy.isElite ? 7 : enemy.variant !== EnemyVariant.STANDARD ? 1.2 : 0.35);
    const bounty = securedEnemyBounty(enemy.type, enemy.isElite);
    if (bounty > 0) {
      this.delivery.awardCredits(bounty);
      this.addUnsecuredCredits(threatBonusFor(bounty, this.threatLevel));
    }
    if (enemy.type === EnemyType.BOSS) this.bossesDestroyed++;
    this.grantWeaponXp(this.lastFiredWeapon);

    // Kill streaks -> arcade announcements + slow-mo on multi-kills
    const now = time;
    if (now - this.lastKillTime < 1.4) {
      this.killStreakCount++;
    } else {
      this.killStreakCount = 1;
    }
    this.lastKillTime = now;
    const tier = multikillTier(this.killStreakCount);
    if (tier) {
      this.announce(tier.label, "", tier.color);
      this.audio.playKillCombo(Math.min(this.killStreakCount, 5));
      if (this.killStreakCount >= 3) {
        this.triggerHitStop(0.3, 0.35); // slow-mo on multi-kills
      }
    }

    // Risky Rendezvous: low health multiplies score (difficulty-scaled ceiling)
    const risk = riskMultiplier(this.health, this.maxHealth, this.difficulty.maxRisk);
    this.score += Math.floor(enemy.basePoints * this.comboMultiplier * risk);
    this.updateUI(time);

    // Trigger Hit-Stop for enemy kills to give a crunchy impact feel
    const stopDuration = enemy.type === EnemyType.BOSS ? 0.32 : enemy.type === EnemyType.TANK ? 0.12 : 0.06;
    const stopScale = enemy.type === EnemyType.BOSS ? 0.02 : 0.05;
    if (source !== "BOMB") this.triggerHitStop(stopDuration, stopScale);

    // Vampire-Survivors style: every kill drops an XP gem you fly through.
    // Gems are the upgrade currency — collect them to level up and roll.
    this.dropXpGem(
      enemy.body.position.x,
      enemy.body.position.y,
      enemy.body.position.z,
      xpForEnemyType(enemy.type, enemy.isElite, enemy.variant),
    );
    this.dropEnemyLoot(enemy);

    if (enemy.isElite) {
      this.announce("ELITE DESTROYED", `+${bounty} CR`, "#ffdd55");
    }

    if (enemy.type === EnemyType.BOSS) {
      this.announce("BOSS DESTROYED", `+${bounty} CR`, "#d78cff");
    }

    // Bigger explosion for enemies based on type
    const explosionSize = enemy.type === EnemyType.BOSS ? 200 : enemy.isElite ? 150 : enemy.type === EnemyType.TANK ? 120 : 80;
    const volumetricScale = enemy.type === EnemyType.BOSS ? 30 : enemy.isElite ? 24 : enemy.type === EnemyType.TANK ? 18 : 12;

    this.particles.spawnExplosion(
      enemy.body.position.x,
      enemy.body.position.y,
      enemy.body.position.z,
      explosionSize,
      time,
      explosionSize * 0.4,
    );
    // Debris chunks + smoke + sparks make each kill read as a real detonation
    // (boss/elites throw more debris, tanks kick up extra sparks).
    this.particles.spawnDebris(
      enemy.body.position.x,
      enemy.body.position.y,
      enemy.body.position.z,
      time,
      enemy.type === EnemyType.BOSS ? 30 : enemy.isElite ? 22 : enemy.type === EnemyType.TANK ? 16 : 8,
      enemy.type === EnemyType.BOSS ? 40 : 28,
    );
    this.particles.spawnSmoke(enemy.body.position.x, enemy.body.position.y + 1, enemy.body.position.z, time);
    this.particles.spawnSparks(
      enemy.body.position.x,
      enemy.body.position.y,
      enemy.body.position.z,
      time,
      enemy.type === EnemyType.TANK ? 6 : 3,
      enemy.type === EnemyType.BOSS ? 40 : 24,
    );
    this.volumetricExplosions.spawn(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z, volumetricScale, volumetricScale * 0.6);
    this.city.damageNearby(enemy.body.position.x, enemy.body.position.z, enemy.type === EnemyType.BOSS ? 40 : 22, 95);
    this.audio.playExplosion(enemy.type === EnemyType.BOSS ? 2.5 : 1.5);

    // B2: elite-affix death behaviors
    if (enemy.modifier & EnemyModifier.EXPLOSIVE) this.detonateExplosiveAffix(enemy, time);
    if (enemy.modifier & EnemyModifier.SPLITTER) this.spawnSplitterDrones(enemy);

    // A1/A3: heavy hulls shed rigid-body debris that tumbles and bounces
    if (enemy.type === EnemyType.TANK || enemy.type === EnemyType.BOSS) {
      this.debris?.spawn(
        enemy.body.position.x,
        enemy.body.position.y,
        enemy.body.position.z,
        time,
        this.fxCount(enemy.type === EnemyType.BOSS ? 10 : 6),
        20,
        0x3a4238,
        0.9,
      );
    }
  }

  /**
   * Grant weapon XP for a kill. Weapon levels persist to meta-progression
   * (hangar mastery) and passively buff that weapon — but they no longer open
   * the upgrade roulette. Run-level XP (collected gems) drives the roulette.
   */
  private grantWeaponXp(weapon: WeaponType) {
    const xp = (this.weaponXp.get(weapon) ?? 0) + 1;
    this.weaponXp.set(weapon, xp);
    const before = this.weaponLevels.get(weapon) ?? 1;
    const after = weaponLevelForXp(xp, MAX_WEAPON_LEVEL);
    if (after > before) {
      this.weaponLevels.set(weapon, after);
      // Persist to meta-progression (hangar screen)
      writeMastery(weapon, after);
      const altFire = after === MAX_WEAPON_LEVEL;
      this.announce(
        altFire ? `WEAPON MAXED` : `WEAPON LV.${after}`,
        altFire
          ? "Signature alt-fire unlocked"
          : `+${Math.round((after - 1) * 18)}% DMG`,
        "#7ee0ff",
      );
      if (altFire) {
        // Rank 5 is the cap — reward instead of a roulette
        this.maxHealth += 10;
        this.repairPlayer(10);
      }
      this.audio.playUpgrade();
    }
  }

  /**
   * Grant run-level XP from a collected gem. Each level crossed queues an
   * upgrade roulette — a big gem can queue several, offered one after another
   * so the player never skips a pick (VS boss-gem behavior).
   */
  private grantRunXp(amount: number, time: number) {
    // C5 perk: xpGain boosts every gem's XP yield.
    this.runXp += amount * (1 + perkEffect("xpGain", this.perks.xpGain));
    const nextLevel = runLevelForXp(this.runXp, MAX_RUN_LEVEL);
    if (nextLevel > this.runLevel) {
      this.pendingLevelUps += nextLevel - this.runLevel;
      this.runLevel = nextLevel;
      this.audio.playUpgrade();
      this.offerNextLevelUp();
    }
  }

  /** Open a roulette for one queued level-up (if any). */
  private offerNextLevelUp() {
    if (this.pendingLevelUps <= 0 || this.upgradePaused) return;
    this.pendingLevelUps--;
    this.announce("LEVEL UP!", `LV.${this.runLevel} — choose an upgrade`, "#7ee0ff");
    this.offerUpgrade();
  }

  switchWeapon = (weaponType: WeaponType) => {
    if (this.currentWeapon === weaponType) return;
    this.currentWeapon = weaponType;
    this.isReloading = false;
    this.reloadTimer = 0;
    this.updateUI(performance.now() / 1000);
  };

  startReload = () => {
    const weapon = this.weapons.get(this.currentWeapon);
    if (!weapon || weapon.ammo === weapon.maxAmmo || weapon.reloadTime === 0) return;
    this.isReloading = true;
    const level = this.weaponLevels.get(this.currentWeapon) ?? 1;
    const lvlBonus = weaponLevelBonus(level);
    const reloadUp = Math.max(0.4, 1 - this.runUpgrades.reload * 0.25);
    this.reloadTimer = weapon.reloadTime * lvlBonus.reloadMult * reloadUp;
    this.audio.playReload();
  };

  onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  findSalvoTarget(centerPoint: THREE.Vector3, radius: number): Enemy | null {
    let closestEnemy: Enemy | null = null;
    let minDist = radius;
    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
      const dx = enemy.body.position.x - centerPoint.x;
      const dz = enemy.body.position.z - centerPoint.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) {
        minDist = dist;
        closestEnemy = enemy;
      }
    }
    return closestEnemy;
  }

  updateSalvoIndicators(enemy: Enemy) {
    let group = this.salvoLockIndicators.get(enemy);
    if (!group) {
      group = new THREE.Group();
      group.position.copy(enemy.mesh.position);
      this.scene.add(group);
      this.salvoLockIndicators.set(enemy, group);
    }

    // Clear old rings in group
    while (group.children.length > 0) {
      const child = group.children[0] as THREE.Mesh;
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
      group.remove(child);
    }

    const lockCount = this.salvoLocks.filter((e) => e === enemy).length;

    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3344,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < lockCount; i++) {
      const r = 2.0 + i * 0.85;
      const geom = new THREE.RingGeometry(r, r + 0.15, 4); // Spinning diamond
      const mesh = new THREE.Mesh(geom, mat);
      mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);
    }
  }

  clearSalvoIndicators() {
    for (const group of this.salvoLockIndicators.values()) {
      group.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m: THREE.Material) => m.dispose());
          } else {
            mesh.material.dispose();
          }
        }
      });
      this.scene.remove(group);
    }
    this.salvoLockIndicators.clear();
  }

  startPaintingLocks() {
    if (!this.isPlaying || this.salvoCooldownTimer > 0) return;
    this.isPaintingLocks = true;
  }

  releaseSalvo() {
    if (!this.isPaintingLocks) return;
    this.isPaintingLocks = false;

    if (this.salvoLocks.length > 0) {
      const now = performance.now() / 1000;
      this.salvoLocks.forEach((enemy, index) => {
        const offsetAngle = (index / this.salvoLocks.length) * Math.PI * 2;
        const spawnX = this.helicopter.body.position.x + Math.sin(offsetAngle) * 4.5;
        const spawnZ = this.helicopter.body.position.z + Math.cos(offsetAngle) * 4.5;
        const spawnY = this.helicopter.body.position.y - 1;

        const dx = enemy.body.position.x - spawnX;
        const dz = enemy.body.position.z - spawnZ;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;

        // Spawn homing salvo missile
        this.playerProjectiles.spawn(
          spawnX,
          spawnY,
          spawnZ,
          dx / len,
          dz / len,
          now,
          265, // speed
          55,  // damage
          12,  // blastRadius
          0xff3344, // colorHex
          enemy, // target
          8.0 // homingStrength
        );
      });

      this.audio.playMissileLaunch();
      this.helicopter.triggerFirePitch(0.05); // salvo launch — tiny nose kick
      this.salvoCooldownTimer = this.getEffectiveSalvoCooldown();
      this.salvoLocks = [];
      this.clearSalvoIndicators();
      this.updateUI(now);
    }
  }

  dropPowerUp = (x: number, y: number, z: number) => {
    let type: PowerUpType;
    const rand = Math.random();
    
    const weapon = this.weapons.get(this.currentWeapon);
    const lowHealth = this.health < 40;
    const lowFuel = this.currentFuel < 35;
    const lowAmmo = weapon && (weapon.ammo / weapon.maxAmmo) < 0.25;
    
    if (lowHealth && Math.random() < 0.5) {
      type = PowerUpType.HEALTH;
    } else if (lowFuel && Math.random() < 0.5) {
      type = PowerUpType.FUEL;
    } else if (lowAmmo && Math.random() < 0.5) {
      type = PowerUpType.AMMO;
    } else {
      if (rand < 0.22) type = PowerUpType.HEALTH;
      else if (rand < 0.38) type = PowerUpType.FUEL;
      else if (rand < 0.52) type = PowerUpType.AMMO;
      else if (rand < 0.68) type = PowerUpType.DAMAGE_BOOST;
      else if (rand < 0.82) type = PowerUpType.SHIELD;
      else if (rand < 0.92) type = PowerUpType.SPEED_BOOST;
      else type = PowerUpType.BOMB;
    }

    const pu = new PowerUp(this.scene, x, y + 2, z, type);
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  };

  /** Drop a small XP gem worth `value` run XP (VS-style upgrade currency). */
  dropXpGem = (x: number, y: number, z: number, value: number) => {
    const pu = new PowerUp(this.scene, x, y + 2, z, PowerUpType.XP_GEM);
    pu.value = value;
    pu.spawnTime = performance.now() / 1000;
    this.powerups.push(pu);
  };

  private dropLootPickup(x: number, y: number, z: number, type: PowerUpType, value = 1) {
    const pickup = new PowerUp(this.scene, x, y + 2, z, type);
    pickup.spawnTime = performance.now() / 1000;
    pickup.value = value;
    this.powerups.push(pickup);
  }

  private dropEnemyLoot(enemy: Enemy) {
    const tier = enemy.type === EnemyType.BOSS
      ? "BOSS" as const
      : enemy.isElite
        ? "ELITE" as const
        : enemy.variant !== EnemyVariant.STANDARD || enemy.type === EnemyType.TANK
          ? "SPECIAL" as const
          : "BASIC" as const;
    const plan = rollLoot(tier, Math.random(), Math.random());
    const { x, y, z } = enemy.body.position;
    if (plan.salvage > 0) this.dropLootPickup(x - 1.2, y, z, PowerUpType.SALVAGE, plan.salvage);
    if (plan.powerup !== null) this.dropLootPickup(x + 1.2, y, z, plan.powerup);
    if (plan.countermeasure) this.dropLootPickup(x, y, z + 1.5, PowerUpType.COUNTERMEASURE);
  }

  applyPowerUp = (type: PowerUpType, time: number) => {
    switch (type) {
      case PowerUpType.HEALTH:
        // Cap at the actual max (hangar armor / maxed weapons push it past 100)
        // so health pickups never silently waste healing.
        this.repairPlayer(30);
        break;
      case PowerUpType.AMMO:
        const weapon = this.weapons.get(this.currentWeapon);
        if (weapon) weapon.ammo = weapon.maxAmmo;
        break;
      case PowerUpType.DAMAGE_BOOST:
        for (const [wType, config] of this.weapons.entries()) {
          config.damage = WEAPON_CONFIGS[wType].damage * 2;
        }
        this.damageBoostTimer = 10.0;
        break;
      case PowerUpType.SHIELD:
        this.shieldTimer = 8.0;
        break;
      case PowerUpType.SPEED_BOOST:
        this.speedBoostTimer = 6.0;
        break;
      case PowerUpType.FUEL:
        this.currentFuel = Math.min(this.maxFuel, this.currentFuel + 35);
        break;
      case PowerUpType.BOMB:
        // Every damage source uses the same idempotent enemy-death pipeline.
        let bombKills = 0;
        for (const e of this.enemies) {
          if (!e.active) continue;
          bombKills++;
          this.onEnemyDestroyed(e, time, "BOMB");
        }
        // One combined streak announcement + hit-stop for the whole nuke
        if (bombKills > 0) {
          const tier = multikillTier(this.killStreakCount);
          if (tier) {
            this.announce(tier.label, "", tier.color);
            this.audio.playKillCombo(Math.min(this.killStreakCount, 5));
            if (this.killStreakCount >= 3) this.triggerHitStop(0.25, 0.2);
          }
        }
        this.score += 150;
        // Mega payoff at the player: big blast + shockwave so the bomb always reads
        const bx = this.helicopter.body.position.x;
        const by = this.helicopter.body.position.y;
        const bz = this.helicopter.body.position.z;
        this.particles.spawnExplosion(bx, by, bz, 160, time, 60);
        this.volumetricExplosions.spawn(bx, by, bz, 26, 10);
        this.shockwaves?.spawn(bx, 0.5, bz, time, 90, 0xffaa44, 1.0);
        this.addExplosionImpulse(bx, by, bz, 2.0, 110);
        this.audio.playExplosion(2.0);
        this.addCameraImpulse(4.5); // BOMB payoff at the player
        this.announce(
          '💥 BOMB AWAY!',
          bombKills > 0 ? `Wiped out ${bombKills} enemies` : '+150 PTS — no enemies in range',
          '#ff8800',
        );
        break;
      case PowerUpType.SALVAGE:
      case PowerUpType.COUNTERMEASURE:
      case PowerUpType.XP_GEM:
        break;
    }
    this.updateUI(time);
  };

  /** 0..1 progress toward the next run level (for the HUD XP bar). */
  runXpProgress(): number {
    if (this.runLevel >= MAX_RUN_LEVEL) return 1;
    const current = runXpForLevel(this.runLevel);
    const next = runXpForLevel(this.runLevel + 1);
    return Math.min(1, Math.max(0, (this.runXp - current) / (next - current)));
  }

  updateUI(time: number) {
    this.emitStatsIfChanged();
    if (this.isPlaying && time - this.lastUiUpdateTime < 1 / 12) return;
    this.lastUiUpdateTime = time;

    const weapon = this.weapons.get(this.currentWeapon);
    const boss =
      this.enemies.find((e) => e.active && e.type === EnemyType.BOSS) ?? null;

    // Flush pending arcade announcements (kill streaks, objectives, phases)
    if (this.announceQueue.length > 0) {
      const next = this.announceQueue.shift()!;
      window.dispatchEvent(
        new CustomEvent("helistrike:announce", { detail: next }),
      );
    }

    const risk = riskMultiplier(this.health, this.maxHealth, this.difficulty.maxRisk);
    const objectives = {
      sam: this.objectives.some((o) => o.active && o.type === ObjectiveType.SAM_SITE),
      radar: this.objectives.some((o) => o.active && o.type === ObjectiveType.RADAR_TOWER),
      depot: this.objectives.some((o) => o.active && o.type === ObjectiveType.AMMO_DEPOT),
      count: this.objectives.filter((o) => o.active).length,
    };
    const delivery = this.delivery.getHudSnapshot(this.helicopter.body.position, time);

    window.dispatchEvent(
      new CustomEvent("helistrike:update", {
        detail: {
          score: this.score,
          health: this.health,
          maxHealth: this.maxHealth,
          fuel: this.currentFuel,
          rotorHealth: this.helicopter.rotorHealth,
          engineHealth: this.helicopter.engineHealth,
          wave: this.currentWave,
          elapsed: this.survivalTime,
          message: this.waveTransitionTimer > 0 ? this.waveMessage : null,
          playing: this.isPlaying,
          runLevel: this.runLevel,
          runXpProgress: this.runXpProgress(),
          weapon: weapon ? {
            name: weapon.name,
            ammo: weapon.ammo,
            maxAmmo: weapon.maxAmmo,
            type: this.currentWeapon,
            reloading: this.isReloading,
            reloadTimer: this.reloadTimer,
            level: this.weaponLevels.get(this.currentWeapon) ?? 1,
          } : null,
          combo: {
            count: this.comboCount,
            multiplier: this.comboMultiplier,
            timer: this.comboTimer,
          },
          salvo: {
            locks: this.salvoLocks.length,
            cooldown: Math.ceil(this.salvoCooldownTimer),
            isPainting: this.isPaintingLocks,
            ready: this.salvoCooldownTimer <= 0 && this.isPlaying,
          },
          status: {
            damageBoost: this.damageBoostTimer,
            shield: this.shieldTimer,
            speedBoost: this.speedBoostTimer,
            threat: this.combatIntensity,
            afterburner: this.afterburnerActive,
            risk: risk > 1 ? risk : null,
          },
          boss: boss ? { hp: Math.max(0, boss.hp), maxHp: boss.maxHp, phase: boss.phase } : null,
          objectives,
          samThreat: this.getSamThreat(),
          countermeasures: {
            charges: this.countermeasures.charges,
            maxCharges: this.countermeasures.maxCharges,
            cooldown: this.countermeasures.cooldownRemaining,
            ready: this.countermeasures.charges > 0 && this.countermeasures.cooldownRemaining <= 0,
          },
          threatSystem: {
            points: this.threatPoints,
            level: this.threatLevel,
            name: THREAT_NAMES[this.threatLevel - 1],
            rewardMultiplier: threatRewardMultiplier(this.threatLevel),
          },
          super: {
            charge: this.superCharge,
            ready: this.superCharge >= SUPER_MAX_CHARGE && time >= this.superCooldownUntil && this.superActiveUntil <= time,
            activeRemaining: Math.max(0, this.superActiveUntil - time),
            cooldownRemaining: Math.max(0, this.superCooldownUntil - time),
          },
          unsecuredCredits: this.unsecuredCredits,
          mission: this.missionManager.getHudSnapshot(),
          radarLinked: this.radarActive && this.samActive,
          salvage: this.runSalvage,
          salvageCredits: salvageCreditsFor(this.runSalvage),
          extraction: this.extractionPosition ? {
            distance: Math.round(Math.hypot(this.extractionPosition.x - this.helicopter.body.position.x, this.extractionPosition.z - this.helicopter.body.position.z)),
            bearing: Math.atan2(this.extractionPosition.x - this.helicopter.body.position.x, -(this.extractionPosition.z - this.helicopter.body.position.z)) * 180 / Math.PI,
            progress: this.extractionProgress,
            active: this.extractionPressure,
            carrying: this.delivery.isCarrying(),
          } : null,
          delivery,
          credits: this.delivery.credits,
        },
      }),
    );
    this.emitMinimap(time);
  }

  /**
   * Tactical radar snapshot for the minimap HUD. Piggybacks on updateUI's
   * ~12 Hz cadence and carries only positions — never entity objects. Regular
   * enemies are filtered to the radar radius; the boss stays visible anywhere.
   */
  private emitMinimap(time: number) {
    if (!this.isPlaying) return;
    const range = 430;
    const rangeSq = range * range;
    const playerPos = this.helicopter.body.position;

    const enemies: MinimapSnapshot["enemies"] = [];
    for (const e of this.enemies) {
      if (!e.active) continue;
      const isBoss = e.type === EnemyType.BOSS;
      const dx = e.body.position.x - playerPos.x;
      const dz = e.body.position.z - playerPos.z;
      if (!isBoss && dx * dx + dz * dz > rangeSq) continue;
      enemies.push({
        x: e.body.position.x,
        z: e.body.position.z,
        type: e.type,
        variant: e.variant,
        elite: e.isElite,
        boss: isBoss,
      });
    }

    const contract = this.delivery.activeContract;
    let delivery: MinimapSnapshot["delivery"] = null;
    if (contract && contract.state !== DeliveryState.FAILED) {
      delivery = {
        origin: { x: contract.originPosition.x, z: contract.originPosition.z },
        destination: { x: contract.destinationPosition.x, z: contract.destinationPosition.z },
        carrying:
          contract.state === DeliveryState.CARRYING ||
          contract.state === DeliveryState.DELIVERING,
        state: contract.state,
      };
    }

    const objectives: MinimapSnapshot["objectives"] = [];
    for (const o of this.objectives) {
      if (!o.active) continue;
      objectives.push({
        type: o.type,
        x: o.position.x,
        z: o.position.z,
        samState: o.samState ?? undefined,
        detectionRange: o.type === ObjectiveType.SAM_SITE ? SAM_DETECTION_RANGE : undefined,
      });
    }

    const threats: MinimapSnapshot["threats"] = [];
    for (const projectile of this.enemyProjectiles.pool) {
      if (!projectile.active || projectile.homingStrength <= 0) continue;
      threats.push({ x: projectile.pos.x, z: projectile.pos.z, kind: "HOMING_MISSILE", target: projectile.targetType });
    }

    const activeMission = this.missionManager.activeMission;
    let mission: MinimapSnapshot["mission"] = null;
    if (activeMission) {
      let target = activeMission.destination ?? activeMission.origin;
      if (activeMission.targetKind === "ELITE" && activeMission.targetId) {
        const elite = this.enemies.find((enemy) => enemy.active && enemy.missionTargetId === activeMission.targetId);
        if (elite) target = { x: elite.body.position.x, y: elite.body.position.y, z: elite.body.position.z };
      }
      if (activeMission.type === MissionType.ESCORT) {
        // C2: pin the escort marker to the moving convoy, not the route end.
        target = convoyPositionAt(activeMission, time);
      }
      if (target) mission = { x: target.x, z: target.z, type: activeMission.type, targetKind: activeMission.targetKind };
    }

    window.dispatchEvent(
      new CustomEvent("helistrike:minimap", {
        detail: {
          player: { x: playerPos.x, y: playerPos.y, z: playerPos.z, heading: this.helicopter.mesh.rotation.y },
          enemies,
          delivery,
          objectives,
          threats,
          extraction: this.extractionPosition
            ? {
                x: this.extractionPosition.x,
                z: this.extractionPosition.z,
                active: this.extractionPressure,
                radius: GameEngine.EXTRACTION_ZONE_RADIUS,
                elevation: this.extractionPosition.y,
              }
            : null,
          mission,
          range,
        } as MinimapSnapshot,
      }),
    );
  }

  emitStatsIfChanged(force = false) {
    const nextHealth = Math.round(THREE.MathUtils.clamp(this.health, 0, this.maxHealth));
    const nextFuel = Math.round(THREE.MathUtils.clamp(this.currentFuel, 0, this.maxFuel));

    if (
      !force &&
      nextHealth === this.lastStatsHealth &&
      nextFuel === this.lastStatsFuel
    ) {
      return;
    }

    this.lastStatsHealth = nextHealth;
    this.lastStatsFuel = nextFuel;
    window.dispatchEvent(
      new CustomEvent("helistrike:stats", {
        detail: {
          currentHealth: nextHealth,
          maxHealth: this.maxHealth,
          currentFuel: nextFuel,
          maxFuel: this.maxFuel,
        },
      }),
    );
  }

  dispatchGameOver(time: number, status: "DESTROYED" | "EXTRACTED" = "DESTROYED", securedThreatBonus = 0, extractedSalvage = 0) {
    if (this.gameOverDispatched) return;
    this.gameOverDispatched = true;
    // C7: every finished run lands in the persisted run history.
    recordRun({
      score: this.score,
      wave: this.currentWave,
      kills: this.totalKills,
      accuracy: accuracyFor(this.shotsHit, this.shotsFired),
      survivalTime: this.survivalTime,
      victory: status === "EXTRACTED",
      at: Date.now(),
    });
    const lostUnsecured = status === "DESTROYED" ? this.unsecuredCredits : 0;
    const lostSalvage = status === "DESTROYED" ? this.runSalvage : 0;
    if (status === "DESTROYED") {
      this.delivery.fail("PLAYER DOWN");
      this.unsecuredCredits = 0;
      this.runSalvage = 0;
      this.spawnPlayerExplosion();
    }
    this.clearExtraction();
    this.isPlaying = false;
    this.audio.stopMusic();
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    this.movementKeys.clear();
    window.dispatchEvent(
      new CustomEvent("helistrike:gameover", {
        detail: {
          score: this.score,
          wave: this.currentWave,
          time,
          kills: this.totalKills,
          maxCombo: this.maxCombo,
          survivalTime: this.survivalTime,
          accuracy: accuracyFor(this.shotsHit, this.shotsFired),
          status,
          threatLevel: this.threatLevel,
          deliveries: this.deliveriesCompleted,
          samSitesDestroyed: this.samSitesDestroyed,
          radarSitesDestroyed: this.radarSitesDestroyed,
          bossesDestroyed: this.bossesDestroyed,
          missionsCompleted: this.missionsCompleted,
          missionBonusesCompleted: this.missionBonusesCompleted,
          salvage: status === "EXTRACTED" ? extractedSalvage : lostSalvage,
          lostUnsecured,
          securedThreatBonus,
          credits: this.delivery.credits,
        },
      }),
    );
    this.updateUI(time);
  }

  /** Player destruction — big layered explosion at the wreck: fireball
   *  particles, debris chunks, smoke, sparks, volumetric fire, camera impulse
   *  and the big boom sound. The helicopter mesh is hidden so the wreck doesn't
   *  linger, and `Helicopter.reset()` restores visibility on restart. */
  private spawnPlayerExplosion() {
    const p = this.helicopter.body.position;
    const now = performance.now() / 1000;
    this.particles.spawnExplosion(p.x, p.y, p.z, 220, now, 46);
    this.particles.spawnDebris(p.x, p.y, p.z, now, 26, 34);
    this.particles.spawnSmoke(p.x, p.y + 2, p.z, now);
    this.particles.spawnSparks(p.x, p.y, p.z, now, 10, 26);
    this.volumetricExplosions.spawn(p.x, p.y, p.z, 36, 22);
    this.city.damageNearby(p.x, p.z, 30, 120);
    this.addCameraImpulse(6.0);
    if (this.audio) this.audio.playBigExplosion(1.6);
    this.helicopter.mesh.visible = false;
  }

  startNextWave() {
    if (this.currentWave > 0) this.announce("WAVE COMPLETE", `Wave ${this.currentWave + 1} incoming`, "#7ee0ff");
    this.currentWave++;
    // C3: seeded night-op roll per wave — the palette eases in and back out.
    const night = nightOpForWave(this.currentWave, this.nightSeed);
    if (night !== this.nightOpsActive) {
      this.nightOpsActive = night;
      this.nightBlendTarget = night ? 1 : 0;
      if (night) this.announce("NIGHT OPS", "Low visibility — lights on", "#8fb7ff");
    }
    this.totalEnemiesInWave = waveEnemyCount(this.currentWave);
    this.enemiesSpawnedInWave = 0;
    this.spawnTimer = 1.2;
    this.minibossSpawnedThisWave = false;
    this.waveThreatBudgetRemaining = Math.round(waveThreatBudget(this.currentWave, this.threatLevel) * this.difficulty.threatBudget);
    this.pendingVariantQueue.length = 0;

    // Determine wave theme / message
    if (this.currentWave % 10 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\n⚠ BOSS BATTLE ⚠`;
    } else if (this.currentWave % 5 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\nMINIBOSS INBOUND`;
    } else if (this.currentWave === 1) {
      this.waveMessage = "WAVE 1\nENGAGE THE DRONES";
    } else if (this.currentWave === 3) {
      this.waveMessage = "WAVE 3\nSTORM INCOMING";
    } else if (this.currentWave % 4 === 0) {
      this.waveMessage = `WAVE ${this.currentWave}\nSWARM TACTICS`;
      this.totalEnemiesInWave += 10; // Extra enemies on swarm waves
    } else {
      this.waveMessage = `WAVE ${this.currentWave}`;
    }

    // Destroyable objectives: spawn on the battlefield (ahead of the player)
    const objectiveCount = Math.min(2, 1 + Math.floor(this.currentWave / 4));
    for (let i = 0; i < objectiveCount; i++) {
      this.spawnObjective();
    }

    // Dynamic Weather based on wave
    if (this.currentWave >= 3) {
      this.weather.targetIntensity = Math.min(
        1.0,
        (this.currentWave - 2) * 0.25,
      );
      this.rain.mesh.visible = true;
    }

    // Time-driven waves never "clear", so the milestone reward is a modest
    // heal rather than a full wave-clear top-up.
    const healing = 10 + this.currentWave; // More healing on higher waves
    this.repairPlayer(healing);

    this.waveTransitionTimer = 2.0; // Brief breather before the next horde surge
    this.updateUI(performance.now() / 1000);
  }

  /**
   * Ambient rooftop turrets: track the player, fire tracer shots,
   * and die with their host building.
   */
  /** Billowing smoke + embers linger at the impact site after a hard crash. */
  private updateCrashSmoke(delta: number, time: number) {
    if (this.crashSmokeTimer > 0 && this.crashSmokePos) {
      this.crashSmokeTimer -= delta;
      const p = this.crashSmokePos;
      if (Math.random() < 0.85) {
        this.particles.spawnSmoke(
          p.x + (Math.random() - 0.5) * 2.5,
          p.y + Math.random() * 3,
          p.z + (Math.random() - 0.5) * 2.5,
          time,
        );
      }
      if (Math.random() < 0.3) {
        this.particles.spawnSparks(
          p.x + (Math.random() - 0.5) * 2,
          p.y + Math.random() * 2,
          p.z + (Math.random() - 0.5) * 2,
          time,
        );
      }
    } else {
      this.crashSmokePos = null;
    }
  }

  private updateTurrets(time: number, delta: number) {
    const px = this.helicopter.body.position.x;
    const pz = this.helicopter.body.position.z;
    const py = this.helicopter.body.position.y;

    for (const t of this.city.turrets) {
      t.updateHitFlash(delta);
      // Host building destroyed (or turret destroyed) → hide the ghost mesh
      if (t.isGone()) {
        t.mesh.visible = false;
        continue;
      }
      const dx = t.position.x - px;
      const dz = t.position.z - pz;
      const distSq = dx * dx + dz * dz;
      // Hide far-away turrets (they cull with their chunk anyway)
      if (distSq > 300 * 300) {
        t.mesh.visible = false;
        continue;
      }
      t.mesh.visible = true;
      if (distSq > t.range * t.range) continue;

      // First frame this turret is in range: arm its fire timer (no instant fire)
      if (t.lastShotTime === Number.POSITIVE_INFINITY) {
        t.lastShotTime = time;
        continue;
      }
      t.aimAt(px, py, pz, time);
      const altDiff = Math.abs(py - t.position.y);
      if (altDiff > 42 || time - t.lastShotTime < t.fireInterval) continue;

      t.lastShotTime = time;
      const m = t.getMuzzle();
      // Lead the player using their REAL velocity over the round's flight time
      // (~0.3s) — the old constant 28 u/s scroll assumption mis-led every shot.
      const LEAD_T = 0.3;
      const hv = this.helicopter.body.velocity;
      const ax = px + hv.x * LEAD_T - m.x;
      const ay = py + hv.y * LEAD_T - m.y;
      const az = pz + hv.z * LEAD_T - m.z;
      const len3 = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      const dirY = (ay / len3) * 185; // vertical velocity component
      const hlen = Math.hypot(ax, az) || 1;
      const spreadX = (Math.random() - 0.5) * 0.09;
      const spreadZ = (Math.random() - 0.5) * 0.09;
      this.enemyProjectiles.spawn(
        m.x,
        m.y,
        m.z,
        ax / hlen + spreadX,
        az / hlen + spreadZ,
        time,
        185,
        6,
        0,
        0xffaa44,
        null,
        0,
        dirY,
        0,
        waveEnemyDamage(this.currentWave),
      );
      this.particles.spawnSparks(m.x, m.y, m.z, time);
      if (time - this.lastEnemyFireSoundTime >= 0.15) {
        this.audio.playEnemyFire();
        this.lastEnemyFireSoundTime = time;
      }
    }
  }

  private launchSamMissile(sam: Objective, time: number) {
    const launch = sam.getSamLaunchPosition();
    const player = this.helicopter.body.position;
    const dx = player.x - launch.x;
    const dz = player.z - launch.z;
    const horizontal = Math.max(0.001, Math.hypot(dx, dz));
    const speed = 112;
    const projectile = this.enemyProjectiles.spawn(
      launch.x, launch.y, launch.z,
      dx / horizontal, dz / horizontal,
      time, speed, 15, 8, 0xff4938,
      { body: this.helicopter.body, active: true },
      SAM_MISSILE_TURN_RATE,
      ((player.y - launch.y) / horizontal) * speed,
      0,
      waveEnemyDamage(this.currentWave),
    );
    if (!projectile) return;
    projectile.configureSamMissile(sam);
    this.particles.spawnSmoke(launch.x, launch.y, launch.z, time);
    this.particles.spawnSparks(launch.x, launch.y, launch.z, time);
    this.audio.playSamMissileLaunch();
  }

  private getSamThreat() {
    const player = this.helicopter.body.position;
    let nearestMissile: Projectile | null = null;
    let missileDistance = Infinity;
    for (const projectile of this.enemyProjectiles.pool) {
      if (
        !projectile.active ||
        projectile.homingStrength <= 0 ||
        projectile.target?.body !== this.helicopter.body
      ) continue;
      const distance = Math.hypot(projectile.pos.x - player.x, projectile.pos.z - player.z);
      if (distance < missileDistance) {
        missileDistance = distance;
        nearestMissile = projectile;
      }
    }
    if (nearestMissile) {
      return {
        state: "INBOUND" as const,
        progress: 1,
        distance: Math.round(missileDistance),
        bearing: Math.atan2(nearestMissile.pos.x - player.x, -(nearestMissile.pos.z - player.z)) * 180 / Math.PI,
      };
    }
    let best: Objective | null = null;
    for (const objective of this.objectives) {
      if (!objective.active || objective.type !== ObjectiveType.SAM_SITE) continue;
      if (objective.samState !== SamState.LOCKING && objective.samState !== SamState.TRACKING) continue;
      if (!best || objective.samLockProgress > best.samLockProgress) best = objective;
    }
    if (!best) return null;
    return {
      state: best.samState === SamState.LOCKING ? "LOCKING" as const : "TRACKING" as const,
      progress: best.samLockProgress,
      distance: Math.round(best.distanceTo(player.x, player.z)),
      bearing: Math.atan2(best.position.x - player.x, -(best.position.z - player.z)) * 180 / Math.PI,
    };
  }

  /** Spawn a spaced rooftop or ground emplacement ahead of the player. */
  private spawnObjective() {
    const player = this.helicopter.body.position;
    const lanes = [-120, -78, -48, -24, 0, 24, 48, 78, 120];
    const roll = Math.random();
    let type = ObjectiveType.SAM_SITE;
    if (this.currentWave >= 3 && roll >= 0.52) type = ObjectiveType.RADAR_TOWER;
    const samCap = this.currentWave < 4 ? 1 : 2;
    const activeSams = this.objectives.filter((o) => o.active && o.type === ObjectiveType.SAM_SITE).length;
    if (type === ObjectiveType.SAM_SITE && activeSams >= samCap) type = ObjectiveType.RADAR_TOWER;

    let laneX = 0;
    let z = player.z - 160;
    let y = 2;
    let placed = false;
    for (let attempt = 0; attempt < 10 && !placed; attempt++) {
      const rooftop = type === ObjectiveType.SAM_SITE && Math.random() < 0.46
        ? this.city.rooftopSpots.filter((spot) =>
            spot.y >= 8 &&
            spot.z < player.z - 105 &&
            spot.z > player.z - 245 &&
            Math.abs(spot.x) < 145)
        : [];
      if (rooftop.length > 0) {
        const spot = rooftop[Math.floor(Math.random() * rooftop.length)];
        laneX = spot.x;
        z = spot.z;
        y = spot.y;
      } else {
        laneX = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 14;
        z = player.z - 130 - Math.random() * 110;
        y = this.city.getHeightAt(laneX, z, 4);
        if (y < 3) y = 2;
      }
      placed = this.objectives.every((o) => !o.active || Math.hypot(o.position.x - laneX, o.position.z - z) >= SAM_MIN_SPACING);
    }
    if (!placed) return;

    const obj = new Objective(this.scene, this.world, laneX, y, z, type);
    this.objectiveMissionId(obj);
    obj.spawnTime = performance.now() / 1000;
    // Ground-level objectives get a type-aware emplacement (Pass 7): military
    // pad for SAM sites, technical layout for radar towers, supply yard for
    // depots. The group is detached automatically when the objective dies.
    if (y <= 3.5) obj.propGroup = this.city.addObjectiveProps(laneX, z, obj.type);
    // Difficulty-scaled objective hull (capped so objectives never become sponges)
    const hpMult = Math.min(1.2, this.difficulty.objectiveHp);
    if (hpMult !== 1) {
      obj.maxHp = Math.max(40, Math.round(obj.maxHp * hpMult));
      obj.hp = obj.maxHp;
    }
    this.objectives.push(obj);
    this.announce(
      type === ObjectiveType.SAM_SITE
        ? "SAM SITE ONLINE"
        : "RADAR TOWER DETECTED",
      "Destroy it to shift the battle",
      "#ff5566",
    );
  }

  /** Apply a destroyable objective's battlefield effect. */
  private destroyObjective(obj: Objective, time: number) {
    if (obj.type === ObjectiveType.SAM_SITE || obj.type === ObjectiveType.RADAR_TOWER) {
      this.missionManager.reportObjectiveDestroyed(
        this.objectiveMissionId(obj),
        obj.type === ObjectiveType.SAM_SITE ? "SAM" : "RADAR",
        time,
        this.getMissionRuntimeSnapshot(),
      );
    }
    // C1: objectives feed the extraction offer gate.
    this.objectivesDestroyedThisRun++;
    this.score += Math.floor(obj.basePoints * this.comboMultiplier);
    this.particles.spawnExplosion(obj.position.x, obj.position.y, obj.position.z, 160, time, 50);
    this.volumetricExplosions.spawn(obj.position.x, obj.position.y, obj.position.z, 22, 9);
    this.addExplosionImpulse(obj.position.x, obj.position.y, obj.position.z, 4.5);
    this.audio.playExplosion(2.0);
    this.triggerHitStop(0.24, 0.05);
    const securedReward = securedObjectiveReward(obj.type);
    this.delivery.awardCredits(securedReward);
    this.addUnsecuredCredits(threatBonusFor(securedReward, this.threatLevel));
    this.addSalvage(salvageForObjective(obj.type));

    if (obj.type === ObjectiveType.SAM_SITE) {
      this.samSitesDestroyed++;
      this.addThreat(8);
      this.samSuppressionTimer = 18; // enemies fire slower for 18s
      this.announce("SAM DESTROYED", `+${securedReward} CR - airspace safer`, "#35e66d");
    } else if (obj.type === ObjectiveType.RADAR_TOWER) {
      this.radarSitesDestroyed++;
      this.addThreat(7);
      // EMP: damage all enemies
      for (const e of this.enemies) {
        if (e.active) {
          e.takeDamage(30, time);
        }
      }
      this.announce("RADAR DESTROYED", `+${securedReward} CR · enemy detection reduced`, "#7ee0ff");
    } else {
      // AMMO_DEPOT: guaranteed bomb power-up (as advertised) + ammo refill
      const bomb = new PowerUp(
        this.scene,
        obj.position.x,
        obj.position.y + 2,
        obj.position.z,
        PowerUpType.BOMB,
      );
      bomb.spawnTime = time;
      this.powerups.push(bomb);
      const weapon = this.weapons.get(this.currentWeapon);
      if (weapon) weapon.ammo = weapon.maxAmmo;
      this.announce("AMMO DEPOT SECURED", `+${securedReward} CR - bomb drop`, "#ffaa33");
    }
    this.updateUI(time);
  }

  spawnEnemy() {
    // --- Threat-budget variant director ---
    // Squads take priority: a picked composition queues its remaining members
    // into pendingVariantQueue, drained one per cadence tick below, so a squad
    // arrives as a staggered stream instead of a single-frame model spike.
    let variant: EnemyVariant | null = null;
    const directorConfig = threatDirectorConfig(this.threatLevel);
    const directorWave = Math.max(this.currentWave, this.threatLevel * 2 - 1) + directorConfig.directorWaveBonus;
    if (this.waveThreatBudgetRemaining < 1) return false;
    if (this.pendingVariantQueue.length > 0) {
      variant = this.pendingVariantQueue.shift()!;
    } else {
      const squad = pickSquadForWave(directorWave, () => Math.max(0, Math.random() - directorConfig.squadChanceBonus - this.difficulty.specialChance));
      if (squad && squad.length > 0 && compositionFitsBudget(squad, this.waveThreatBudgetRemaining)) {
        variant = squad[0];
        this.pendingVariantQueue.push(...squad.slice(1, SPAWN_CONFIG.maxQueue));
      } else {
        variant = pickEnemyVariant(directorWave);
      }
    }

    // Per-variant soft caps: never stack unfair support/missile/rare units.
    // If this variant is at its battlefield cap, fall back to the base hull.
    let vConfig = ENEMY_VARIANTS[variant];
    if (vConfig.maxActive !== undefined) {
      let active = 0;
      for (const e of this.enemies) if (e.active && e.variant === variant) active++;
      if (active >= vConfig.maxActive) {
        variant = EnemyVariant.STANDARD;
        vConfig = ENEMY_VARIANTS[variant];
      }
    }
    const type = vConfig.baseType;
    if (vConfig.threat > this.waveThreatBudgetRemaining) {
      variant = EnemyVariant.STANDARD;
      vConfig = ENEMY_VARIANTS[variant];
    }

    // --- Base hull personality: modifiers & attack patterns ---
    // (Variant behaviors take over movement via updateVariant; these add
    //  flavor to the shared hull for STANDARD and capped-out units.)
    let modifier = EnemyModifier.NONE;
    let pattern = AttackPattern.CHASE;
    const w = directorWave;
    const r2 = Math.random();

    // Tanks: artillery or circle strafing from wave 3+; shielded from wave 5+
    if (type === EnemyType.TANK) {
      if (w >= 4 && r2 < 0.4) pattern = AttackPattern.ARTILLERY;
      else if (w >= 5 && r2 < 0.65) pattern = AttackPattern.CIRCLE;
      if (w >= 5 && Math.random() < 0.3) modifier |= EnemyModifier.SHIELDED;
      if (w >= 7 && Math.random() < 0.25) modifier |= EnemyModifier.REGENERATING;
    }
    // Drones: kamikaze dives from wave 4+, occasionally shielded
    else if (type === EnemyType.DRONE) {
      if (w >= 4 && r2 < 0.45) pattern = AttackPattern.KAMIKAZE;
      if (w >= 6 && Math.random() < 0.2) modifier |= EnemyModifier.SHIELDED;
    }
    // Shooters: circle strafing runs from wave 4+, regenerating from wave 6+
    else if (type === EnemyType.SHOOTER) {
      if (w >= 4 && r2 < 0.35) pattern = AttackPattern.CIRCLE;
      if (w >= 6 && Math.random() < 0.25) modifier |= EnemyModifier.REGENERATING;
    }
    // Basics: shielded from wave 8+
    else if (type === EnemyType.BASIC && w >= 8 && Math.random() < 0.15) {
      modifier |= EnemyModifier.SHIELDED;
    }

    // Variant units skip conflicting base patterns — updateVariant drives them.
    if (variant !== EnemyVariant.STANDARD) pattern = AttackPattern.CHASE;

    // B2: elite affixes — late-game rolls turn spawns into volatile threats
    const affixes = affixChancesForWave(w);
    if (affixes.explosive > 0 && Math.random() < affixes.explosive) modifier |= EnemyModifier.EXPLOSIVE;
    if (affixes.splitter > 0 && Math.random() < affixes.splitter) modifier |= EnemyModifier.SPLITTER;
    if (affixes.vampiric > 0 && Math.random() < affixes.vampiric) modifier |= EnemyModifier.VAMPIRIC;

    let spot;
    let attempts = 0;
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const playerPos = this.helicopter.body.position;

    // Safe Spawn Validation (Max 8 attempts for better placement)
    while (attempts < 8) {
      spot = this.getArcadeSpawnPoint(type, 0, 1);
      
      const point = new THREE.Vector3(spot.x, spot.y, spot.z);
      // Ensure it's not popping in immediately in the frustum
      if (frustum.containsPoint(point)) {
        const distSq = (spot.x - playerPos.x) ** 2 + (spot.z - playerPos.z) ** 2;
        if (distSq < 3600) { // Only reject if extremely close (within 60 units) to allow ahead-of-player spawn in view
          attempts++;
          continue; 
        }
      }
      
      // Avoid spawn overlap
      let overlap = false;
      for (const enemy of this.enemies) {
         if (enemy.active) {
            const eDistSq = (spot.x - enemy.mesh.position.x) ** 2 + (spot.z - enemy.mesh.position.z) ** 2;
            if (eDistSq < SPAWN_CONFIG.separation * SPAWN_CONFIG.separation) {
               overlap = true;
               break;
            }
         }
      }
      if (overlap) {
         attempts++;
         continue;
      }

      break;
    }

    if (!spot) spot = this.getArcadeSpawnPoint(type, 0, 1);

    const enemy = new Enemy(
      this.scene,
      this.world,
      spot.x,
      spot.z,
      type,
      spot.y,
      { modifier, pattern, variant, isElite: Math.random() < Math.max(0, 0.01 + directorConfig.eliteChanceBonus + this.difficulty.eliteChance) },
    );
    this.scaleEnemyForDifficulty(enemy);
    this.enemies.push(enemy);
    this.waveThreatBudgetRemaining = Math.max(0, this.waveThreatBudgetRemaining - vConfig.threat);
    
    // Spawn teleportation/arrival effect so enemies don't just pop in jarringly
    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 30, performance.now() / 1000, 15);
    
    this.enemiesSpawnedInWave++;
    this.playSpawnCue(performance.now() / 1000);
    return true;
  }

  /**
   * Scale an enemy for the selected difficulty AND the procedural wave curve:
   * every wave raises HP (+18%), damage (+7%) and fire rate (+4%) so the
   * battlefield is measurably harder on wave 20 than wave 2.
   */
  private scaleEnemyForDifficulty(enemy: Enemy) {
    const mult = this.difficulty.enemyHp * waveEnemyPower(this.currentWave);
    if (mult !== 1) {
      enemy.maxHp = Math.max(5, Math.round(enemy.maxHp * mult));
      enemy.hp = enemy.maxHp;
    }
    if (enemy.shieldMaxHp > 0) {
      enemy.shieldMaxHp = Math.max(5, Math.round(enemy.shieldMaxHp * mult));
      enemy.shieldHp = enemy.shieldMaxHp;
      if (enemy.shieldMesh) enemy.shieldMesh.visible = true;
    }
    // Wave-scaled enemy weapon damage (stored for the player-hit callback)
    enemy.waveDamageMult = waveEnemyDamage(this.currentWave);
    enemy.waveFireRateMult = waveEnemyFireRate(this.currentWave);
  }

  /** Spawn the elite miniboss for wave % 5 === 0 waves. */
  private spawnMiniboss(time: number) {
    // Minibosses escalate every 5th wave (wave 5 → 10 → 15 …)
    const scale = 1 + Math.floor(this.currentWave / 5) * 0.35;
    const type = this.currentWave >= 10 ? EnemyType.TANK : EnemyType.DRONE;
    const spot = this.getArcadeSpawnPoint(type, 0, 1);
    const elite = new Enemy(
      this.scene,
      this.world,
      spot.x,
      spot.z,
      type,
      spot.y,
      {
        isElite: true,
        modifier: EnemyModifier.SHIELDED,
        pattern: this.currentWave >= 10 ? AttackPattern.ARTILLERY : AttackPattern.KAMIKAZE,
      },
    );
    elite.maxHp = Math.max(5, Math.round(elite.maxHp * scale));
    elite.hp = elite.maxHp;
    if (elite.shieldMaxHp > 0) {
      elite.shieldMaxHp = Math.max(5, Math.round(elite.shieldMaxHp * scale));
      elite.shieldHp = elite.shieldMaxHp;
    }
    this.scaleEnemyForDifficulty(elite);
    this.enemies.push(elite);
    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 50, time, 20);
    this.audio.playEnemySpawn();
    this.addCameraImpulse(2.5);
    this.announce("ELITE MINIBOSS", "Brace for impact", "#ffdd55");
  }

  /**
   * Wave-10 boss presentation: a short staged intro (warning → name → spawn)
   * so the fight lands like an event instead of a pop-in. Player control is
   * never removed; the boss simply enters after the framing beats (~2.7s).
   */
  private bossIntroActive = false;
  private bossIntroStage = 0;
  private bossIntroNextTime = 0;

  private startBossBattle(time: number) {
    if (this.bossIntroActive) return;
    this.bossIntroActive = true;
    this.bossIntroStage = 1;
    this.bossIntroNextTime = time + 0.9;
    this.announce("⚠ INCOMING ⚠", "Hostile gunship detected", "#ff3366");
    this.audio.playUpgrade();
  }

  private updateBossIntro(time: number) {
    if (!this.bossIntroActive || time < this.bossIntroNextTime) return;
    if (this.bossIntroStage === 1) {
      this.bossIntroStage = 2;
      this.bossIntroNextTime = time + 0.9;
      this.announce("ARCHON", "Shielded heavy gunship", "#d84cff");
      this.audio.playUpgrade();
    } else if (this.bossIntroStage === 2) {
      this.bossIntroStage = 3;
      this.bossIntroNextTime = time + 0.9;
      this.spawnBossBattle(time);
    } else {
      this.bossIntroActive = false;
    }
  }

  /**
   * Real boss battle every 10th wave. The BOSS type already carries the
   * three-phase state machine (new attack at 66%/33%, telegraphed beam
   * volleys, radial bursts); here we scale it up for the wave and escort it
   * with a few minions so the arena feels alive.
   */
  private spawnBossBattle(time: number) {
    const spot = this.getArcadeSpawnPoint(EnemyType.BOSS, 0, 1);
    const boss = new Enemy(
      this.scene,
      this.world,
      spot.x,
      spot.z,
      EnemyType.BOSS,
      Math.max(10, spot.y),
      {
        isElite: true,
        modifier: EnemyModifier.SHIELDED,
        pattern: AttackPattern.CIRCLE,
      },
    );
    // Boss gets a flat ×2.0 "boss bonus" only; scaleEnemyForDifficulty below
    // is the SINGLE place wave power + difficulty are applied (no double-dip)
    const bossScale = 2.0;
    boss.maxHp = Math.max(50, Math.round(boss.maxHp * bossScale));
    boss.hp = boss.maxHp;
    boss.basePoints = Math.round(boss.basePoints * bossScale);
    if (boss.shieldMaxHp > 0) {
      boss.shieldMaxHp = Math.max(50, Math.round(boss.shieldMaxHp * bossScale));
      boss.shieldHp = boss.shieldMaxHp;
    }
    this.scaleEnemyForDifficulty(boss);
    this.enemies.push(boss);

    // Escort squad so it isn't a lonely duel — queued so the escort models
    // construct over the next frames instead of spiking in the boss's frame.
    for (let i = 0; i < 3; i++) {
      const escortType = i % 2 === 0 ? EnemyType.SHOOTER : EnemyType.DRONE;
      const eSpot = this.getArcadeSpawnPoint(escortType, i, 3);
      this.pendingEventSpawns.push({
        type: escortType,
        x: eSpot.x + (Math.random() - 0.5) * 30,
        z: eSpot.z + i * 14,
        y: Math.max(2.4, eSpot.y),
        modifier: EnemyModifier.NONE,
        pattern: AttackPattern.CHASE,
      });
    }

    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 70, time, 30);
    this.audio.playEnemySpawn();
    this.addCameraImpulse(4.0);
    this.triggerHitStop(0.35, 0.05);
    this.announce("⚠ BOSS BATTLE ⚠", "Three phases. No mercy.", "#ff3366");
  }

  private getArcadeSpawnPoint(type: EnemyType, index: number, formationSize: number) {
    const player = this.helicopter.body.position;
    const lanes =
      this.combatIntensity < 0.25
        ? [-78, -48, -22, 0, 22, 48, 78]
        : [-145, -112, -82, -52, -24, 0, 24, 52, 82, 112, 145];
    const laneIndex = Math.floor(Math.random() * lanes.length);
    const formationOffset = (index - (formationSize - 1) / 2) * 21;
    const baseX = lanes[laneIndex] + formationOffset + (Math.random() - 0.5) * 12;
    // Horde surround: ~20% of spawns come from behind at wide side lanes so
    // enemies stream in from every direction like a Vampire-Survivors swarm.
    const flankFromBehind = Math.random() < 0.2 && type !== EnemyType.BOSS && index === 0;
    const aheadDistance =
      type === EnemyType.DRONE
        ? SPAWN_CONFIG.minDistance + Math.random() * 100
        : type === EnemyType.TANK
          ? 92 + Math.random() * (SPAWN_CONFIG.maxDistance - 92)
          : SPAWN_CONFIG.minDistance + Math.random() * 120;
    // Keep behind-spawns within ~2 camera lengths (cam sits at +52) so they
    // arrive visible at the screen edge instead of popping in off-screen.
    const z = flankFromBehind
      ? player.z + SPAWN_CONFIG.minDistance + Math.random() * 25
      : player.z - aheadDistance - index * 10;
    const height = this.city.getHeightAt(baseX, z, type === EnemyType.DRONE ? 0 : 3);
    const rooftopFallback =
      height > 2
        ? { x: baseX, y: height + 4.5, z }
        : this.city.getAmbushSpot(player, SPAWN_CONFIG.minDistance, Math.min(205, SPAWN_CONFIG.maxDistance));

    if (type === EnemyType.DRONE) {
      return {
        x: THREE.MathUtils.clamp(baseX, -170, 170),
        y: THREE.MathUtils.clamp(player.y + 4 + Math.random() * 16, 18, 58),
        z,
      };
    }

    if (height > 2 || Math.random() < 0.22) {
      return {
        x: THREE.MathUtils.clamp(rooftopFallback.x + (Math.random() - 0.5) * 10, -175, 175),
        y: Math.max(2.4, rooftopFallback.y),
        z: rooftopFallback.z,
      };
    }

    return {
      x: THREE.MathUtils.clamp(baseX, -175, 175),
      y: 2.4,
      z,
    };
  }

  private playSpawnCue(time: number) {
    if (time - this.lastSpawnSoundTime < 0.4) return;
    this.lastSpawnSoundTime = time;
    this.audio.playEnemySpawn();
  }

  /**
   * Drain the bounded event/escort spawn queue. Constructs at most one model
   * per call, so convoy ambushes, air raids and boss escorts
   * arrive as a staggered stream instead of a single-frame model spike.
   */
  private drainEventSpawns(time: number) {
    let drained = 0;
    while (drained < SPAWN_CONFIG.maxPerTick && this.pendingEventSpawns.length > 0) {
      const d = this.pendingEventSpawns.shift()!;
      const enemy = new Enemy(this.scene, this.world, d.x, d.z, d.type, d.y, {
        modifier: d.modifier ?? EnemyModifier.NONE,
        pattern: d.pattern ?? AttackPattern.CHASE,
        variant: d.variant,
      });
      this.scaleEnemyForDifficulty(enemy);
      this.enemies.push(enemy);
      this.particles.spawnExplosion(d.x, d.y, d.z, 20, time, 10);
      this.playSpawnCue(time);
      if (this.isPlaying) this.enemiesSpawnedInWave++;
      drained++;
      // Tanks/bosses are the heaviest models — one per tick keeps frames smooth.
      if (d.type === EnemyType.TANK || d.type === EnemyType.BOSS) break;
    }
  }

  updateAIDirector(time: number, delta: number) {
    this.survivalTime += delta;
    const pressureFromTime = Math.min(1, this.survivalTime / 180);
    const pressureFromThreats = Math.min(1, this.enemies.length / 22);
    const pressureFromHealth = 1 - this.health / this.maxHealth;
    this.combatIntensity = THREE.MathUtils.clamp(
      pressureFromTime * 0.5 + pressureFromThreats * 0.35 + pressureFromHealth * 0.3,
      0,
      1.3,
    );

    // Initial start
    if (this.currentWave === 0) {
      if (this.waveTransitionTimer <= 0) {
        this.startNextWave();
      }
      return;
    }

    // Periodic power-up spawning check
    this.powerupSpawnTimer -= delta;
    if (this.powerupSpawnTimer <= 0) {
      this.spawnPeriodicPowerUp();
      this.powerupSpawnTimer = 8.0 + Math.random() * 4.0;
    }

    // Pause spawning during transitions (milestone announcements / battlefield events)
    if (this.waveTransitionTimer > 0) {
      return;
    }

    // Vampire-Survivors style: waves advance on a clock, never on clearing the
    // field. Enemies stream in forever — survival time is the real score.
    this.waveTimer += delta;
    if (this.waveTimer >= waveDuration(this.currentWave)) {
      this.waveTimer = 0;
      this.startNextWave();
      return;
    }

    // Full boss battle every 10th wave; elite miniboss on the other 5th waves
    this.updateBossIntro(time);
    if (this.currentWave % 10 === 0 && !this.minibossSpawnedThisWave) {
      this.minibossSpawnedThisWave = true;
      this.startBossBattle(time);
    } else if (this.currentWave % 5 === 0 && !this.minibossSpawnedThisWave) {
      this.minibossSpawnedThisWave = true;
      this.spawnMiniboss(time);
    }

    // Continuous horde spawning — never stops, only ramps. Bursts are queued
    // and drained ONE per cadence tick (frame budget = 1) so hordes stream in
    // smoothly instead of popping in as a group. The interval is unchanged, so
    // the per-second spawn rate — and the difficulty curve — is preserved.
    this.spawnTimer -= delta;
    const maxActiveEnemies = Math.min(
      72,
      Math.round((26 + Math.floor(this.currentWave * 3.2) + threatDirectorConfig(this.threatLevel).activeEnemyCapBonus) * this.difficulty.spawnRate),
    );
    const hordeInterval = Math.max(
      0.16,
      (0.62 - this.currentWave * 0.045) * (2 - this.difficulty.spawnRate) * (1.15 - this.combatIntensity * 0.35) * threatDirectorConfig(this.threatLevel).spawnIntervalMult,
    );
    if (this.spawnTimer <= 0) {
      if (this.pendingEventSpawns.length > 0) {
        // Event/escort spawns take priority and drain on a short stagger.
        this.drainEventSpawns(time);
        this.spawnTimer = 0.18;
      } else if (this.pendingSpawns > 0) {
        // One enemy per tick from the queued burst.
        this.spawnEnemy();
        this.pendingSpawns--;
        this.spawnTimer = hordeInterval;
      } else if (this.enemies.length < maxActiveEnemies && this.waveThreatBudgetRemaining >= 1) {
        // Queue a fresh burst (same sizes as before — the queue distributes
        // them across time instead of constructing them all this frame).
        this.pendingSpawns = Math.min(
          maxActiveEnemies - this.enemies.length,
          1 + Math.floor(Math.random() * (1 + Math.min(2, Math.floor(this.currentWave / 4)))),
          SPAWN_CONFIG.maxQueue,
        );
        if (this.pendingSpawns <= 0) this.pendingSpawns = 1;
        this.spawnTimer = hordeInterval;
      } else {
        // At the active cap — wait and re-check.
        this.spawnTimer = 0.25;
      }
    }

    // Trigger battlefield events at intervals during the wave if not in transition
    this.battlefieldEventTimer -= delta;
    if (this.battlefieldEventTimer <= 0) {
      this.triggerBattlefieldEvent(time);
      this.battlefieldEventTimer = Math.max(12, 28 - this.combatIntensity * 12);
    }
  }

  spawnDirectedEnemy(time = performance.now() / 1000, index = 0, formationSize = 1) {
    // Legacy callers feed the same bounded queue as the wave director. Keeping
    // construction in spawnEnemy guarantees one normal enemy per simulation tick.
    void time;
    void index;
    this.pendingSpawns = Math.min(
      SPAWN_CONFIG.maxQueue,
      this.pendingSpawns + Math.max(1, Math.floor(formationSize)),
    );
    this.spawnTimer = Math.min(this.spawnTimer, 0.05);
  }

  /** Count of active enemies of a given variant (used for event cap checks). */
  private variantActiveCount(variant: EnemyVariant): number {
    let count = 0;
    for (const e of this.enemies) if (e.active && e.variant === variant) count++;
    return count;
  }

  /**
   * When a shield drone leaves the battlefield, clear its damage-reduction
   * aura from every remaining enemy. Surviving shield drones re-apply their
   * own aura on the next tick, so support never leaks across a death.
   */
  private releaseShieldAuras(removed: Enemy) {
    if (removed.variant !== EnemyVariant.SHIELD_DRONE) return;
    for (const other of this.enemies) {
      if (other !== removed && other.active && other.incomingDamageMult < 1) {
        other.incomingDamageMult = 1;
      }
    }
  }

  triggerBattlefieldEvent(time: number) {
    const player = this.helicopter.body.position;
    const eventRoll = Math.random();
    const eventZ = player.z - 95 - Math.random() * 80;

    if (eventRoll < 0.34) {
      this.waveMessage = "MISSILE STORM";
      this.waveTransitionTimer = 1.4;
      for (let i = 0; i < 7 + this.combatIntensity * 6; i++) {
        const x = player.x + (Math.random() - 0.5) * 130;
        const z = player.z - 50 - Math.random() * 150;
        const dx = player.x - x;
        const dz = player.z - z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        this.enemyProjectiles.spawn(x, player.y + 8 + Math.random() * 12, z, dx / len, dz / len, time, 115 + this.combatIntensity * 85);
      }
    } else if (eventRoll < 0.68) {
      this.waveMessage = "CONVOY AMBUSH";
      this.waveTransitionTimer = 1.4;
      // Queue the convoy — tanks/shooters construct and arrive over the next
      // few seconds instead of 4-8 full models in this single frame. Variants
      // respect their battlefield caps so events never stack rare units.
      const flakCapped = this.variantActiveCount(EnemyVariant.FLAK_TANK) >= (ENEMY_VARIANTS[EnemyVariant.FLAK_TANK].maxActive ?? 6);
      const carrierCapped = this.variantActiveCount(EnemyVariant.MISSILE_CARRIER) >= (ENEMY_VARIANTS[EnemyVariant.MISSILE_CARRIER].maxActive ?? 2);
      let carrierQueued = false;
      for (let i = 0; i < 4 + this.combatIntensity * 4; i++) {
        const isTank = i % 2 === 0;
        let variant: EnemyVariant | undefined;
        if (isTank) {
          if (!carrierCapped && !carrierQueued && this.currentWave >= 5) {
            variant = EnemyVariant.MISSILE_CARRIER;
            carrierQueued = true;
          } else if (!flakCapped && this.currentWave >= 4) {
            variant = EnemyVariant.FLAK_TANK;
          }
        } else if (this.currentWave >= 3) {
          variant = pickEnemyVariant(this.currentWave);
        }
        this.pendingEventSpawns.push({
          type: isTank ? EnemyType.TANK : EnemyType.SHOOTER,
          x: -70 + i * 35,
          z: eventZ - i * 12,
          y: 7,
          variant,
        });
        if (this.isPlaying) this.totalEnemiesInWave++;
      }
    } else {
      this.waveMessage = "AIR RAID";
      this.waveTransitionTimer = 1.4;
      // Queue the raid — drones trickle in rather than an 8-14 model spike.
      const kamikazeCapped = this.variantActiveCount(EnemyVariant.KAMIKAZE_DRONE) >= (ENEMY_VARIANTS[EnemyVariant.KAMIKAZE_DRONE].maxActive ?? 6);
      let kamikazeQueued = 0;
      for (let i = 0; i < 8 + this.combatIntensity * 6; i++) {
        // ~25% of a raid are kamikaze divers (capped); the rest are scouts/standard.
        let variant: EnemyVariant | undefined;
        if (this.currentWave >= 3 && !kamikazeCapped && kamikazeQueued < 2 && Math.random() < 0.25) {
          variant = EnemyVariant.KAMIKAZE_DRONE;
          kamikazeQueued++;
        } else if (this.currentWave >= 2 && Math.random() < 0.5) {
          variant = EnemyVariant.SCOUT_DRONE;
        }
        this.pendingEventSpawns.push({
          type: EnemyType.DRONE,
          x: player.x + (Math.random() - 0.5) * 160,
          z: eventZ - Math.random() * 130,
          y: player.y + 2 + Math.random() * 14,
          variant,
        });
        if (this.isPlaying) this.totalEnemiesInWave++;
      }
    }
  }

  pollGamepad(time: number, delta: number) {
    if (!this.isPlaying) return;
    if (this.gamepadIndex === null) return;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) {
      this.onGamepadDisconnected();
      return;
    }

    const DEADZONE = 0.15;
    const lx = gp.axes[0];
    const ly = gp.axes[1];
    const rx = gp.axes[2];
    const ry = gp.axes[3];

    // Move target with Right Stick (or Left Stick if Right is idle)
    let aimX = Math.abs(rx) > DEADZONE ? rx : Math.abs(lx) > DEADZONE ? lx : 0;
    let aimY = Math.abs(ry) > DEADZONE ? ry : Math.abs(ly) > DEADZONE ? ly : 0;

    const hasGamepadInput =
      Math.abs(aimX) > DEADZONE ||
      Math.abs(aimY) > DEADZONE ||
      gp.buttons.some((b) => b.pressed);

    if (Math.abs(aimX) > DEADZONE || Math.abs(aimY) > DEADZONE) {
      this.hasInputThisFrame = true;
      // Circular deadzone/curve for smoother input
      const mag = Math.sqrt(aimX * aimX + aimY * aimY);
      const normX = aimX / mag;
      const normY = aimY / mag;
      const curvedMag = Math.pow((mag - DEADZONE) / (1 - DEADZONE), 1.2);

      const sens = this.settings.gamepadSensitivity;
      this.gamepadMove.x = normX * curvedMag * sens;
      this.gamepadMove.z = (this.settings.invertedY ? -normY : normY) * curvedMag * sens;

      // Resume audio on stick move
      this.audio.resume();

      // Disable mouse logic if gamepad is active
      this.isMouseActive = false;
    } else {
      this.gamepadMove.x = 0;
      this.gamepadMove.z = 0;
      if (hasGamepadInput) {
        // Even if just buttons, maybe keep mouse logic off to avoid snapping?
        this.isMouseActive = false;
      }
    }

    // Buttons (A or R2 to fire)
    this.isFiringGamepad =
      gp.buttons[0].pressed ||
      gp.buttons[7].pressed ||
      (gp.buttons[6] && gp.buttons[6].value > 0.1);
    if (this.isFiringGamepad) {
      this.audio.resume();
    }
  }

  updateKeyboardMovement(delta: number) {
    let moveX = 0;
    let moveZ = 0;

    if (this.movementKeys.has("a") || this.movementKeys.has("arrowleft"))
      moveX -= 1;
    if (this.movementKeys.has("d") || this.movementKeys.has("arrowright"))
      moveX += 1;
    if (this.movementKeys.has("w") || this.movementKeys.has("arrowup"))
      moveZ -= 1;
    if (this.movementKeys.has("s") || this.movementKeys.has("arrowdown"))
      moveZ += 1;

    if (this.leftStick.active) {
      moveX += this.leftStick.x;
      moveZ += this.leftStick.y;
    }
    // Phase 2: route gamepad stick input into the same normalization pipeline.
    if (this.gamepadMove.x !== 0 || this.gamepadMove.z !== 0) {
      moveX += this.gamepadMove.x;
      moveZ += this.gamepadMove.z;
    }

    let moveY = 0;
    if (
      this.movementKeys.has(" ") ||
      this.movementKeys.has("spacebar") ||
      this.movementKeys.has("pageup")
    )
      moveY += 1;
    if (
      this.movementKeys.has("pagedown") ||
      this.movementKeys.has("alt")
    )
      moveY -= 1;

    // Normalize desired keyboard input vector
    const mag = Math.sqrt(moveX * moveX + moveZ * moveZ);
    let normX = 0;
    let normZ = 0;
    if (mag > 0) {
      normX = moveX / mag;
      normZ = moveZ / mag;
    }

    // Digital input is immediate. The single physical response layer lives in
    // Helicopter.update, so there is no input-lag smoothing stack.
    const targetMag = Math.min(1, mag);
    this.keyboardVelocity.set(normX * targetMag, normZ * targetMag);

    const inputLength = this.keyboardVelocity.length();
    if (inputLength > 0.005) {
      this.hasInputThisFrame = true;
      // keyboardVelocity is a normalized command, not a smoothed velocity.
    }

    // Afterburner: hold Shift to burn fuel for speed + damage
    this.afterburnerActive =
      this.movementKeys.has("shift") &&
      this.currentFuel > 1 &&
      this.isPlaying;

    // Phase 2: vertical is fully separate from horizontal — Space = climb,
    // Alt = descend, each with velocity-based accel/brake in the helicopter.
    // The engine conveys vertical input directly; vertical physics supplies weight.
    if (moveY !== 0) this.hasInputThisFrame = true;
    this.verticalInput = moveY;
  }



  tick = () => {
    if (this.disposed || !this.running) return;
    this.animationFrameId = requestAnimationFrame(this.tick);
    this.frameCount++;

    const time = performance.now() / 1000;
    // Phase 1: clamp frame spikes so a 0.2–2s hitch (tab switch, GC, driver
    // stall) can't launch entities across the world. 0.05s = exactly the 3
    // fixed substeps of world.step(1/60, dt, 3), so physics stays in sync up
    // to the clamp. Negative/NaN deltas (clock jumps) are treated as 0.
    let realDelta = time - this.lastTime;
    this.lastTime = time;
    if (!Number.isFinite(realDelta) || realDelta < 0) realDelta = 0;
    realDelta = Math.min(realDelta, GameEngine.MAX_SIMULATION_DT);

    // Rolling FPS (read-only, no allocations)
    this.fpsFrames++;
    this.fpsAccum += realDelta;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsFrames = 0;
      this.fpsAccum = 0;
    }

    // A4: adaptive quality governor — one measurement window every 1.5s.
    this.governorWindowFrames++;
    this.governorWindowTime += realDelta;
    if (this.governorWindowTime >= 1.5) {
      const windowFps = this.governorWindowFrames / this.governorWindowTime;
      this.governorWindowFrames = 0;
      this.governorWindowTime = 0;
      const before = this.governor.level;
      this.governor = updateQualityGovernor(this.governor, windowFps, time);
      if (this.governor.level !== before) this.applyGovernorQuality();
    }

    // Phase 1 dev memory monitor (Step 9) — every 2s, DEV only, opt-in.
    if (this.memMon) {
      this.memMonTimer += realDelta;
      if (this.memMonTimer >= 2.0) {
        this.memMonTimer = 0;
        this.monitorMemory(time);
      }
    }

    // Process Hit-Stop timer using real unscaled time
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= realDelta;
      if (this.hitStopTimer <= 0) {
        this.timeScale = 1.0;
      }
    }

    const delta = realDelta * this.timeScale;

    if (!this.isPlaying) {
      this.innerRing.rotation.z += 0.025;
      this.outerRing.rotation.z -= 0.01;
      this.helicopter.animateRotors(0, 60, delta);
      this.updateCamera(delta);
      this.syncBlobShadows();
      this.renderFrame();
      return;
    }

    this.hasInputThisFrame = false;
    this.pollGamepad(time, delta);
    this.updateKeyboardMovement(delta);

    // Explicit READY → DASHING → COOLDOWN state machine.
    if (this.dashState === "DASHING") {
      this.dashActiveTimer = Math.max(0, this.dashActiveTimer - delta);
      if (this.dashActiveTimer === 0) {
        this.dashState = "COOLDOWN";
        this.dashCooldownTimer = MOVEMENT_CONFIG.dashCooldown * Math.max(0.45, 1 - this.runUpgrades.dashCooldown * 0.15) * (1 - perkEffect("dash", this.perks.dash));
      } else {
        const progress = 1 - this.dashActiveTimer / MOVEMENT_CONFIG.dashDuration;
        const speedBoost = this.speedBoostTimer > 0 ? MOVEMENT_CONFIG.speedBoostMultiplier : 1;
        const dashSpeed = THREE.MathUtils.lerp(
          MOVEMENT_CONFIG.dashSpeed,
          MOVEMENT_CONFIG.maxHorizontalSpeed * 1.05,
          progress,
        ) * speedBoost;
        this.helicopter.body.velocity.x = this.dashDirection.x * dashSpeed;
        this.helicopter.body.velocity.z = this.dashDirection.z * dashSpeed;
        this.hasInputThisFrame = true;
      }
    } else if (this.dashState === "COOLDOWN") {
      this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - delta);
      if (this.dashCooldownTimer === 0) this.dashState = "READY";
    }

    // Phase 2: no idle-decay or position-target clamp — movement is
    // velocity-controlled; the body is the source of truth.

    // Fuel drain (afterburner burns much faster; fuel-efficiency upgrade slows it)
    const permanentFuelMult = Math.max(0.7, 1 - this.hangarUpgrades.fuel * 0.06);
    const engineBurnMult = Math.max(0.88, 1 - this.hangarUpgrades.engine * 0.024);
    const fuelEfficiencyMult = Math.max(0.4, 1 - this.runUpgrades.fuelEfficiency * 0.3) * permanentFuelMult * (1 - perkEffect("fuelSaver", this.perks.fuelSaver));
    const burnRate =
      this.fuelDrainPerSecond * fuelEfficiencyMult * engineBurnMult * (this.afterburnerActive ? this.afterburnerDrainPerSecond : 1);
    this.currentFuel = Math.max(0, this.currentFuel - burnRate * delta);
    this.afterburnerEffectTimer = Math.max(0, this.afterburnerEffectTimer - delta);
    if (this.afterburnerActive && this.health > 0 && this.afterburnerEffectTimer === 0) {
      this.afterburnerEffectTimer = 0.05;
      const wingX = this.helicopter.body.position.x;
      this.particles.spawnSmoke(wingX - 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSmoke(wingX + 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSparks(wingX - 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSparks(wingX + 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
    }
    if (this.currentFuel <= 0 && this.health > 0) {
      this.applyPlayerDamage(8 * delta, "FUEL STARVATION", "COLLISION", time, false);
    }
    this.emitStatsIfChanged();
    this.city.update(this.helicopter.body.position, this.world, delta);
    this.delivery.update(time, delta, this.helicopter.body.position, this.currentWave);
    this.updateMissions(time, delta);
    this.updateDepotService(delta);
    this.updateCountermeasures(delta, time);
    this.updateThreatAndExtraction(delta, time);
    this.updateTurrets(time, delta);
    this.updateCrashSmoke(delta, time);

    // --- Destroyable objectives ---
    const playerX = this.helicopter.body.position.x;
    const playerZ = this.helicopter.body.position.z;
    for (let i = this.objectives.length - 1; i >= 0; i--) {
      const obj = this.objectives[i];
      obj.update(time, delta);
      // Show beacon + label only when near (avoids clutter at distance)
      const dist = obj.distanceTo(playerX, playerZ);
      const showMarker = dist < 260;
      if (obj.beacon) obj.beacon.visible = showMarker;
      if (obj.labelSprite) obj.labelSprite.visible = showMarker;
      if (obj.active && obj.type === ObjectiveType.SAM_SITE) {
        const radarSupported = this.objectives.some((radar) =>
          radar.active &&
          radar.type === ObjectiveType.RADAR_TOWER &&
          Math.hypot(radar.position.x - obj.position.x, radar.position.z - obj.position.z) <= 300);
        const result = obj.updateSam(this.helicopter.body.position, time, delta, this.currentWave, {
          radarSupported,
          lockSpeedMultiplier: 1 / this.difficulty.samLock,
        });
        if (result?.beep) this.audio.playSamLockBeep(obj.samLockProgress);
        if (result?.fired) this.launchSamMissile(obj, time);
        if (this.delivery.isCarrying() && dist <= SAM_DETECTION_RANGE) this.delivery.markSamExposure();
        const damageStage = obj.getDamageStage();
        if (damageStage > 0 && obj.damageFxTimer <= 0) {
          const target = obj.targetPoint;
          this.particles.spawnSmoke(target.x, target.y, target.z, time);
          if (damageStage === 2) this.particles.spawnSparks(target.x, target.y, target.z, time);
          obj.damageFxTimer = damageStage === 2 ? 0.16 : 0.38;
        }
      }
      // Cull objectives far behind the player
      if (obj.position.z > playerZ + 120) {
        if (obj.missionTargetId) this.missionManager.reportTargetLost(obj.missionTargetId);
        obj.destroy();
        this.objectives.splice(i, 1);
      }
    }
    // Preserve the battlefield-wide suppression hook while each site now owns
    // its targeting, lock, launch, and reload cadence.
    this.samActive = this.objectives.some((o) => o.active && o.type === ObjectiveType.SAM_SITE);
    this.radarActive = this.objectives.some((o) => o.active && o.type === ObjectiveType.RADAR_TOWER);
    /* Legacy global SAM cadence replaced by per-site state machines.
    if (this.samActive) {
      this.samFireTimer -= delta;
      if (this.samFireTimer <= 0) {
        this.samFireTimer = 2.6;
        const sam = this.objectives.find((o) => o.active && o.type === ObjectiveType.SAM_SITE);
        if (sam) {
          const p = this.helicopter.body.position;
          const dx = p.x - sam.position.x;
          const dz = p.z - sam.position.z;
          const hDist = Math.sqrt(dx * dx + dz * dz) || 1;
          // Range gate: a site hundreds of units away shouldn't lob blind
          // shots across the map — engage inside a useful envelope only.
          if (hDist < 460) {
            const speed = 210;
            const dy = p.y - (sam.position.y + 4);
            this.enemyProjectiles.spawn(
              sam.position.x,
              sam.position.y + 4,
              sam.position.z,
              dx / hDist,
              dz / hDist,
              time,
              speed,
              8,
              0,
              0xff5544,
              { body: this.helicopter.body, active: true }, // homing target
              2.2, // homing strength — tracks, but stays dodgeable
              (dy / hDist) * speed, // initial vertical aim at the player
              0,
            );
            this.audio.playEnemyFire();
          }
        }
      }
    }
    */
    if (this.samSuppressionTimer > 0) {
      this.samSuppressionTimer = Math.max(0, this.samSuppressionTimer - delta);
    }

    this.updateAIDirector(time, delta);

    // Twin-stick aim has priority on mobile; desktop mouse fire uses auto-lock.
    if (this.rightStick.active) {
      this.updateStickAim();
    } else {
      this.updateAutoAim();
    }
    this.innerRing.rotation.z += 0.05;
    this.outerRing.rotation.z -= 0.02;

    // --- Salvo Cooldown Timer ---
    if (this.salvoCooldownTimer > 0) {
      this.salvoCooldownTimer = Math.max(0, this.salvoCooldownTimer - delta);
    }

    // --- Active Salvo Target Locking ---
    if (this.isPaintingLocks && this.salvoCooldownTimer <= 0) {
      if (time - this.lastLockPaintTime >= this.lockPaintInterval) {
        const target = this.findSalvoTarget(this.aimPoint, this.lockSearchRadius);
        if (target && this.salvoLocks.length < 6) {
          const currentTargetLocks = this.salvoLocks.filter((e) => e === target).length;
          if (currentTargetLocks < 3) {
            this.salvoLocks.push(target);
            this.lastLockPaintTime = time;
            this.audio.playLockBeep();
            this.updateSalvoIndicators(target);
            this.updateUI(time);
          }
        }
      }
    }

    // --- Clean Up Dead Enemies in Salvo Locks ---
    this.salvoLocks = this.salvoLocks.filter((enemy) => enemy.active);

    // --- Update Salvo Lock Indicator Visual Positions & Rotations ---
    for (const [enemy, group] of this.salvoLockIndicators.entries()) {
      if (!enemy.active) {
        group.children.forEach((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) {
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach((m) => m.dispose());
            } else {
              mesh.material.dispose();
            }
          }
        });
        this.scene.remove(group);
        this.salvoLockIndicators.delete(enemy);
      } else {
        group.position.copy(enemy.mesh.position);
        group.children.forEach((child, index: number) => {
          const rotationSpeed = 0.06 + index * 0.025;
          const direction = index % 2 === 0 ? 1 : -1;
          child.rotation.z += rotationSpeed * direction;
        });
      }
    }

    // --- Crosshair styling/pulsing during salvo painting ---
    if (this.isPaintingLocks) {
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff3344);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xff3344);
      const scale = 1.0 + Math.sin(time * 15) * 0.15;
      this.targetGroup.scale.set(scale, scale, scale);
    } else {
      (this.innerRing.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      (this.outerRing.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      this.targetGroup.scale.set(1, 1, 1);
    }

    // --- Survival encounter messaging ---
    if (this.waveTransitionTimer > 0) {
      this.waveTransitionTimer -= delta;
      if (this.frameCount % 30 === 0) this.updateUI(time);
    }

    // --- Reload Timer ---
    if (this.isReloading) {
      this.reloadTimer -= delta;
      if (this.reloadTimer <= 0) {
        const weapon = this.weapons.get(this.currentWeapon);
        if (weapon) {
          weapon.ammo = weapon.maxAmmo;
          this.isReloading = false;
        }
      }
    }

    // Keep the last finite player position as the NaN-recovery anchor.
    const playerBodyPosition = this.helicopter.body.position;
    if (
      Number.isFinite(playerBodyPosition.x) &&
      Number.isFinite(playerBodyPosition.y) &&
      Number.isFinite(playerBodyPosition.z)
    ) {
      this.movementTarget.set(
        playerBodyPosition.x,
        playerBodyPosition.y,
        playerBodyPosition.z,
      );
    }
    this.helicopter.setAim(this.aimPoint.x, this.aimPoint.z);

    // --- Weather & Environment ---
    this.weather.update(time, delta, this.scene);
    this.rain.update(time, this.helicopter.mesh.position);
    (this.rain.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value =
      time; // redundancy check
    // Pass 8: rain keeps a visibility floor at any storm strength so weather
    // reads, while the cap protects player/enemy silhouettes (additive rain
    // washes contrast fast).
    (this.rain.mesh.material as THREE.ShaderMaterial).opacity =
      0.12 + this.weather.stormIntensity * 0.25;

    if (this.weather.isLightning) {
      this.renderer.setClearColor(0xffffff);

      this.audio.playExplosion(2.0); // Thunder

      // Small EMP damage chance
      if (Math.random() < 0.2) {
        this.applyPlayerDamage(5, "LIGHTNING EMP", "EXPLOSIVE", time);
      }

      if (this.lightningTimeout !== null) {
        window.clearTimeout(this.lightningTimeout);
      }
      this.lightningTimeout = window.setTimeout(() => {
        if (!this.disposed) {
          const fogColor = (this.scene.fog as THREE.FogExp2).color;
          this.renderer.setClearColor(fogColor);
        }
        this.lightningTimeout = null;
      }, 50);
    } else {
      if (this.lightningTimeout === null) {
        const fogColor = (this.scene.fog as THREE.FogExp2).color;
        this.renderer.setClearColor(fogColor);
      }
    }

    // Phase 1 NaN guard: one invalid Vector3 propagates into every body, mesh
    // and camera in the scene and the run is unrecoverable — recover to a safe
    // state (movement target, zero velocity) instead of corrupting the sim.
    const hp = this.helicopter.body.position;
    const hv = this.helicopter.body.velocity;
    if (
      !Number.isFinite(hp.x) || !Number.isFinite(hp.y) || !Number.isFinite(hp.z) ||
      !Number.isFinite(hv.x) || !Number.isFinite(hv.y) || !Number.isFinite(hv.z)
    ) {
      if (import.meta.env.DEV) {
        console.warn(
          "[Heli-Strike] NaN in helicopter body — recovering",
          { pos: [hp.x, hp.y, hp.z], vel: [hv.x, hv.y, hv.z], dt: delta, time },
        );
      }
      hp.set(this.movementTarget.x, this.movementTarget.y, this.movementTarget.z);
      hv.set(0, 0, 0);
      this.helicopter.body.angularVelocity.set(0, 0, 0);
      copyPhysicsPos(this.helicopter.mesh, hp);
    }

    // Apply the controller before the fixed physics step so key presses affect
    // this frame's integration and collision callbacks get the final say on
    // inward wall velocity.
    this.windCannon.set(this.weather.windForce.x, 0, this.weather.windForce.z);
    const hoverFloor = this.city.getHeightAt(
      this.helicopter.body.position.x,
      this.helicopter.body.position.z,
      0.5,
    );
    this.helicopter.setHoverFloor(hoverFloor);
    this.helicopter.update(
      time, delta, this.windCannon, this.particles,
      this.shieldTimer > 0, this.speedBoostTimer > 0, this.hasInputThisFrame,
      {
        x: this.keyboardVelocity.x,
        z: this.keyboardVelocity.y,
        y: this.verticalInput * (1 + this.hangarUpgrades.rotor * 0.025),
        afterburner: this.afterburnerActive
          ? MOVEMENT_CONFIG.afterburnerMultiplier + this.hangarUpgrades.engine * 0.025
          : 1,
        cargoMultiplier: this.delivery.isCarrying()
          ? cargoMovementMultiplier(this.hangarUpgrades.airframe)
          : 1,
      },
    );

    // Aim pivots are now current, so machine-gun shots leave the live muzzle.
    if (
      (this.isFiringMouse || this.isFiringGamepad) &&
      this.health > 0
    ) {
      this.fireWeapons(time);
    }

    this.world.step(1 / 60, delta, 3);

    // Catch solver/contact corruption before enemies, projectiles, or the camera
    // can consume it in this frame.
    const steppedPosition = this.helicopter.body.position;
    const steppedVelocity = this.helicopter.body.velocity;
    if (
      !Number.isFinite(steppedPosition.x) ||
      !Number.isFinite(steppedPosition.y) ||
      !Number.isFinite(steppedPosition.z) ||
      !Number.isFinite(steppedVelocity.x) ||
      !Number.isFinite(steppedVelocity.y) ||
      !Number.isFinite(steppedVelocity.z)
    ) {
      steppedPosition.set(
        this.movementTarget.x,
        this.movementTarget.y,
        this.movementTarget.z,
      );
      steppedVelocity.set(0, 0, 0);
      this.helicopter.body.angularVelocity.set(0, 0, 0);
    }

    // World-bound clamp (the city scrolls forever in z; x has a hard boundary).
    const bx = this.helicopter.body.position.x;
    const bound = MOVEMENT_CONFIG.worldBoundX;
    if (bx > bound) {
      this.helicopter.body.position.x = bound;
      if (this.helicopter.body.velocity.x > 0) this.helicopter.body.velocity.x = 0;
    } else if (bx < -bound) {
      this.helicopter.body.position.x = -bound;
      if (this.helicopter.body.velocity.x < 0) this.helicopter.body.velocity.x = 0;
    }
    this.helicopter.syncBodyTransform();

    // Engine sound based on speed
    const currentSpeed = Math.sqrt(
      this.helicopter.body.velocity.x ** 2 +
        this.helicopter.body.velocity.z ** 2,
    );
    this.audio.updateEngine(Math.min(1.0, currentSpeed / 60), 10);

    // --- Enemy Logic ---
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.active) {
        this.releaseShieldAuras(e);
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }
      // Phase 1 NaN guard: an invalid enemy body corrupts every system that
      // reads it (boids, homing missiles, avoidance) — drop it cleanly.
      if (
        !Number.isFinite(e.body.position.x) ||
        !Number.isFinite(e.body.position.y) ||
        !Number.isFinite(e.body.position.z) ||
        !Number.isFinite(e.body.velocity.x) ||
        !Number.isFinite(e.body.velocity.y) ||
        !Number.isFinite(e.body.velocity.z)
      ) {
        if (import.meta.env.DEV) {
          console.warn(
            "[Heli-Strike] NaN in enemy body — removing",
            { type: e.type, pos: [e.body.position.x, e.body.position.y, e.body.position.z] },
          );
        }
        if (e.missionTargetId) this.missionManager.reportTargetLost(e.missionTargetId);
        this.releaseShieldAuras(e);
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }
      if (
        e.body.position.z > this.helicopter.body.position.z + 165 ||
        e.body.position.z < this.helicopter.body.position.z - 320
      ) {
        if (e.missionTargetId) this.missionManager.reportTargetLost(e.missionTargetId);
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }

      // B1: burn DoT + status timestamps tick every frame for every enemy.
      e.tickStatusEffects(time, delta);
      if (!e.active) {
        if (e.diedFromStatus) {
          this.onEnemyDestroyed(e, time);
        } else {
          this.releaseShieldAuras(e);
          e.destroy();
          this.enemies.splice(i, 1);
        }
        continue;
      }
      // B1: status drips — sparks while burning, smoke crackle while shocked.
      if (this.frameCount % 6 === 0) {
        if (e.isBurning(time)) {
          this.particles.spawnSparks(e.body.position.x, e.body.position.y, e.body.position.z, time, 1, 14);
        } else if (e.isShocked(time)) {
          this.particles.spawnSmoke(e.body.position.x, e.body.position.y + 1, e.body.position.z, time);
        }
      }

      // SAM sites boost enemy fire rate; destruction suppresses it
      const radarAcquisitionMult = this.radarActive ? 0.9 : 1;
      const enemyFireRateMult = (this.samActive && !this.samSuppressionTimer
        ? 0.72
        : this.samSuppressionTimer > 0
          ? 1.7
          : 1.0) * radarAcquisitionMult;
      const prevPhase = e.phase;
      const fired = e.updateDirection(
        this.helicopter.body.position,
        time,
        this.enemyProjectiles,
        this.playerProjectiles.pool,
        this.enemies,
        this.city,
        enemyFireRateMult,
        delta,
        undefined,
        this.helicopter.body.velocity,
      );
      // Only announce when the boss LOSES a phase (never on spawn)
      if (e.type === EnemyType.BOSS && e.phase < prevPhase) {
        this.announce(
          e.phase === 2 ? "PHASE 2" : "FINAL PHASE",
          e.phase === 2 ? "New attack pattern" : "Telegraphed beam volleys",
          "#ff3366",
        );
        this.audio.playUpgrade();
        this.addCameraImpulse(2.0); // boss phase slam
        this.triggerHitStop(0.2, 0.4);
      }
      if (fired && time - this.lastEnemyFireSoundTime >= 0.15) {
        this.audio.playEnemyFire();
        this.lastEnemyFireSoundTime = time;
      }

      // Ramming Check (Kamikaze)
      if (
        e.body.position.distanceSquared(this.helicopter.body.position) < 25 &&
        this.health > 0
      ) {
        e.active = false;
        this.particles.spawnExplosion(
          e.body.position.x,
          this.helicopter.body.position.y,
          e.body.position.z,
          80,
          time,
          30,
        );
        this.audio.playExplosion(1.5);
        this.addCameraImpulse(2.5); // kamikaze ram — heavy hit

        // Tanks do massive ram damage
        const dmg = e.type === EnemyType.TANK ? 30 : 10;
        if (this.dashActiveTimer <= 0) {
          this.applyPlayerDamage(dmg, e.variant === EnemyVariant.KAMIKAZE_DRONE ? "KAMIKAZE" : "RAM", "COLLISION", time);
        }
        this.updateUI(time);
      }
    }

    // --- Projectile Physics ---
    this.playerProjectiles.updatePositions(time, delta, this.particles);
    this.enemyProjectiles.updatePositions(time, delta, this.particles);

    for (const proj of this.playerProjectiles.pool) {
      if (!proj.active) continue;
      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        proj.damage * (proj.blastRadius > 0 ? 1.2 : 0.55),
      );
      if (!hitBlock) continue;

      if (proj.blastRadius === 0) {
        // Machine gun ricochet sparks
        for (let s = 0; s < 3; s++) this.particles.spawnSparks(proj.pos.x, proj.pos.y, proj.pos.z, time);
      } else {
        // High explosive detonation
        this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 38, time, 22);
        this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 8, proj.blastRadius * 0.35);
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius, proj.damage * 0.85);
      }
      if (proj.blastRadius > 0 || time - this.lastBuildingHitSoundTime >= 0.20) {
        this.audio.playExplosion(proj.blastRadius > 0 ? 0.65 : 0.16);
        if (proj.blastRadius <= 0) {
          this.lastBuildingHitSoundTime = time;
        }
      }
      proj.deactivate();
    }

    for (const proj of this.enemyProjectiles.pool) {
      if (!proj.active) continue;
      const hitBlock = this.city.damageProjectilePath(
        proj.prevPos,
        proj.pos,
        18,
      );
      if (!hitBlock) continue;
      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 10, time, 8);
      this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 3, 2.0);
      proj.deactivate();
    }

    // --- Objective hits ---
    this.playerProjectiles.checkObjectiveHits(this.objectives, (proj, obj) => {
      this.shotsHit++;
      const objDmg = proj.damage * (proj.blastRadius > 0 ? 1.1 : 1.0);
      const destroyed = obj.takeDamage(objDmg);
      this.hitMarkerTimer = 0.12;
      this.hitMarkerPosition.set(obj.targetPoint.x, obj.targetPoint.y, obj.targetPoint.z);
      this.particles.spawnSparks(proj.pos.x, proj.pos.y, proj.pos.z, time);
      if (proj.blastRadius > 0) this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 14, time, 9);
      this.audio.playHit();
      if (destroyed) {
        this.destroyObjective(obj, time);
      }
    });

    // --- Rooftop turret hits ---
    this.playerProjectiles.checkTurretHits(this.city.turrets, (proj, turret) => {
      this.shotsHit++;
      const destroyed = turret.takeDamage(proj.damage);
      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 14, time, 9);
      if (destroyed) {
        this.score += Math.floor(turret.basePoints * this.comboMultiplier);
        this.particles.spawnExplosion(
          turret.position.x,
          turret.position.y + 1,
          turret.position.z,
          90,
          time,
          26,
        );
        this.volumetricExplosions.spawn(turret.position.x, turret.position.y + 1, turret.position.z, 10, 4);
        this.audio.playExplosion(0.7);
        this.updateUI(time);
      }
    });

    this.playerProjectiles.checkEnemyHits(this.enemies, (proj, enemy) => {
      this.shotsHit++;
      // C6: mod damage bonuses against favored hull types
      let totalDmg = proj.damage * this.comboMultiplier;
      if (proj.piercing && (enemy.type === EnemyType.TANK || enemy.type === EnemyType.BOSS)) totalDmg *= 1.35;
      if (proj.shaped && (enemy.type === EnemyType.BOSS || enemy.isElite)) totalDmg *= 1.45;
      const result = enemy.takeDamage(totalDmg, time);
      const died = result === "destroyed";
      // B1/C6: status procs from mods + run upgrades + proc perks
      this.tryApplyStatusProc(proj, enemy, time);

      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 15, time, 10);
      this.volumetricExplosions.spawn(proj.pos.x, proj.pos.y, proj.pos.z, 6, proj.blastRadius > 0 ? 3.5 : 1.5);
      this.audio.playExplosion(0.2);

      if (result === "shield-broken") {
        this.particles.spawnExplosion(
          enemy.body.position.x,
          enemy.body.position.y,
          enemy.body.position.z,
          50,
          time,
          18,
        );
        this.audio.playUpgrade();
      }

      if (proj.blastRadius > 0) {
        for (const nearby of this.enemies) {
          if (!nearby.active || nearby === enemy) continue;
          const dx = nearby.body.position.x - proj.pos.x;
          const dz = nearby.body.position.z - proj.pos.z;
          const dy = Math.abs(nearby.body.position.y - proj.pos.y);
          const radiusSq = proj.blastRadius * proj.blastRadius;
          if (dx * dx + dz * dz < radiusSq && dy < 32) {
            // B1: guaranteed-proc mods (EMP warheads) disable everything in the blast
            if (proj.procKind && proj.procChance >= 1) nearby.applyStatus(proj.procKind, time);
            const r = nearby.takeDamage(totalDmg * 0.55, time);
            if (r === "destroyed") {
              this.onEnemyDestroyed(nearby, time);
            }
          }
        }
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius * 0.9, totalDmg);
        // C6: cluster warheads split into 3 mini-blasts around the impact
        if (proj.cluster) this.spawnClusterBlasts(proj.pos.x, proj.pos.y, proj.pos.z, totalDmg, time);
        // A3: explosion knockback shoves the helicopter away from the blast
        this.addExplosionImpulse(proj.pos.x, proj.pos.y, proj.pos.z, 1.2, proj.blastRadius * 2.5);
      }

      // Update combo
      this.comboCount++;
      this.comboTimer = 3.0;
      this.comboMultiplier = comboMultiplier(this.comboCount); // Cap at 6x
      this.maxCombo = Math.max(this.maxCombo, this.comboCount);

      if (died) {
        this.onEnemyDestroyed(enemy, time);
      }
    });

    this.enemyProjectiles.checkPlayerHits(
      this.helicopter.body.position,
      (proj) => {
        if (this.health > 0) {
          // Shield or dash protects from damage through the central pipeline.
          if (this.shieldTimer > 0 || this.dashActiveTimer > 0) {
            this.particles.spawnExplosion(
              proj.pos.x,
              proj.pos.y,
              proj.pos.z,
              20,
              time,
              15,
            );
            return;
          }
          // Respect each shot's real damage (turret 6, boss volley 8, artillery 16)
          const dmg = Math.round(proj.damage * this.difficulty.enemyDamage * (proj.waveDamageMult ?? 1));
          const damageType: PlayerDamageType = proj.kind === "SAM_MISSILE"
            ? "MISSILE"
            : proj.blastRadius > 0 ? "EXPLOSIVE" : "BULLET";
          const applied = this.applyPlayerDamage(dmg, proj.kind === "SAM_MISSILE" ? "SAM MISSILE" : "ENEMY PROJECTILE", damageType, time);
          // B2: vampiric enemies feed on confirmed damage
          if (applied > 0) this.healVampiricEnemies(applied, time);
          this.particles.spawnExplosion(
            proj.pos.x,
            proj.pos.y,
            proj.pos.z,
            30,
            time,
            20,
          );
        }
      },
    );

    // --- Combo Timer ---
    if (this.comboTimer > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) {
        this.comboCount = 0;
        this.comboMultiplier = 1;
      }
    }

    // B3: Devastation overcharge expiry announcement
    if (this.superActiveUntil > 0 && time >= this.superActiveUntil) {
      this.superActiveUntil = 0;
      this.announce("OVERCHARGE SPENT", "Devastation recharging", "#ff88aa");
    }

    // --- Update Power-ups ---
    const playerPos = this.helicopter.mesh.position;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];

      // Magnet: XP gems drift toward the player when close (VS feel). Pull is
      // strong enough to actually catch the helicopter (cruise ~68 u/s), so
      // gems dropped beside/behind the flight path aren't left behind.
      if (pu.type === PowerUpType.XP_GEM || pu.type === PowerUpType.SALVAGE || pu.type === PowerUpType.COUNTERMEASURE) {
        const dx = playerPos.x - pu.mesh.position.x;
        const dz = playerPos.z - pu.mesh.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const magnetRadius = 24 * (1 + this.runUpgrades.xpMagnet * 0.3) * (1 + perkEffect("magnet", this.perks.magnet));
        if (dist > 0.1 && dist < magnetRadius) {
          const pull = (1 - dist / magnetRadius) * 52 * delta;
          pu.position.x += (dx / dist) * pull;
          pu.position.z += (dz / dist) * pull;
        }
      }

      pu.update(time, delta);

      const tooFar = Math.hypot(pu.mesh.position.x - playerPos.x, pu.mesh.position.z - playerPos.z) > 520;

      if (!pu.active || tooFar) {
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        continue;
      }

      // Check collection
      if (pu.checkCollection(playerPos)) {
        if (pu.type === PowerUpType.XP_GEM) {
          this.grantRunXp(pu.value, time);
        } else if (pu.type === PowerUpType.SALVAGE) {
          this.addSalvage(pu.value);
          this.announce("SALVAGE COLLECTED", `+${pu.value} scrap`, "#ffa632");
        } else if (pu.type === PowerUpType.COUNTERMEASURE) {
          this.countermeasures.replenish(1);
        } else {
          this.applyPowerUp(pu.type, time);
        }
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        this.audio.playPickup();
      }
    }

    // --- Power-up Timers ---
    if (this.damageBoostTimer > 0) {
      this.damageBoostTimer -= delta;
      if (this.damageBoostTimer <= 0) {
        for (const [wType, config] of this.weapons.entries()) {
          config.damage = WEAPON_CONFIGS[wType].damage;
        }
      }
    }
    if (this.shieldTimer > 0) {
      this.shieldTimer -= delta;
    }
    if (this.speedBoostTimer > 0) {
      this.speedBoostTimer -= delta;
      if (this.speedBoostTimer <= 0) {
        // Reset speed - handled in helicopter update
      }
    }

    if (this.health <= 0) {
      this.dispatchGameOver(time);
    }

    this.particles.update(time);
    this.volumetricExplosions.update(delta);
    this.debris?.update(time);
    this.shockwaves?.update(time);
    this.updateNightOps(time, delta);

    // Update UI every and radar every frame for smoothness
    this.updateUI(time);

    this.updateCamera(delta);

    this.syncBlobShadows();
    this.renderFrame();
  };

  /** Phase 1 intentionally disables all gameplay camera impulses. */
  addCameraImpulse(_strength: number) {}

  /** C4: a volatile street prop cooked off — blast hurts enemies and the hull.
   *  During chain-reactions multiple props detonate in one frame; audio is
   *  deduplicated and the UI update is skipped (the tick loop handles it). */
  private explodeVolatileProp(x: number, z: number) {
    const time = performance.now() / 1000;
    this.particles.spawnExplosion(x, 3, z, this.fxCount(70), time, 24);
    this.volumetricExplosions.spawn(x, 3, z, 14, 6);
    this.shockwaves?.spawn(x, 0.5, z, time, 26, 0xff9a3d, 0.7);
    // Dedup audio: only play if no prop explosion sound in the last 0.08s.
    if (time - this.lastPropExplosionSoundTime >= 0.08) {
      this.audio.playExplosion(1.2);
      this.lastPropExplosionSoundTime = time;
    }
    this.addExplosionImpulse(x, 3, z, 2.2, 48);
    const radiusSq = 22 * 22;
    for (const e of this.enemies) {
      if (!e.active) continue;
      const dx = e.body.position.x - x;
      const dz = e.body.position.z - z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radiusSq) continue;
      const falloff = 1 - Math.sqrt(distSq) / 22;
      if (e.takeDamage(34 * falloff, time) === "destroyed") this.onEnemyDestroyed(e, time);
    }
    // The hull isn't immune to friendly infrastructure cooking off nearby.
    const pdx = this.helicopter.body.position.x - x;
    const pdz = this.helicopter.body.position.z - z;
    const pDistSq = pdx * pdx + pdz * pdz;
    if (pDistSq <= radiusSq && this.isPlaying && this.health > 0 && this.superActiveUntil <= time) {
      const falloff = 1 - Math.sqrt(pDistSq) / 22;
      this.applyPlayerDamage(10 * falloff, "VOLATILE PROP", "EXPLOSIVE", time, false);
    }
    // No per-detonation updateUI — the tick loop calls it every frame.
  }

  /** C3: ease the world between day and the deep-navy night rig. */
  private updateNightOps(time: number, delta: number) {
    if (this.nightBlend !== this.nightBlendTarget) {
      const step = delta / 2.4; // ~2.4s full transition
      this.nightBlend = this.nightBlendTarget > this.nightBlend
        ? Math.min(this.nightBlendTarget, this.nightBlend + step)
        : Math.max(this.nightBlendTarget, this.nightBlend - step);
      this.applyNightPalette(this.nightBlend);
    }
    if (this.nightBeams) {
      const visible = this.nightBlend > 0.4;
      this.nightBeams.visible = visible;
      if (visible) {
        // Keep the sweep anchored ahead of the player as the city streams by.
        const heli = this.helicopter.body.position;
        this.nightBeams.position.set(0, 0, heli.z - 120);
        for (let i = 0; i < this.nightBeams.children.length; i++) {
          this.nightBeams.children[i].rotation.y = time * (0.35 + i * 0.09) + i * 2.1;
        }
      }
    }
  }

  private applyNightPalette(t: number) {
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.dayFogColor).lerp(this.nightFogColor, t);
    (this.scene.background as THREE.Color).copy(this.daySkyColor).lerp(this.nightSkyColor, t);
    this.renderer.setClearColor(fog.color);
    this.ambientLight.color.copy(this.dayHemiSky).lerp(this.nightHemiSky, t);
    this.ambientLight.groundColor.copy(this.dayHemiGround).lerp(this.nightHemiGround, t);
    this.ambientLight.intensity = THREE.MathUtils.lerp(1.25, 0.62, t);
    this.keyLight.color.copy(this.dayKeyColor).lerp(this.nightKeyColor, t);
    this.keyLight.intensity = THREE.MathUtils.lerp(1.7, 0.72, t);
    if (t > 0.5) this.ensureNightBeams();
  }

  /** C3: three slow-sweeping searchlight cones anchored ahead of the player. */
  private ensureNightBeams() {
    if (this.nightBeams) return;
    const group = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x9fc4ff,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i++) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 7, 130, 8, 1, true), beamMat);
      beam.position.set((i - 1) * 95, 64, (i - 1) * 26);
      beam.rotation.z = 0.22 - i * 0.08;
      group.add(beam);
    }
    group.visible = false;
    this.scene.add(group);
    this.nightBeams = group;
  }

  /** Distance-falloff explosion impulse: far → none, nearby → small, very
   *  close + large → stronger but capped. */
  addExplosionImpulse(x: number, y: number, z: number, strength: number, radius = 90) {
    const dx = this.helicopter.body.position.x - x;
    const dz = this.helicopter.body.position.z - z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= radius) return;
    const falloff = 1 - dist / radius;
    this.addCameraImpulse(strength * falloff * falloff);
    // A3: knockback — shove the hull away from the blast (1/distance falloff)
    if (dist > 0.001 && this.isPlaying && this.health > 0) {
      const push = Math.min(32, (10 + strength * 5) * falloff);
      this.helicopter.addImpulse((dx / dist) * push, (dz / dist) * push);
    }
  }

  updateCamera(delta: number) {
    const heli = this.helicopter.body.position;
    const velocity = this.helicopter.body.velocity;
    if (
      !Number.isFinite(heli.x) || !Number.isFinite(heli.y) || !Number.isFinite(heli.z) ||
      !Number.isFinite(velocity.x) || !Number.isFinite(velocity.z)
    ) return;

    const speed = Math.hypot(velocity.x, velocity.z);
    const camTargetX = heli.x + THREE.MathUtils.clamp(velocity.x * 0.18, -7, 7);
    const camTargetZ =
      heli.z + 44 + this.combatIntensity * 8 + THREE.MathUtils.clamp(velocity.z * 0.16, -7, 7);
    const camLerp = 1 - Math.exp(-(this.isPlaying ? 10 : 3.5) * delta);
    this.baseCamPos.x += (camTargetX - this.baseCamPos.x) * camLerp;
    this.baseCamPos.z += (camTargetZ - this.baseCamPos.z) * camLerp;

    const blockedTop = this.city.getCameraBlockedHeight(
      this.baseCamPos.x,
      this.baseCamPos.y,
      this.baseCamPos.z,
      heli.x,
      heli.y,
      heli.z,
    );
    const baseCamY = heli.y + 36 + Math.min(speed * 0.08, 7) + this.combatIntensity * 5;
    const camTargetY = blockedTop > 0 ? Math.max(baseCamY, blockedTop + 6) : baseCamY;
    const camYLerp = 1 - Math.exp(-(blockedTop > 0 ? 8 : 6) * delta);
    this.baseCamPos.y += (camTargetY - this.baseCamPos.y) * camYLerp;

    const targetFov = 52 + Math.min(speed * 0.07, 6) + this.combatIntensity * 4;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-4 * delta));
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.baseCamPos);

    this.city.updateOcclusion(
      this.baseCamPos.x,
      this.baseCamPos.y,
      this.baseCamPos.z,
      heli.x,
      heli.y,
      heli.z,
      delta,
      this.isPlaying,
    );

    const desiredLookX = heli.x + THREE.MathUtils.clamp(velocity.x * 0.1, -4, 4);
    const desiredLookY = Math.max(8, Math.min(70, heli.y + 2));
    const desiredLookZ = heli.z - 9 + THREE.MathUtils.clamp(velocity.z * 0.12, -7, 5);
    const lookLerp = 1 - Math.exp(-12 * delta);
    this.cameraLookAtTarget.x += (desiredLookX - this.cameraLookAtTarget.x) * lookLerp;
    this.cameraLookAtTarget.y += (desiredLookY - this.cameraLookAtTarget.y) * lookLerp;
    this.cameraLookAtTarget.z += (desiredLookZ - this.cameraLookAtTarget.z) * lookLerp;

    if (
      Number.isFinite(this.camera.position.x) &&
      Number.isFinite(this.camera.position.y) &&
      Number.isFinite(this.camera.position.z) &&
      Number.isFinite(this.cameraLookAtTarget.x) &&
      Number.isFinite(this.cameraLookAtTarget.y) &&
      Number.isFinite(this.cameraLookAtTarget.z)
    ) {
      this.camera.lookAt(this.cameraLookAtTarget);
    }
  }
}
