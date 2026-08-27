import * as THREE from "three";
import {
  AttackSector,
  DirectionalPressureMode,
  type CombatDirectorSnapshot,
} from "./types";
import {
  maxActiveAirAttackers,
  maxActiveHeavyAttacks,
  attackRotationDelay,
  microLullConfig,
  enemyHPScale,
  enemyDamageScale,
  enemySpeedScale,
  enemyPopulationTarget,
  groundThreatTarget,
  airThreatTarget,
  calculateSpawnInterval,
} from "./logic";

export interface AirAttackReservation {
  enemyId: number;
  grantedTime: number;
  timeoutTime: number;
  sector: AttackSector;
}

export interface GroundAttackReservation {
  enemyId: number;
  grantedTime: number;
  timeoutTime: number;
}

export interface HeavyAttackReservation {
  sourceId: number;
  sourceType: "TANK" | "SAM" | "BOSS" | "ARTILLERY";
  grantedTime: number;
  timeoutTime: number;
}

export const PERFORMANCE_CAPS = {
  MAX_ACTIVE_ENEMIES: 48,
  MAX_ACTIVE_AIR: 12,
  MAX_ACTIVE_GROUND: 36,
  MAX_ACTIVE_AIR_ATTACKERS: 6,
  MAX_ACTIVE_HEAVY_ATTACKS: 3,
  MAX_PROJECTILES: 180,
  MAX_PARTICLES: 600,
  MAX_SPAWN_QUEUE: 18,
} as const;

export class CombatDirector {
  // Active attack slots
  private airReservations = new Map<number, AirAttackReservation>();
  private groundReservations = new Map<number, GroundAttackReservation>();
  private heavyReservations = new Map<number, HeavyAttackReservation>();

  // Personal cooldowns (enemyId -> readyTime)
  private personalAirCooldowns = new Map<number, number>();
  private personalGroundCooldowns = new Map<number, number>();
  private personalHeavyCooldowns = new Map<number, number>();

  // Attack rotation tracking
  private lastAirAttackReleaseTime = -Infinity;
  private lastGroundAttackReleaseTime = -Infinity;
  private lastHeavyAttackReleaseTime = -Infinity;

  // Staggering timers to prevent simultaneous frame-perfect volleys
  private lastAirAttackGrantTime = -Infinity;
  private lastGroundAttackGrantTime = -Infinity;
  private lastHeavyAttackGrantTime = -Infinity;

  // Directional Pressure System
  private directionalPressureTimer = 0;
  private dominantDirectionIndex = 0;
  private secondaryDirectionIndex = 2; // Flank direction offset
  private static readonly DIRECTION_ANGLES = [
    0, // NORTH (0 rad)
    Math.PI * 0.25, // NORTHEAST
    Math.PI * 0.5, // EAST
    Math.PI * 0.75, // SOUTHEAST
    Math.PI, // SOUTH
    Math.PI * 1.25, // SOUTHWEST
    Math.PI * 1.5, // WEST
    Math.PI * 1.75, // NORTHWEST
  ];
  private static readonly DIRECTION_NAMES = [
    "NORTH",
    "NORTHEAST",
    "EAST",
    "SOUTHEAST",
    "SOUTH",
    "SOUTHWEST",
    "WEST",
    "NORTHWEST",
  ];

  // Micro-lull state
  private microLullActive = false;
  private microLullRemaining = 0;
  private timeSinceLastLull = 0;

  constructor() {
    this.reset();
  }

  reset() {
    this.airReservations.clear();
    this.groundReservations.clear();
    this.heavyReservations.clear();
    this.personalAirCooldowns.clear();
    this.personalGroundCooldowns.clear();
    this.personalHeavyCooldowns.clear();

    this.lastAirAttackReleaseTime = -Infinity;
    this.lastGroundAttackReleaseTime = -Infinity;
    this.lastHeavyAttackReleaseTime = -Infinity;
    this.lastAirAttackGrantTime = -Infinity;
    this.lastGroundAttackGrantTime = -Infinity;
    this.lastHeavyAttackGrantTime = -Infinity;

    this.directionalPressureTimer = 7.0;
    this.dominantDirectionIndex = Math.floor(Math.random() * CombatDirector.DIRECTION_ANGLES.length);
    this.secondaryDirectionIndex = (this.dominantDirectionIndex + 2 + Math.floor(Math.random() * 3)) % CombatDirector.DIRECTION_ANGLES.length;

    this.microLullActive = false;
    this.microLullRemaining = 0;
    this.timeSinceLastLull = 0;
  }

  /**
   * Determine max allowed concurrent aerial attackers based on wave, threat, boss state, and overdrive.
   */
  getMaxAirAttackSlots(
    wave: number,
    threatLevel: number = 1,
    isOverdrive = false,
    overdriveMultiplier = 1.0,
    isBossActive = false,
  ): number {
    return maxActiveAirAttackers(wave, threatLevel, isOverdrive, overdriveMultiplier, isBossActive);
  }

  /**
   * Max concurrent standard ground attacks (e.g. Tank lane fire).
   */
  getMaxGroundAttackSlots(wave: number, isBossActive = false): number {
    if (isBossActive) return 1;
    if (wave <= 3) return 1;
    if (wave <= 7) return 2;
    return 3;
  }

  /**
   * Max concurrent heavy attacks (Tank cannon, SAM missile, Boss beam volleys).
   */
  getMaxHeavyAttackSlots(wave: number, isBossActive = false): number {
    return maxActiveHeavyAttacks(wave, isBossActive);
  }

  /**
   * Periodic update loop (stepped at 10-60 Hz).
   */
  update(
    delta: number,
    time: number,
    currentWave: number,
    activeEnemyIds: Set<number>,
    isOverdrive = false,
  ) {
    const lullCfg = microLullConfig(currentWave, isOverdrive);

    // 1. Directional pressure rotation
    this.directionalPressureTimer -= delta;
    if (this.directionalPressureTimer <= 0) {
      const rotationStep = isOverdrive ? 2 : 1;
      this.dominantDirectionIndex =
        (this.dominantDirectionIndex + rotationStep + Math.floor(Math.random() * 2)) %
        CombatDirector.DIRECTION_ANGLES.length;
      this.secondaryDirectionIndex =
        (this.dominantDirectionIndex + 2 + Math.floor(Math.random() * 3)) %
        CombatDirector.DIRECTION_ANGLES.length;
      this.directionalPressureTimer = isOverdrive ? 4.0 + Math.random() * 2.5 : 6.0 + Math.random() * 3.5;
    }

    // 2. Micro-lull update
    this.timeSinceLastLull += delta;
    if (this.microLullActive) {
      this.microLullRemaining -= delta;
      if (this.microLullRemaining <= 0) {
        this.microLullActive = false;
        this.timeSinceLastLull = 0;
      }
    } else if (this.timeSinceLastLull > lullCfg.interval) {
      this.triggerMicroLull(lullCfg.duration);
    }

    // 3. Timeout safety & stale enemy slot cleanup
    for (const [id, res] of this.airReservations.entries()) {
      if (!activeEnemyIds.has(id) || time >= res.timeoutTime) {
        this.airReservations.delete(id);
      }
    }
    for (const [id, res] of this.groundReservations.entries()) {
      if (!activeEnemyIds.has(id) || time >= res.timeoutTime) {
        this.groundReservations.delete(id);
      }
    }
    for (const [id, res] of this.heavyReservations.entries()) {
      if (!activeEnemyIds.has(id) || time >= res.timeoutTime) {
        this.heavyReservations.delete(id);
      }
    }

    // 4. Clean old personal cooldowns
    for (const [id, readyTime] of this.personalAirCooldowns.entries()) {
      if (!activeEnemyIds.has(id) || time > readyTime + 10) {
        this.personalAirCooldowns.delete(id);
      }
    }
    for (const [id, readyTime] of this.personalGroundCooldowns.entries()) {
      if (!activeEnemyIds.has(id) || time > readyTime + 10) {
        this.personalGroundCooldowns.delete(id);
      }
    }
    for (const [id, readyTime] of this.personalHeavyCooldowns.entries()) {
      if (!activeEnemyIds.has(id) || time > readyTime + 10) {
        this.personalHeavyCooldowns.delete(id);
      }
    }
  }

  triggerMicroLull(duration = 3.0) {
    this.microLullActive = true;
    this.microLullRemaining = duration;
    this.timeSinceLastLull = 0;
  }

  isMicroLull(): boolean {
    return this.microLullActive;
  }

  getMicroLullRemaining(): number {
    return Math.max(0, this.microLullRemaining);
  }

  getCurrentDirectionalAngle(): number {
    return CombatDirector.DIRECTION_ANGLES[this.dominantDirectionIndex];
  }

  getCurrentDirectionalName(): string {
    return CombatDirector.DIRECTION_NAMES[this.dominantDirectionIndex];
  }

  getSecondaryDirectionalAngle(): number {
    return CombatDirector.DIRECTION_ANGLES[this.secondaryDirectionIndex];
  }

  getDirectionalMode(wave: number, isOverdrive = false): DirectionalPressureMode {
    if (isOverdrive) return DirectionalPressureMode.PINCER_SURROUND;
    if (wave <= 3) return DirectionalPressureMode.SINGLE_SECTOR;
    if (wave <= 6) return DirectionalPressureMode.DOMINANT_AND_FLANK;
    return DirectionalPressureMode.DUAL_SECTORS;
  }

  /**
   * Returns a spawn angle based on the current directional pressure mode and active sectors.
   */
  getSectorSpawnAngle(enemyId: number, wave = 1, isOverdrive = false): number {
    const mode = this.getDirectionalMode(wave, isOverdrive);
    const hash = ((enemyId * 9301 + 49297) % 233280) / 233280;

    if (mode === DirectionalPressureMode.SINGLE_SECTOR) {
      const base = this.getCurrentDirectionalAngle();
      const spread = (hash - 0.5) * Math.PI * 0.55;
      return base + spread;
    }

    if (mode === DirectionalPressureMode.DOMINANT_AND_FLANK) {
      const isFlank = hash < 0.28;
      const base = isFlank ? this.getSecondaryDirectionalAngle() : this.getCurrentDirectionalAngle();
      const spread = (hash - 0.5) * Math.PI * 0.65;
      return base + spread;
    }

    if (mode === DirectionalPressureMode.DUAL_SECTORS) {
      const pickSecondary = hash < 0.45;
      const base = pickSecondary ? this.getSecondaryDirectionalAngle() : this.getCurrentDirectionalAngle();
      const spread = (hash - 0.5) * Math.PI * 0.75;
      return base + spread;
    }

    // PINCER_SURROUND (Overdrive)
    const quadrant = Math.floor(hash * 4);
    return quadrant * (Math.PI / 2) + (hash - 0.5) * (Math.PI * 0.4);
  }

  /**
   * Request an aerial attack slot for a Combat Drone entering ATTACK_RUN.
   */
  requestAirAttackSlot(
    enemyId: number,
    time: number,
    wave: number,
    threatLevel = 1,
    isOverdrive = false,
    overdriveMultiplier = 1.0,
    isBossActive = false,
    maxDuration = 2.8,
  ): boolean {
    // If already holds a reservation, renew
    if (this.airReservations.has(enemyId)) {
      return true;
    }

    // Block during micro-lull unless zero active attackers
    if (this.microLullActive && this.airReservations.size > 0) {
      return false;
    }

    // Check personal cooldown
    const readyAt = this.personalAirCooldowns.get(enemyId) ?? 0;
    if (time < readyAt) {
      return false;
    }

    // Check concurrency slot cap
    const maxSlots = this.getMaxAirAttackSlots(wave, threatLevel, isOverdrive, overdriveMultiplier, isBossActive);
    if (this.airReservations.size >= maxSlots) {
      return false;
    }

    // Attack rotation replacement delay check
    const rotDelay = attackRotationDelay(wave, isOverdrive, overdriveMultiplier);
    if (time - this.lastAirAttackReleaseTime < rotDelay && this.airReservations.size > 0) {
      return false;
    }

    // Stagger check: enforce at least 250ms gap between consecutive attack commitments
    if (time - this.lastAirAttackGrantTime < 0.25) {
      return false;
    }

    // Grant slot
    this.lastAirAttackGrantTime = time;
    this.airReservations.set(enemyId, {
      enemyId,
      grantedTime: time,
      timeoutTime: time + maxDuration,
      sector: this.assignSectorForIndex(this.airReservations.size),
    });

    return true;
  }

  /**
   * Release an aerial attack slot when an attack run completes or enemy breaks away.
   */
  releaseAirAttackSlot(enemyId: number, time: number, cooldown = 2.8) {
    this.airReservations.delete(enemyId);
    this.lastAirAttackReleaseTime = time;
    this.personalAirCooldowns.set(enemyId, time + cooldown);
  }

  hasAirAttackSlot(enemyId: number): boolean {
    return this.airReservations.has(enemyId);
  }

  /**
   * Request a standard ground attack slot (Tank lane positioning / fire).
   */
  requestGroundAttackSlot(
    enemyId: number,
    time: number,
    wave: number,
    isBossActive = false,
    maxDuration = 2.0,
  ): boolean {
    if (this.groundReservations.has(enemyId)) return true;
    if (this.microLullActive && this.groundReservations.size > 0) return false;

    const readyAt = this.personalGroundCooldowns.get(enemyId) ?? 0;
    if (time < readyAt) return false;

    const maxSlots = this.getMaxGroundAttackSlots(wave, isBossActive);
    if (this.groundReservations.size >= maxSlots) return false;

    // Stagger ground cannon blasts by at least 350ms
    if (time - this.lastGroundAttackGrantTime < 0.35) return false;

    this.lastGroundAttackGrantTime = time;
    this.groundReservations.set(enemyId, {
      enemyId,
      grantedTime: time,
      timeoutTime: time + maxDuration,
    });
    return true;
  }

  releaseGroundAttackSlot(enemyId: number, time: number, cooldown = 2.4) {
    this.groundReservations.delete(enemyId);
    this.lastGroundAttackReleaseTime = time;
    this.personalGroundCooldowns.set(enemyId, time + cooldown);
  }

  hasGroundAttackSlot(enemyId: number): boolean {
    return this.groundReservations.has(enemyId);
  }

  /**
   * Request a Heavy Attack slot (Tank main cannon blast, SAM missile launch, Boss beam volley).
   * Prevents simultaneous synchronized heavy attacks on the same frame.
   */
  requestHeavyAttackSlot(
    sourceId: number,
    sourceType: "TANK" | "SAM" | "BOSS" | "ARTILLERY",
    time: number,
    wave: number,
    isBossActive = false,
    maxDuration = 2.5,
  ): boolean {
    if (this.heavyReservations.has(sourceId)) return true;
    if (this.microLullActive && this.heavyReservations.size > 0) return false;

    const readyAt = this.personalHeavyCooldowns.get(sourceId) ?? 0;
    if (time < readyAt) return false;

    const maxHeavy = this.getMaxHeavyAttackSlots(wave, isBossActive);
    if (this.heavyReservations.size >= maxHeavy) return false;

    // Heavy attack stagger: enforce at least 450ms gap between any two heavy strikes
    if (time - this.lastHeavyAttackGrantTime < 0.45) return false;

    this.lastHeavyAttackGrantTime = time;
    this.heavyReservations.set(sourceId, {
      sourceId,
      sourceType,
      grantedTime: time,
      timeoutTime: time + maxDuration,
    });
    return true;
  }

  releaseHeavyAttackSlot(sourceId: number, time: number, cooldown = 2.8) {
    this.heavyReservations.delete(sourceId);
    this.lastHeavyAttackReleaseTime = time;
    this.personalHeavyCooldowns.set(sourceId, time + cooldown);
  }

  hasHeavyAttackSlot(sourceId: number): boolean {
    return this.heavyReservations.has(sourceId);
  }

  /**
   * Get an approach sector angle for an aerial or ground unit, respecting directional pressure mode.
   */
  getAssignedApproachAngle(
    enemyId: number,
    personalityOffset: number,
    wave = 1,
    isOverdrive = false,
  ): number {
    const mode = this.getDirectionalMode(wave, isOverdrive);
    const hash = ((enemyId * 9301 + 49297) % 233280) / 233280;

    let baseAngle: number;
    if (mode === DirectionalPressureMode.SINGLE_SECTOR) {
      baseAngle = this.getCurrentDirectionalAngle();
      const spread = (hash - 0.5) * Math.PI * 0.45;
      return baseAngle + spread + Math.sin(personalityOffset) * 0.15;
    }

    if (mode === DirectionalPressureMode.DOMINANT_AND_FLANK) {
      const isFlank = hash < 0.25;
      baseAngle = isFlank ? this.getSecondaryDirectionalAngle() : this.getCurrentDirectionalAngle();
      const spread = (hash - 0.5) * Math.PI * 0.55;
      return baseAngle + spread + Math.sin(personalityOffset) * 0.18;
    }

    if (mode === DirectionalPressureMode.DUAL_SECTORS) {
      const pickSecondary = hash < 0.45;
      baseAngle = pickSecondary ? this.getSecondaryDirectionalAngle() : this.getCurrentDirectionalAngle();
      const spread = (hash - 0.5) * Math.PI * 0.65;
      return baseAngle + spread + Math.sin(personalityOffset) * 0.20;
    }

    // PINCER_SURROUND (Overdrive)
    const quadrant = Math.floor(hash * 4);
    baseAngle = quadrant * (Math.PI / 2) + Math.sin(personalityOffset) * 0.25;
    return baseAngle;
  }

  private assignSectorForIndex(idx: number): AttackSector {
    const sectors = [
      AttackSector.FRONT_LEFT,
      AttackSector.FRONT_RIGHT,
      AttackSector.LEFT,
      AttackSector.RIGHT,
      AttackSector.REAR_LEFT,
      AttackSector.REAR_RIGHT,
    ];
    return sectors[idx % sectors.length];
  }

  /**
   * Returns snapshot for dev telemetry HUD overlay.
   */
  getSnapshot(
    activeAirCount: number,
    activeTotalEnemies: number,
    currentGroundThreat: number,
    currentAirThreat: number,
    combatIntensity: number,
    wave: number,
    threatLevel = 1,
    isOverdrive = false,
    overdriveMultiplier = 1.0,
    isBossActive = false,
    difficulty: "casual" | "normal" | "hard" = "normal",
    priorityTargetActive = false,
    pickupRiskActive = false,
    spawnQueueLength = 0,
  ): CombatDirectorSnapshot {
    const attackingIds = Array.from(this.airReservations.keys());
    const mode = this.getDirectionalMode(wave, isOverdrive);
    const targetPop = enemyPopulationTarget(wave, threatLevel, isOverdrive, overdriveMultiplier, isBossActive);
    const targetGround = groundThreatTarget(wave, threatLevel, isOverdrive, isBossActive);
    const targetAir = airThreatTarget(wave, threatLevel, isOverdrive, isBossActive);
    const rotDelay = attackRotationDelay(wave, isOverdrive, overdriveMultiplier);
    const spawnInt = calculateSpawnInterval(wave, 1.0, 1.0, combatIntensity, this.microLullActive);

    return {
      wave,
      combatIntensity,
      activeEnemies: activeTotalEnemies,
      targetEnemies: targetPop,
      groundThreat: Math.round(currentGroundThreat * 10) / 10,
      targetGroundThreat: Math.round(targetGround * 10) / 10,
      airThreat: Math.round(currentAirThreat * 10) / 10,
      targetAirThreat: Math.round(targetAir * 10) / 10,
      activeAirEnemies: activeAirCount,
      activeAirAttackers: this.airReservations.size,
      maxAirAttackSlots: this.getMaxAirAttackSlots(wave, threatLevel, isOverdrive, overdriveMultiplier, isBossActive),
      activeGroundAttackers: this.groundReservations.size,
      maxGroundAttackSlots: this.getMaxGroundAttackSlots(wave, isBossActive),
      activeHeavyAttacks: this.heavyReservations.size,
      maxHeavyAttacks: this.getMaxHeavyAttackSlots(wave, isBossActive),
      spawnInterval: Math.round(spawnInt * 100) / 100,
      attackRotationDelay: Math.round(rotDelay * 100) / 100,
      isMicroLull: this.microLullActive,
      microLullRemaining: Math.round(this.microLullRemaining * 10) / 10,
      currentDirectionalBias: this.getCurrentDirectionalName(),
      directionalMode: mode,
      hpScale: Math.round(enemyHPScale(wave, difficulty) * 100) / 100,
      damageScale: Math.round(enemyDamageScale(wave, difficulty) * 100) / 100,
      speedScale: Math.round(enemySpeedScale(wave) * 100) / 100,
      attackingIds,
      preparingIds: [],
      priorityTargetActive,
      pickupRiskActive,
      spawnQueueLength,
    };
  }
}

