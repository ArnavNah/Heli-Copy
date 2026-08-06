import * as THREE from "three";
import * as CANNON from "cannon-es";
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { AudioManager } from "../audio";
import { createGlowMaterial, createSkyDome } from "./materials";
import { Enemy, Helicopter, Objective, PowerUp, Projectile, ProjectilePool } from "./entities";
import { CityEnvironment } from "./city";
import { GPUParticleSystem, RainSystem, VolumetricExplosions, WeatherSystem } from "./particles";
import {
  AttackPattern,
  EnemyModifier,
  EnemyType,
  FOG_CLEAR_COLOR,
  GameSettings,
  HelicopterModel,
  MAX_RENDER_PIXEL_RATIO,
  ObjectiveType,
  SKY_CLEAR_COLOR,
  StickInput,
  TARGET_RENDER_FPS,
  WEAPON_CONFIGS,
  WeaponConfig,
  WeaponType,
  PowerUpType,
} from "./types";
import {
  accuracyFor,
  BOSS_TELEGRAPH_DURATION,
  bossPhaseForRatio,
  bossVolleyConfig,
  comboMultiplier,
  DIFFICULTIES,
  MAX_WEAPON_LEVEL,
  objectiveConfig,
  pickUpgrades,
  riskMultiplier,
  waveEnemyCount,
  waveEnemyDamage,
  waveEnemyFireRate,
  waveEnemyPower,
  waveDuration,
  weaponLevelBonus,
  weaponLevelForXp,
  multikillTier,
  writeMastery,
} from "./logic";
import type { Difficulty as DifficultySetting, UpgradeId, UpgradeOption } from "./logic";

export class GameEngine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cameraLookAtTarget: THREE.Vector3 = new THREE.Vector3();
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  world: CANNON.World;
  city: CityEnvironment;

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
  aimPoint: THREE.Vector3 = new THREE.Vector3(0, 26, -35);
  mouseAimPoint: THREE.Vector3 = new THREE.Vector3(0, 26, -55);
  mouseAimValid: boolean = false;
  autoAimTarget: Enemy | null = null;
  lastCollisionDamageTime = 0;
  // Trailing smoke column after a hard building crash
  crashSmokeTimer: number = 0;
  crashSmokePos: { x: number; y: number; z: number } | null = null;

  raycaster: THREE.Raycaster = new THREE.Raycaster();
  mousePlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -26);
  mouseNDC: THREE.Vector2 = new THREE.Vector2(0, 0);

  targetGroup: THREE.Group;
  innerRing: THREE.Mesh;
  outerRing: THREE.Mesh;

  animationFrame = 0;
  lightningTimeout: number | null = null;
  disposed = false;
  isPlaying = false;
  gameOverDispatched = false;
  isFiringMouse = false;
  isFiringGamepad = false;
  cameraShake = 0;
  score = 0;
  totalKills = 0;
  shotsFired = 0;
  shotsHit = 0;
  health = 100;
  maxHealth = 100;
  currentFuel = 100;
  maxFuel = 100;
  fuelDrainPerSecond = 0.85;
  lastStatsHealth = -1;
  lastStatsFuel = -1;
  lastUiUpdateTime = -Infinity;
  survivalTime = 0;
  combatIntensity = 0;
  directorTimer = 0;
  battlefieldEventTimer = 18;
  lastSpawnSoundTime = 0;
  lastBuildingHitSoundTime = 0;
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

  // Destroyable objectives (SAM sites, radar towers, ammo depots)
  objectives: Objective[] = [];
  samSuppressionTimer: number = 0; // enemy fire-rate debuff while > 0
  samActive: boolean = false; // any SAM site alive boosts enemy fire rate
  samFireTimer: number = 0;

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
    bomb: 0,
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_CLEAR_COLOR);
    this.scene.fog = new THREE.FogExp2(FOG_CLEAR_COLOR, 0.005);
    this.scene.add(createSkyDome());

    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / window.innerHeight,
      0.1,
      300,
    );
    this.camera.position.set(0, 62, 46);
    this.camera.lookAt(0, 0, 0);

    // EffectComposer Setup
    this.composer = new EffectComposer(this.renderer);
    
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    this.bloomPass.threshold = 0.82;
    this.bloomPass.strength = 0.72;
    this.bloomPass.radius = 0.42;
    this.bloomPass.enabled = this.settings.quality === 'high';
    this.composer.addPass(this.bloomPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    this.world = new CANNON.World();
    this.world.gravity.set(0, -9.82, 0);
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    const ambient = new THREE.HemisphereLight(0xe9fbff, 0x4a5576, 2.05);
    this.scene.add(ambient);

    const softKey = new THREE.DirectionalLight(0xfff0cb, 1.18);
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

    const rimLight = new THREE.DirectionalLight(0x8bd8ff, 0.62);
    rimLight.position.set(65, 50, -85);
    this.scene.add(rimLight);

    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(8, 18, 10),
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
      if (this.volumetricExplosions) {
        this.volumetricExplosions.spawn(x, y, z, 20, 6.0);
      }
      if (this.audio) {
        this.audio.playExplosion(1.0);
      }
      this.cameraShake = Math.max(this.cameraShake, 3.5);
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

    this.rain = new RainSystem(5000);
    this.scene.add(this.rain.mesh);
    this.rain.mesh.visible = false;

    this.weather = new WeatherSystem();
    this.audio = new AudioManager();
    this.applySettings();

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

    window.addEventListener("resize", this.onResize);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("helistrike:left-stick", this.onLeftStick);
    window.addEventListener("helistrike:right-stick", this.onRightStick);
    window.addEventListener("gamepadconnected", this.onGamepadConnected);
    window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.addEventListener("helistrike:settings", this.onSettingsChanged);
    window.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("helistrike:fire", this.onFireChange);
    window.addEventListener("helistrike:upgrade-choice", this.onUpgradeChosen);
    window.addEventListener("helistrike:player-model", this.onPlayerModelChanged);

    this.lastTime = performance.now() / 1000;

    // Initialize weapon system
    Object.values(WeaponType).filter(v => typeof v === 'number').forEach((wt) => {
      const config = { ...WEAPON_CONFIGS[wt as WeaponType] };
      this.weapons.set(wt as WeaponType, config);
    });

    this.updateUI(this.lastTime); // Init UI
    this.tick();
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
    this.lastTime = performance.now() / 1000;
    this.updateUI(this.lastTime);
    if (paused) {
      this.audio.stopMusic();
    } else {
      this.audio.startMusic();
    }
  }

  resetGame() {
    this.city.reset(this.world);
    for (const enemy of this.enemies) {
      enemy.destroy();
    }
    this.enemies = [];
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
    this.cameraShake = 0;
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
    this.weather.stormIntensity = 0;
    this.weather.targetIntensity = 0;
    this.rain.mesh.visible = false;
    this.gameOverDispatched = false;
    this.isPlaying = false;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboMultiplier = 1;
    this.maxCombo = 0;
    this.muzzleFlip = 1;
    this.damageBoostTimer = 0;
    this.shieldTimer = 0;
    this.speedBoostTimer = 0;
    this.hitMarkerTimer = 0;
    this.powerupSpawnTimer = 0;

    this.isPaintingLocks = false;
    this.salvoLocks = [];
    this.salvoCooldownTimer = 0;
    this.lastLockPaintTime = 0;
    this.clearSalvoIndicators();

    // Reset progression systems
    this.minibossSpawnedThisWave = false;
    this.samSuppressionTimer = 0;
    this.samActive = false;
    this.samFireTimer = 0;
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
      bomb: 0,
    };
    this.pendingUpgradeOffer = [];
    this.upgradePaused = false;
    this.killStreakCount = 0;
    this.lastKillTime = 0;
    this.announceQueue = [];
    this.afterburnerActive = false;

    this.updateUI(performance.now() / 1000);
    this.emitStatsIfChanged(true);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("helistrike:left-stick", this.onLeftStick);
    window.removeEventListener("helistrike:right-stick", this.onRightStick);
    window.removeEventListener("gamepadconnected", this.onGamepadConnected);
    window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);
    window.removeEventListener("helistrike:settings", this.onSettingsChanged);
    window.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("helistrike:fire", this.onFireChange);
    window.removeEventListener("helistrike:upgrade-choice", this.onUpgradeChosen);
    window.removeEventListener("helistrike:player-model", this.onPlayerModelChanged);
    this.clearSalvoIndicators();
    this.helicopter.body.removeEventListener(
      "collide",
      this.onHelicopterCollide,
    );
    if (this.lightningTimeout !== null) {
      window.clearTimeout(this.lightningTimeout);
      this.lightningTimeout = null;
    }
    cancelAnimationFrame(this.animationFrame);
    this.audio.dispose();
    this.renderer.dispose();
  }

  onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.getMaxPixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  };

  getMaxPixelRatio() {
    return this.settings.quality === 'high'
      ? Math.min(window.devicePixelRatio, 2)
      : Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO);
  }

  applySettings() {
    this.renderer.setPixelRatio(this.getMaxPixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    if (this.bloomPass) {
      this.bloomPass.enabled = this.settings.quality === 'high';
    }
    this.audio.setVolume(this.settings.volume);
  }

  private renderFrame() {
    if (this.settings.quality === 'high') {
      this.composer.render();
      return;
    }
    this.renderer.render(this.scene, this.camera);
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

  private findAutoAimTarget(maxDistance = 245, useMouseCone = false) {
    let bestEnemy: Enemy | null = null;
    let bestScore = Infinity;
    const origin = this.helicopter.body.position;
    const forward = this.getFallbackFireDirection();

    for (const enemy of this.enemies) {
      if (!enemy.active) continue;
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
        bestEnemy = enemy;
      }
    }

    return bestEnemy;
  }

  private updateAutoAim() {
    const aimHeight = this.helicopter.body.position.y;
    // Auto-Aim setting: lock the guns onto the best enemy at all times (wide search),
    // so the chin turret tracks while the body flies on course.
    this.autoAimTarget = this.settings.autoAim
      ? this.findAutoAimTarget(255, false)
      : this.mouseAimValid
        ? this.findAutoAimTarget(225, true)
        : this.findAutoAimTarget(235, false);

    if (this.autoAimTarget) {
      const targetPos = this.autoAimTarget.body.position;
      this.aimPoint.set(targetPos.x, aimHeight, targetPos.z);
      this.helicopter.setGunAim(targetPos.x, targetPos.y, targetPos.z, true);
      this.targetGroup.visible = true;
      this.targetGroup.position.set(targetPos.x, targetPos.y + 1.2, targetPos.z);
      const scale = this.autoAimTarget.type === EnemyType.TANK || this.autoAimTarget.type === EnemyType.BOSS ? 1.5 : 1.0;
      this.targetGroup.scale.setScalar(scale);
    } else {
      this.helicopter.setGunAim(0, 0, 0, false);
      if (this.mouseAimValid) {
        this.aimPoint.copy(this.mouseAimPoint);
        this.aimPoint.y = aimHeight;
        this.targetGroup.visible = true;
        this.targetGroup.position.set(this.aimPoint.x, aimHeight + 0.3, this.aimPoint.z);
        this.targetGroup.scale.setScalar(0.82);
      } else {
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
    this.mousePlane.set(new THREE.Vector3(0, 1, 0), -aimHeight);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);

    const target = new THREE.Vector3();
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

  onWindowBlur = () => {
    this.isFiringMouse = false;
    this.isFiringGamepad = false;
    this.movementKeys.clear();
    this.leftStick = { x: 0, y: 0, active: false };
    this.rightStick = { x: 0, y: 0, active: false };
    if (this.isPlaying) {
      window.dispatchEvent(new CustomEvent("helistrike:autopause"));
    }
  };

  onKeyDown = (e: KeyboardEvent) => {
    if (!this.isPlaying) return;
    const key = e.key.toLowerCase();

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
    if (this.dashCooldownTimer > 0 || this.dashActiveTimer > 0) return;
    this.dashCooldownTimer = 0.75;
    this.dashActiveTimer = 0.28;
    this.dashDirection.set(dx, 0, dz).normalize();
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

  onHelicopterCollide = (e: any) => {
    // getImpactVelocityAlongNormal() reads 0 in this CANNON setup, so compute the
    // closing speed ourselves: helicopter velocity dotted with the contact normal.
    let impact = 0;
    if (e.contact) {
      const n = e.contact.ni;
      const v = this.helicopter.body.velocity;
      impact = Math.abs(v.x * n.x + v.y * n.y + v.z * n.z);
    }
    if (impact < 0.01) {
      const v = this.helicopter.body.velocity;
      impact = Math.sqrt(v.x * v.x + v.z * v.z);
    }
    const now = performance.now() / 1000;
    // Objectives are destructible targets, not obstacles — never damage the player
    const isObjective =
      e.body && this.objectives.some((o) => o.active && o.body === e.body);
    if (isObjective) return;
    const isBuilding = e.body && e.body.type === CANNON.Body.STATIC;

    if (
      (impact > 3.5 || isBuilding) &&
      now - this.lastCollisionDamageTime > 1.0 &&
      this.health > 0
    ) {
      let dmg = Math.min(14, Math.max(3, impact * 1.1));

      if (isBuilding) {
        // Crash severity: a gentle scrape costs a little, a full-speed slam hurts
        const isSlam = impact >= 12;
        dmg = isSlam
          ? Math.min(28, Math.round(10 + impact * 0.8))
          : Math.min(12, Math.round(3 + impact * 0.7));

        // Calculate rebound normal pointing AWAY from building
        let nx = 0;
        let nz = 0;
        if (e.contact) {
          const isBi = e.contact.bi === this.helicopter.body;
          const normal = e.contact.ni;
          nx = isBi ? -normal.x : normal.x;
          nz = isBi ? -normal.z : normal.z;
        }

        // Fallback if normal calculations yield zero or e.contact is missing
        if (nx === 0 && nz === 0 && e.body) {
          const dx = this.helicopter.body.position.x - e.body.position.x;
          const dz = this.helicopter.body.position.z - e.body.position.z;
          const len = Math.sqrt(dx * dx + dz * dz);
          if (len > 0) {
            nx = dx / len;
            nz = dz / len;
          } else {
            nz = 1.0;
          }
        }

        // Ensure normal is unit vector
        const normalLen = Math.sqrt(nx * nx + nz * nz);
        if (normalLen > 0) {
          nx /= normalLen;
          nz /= normalLen;
        } else {
          nz = 1.0;
        }

        // Offset explosion spawn slightly outside building bounding box
        const spawnX = this.helicopter.body.position.x + nx * 3.0;
        const spawnY = this.helicopter.body.position.y;
        const spawnZ = this.helicopter.body.position.z + nz * 3.0;

        if (isSlam) {
          // Full crash: debris burst + hit-stop + heavy shake + trailing smoke
          this.particles.spawnExplosion(spawnX, spawnY, spawnZ, 170, now, 48);
          this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
          this.particles.spawnSmoke(spawnX, spawnY, spawnZ, now);
          this.volumetricExplosions.spawn(spawnX, spawnY, spawnZ, 26, 8);
          this.audio.playExplosion(1.3);
          this.cameraShake = Math.max(this.cameraShake, 8);
          this.triggerHitStop(0.18, 0.06);
          this.crashSmokeTimer = 1.1;
          this.crashSmokePos = { x: spawnX, y: spawnY, z: spawnZ };
          this.helicopter.triggerCrashTilt(Math.min(1, impact / 14));
        } else {
          // Scrape: sparks + smoke + light shake
          this.particles.spawnSparks(spawnX, spawnY, spawnZ, now);
          this.particles.spawnSmoke(spawnX, spawnY, spawnZ, now);
          this.audio.playHit();
          this.cameraShake = Math.max(this.cameraShake, 2.2);
          this.helicopter.triggerCrashTilt(0.35);
        }

        // Instantly shift position away from building to break contact and prevent stuck states
        this.helicopter.body.position.x += nx * 2.5;
        this.helicopter.body.position.z += nz * 2.5;

        // Velocity rebound (harder the faster you hit)
        const rebound = Math.min(58, 24 + impact * 1.4);
        this.helicopter.body.velocity.x = nx * rebound;
        this.helicopter.body.velocity.z = nz * rebound;

        this.movementTarget.set(
          this.helicopter.body.position.x + nx * 18,
          this.movementTarget.y,
          this.helicopter.body.position.z + nz * 18,
        );
        this.helicopter.setTarget(
          this.movementTarget.x,
          this.movementTarget.y,
          this.movementTarget.z,
        );
      } else {
        this.cameraShake = Math.max(this.cameraShake, Math.min(1.8, impact * 0.25));
        this.audio.playHit();
        this.movementTarget.set(
          this.helicopter.body.position.x,
          Math.max(this.helicopter.body.position.y, this.movementTarget.y),
          this.helicopter.body.position.z,
        );
      }

      if (this.dashActiveTimer > 0) {
        dmg = 0;
      }
      this.health = Math.max(0, this.health - dmg);
      this.helicopter.takeDamage(dmg);
      this.lastCollisionDamageTime = now;
      this.updateUI(now);
    }
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
      next.quality = detail.quality === 'high' ? 'high' : 'low';
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
    // Detach the old helicopter (dispose its GPU resources too — no leaks across rebuilds)
    this.helicopter.body.removeEventListener("collide", this.onHelicopterCollide);
    this.helicopter.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      }
    });
    this.helicopter.destroy();
    // Build the newly selected model
    this.helicopter = new Helicopter(this.scene, this.world, this.playerModel);
    this.helicopter.body.addEventListener("collide", this.onHelicopterCollide);
    this.movementTarget.set(0, 26, 0);
    this.updateUI(performance.now() / 1000);
  }

  onUpgradeChosen = (e: Event) => {
    const detail = (e as CustomEvent<{ id: UpgradeId }>).detail;
    if (!detail || !this.upgradePaused) return;
    this.applyRunUpgrade(detail.id);
    this.upgradePaused = false;
    this.isPlaying = true;
    this.updateUI(performance.now() / 1000);
  };

  /** Grant a picked upgrade and resume play. */
  private applyRunUpgrade(id: UpgradeId) {
    this.runUpgrades[id]++;
    switch (id) {
      case 'maxHealth':
        this.maxHealth += 20;
        this.health = Math.min(this.maxHealth, this.health + 20);
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
    const rateUp = 1 + this.runUpgrades.fireRate * 0.18;
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

    // Fire origin: the rotating chin turret when auto-aim is locked on — but only
    // for the Machine Gun; missiles/rockets keep their wing/nose pod spawns.
    const gunWorld = new THREE.Vector3();
    const usingGun =
      (this.autoAimTarget?.active ?? false) && this.currentWeapon === WeaponType.MACHINE_GUN;
    if (usingGun) this.helicopter.gunMount.getWorldPosition(gunWorld);
    const originX = usingGun ? gunWorld.x : this.helicopter.body.position.x;
    const originY = usingGun
      ? gunWorld.y - 0.25
      : this.helicopter.body.position.y -
        (this.currentWeapon === WeaponType.MISSILE || this.currentWeapon === WeaponType.ROCKET ? -0.75 : -0.45);
    const originZ = usingGun ? gunWorld.z : this.helicopter.body.position.z;

    let hDirX = this.aimPoint.x - originX;
    let hDirZ = this.aimPoint.z - originZ;
    const aimLen = Math.sqrt(hDirX * hDirX + hDirZ * hDirZ);
    if (aimLen > 0.001) {
      hDirX /= aimLen;
      hDirZ /= aimLen;
    } else {
      const fallback = this.getFallbackFireDirection();
      hDirX = fallback.x;
      hDirZ = fallback.z;
    }
    const heading = Math.atan2(hDirX, hDirZ);
    const cursorLock =
      this.autoAimTarget?.active
        ? this.autoAimTarget
        : this.findAutoAimTarget(this.mouseAimValid ? 225 : 235, this.mouseAimValid);
    const lockTarget =
      cursorLock ??
      (weapon.homing || this.currentWeapon !== WeaponType.MACHINE_GUN
        ? this.findLockTarget(hDirX, hDirZ, weapon.homing ? 230 : 170)
        : null);
    const projectileAssist =
      weapon.homing
        ? 7.4
        : lockTarget
          ? this.currentWeapon === WeaponType.MACHINE_GUN
            ? 1.8
            : this.currentWeapon === WeaponType.SHOTGUN
              ? 1.2
              : 2.8
          : 0;

    // Play appropriate sound
    switch (this.currentWeapon) {
      case WeaponType.MISSILE:
        this.audio.playMissileLaunch();
        break;
      case WeaponType.ROCKET:
        this.audio.playRocketLaunch();
        break;
      case WeaponType.SHOTGUN:
        this.audio.playShotgun(this.helicopter.body.position.x);
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
        const spreadMul = 1 + (level - 1) * 0.1;
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

      this.playerProjectiles.spawn(
        originX + hDirX * noseOffset + rightUnitX * side * podSpacing,
        originY,
        originZ + hDirZ * noseOffset + rightUnitZ * side * podSpacing,
        dirX,
        dirZ,
        time,
        weapon.speed,
        damage,
        blast,
        weapon.color,
        lockTarget,
        projectileAssist,
      );
    }
    if (totalCount === 1) this.muzzleFlip *= -1;

    // Weapon specific muzzle flash & shake (flash from the same origin as the bullets)
    const fxX = originX + hDirX * noseOffset;
    const fxY = usingGun ? originY : muzzleY;
    const fxZ = originZ + hDirZ * noseOffset;
    
    if (weapon.spread > 0) { 
      // Shotgun Flash
      this.particles.spawnExplosion(fxX, fxY, fxZ, 15, time, 12);
      this.cameraShake = Math.max(this.cameraShake, 0.5);
    } else if (weapon.blastRadius > 0) {
      // Missile / Rocket backblast
      this.particles.spawnExplosion(fxX, fxY, fxZ, 8, time, 6);
      this.cameraShake = Math.max(this.cameraShake, 0.8);
    } else {
      // Machine Gun Sparks
      for(let s=0; s<2; s++) this.particles.spawnSparks(fxX, fxY, fxZ, time);
      this.cameraShake = Math.max(this.cameraShake, 0.06); // Reduced machine gun shake for smooth arcade shooting
    }

    // Auto-reload if out of ammo
    if (weapon.ammo <= 0) {
      this.startReload();
    }
  };

  /**
   * Full kill processing: XP, kill streaks, risk multiplier scoring,
   * hit-stop, power-up drops, and the death explosion.
   */
  private onEnemyDestroyed(enemy: Enemy, time: number) {
    this.totalKills++;
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
    this.triggerHitStop(stopDuration, stopScale);

    // Drop power-up chance (increased for arcade shoot-em-up intensity)
    const dropChance = enemy.type === EnemyType.TANK ? 0.65 : enemy.type === EnemyType.BOSS ? 1.0 : 0.35;
    if (Math.random() < dropChance) {
      this.dropPowerUp(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z);
    }

    // Minibosses drop a guaranteed power-up plus ammo
    if (enemy.isElite) {
      this.dropPowerUp(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z);
      this.announce("MINIBOSS DOWN", `+${Math.floor(enemy.basePoints * this.comboMultiplier * risk)} PTS`, "#ffdd55");
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
    this.volumetricExplosions.spawn(enemy.body.position.x, enemy.body.position.y, enemy.body.position.z, volumetricScale, volumetricScale * 0.6);
    this.city.damageNearby(enemy.body.position.x, enemy.body.position.z, enemy.type === EnemyType.BOSS ? 40 : 22, 95);
    this.audio.playExplosion(enemy.type === EnemyType.BOSS ? 2.5 : 1.5);
  }

  /** Grant weapon XP for a kill; level-ups open the upgrade roulette. */
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
      this.audio.playUpgrade();
      if (!altFire) {
        this.offerUpgrade();
      } else {
        // Rank 5 is the cap — reward instead of a roulette
        this.maxHealth += 10;
        this.health = Math.min(this.maxHealth, this.health + 10);
        this.audio.playUpgrade();
      }
    }
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
      group.children.forEach((child: any) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((m: any) => m.dispose());
          } else {
            child.material.dispose();
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
      this.cameraShake = Math.max(this.cameraShake, 1.4);
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

  applyPowerUp = (type: PowerUpType, time: number) => {
    switch (type) {
      case PowerUpType.HEALTH:
        this.health = Math.min(100, this.health + 30);
        this.helicopter.repair(30);
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
        // Kill all enemies on screen
        for (const e of this.enemies) {
          if (e.active) {
            e.active = false;
            this.score += e.basePoints;
            this.particles.spawnExplosion(
              e.body.position.x,
              e.body.position.y,
              e.body.position.z,
              100,
              time,
              40,
            );
            this.city.damageNearby(e.body.position.x, e.body.position.z, 25, 120);
          }
        }
        this.audio.playExplosion(2.0);
        this.cameraShake = 3.0;
        break;
    }
    this.updateUI(time);
  };

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

    window.dispatchEvent(
      new CustomEvent("helistrike:update", {
        detail: {
          score: this.score,
          health: this.health,
          fuel: this.currentFuel,
          rotorHealth: this.helicopter.rotorHealth,
          engineHealth: this.helicopter.engineHealth,
          wave: this.currentWave,
          message: this.waveTransitionTimer > 0 ? this.waveMessage : null,
          playing: this.isPlaying,
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
        },
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

  dispatchGameOver(time: number) {
    if (this.gameOverDispatched) return;
    this.gameOverDispatched = true;
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
        },
      }),
    );
    this.updateUI(time);
  }

  startNextWave() {
    this.currentWave++;
    this.totalEnemiesInWave = waveEnemyCount(this.currentWave);
    this.enemiesSpawnedInWave = 0;
    this.spawnTimer = 1.2;
    this.minibossSpawnedThisWave = false;

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
    this.health = Math.min(100, this.health + healing); // Milestone heal
    this.helicopter.repair(healing);

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
      t.aimAt(px, pz, time);
      const altDiff = Math.abs(py - t.position.y);
      if (altDiff > 42 || time - t.lastShotTime < t.fireInterval) continue;

      t.lastShotTime = time;
      const m = t.getMuzzle();
      // Lead the player slightly (they auto-scroll forward at 28 u/s)
      const leadZ = dz - 28 * 0.3;
      const len = Math.sqrt(dx * dx + leadZ * leadZ) || 1;
      const spreadX = (Math.random() - 0.5) * 0.09;
      const spreadZ = (Math.random() - 0.5) * 0.09;
      this.enemyProjectiles.spawn(
        m.x,
        m.y,
        m.z,
        dx / len + spreadX,
        leadZ / len + spreadZ,
        time,
        185,
        6,
        0,
        0xffaa44,
        null,
        0,
        0,
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

  /** Spawn a destroyable objective on a rooftop ahead of the player. */
  private spawnObjective() {
    const player = this.helicopter.body.position;
    const lanes = [-78, -48, -24, 0, 24, 48, 78];
    const laneX = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 14;
    const z = player.z - 130 - Math.random() * 90;
    let y = this.city.getHeightAt(laneX, z, 4);
    if (y < 3) y = 2.0;

    const roll = Math.random();
    let type = ObjectiveType.AMMO_DEPOT;
    if (this.currentWave >= 2 && roll < 0.34) type = ObjectiveType.SAM_SITE;
    else if (this.currentWave >= 3 && roll < 0.68) type = ObjectiveType.RADAR_TOWER;

    const obj = new Objective(this.scene, this.world, laneX, y, z, type);
    obj.spawnTime = performance.now() / 1000;
    // Difficulty-scaled objective hull
    const hpMult = this.difficulty.objectiveHp;
    if (hpMult !== 1) {
      obj.maxHp = Math.max(40, Math.round(obj.maxHp * hpMult));
      obj.hp = obj.maxHp;
    }
    this.objectives.push(obj);
    this.announce(
      type === ObjectiveType.SAM_SITE
        ? "SAM SITE ONLINE"
        : type === ObjectiveType.RADAR_TOWER
          ? "RADAR TOWER DETECTED"
          : "AMMO DEPOT SPOTTED",
      "Destroy it to shift the battle",
      "#ff5566",
    );
  }

  /** Apply a destroyable objective's battlefield effect. */
  private destroyObjective(obj: Objective, time: number) {
    this.score += Math.floor(obj.basePoints * this.comboMultiplier);
    this.particles.spawnExplosion(obj.position.x, obj.position.y, obj.position.z, 160, time, 50);
    this.volumetricExplosions.spawn(obj.position.x, obj.position.y, obj.position.z, 22, 9);
    this.cameraShake = Math.max(this.cameraShake, 4.5);
    this.audio.playExplosion(2.0);
    this.triggerHitStop(0.24, 0.05);

    if (obj.type === ObjectiveType.SAM_SITE) {
      this.samSuppressionTimer = 18; // enemies fire slower for 18s
      this.announce("SAM SITE DESTROYED", "Enemy accuracy reduced", "#35e66d");
    } else if (obj.type === ObjectiveType.RADAR_TOWER) {
      // EMP: damage all enemies
      for (const e of this.enemies) {
        if (e.active) {
          e.takeDamage(30, time);
        }
      }
      this.announce("RADAR TOWER DOWN", "EMP pulse hits all enemies", "#7ee0ff");
    } else {
      // AMMO_DEPOT: bomb power-up + ammo refill
      this.dropPowerUp(obj.position.x, obj.position.y, obj.position.z);
      const weapon = this.weapons.get(this.currentWeapon);
      if (weapon) weapon.ammo = weapon.maxAmmo;
      this.announce("AMMO DEPOT SECURED", "Bomb drop + ammo refill", "#ffaa33");
    }
    this.updateUI(time);
  }

  spawnEnemy() {
    let type = EnemyType.BASIC;
    const rand = Math.random();

    // Procedurally assign harder enemies in later waves based on themes
    if (this.currentWave >= 7) {
      if (rand < 0.2) type = EnemyType.DRONE;
      else if (rand < 0.4) type = EnemyType.TANK;
      else if (rand < 0.7) type = EnemyType.SHOOTER;
    } else if (this.currentWave >= 5) {
      if (rand < 0.3) type = EnemyType.TANK;
      else if (rand < 0.6) type = EnemyType.SHOOTER;
      else if (rand < 0.8 && this.currentWave >= 6) type = EnemyType.DRONE;
    } else if (this.currentWave % 4 === 0) {
      // Swarm: mostly basic, some shooters
      if (rand < 0.2) type = EnemyType.SHOOTER;
    } else if (this.currentWave >= 3) {
      if (rand < 0.2 + this.currentWave * 0.05) type = EnemyType.SHOOTER;
      if (rand > 0.85 - this.currentWave * 0.02) type = EnemyType.TANK;
    } else if (this.currentWave >= 2) {
      if (rand < 0.3) type = EnemyType.SHOOTER;
    }

    // --- Wave personality: modifiers & attack patterns ---
    let modifier = EnemyModifier.NONE;
    let pattern = AttackPattern.CHASE;
    const w = this.currentWave;
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
            if (eDistSq < 144) { // 12 units
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
      { modifier, pattern },
    );
    this.scaleEnemyForDifficulty(enemy);
    this.enemies.push(enemy);
    
    // Spawn teleportation/arrival effect so enemies don't just pop in jarringly
    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 30, performance.now() / 1000, 15);
    
    this.enemiesSpawnedInWave++;
    this.playSpawnCue(performance.now() / 1000);
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
    this.cameraShake = Math.max(this.cameraShake, 2.5);
    this.announce("ELITE MINIBOSS", "Brace for impact", "#ffdd55");
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

    // Escort squad so it isn't a lonely duel
    for (let i = 0; i < 3; i++) {
      const escortType = i % 2 === 0 ? EnemyType.SHOOTER : EnemyType.DRONE;
      const eSpot = this.getArcadeSpawnPoint(escortType, i, 3);
      const escort = new Enemy(
        this.scene,
        this.world,
        eSpot.x + (Math.random() - 0.5) * 30,
        eSpot.z + i * 14,
        escortType,
        Math.max(2.4, eSpot.y),
        { modifier: EnemyModifier.NONE, pattern: AttackPattern.CHASE },
      );
      this.scaleEnemyForDifficulty(escort);
      this.enemies.push(escort);
    }

    this.particles.spawnExplosion(spot.x, spot.y, spot.z, 70, time, 30);
    this.audio.playEnemySpawn();
    this.cameraShake = Math.max(this.cameraShake, 4.0);
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
        ? 78 + Math.random() * 92
        : type === EnemyType.TANK
          ? 92 + Math.random() * 130
          : 64 + Math.random() * 120;
    // Keep behind-spawns within ~2 camera lengths (cam sits at +52) so they
    // arrive visible at the screen edge instead of popping in off-screen.
    const z = flankFromBehind
      ? player.z + 40 + Math.random() * 45
      : player.z - aheadDistance - index * 10;
    const height = this.city.getHeightAt(baseX, z, type === EnemyType.DRONE ? 0 : 3);
    const rooftopFallback =
      height > 2
        ? { x: baseX, y: height + 4.5, z }
        : this.city.getAmbushSpot(player, 55, 205);

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
    if (this.currentWave % 10 === 0 && !this.minibossSpawnedThisWave) {
      this.minibossSpawnedThisWave = true;
      this.spawnBossBattle(time);
    } else if (this.currentWave % 5 === 0 && !this.minibossSpawnedThisWave) {
      this.minibossSpawnedThisWave = true;
      this.spawnMiniboss(time);
    }

    // Continuous horde spawning — never stops, only ramps
    this.spawnTimer -= delta;
    const maxActiveEnemies = Math.min(
      72,
      Math.round((26 + Math.floor(this.currentWave * 3.2)) * this.difficulty.spawnRate),
    );
    if (this.spawnTimer <= 0 && this.enemies.length < maxActiveEnemies) {
      // Spawn 1-3 at a time (more as waves climb) so hordes pack in and surround
      const count = Math.min(
        maxActiveEnemies - this.enemies.length,
        1 + Math.floor(Math.random() * (1 + Math.min(2, Math.floor(this.currentWave / 4)))),
      );
      for (let i = 0; i < count; i++) {
        this.spawnEnemy();
      }
      this.spawnTimer = Math.max(
        0.16,
        (0.62 - this.currentWave * 0.045) * (2 - this.difficulty.spawnRate) * (1.15 - this.combatIntensity * 0.35),
      );
    }

    // Trigger battlefield events at intervals during the wave if not in transition
    this.battlefieldEventTimer -= delta;
    if (this.battlefieldEventTimer <= 0) {
      this.triggerBattlefieldEvent(time);
      this.battlefieldEventTimer = Math.max(12, 28 - this.combatIntensity * 12);
    }
  }

  spawnDirectedEnemy(time = performance.now() / 1000, index = 0, formationSize = 1) {
    const roll = Math.random();
    const intensity = this.combatIntensity;
    let type = EnemyType.BASIC;
    if (roll > 0.985 - intensity * 0.06) type = EnemyType.BOSS;
    else if (roll < 0.22 + intensity * 0.14) type = EnemyType.DRONE;
    else if (roll < 0.45 + intensity * 0.18) type = EnemyType.SHOOTER;
    else if (roll > 0.78 - intensity * 0.18) type = EnemyType.TANK;

    const spot = this.getArcadeSpawnPoint(type, index, formationSize);
    const sideOffset = (Math.random() - 0.5) * (type === EnemyType.DRONE ? 22 : 10);
    const y = type === EnemyType.DRONE ? spot.y : Math.max(2.4, spot.y);
    const w = this.currentWave;
    let modifier = EnemyModifier.NONE;
    let pattern = AttackPattern.CHASE;
    const r2 = Math.random();
    if (type === EnemyType.TANK) {
      if (w >= 4 && r2 < 0.4) pattern = AttackPattern.ARTILLERY;
      else if (w >= 5 && r2 < 0.65) pattern = AttackPattern.CIRCLE;
      if (w >= 5 && Math.random() < 0.3) modifier |= EnemyModifier.SHIELDED;
    } else if (type === EnemyType.DRONE) {
      if (w >= 4 && r2 < 0.45) pattern = AttackPattern.KAMIKAZE;
    } else if (type === EnemyType.SHOOTER) {
      if (w >= 4 && r2 < 0.35) pattern = AttackPattern.CIRCLE;
      if (w >= 6 && Math.random() < 0.25) modifier |= EnemyModifier.REGENERATING;
    }
    const enemy = new Enemy(
      this.scene,
      this.world,
      spot.x + sideOffset,
      spot.z - Math.random() * 30,
      type,
      y,
      { modifier, pattern },
    );
    this.scaleEnemyForDifficulty(enemy);
    this.enemies.push(enemy);
    this.playSpawnCue(time);

    const packChance = 0.18 + intensity * 0.22;
    if (type !== EnemyType.BOSS && this.enemies.length < 28 && Math.random() < packChance) {
      const packSize = type === EnemyType.DRONE ? 2 : 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < packSize; i++) {
        const escortType =
          type === EnemyType.TANK
            ? EnemyType.SHOOTER
            : Math.random() < 0.55
              ? EnemyType.BASIC
              : EnemyType.DRONE;
        const escortY =
          escortType === EnemyType.DRONE
            ? this.helicopter.body.position.y + 3 + Math.random() * 12
            : spot.y;
        this.enemies.push(
          new Enemy(
            this.scene,
            this.world,
            spot.x + sideOffset + (Math.random() - 0.5) * 36,
            spot.z - 12 - Math.random() * 46,
            escortType,
            escortY,
          ),
        );
      }
    }
  }

  triggerBattlefieldEvent(time: number) {
    const player = this.helicopter.body.position;
    const eventRoll = Math.random();
    const eventZ = player.z - 95 - Math.random() * 80;
    this.cameraShake = Math.max(this.cameraShake, 1.2 + this.combatIntensity);

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
      for (let i = 0; i < 4 + this.combatIntensity * 4; i++) {
        const enemy = new Enemy(
          this.scene,
          this.world,
          -70 + i * 35,
          eventZ - i * 12,
          i % 2 === 0 ? EnemyType.TANK : EnemyType.SHOOTER,
          7,
        );
        this.enemies.push(enemy);
        if (this.isPlaying) {
          this.enemiesSpawnedInWave++;
          this.totalEnemiesInWave++;
        }
      }
    } else {
      this.waveMessage = "AIR RAID";
      this.waveTransitionTimer = 1.4;
      for (let i = 0; i < 8 + this.combatIntensity * 6; i++) {
        const enemy = new Enemy(
          this.scene,
          this.world,
          player.x + (Math.random() - 0.5) * 160,
          eventZ - Math.random() * 130,
          EnemyType.DRONE,
          player.y + 2 + Math.random() * 14,
        );
        this.enemies.push(enemy);
        if (this.isPlaying) {
          this.enemiesSpawnedInWave++;
          this.totalEnemiesInWave++;
        }
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

      const moveSpeed = 150 * delta * this.settings.gamepadSensitivity;
      this.movementTarget.x += normX * curvedMag * moveSpeed;

      const yMove = this.settings.invertedY ? -normY : normY;
      this.movementTarget.z += yMove * curvedMag * moveSpeed;

      // Resume audio on stick move
      this.audio.resume();

      // Disable mouse logic if gamepad is active
      this.isMouseActive = false;
    } else if (hasGamepadInput) {
      // Even if just buttons, maybe keep mouse logic off to avoid snapping?
      this.isMouseActive = false;
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
    if (this.dashActiveTimer > 0) return;
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

    let moveY = 0;
    if (
      this.movementKeys.has(" ") ||
      this.movementKeys.has("spacebar") ||
      this.movementKeys.has("e") ||
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

    // Smooth input ramp for keyboard controls to prevent instant jerks
    const targetMag = Math.min(1, mag);
    const targetVelocityX = normX * targetMag;
    const targetVelocityY = normZ * targetMag;
    const inputLerpFactor = 1 - Math.exp(-delta * 9.5); // Fast but smooth ramp
    this.keyboardVelocity.x = THREE.MathUtils.lerp(this.keyboardVelocity.x, targetVelocityX, inputLerpFactor);
    this.keyboardVelocity.y = THREE.MathUtils.lerp(this.keyboardVelocity.y, targetVelocityY, inputLerpFactor);

    const inputLength = this.keyboardVelocity.length();
    if (inputLength > 0.005) {
      this.hasInputThisFrame = true;
      const speedBoost = this.speedBoostTimer > 0 ? 1.24 : 1;
      const afterburnerBoost = this.afterburnerActive ? 1.55 : 1;
      // Arcade style: High target speed so the target jumps to the tight clamp boundary almost instantly
      const moveSpeed = 220 * speedBoost * afterburnerBoost;
      this.movementTarget.x += this.keyboardVelocity.x * moveSpeed * delta;
      this.movementTarget.z += this.keyboardVelocity.y * moveSpeed * delta;
    }

    // Afterburner: hold Shift to burn fuel for speed + damage
    this.afterburnerActive =
      this.movementKeys.has("shift") &&
      this.currentFuel > 1 &&
      this.isPlaying;

    // WASD-only flight: the ship moves only while keys are held — no auto-scroll
    // dragging it forward, so releasing the keys lets it hover and breathe.

    if (moveY !== 0) {
      this.hasInputThisFrame = true;
      const climbSpeed = 34;
      this.movementTarget.y += moveY * climbSpeed * delta;
    } else {
      this.movementTarget.y +=
        (this.helicopter.body.position.y - this.movementTarget.y) *
        Math.min(1, delta * 8.0);
    }
  }

  clampMovementTarget() {
    // 1. Clamp to global screen boundary constraints (wider city = wider flight corridor)
    this.movementTarget.x = Math.max(
      -210,
      Math.min(210, this.movementTarget.x),
    );
    
    // 2. Clamp relative to helicopter's actual physical position
    // Arcade style: keep the target very close to the helicopter so direction changes are near-instantaneous
    const hPos = this.helicopter.body.position;
    this.movementTarget.x = Math.max(
      hPos.x - 12,
      Math.min(hPos.x + 12, this.movementTarget.x),
    );
    this.movementTarget.z = Math.max(
      hPos.z - 12,
      Math.min(hPos.z + 12, this.movementTarget.z),
    );
    this.movementTarget.y = Math.max(
      Math.max(15, hPos.y - 12),
      Math.min(Math.min(58, hPos.y + 12), this.movementTarget.y),
    );
  }

  tick = () => {
    this.animationFrame = requestAnimationFrame(this.tick);

    const time = performance.now() / 1000;
    const realDelta = Math.min(time - this.lastTime, 0.1);
    this.lastTime = time;

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
      this.helicopter.animateRotors(0, 60, Math.max(delta, 1 / TARGET_RENDER_FPS));
      this.updateCamera();
      this.renderFrame();
      return;
    }

    this.hasInputThisFrame = false;
    this.pollGamepad(time, delta);
    this.updateKeyboardMovement(delta);

    // Update dash timers and mechanics
    if (this.dashCooldownTimer > 0) {
      this.dashCooldownTimer -= delta;
    }
    if (this.dashActiveTimer > 0) {
      this.dashActiveTimer -= delta;
      const speedBoost = this.speedBoostTimer > 0 ? 1.24 : 1.0;
      const dashSpeed = 155 * speedBoost;
      this.helicopter.body.velocity.x = this.dashDirection.x * dashSpeed;
      this.helicopter.body.velocity.z = this.dashDirection.z * dashSpeed;
      
      // Match the target position directly to prevent drag-back when dash ends
      this.movementTarget.x = this.helicopter.body.position.x;
      this.movementTarget.z = this.helicopter.body.position.z;
    }

    // Apply unified post-input target decay back to player position when idle,
    // so the ship settles into a true hover instead of creeping forward.
    if (!this.hasInputThisFrame) {
      const targetLerp = 1 - Math.exp(-delta * 8.0);
      this.movementTarget.x = THREE.MathUtils.lerp(
        this.movementTarget.x,
        this.helicopter.body.position.x,
        targetLerp
      );
      this.movementTarget.z = THREE.MathUtils.lerp(
        this.movementTarget.z,
        this.helicopter.body.position.z,
        targetLerp
      );
    }
    this.clampMovementTarget();

    // Fuel drain (afterburner burns much faster; fuel-efficiency upgrade slows it)
    const fuelEfficiencyMult = Math.max(0.4, 1 - this.runUpgrades.fuelEfficiency * 0.3);
    const burnRate =
      this.fuelDrainPerSecond * fuelEfficiencyMult * (this.afterburnerActive ? this.afterburnerDrainPerSecond : 1);
    this.currentFuel = Math.max(0, this.currentFuel - burnRate * delta);
    if (this.afterburnerActive && this.health > 0 && Math.random() < 0.5) {
      const wingX = this.helicopter.body.position.x;
      this.particles.spawnSmoke(wingX - 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSmoke(wingX + 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSparks(wingX - 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
      this.particles.spawnSparks(wingX + 2, this.helicopter.body.position.y - 1, this.helicopter.body.position.z, time);
    }
    if (this.currentFuel <= 0 && this.health > 0) {
      this.health = Math.max(0, this.health - 8 * delta);
      this.helicopter.takeDamage(2 * delta);
    }
    this.emitStatsIfChanged();
    this.city.update(this.helicopter.body.position, this.world, delta);
    this.updateTurrets(time, delta);
    this.updateCrashSmoke(delta, time);

    // --- Destroyable objectives ---
    const playerX = this.helicopter.body.position.x;
    const playerZ = this.helicopter.body.position.z;
    for (let i = this.objectives.length - 1; i >= 0; i--) {
      const obj = this.objectives[i];
      obj.update(time);
      // Show beacon + label only when near (avoids clutter at distance)
      const dist = obj.distanceTo(playerX, playerZ);
      const showMarker = dist < 260;
      if (obj.beacon) obj.beacon.visible = showMarker;
      if (obj.labelSprite) obj.labelSprite.visible = showMarker;
      // Cull objectives far behind the player
      if (obj.position.z > playerZ + 120) {
        obj.destroy();
        this.objectives.splice(i, 1);
      }
    }
    // SAM sites fire homing-ish shots at the player while alive
    this.samActive = this.objectives.some((o) => o.active && o.type === ObjectiveType.SAM_SITE);
    if (this.samActive) {
      this.samFireTimer -= delta;
      if (this.samFireTimer <= 0) {
        this.samFireTimer = 2.6;
        const sam = this.objectives.find((o) => o.active && o.type === ObjectiveType.SAM_SITE);
        if (sam) {
          const p = this.helicopter.body.position;
          const dx = p.x - sam.position.x;
          const dz = p.z - sam.position.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          this.enemyProjectiles.spawn(
            sam.position.x,
            sam.position.y + 4,
            sam.position.z,
            dx / len,
            dz / len,
            time,
            200,
            8,
            0,
            0xff5544,
          );
          this.audio.playEnemyFire();
        }
      }
    }
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
        group.children.forEach((child: any) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => m.dispose());
            } else {
              child.material.dispose();
            }
          }
        });
        this.scene.remove(group);
        this.salvoLockIndicators.delete(enemy);
      } else {
        group.position.copy(enemy.mesh.position);
        group.children.forEach((child: any, index: number) => {
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
      if (this.animationFrame % 30 === 0) this.updateUI(time);
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

    // --- Helicopter controls & Weapons ---
    if (
      (this.isFiringMouse || this.isFiringGamepad) &&
      this.health > 0
    ) {
      this.fireWeapons(time);
    }

    this.helicopter.setTarget(
      this.movementTarget.x,
      this.movementTarget.y,
      this.movementTarget.z,
    );
    this.helicopter.setAim(this.aimPoint.x, this.aimPoint.z);

    // --- Weather & Environment ---
    this.weather.update(time, delta, this.scene);
    this.rain.update(time, this.helicopter.mesh.position);
    (this.rain.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value =
      time; // redundancy check
    (this.rain.mesh.material as THREE.ShaderMaterial).opacity =
      this.weather.stormIntensity * 0.5;

    if (this.weather.isLightning) {
      this.renderer.setClearColor(0xffffff);
      this.cameraShake = Math.max(this.cameraShake, 2.0);
      this.audio.playExplosion(2.0); // Thunder

      // Small EMP damage chance
      if (Math.random() < 0.2) {
        this.helicopter.takeDamage(5);
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

    this.world.step(1 / 60, delta, 3);

    const windCannon = new CANNON.Vec3(
      this.weather.windForce.x,
      0,
      this.weather.windForce.z,
    );
    const hoverFloor = this.city.getHeightAt(
      this.helicopter.body.position.x,
      this.helicopter.body.position.z,
      1.5,
    );
    this.helicopter.setHoverFloor(hoverFloor);
    this.helicopter.update(time, delta, windCannon, this.particles, this.shieldTimer > 0, this.speedBoostTimer > 0, this.hasInputThisFrame, 0);

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
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }
      if (
        e.body.position.z > this.helicopter.body.position.z + 165 ||
        e.body.position.z < this.helicopter.body.position.z - 320
      ) {
        e.destroy();
        this.enemies.splice(i, 1);
        continue;
      }

      // SAM sites boost enemy fire rate; destruction suppresses it
      const enemyFireRateMult = this.samActive && !this.samSuppressionTimer
        ? 0.72
        : this.samSuppressionTimer > 0
          ? 1.7
          : 1.0;
      const prevPhase = e.phase;
      const fired = e.updateDirection(
        this.helicopter.body.position,
        time,
        this.enemyProjectiles,
        this.playerProjectiles.pool,
        this.enemies,
        this.city,
        enemyFireRateMult,
      );
      // Only announce when the boss LOSES a phase (never on spawn)
      if (e.type === EnemyType.BOSS && e.phase < prevPhase) {
        this.announce(
          e.phase === 2 ? "PHASE 2" : "FINAL PHASE",
          e.phase === 2 ? "New attack pattern" : "Telegraphed beam volleys",
          "#ff3366",
        );
        this.audio.playUpgrade();
        this.cameraShake = Math.max(this.cameraShake, 2.0);
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
        this.cameraShake = 2.5;

        // Tanks do massive ram damage
        const dmg = e.type === EnemyType.TANK ? 30 : 10;
        if (this.dashActiveTimer <= 0) {
          this.health = Math.max(0, this.health - dmg);
          this.helicopter.takeDamage(dmg);
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
      this.particles.spawnExplosion(proj.pos.x, proj.pos.y, proj.pos.z, 14, time, 9);
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
      const totalDmg = proj.damage * this.comboMultiplier;
      const result = enemy.takeDamage(totalDmg, time);
      const died = result === "destroyed";

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
            const r = nearby.takeDamage(totalDmg * 0.55, time);
            if (r === "destroyed") {
              this.onEnemyDestroyed(nearby, time);
            }
          }
        }
        this.city.damageNearby(proj.pos.x, proj.pos.z, proj.blastRadius * 0.9, totalDmg);
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
          // Shield or dash protects from damage
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
          this.health = Math.max(0, this.health - dmg);
          this.helicopter.takeDamage(dmg);
          this.cameraShake = 1.0;
          this.particles.spawnExplosion(
            proj.pos.x,
            proj.pos.y,
            proj.pos.z,
            30,
            time,
            20,
          );
          this.audio.playHit();
          this.updateUI(time);
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

    // --- Update Power-ups ---
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];
      pu.update(time, delta);

      if (!pu.active) {
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        continue;
      }

      // Check collection
      if (pu.checkCollection(this.helicopter.mesh.position)) {
        this.applyPowerUp(pu.type, time);
        pu.destroy(this.scene);
        this.powerups.splice(i, 1);
        this.audio.playPickup();
      }
    }

    // --- Power-up Timers ---
    if (this.damageBoostTimer > 0) {
      this.damageBoostTimer -= delta;
      if (this.damageBoostTimer <= 0) {
        // Reset damage boost for all weapons
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

    // Update UI every and radar every frame for smoothness
    this.updateUI(time);

    this.updateCamera();

    this.renderFrame();
  };

  updateCamera() {
    const speed = Math.sqrt(
      this.helicopter.body.velocity.x ** 2 + this.helicopter.body.velocity.z ** 2,
    );
    let camTargetX = this.helicopter.body.position.x;
    let camTargetZ = this.helicopter.body.position.z + 52 + this.combatIntensity * 8;

    // Keep the velocity feed-forward mild so direction reversals don't overshoot
    camTargetX += this.helicopter.body.velocity.x * 0.32;
    camTargetZ += this.helicopter.body.velocity.z * 0.3;

    const camLerp = this.isPlaying ? 0.1 : 0.035;
    this.camera.position.x += (camTargetX - this.camera.position.x) * camLerp;
    this.camera.position.z += (camTargetZ - this.camera.position.z) * camLerp;

    const camTargetY = 62 + Math.min(speed * 0.1, 9) + this.combatIntensity * 5;
    this.camera.position.y += (camTargetY - this.camera.position.y) * 0.05;

    const targetFov = 52 + Math.min(speed * 0.08, 7) + this.combatIntensity * 5;
    this.camera.fov += (targetFov - this.camera.fov) * 0.045;
    this.camera.updateProjectionMatrix();

    if (this.cameraShake > 0) {
      const shake = this.cameraShake;
      this.camera.position.x += (Math.random() - 0.5) * shake;
      this.camera.position.y += (Math.random() - 0.5) * shake;
      this.camera.position.z += (Math.random() - 0.5) * shake;
      this.cameraShake *= 0.9;
      if (this.cameraShake < 0.01) this.cameraShake = 0;
    }

    this.camera.lookAt(
      this.helicopter.body.position.x,
      17,
      this.helicopter.body.position.z - 9,
    );
  }
}
