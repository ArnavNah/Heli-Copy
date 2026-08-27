import { describe, expect, it, beforeEach } from "vitest";
import {
  calculateCombatIntensity,
  enemyPopulationTarget,
  groundThreatTarget,
  airThreatTarget,
  maxActiveAirAttackers,
  maxActiveHeavyAttacks,
  attackRotationDelay,
  microLullConfig,
  enemyHPScale,
  enemyDamageScale,
  enemySpeedScale,
  enemyAimAccuracy,
  calculateSpawnInterval,
  ENEMY_VARIANTS,
  AIR_THREAT_COSTS,
  GROUND_THREAT_COSTS,
  PRIORITY_TARGET_WAVE_CHANCE,
  PRIORITY_TARGET_OVERDRIVE_CHANCE,
  priorityTargetReward,
} from "./logic";
import { CombatDirector, PERFORMANCE_CAPS } from "./combatDirector";
import { DirectionalPressureMode, EnemyVariant } from "./types";

describe("Difficulty & Pressure Scaling Overhaul", () => {
  describe("1. Central Combat Intensity Model", () => {
    it("calculates bounded intensity that surges with time, wave, and health danger", () => {
      const earlyChill = calculateCombatIntensity({
        elapsedRunTime: 10,
        wave: 1,
        threatLevel: 1,
        healthRatio: 1.0,
        activeEnemiesCount: 4,
        targetEnemiesCount: 5,
        isBossActive: false,
        isOverdrive: false,
        overdriveMultiplier: 1.0,
      });
      expect(earlyChill).toBeGreaterThanOrEqual(0.1);
      expect(earlyChill).toBeLessThan(0.45);

      const lateIntense = calculateCombatIntensity({
        elapsedRunTime: 180,
        wave: 9,
        threatLevel: 4,
        healthRatio: 0.3,
        activeEnemiesCount: 22,
        targetEnemiesCount: 24,
        isBossActive: false,
        isOverdrive: false,
        overdriveMultiplier: 1.0,
      });
      expect(lateIntense).toBeGreaterThan(0.85);
      expect(lateIntense).toBeLessThanOrEqual(1.5);

      const bossIntensity = calculateCombatIntensity({
        elapsedRunTime: 200,
        wave: 10,
        threatLevel: 3,
        healthRatio: 0.5,
        activeEnemiesCount: 10,
        targetEnemiesCount: 10,
        isBossActive: true,
        isOverdrive: false,
        overdriveMultiplier: 1.0,
      });
      expect(bossIntensity).toBeGreaterThan(0.9);
    });
  });

  describe("2. Non-Sponge Stat Scaling Curves", () => {
    it("scales HP conservatively without bullet-sponge inflation", () => {
      expect(enemyHPScale(1)).toBe(1.0);
      expect(enemyHPScale(5)).toBeCloseTo(1.20); // ~1.15-1.30 range
      expect(enemyHPScale(9)).toBeCloseTo(1.40); // ~1.35-1.60 range
      expect(enemyHPScale(15)).toBeCloseTo(1.75);
      expect(enemyHPScale(50)).toBeLessThanOrEqual(2.35); // Capped
    });

    it("scales damage slower than HP to prevent unfair one-shots", () => {
      expect(enemyDamageScale(1)).toBe(1.0);
      expect(enemyDamageScale(5)).toBeCloseTo(1.12); // ~1.10-1.15 range
      expect(enemyDamageScale(9)).toBeCloseTo(1.24); // ~1.20-1.35 range
      expect(enemyDamageScale(15)).toBeCloseTo(1.45);
      expect(enemyDamageScale(50)).toBeLessThanOrEqual(1.70); // Capped
    });

    it("scales movement speed conservatively to preserve dogfight physics", () => {
      expect(enemySpeedScale(1)).toBe(1.0);
      expect(enemySpeedScale(3)).toBe(1.0);
      expect(enemySpeedScale(5)).toBeCloseTo(1.04);
      expect(enemySpeedScale(9)).toBeCloseTo(1.12);
      expect(enemySpeedScale(50)).toBe(1.18); // Hard capped at 1.18 max
    });

    it("sharpens aim precision gradually without becoming a perfect aimbot", () => {
      expect(enemyAimAccuracy(1)).toBeCloseTo(0.45);
      expect(enemyAimAccuracy(5)).toBeCloseTo(0.63);
      expect(enemyAimAccuracy(9)).toBeCloseTo(0.764);
      expect(enemyAimAccuracy(20)).toBe(0.80); // Capped for normal waves
      expect(enemyAimAccuracy(10, true)).toBe(0.82); // Boss accuracy
    });
  });

  describe("3. Population & Decoupled Threat Targets", () => {
    it("scales population targets across waves and throttles during boss encounters", () => {
      expect(enemyPopulationTarget(1)).toBe(5);
      expect(enemyPopulationTarget(2)).toBe(7);
      expect(enemyPopulationTarget(3)).toBe(10);
      expect(enemyPopulationTarget(5)).toBe(14);
      expect(enemyPopulationTarget(7)).toBe(18);
      expect(enemyPopulationTarget(9)).toBe(24);
      // Boss active throttles regular population to 10
      expect(enemyPopulationTarget(10, 1, false, 1.0, true)).toBe(10);
      // Hard capped at 48 max
      expect(enemyPopulationTarget(50, 5, true, 3.0)).toBeLessThanOrEqual(48);
    });

    it("escalates Ground and Air threats independently with Air-First focus", () => {
      // Ground threat serves as tactical support
      expect(groundThreatTarget(1)).toBe(1.5);
      expect(groundThreatTarget(3)).toBe(3.5);
      expect(groundThreatTarget(5)).toBe(5.5);
      expect(groundThreatTarget(9)).toBe(11.0);
      expect(groundThreatTarget(10, 1, false, true)).toBe(3.0); // Boss support throttle

      // Aerial threat is primary from Wave 1
      expect(airThreatTarget(1)).toBe(6.0); // Light Helicopters / Combat Drones
      expect(airThreatTarget(3)).toBe(10.5);
      expect(airThreatTarget(5)).toBe(14.0);
      expect(airThreatTarget(6)).toBe(16.0); // Attack Gunships introduced
      expect(airThreatTarget(7)).toBe(18.0); // Rocket Gunships introduced
      expect(airThreatTarget(9)).toBe(24.0); // Full aerial pressure
      expect(airThreatTarget(10, 1, false, true)).toBe(6.0); // Boss support throttle

      // Verify Target Enemy Mix Ratios
      const earlyAirRatio = airThreatTarget(1) / (airThreatTarget(1) + groundThreatTarget(1));
      expect(earlyAirRatio).toBeGreaterThanOrEqual(0.70); // 70-80% Air early

      const midAirRatio = airThreatTarget(5) / (airThreatTarget(5) + groundThreatTarget(5));
      expect(midAirRatio).toBeGreaterThanOrEqual(0.65); // 65-75% Air mid

      const lateAirRatio = airThreatTarget(9) / (airThreatTarget(9) + groundThreatTarget(9));
      expect(lateAirRatio).toBeGreaterThanOrEqual(0.60); // 60-70% Air late
    });
  });

  describe("4. Combat Director Concurrency & Attack Coordination", () => {
    let director: CombatDirector;

    beforeEach(() => {
      director = new CombatDirector();
    });

    it("scales concurrent air attack slots across progression", () => {
      expect(maxActiveAirAttackers(1)).toBe(1);
      expect(maxActiveAirAttackers(4)).toBe(2);
      expect(maxActiveAirAttackers(7)).toBe(3);
      expect(maxActiveAirAttackers(9)).toBe(4);
      expect(maxActiveAirAttackers(10, 1, false, 1.0, true)).toBe(2);
      expect(maxActiveAirAttackers(15, 3, true, 2.5)).toBe(6);
    });

    it("coordinates heavy attack budget with concurrency limits and stagger gap", () => {
      expect(maxActiveHeavyAttacks(1)).toBe(1);
      expect(maxActiveHeavyAttacks(5)).toBe(2);
      expect(maxActiveHeavyAttacks(9)).toBe(3);
      expect(maxActiveHeavyAttacks(10, true)).toBe(1);

      const time = 100.0;
      // Grant heavy slot 1
      expect(director.requestHeavyAttackSlot(1, "TANK", time, 5)).toBe(true);

      // Attempt second heavy attack at time + 0.1 (blocked by 450ms stagger gap)
      expect(director.requestHeavyAttackSlot(2, "SAM", time + 0.1, 5)).toBe(false);

      // Attempt after stagger gap at time + 0.5 (granted)
      expect(director.requestHeavyAttackSlot(2, "SAM", time + 0.5, 5)).toBe(true);

      // Third heavy attack at time + 1.0 (blocked by max slots limit of 2)
      expect(director.requestHeavyAttackSlot(3, "TANK", time + 1.0, 5)).toBe(false);

      // Release first slot and grant third slot
      director.releaseHeavyAttackSlot(1, time + 1.1, 2.0);
      expect(director.requestHeavyAttackSlot(3, "TANK", time + 1.6, 5)).toBe(true);
    });

    it("shrinks attack rotation delay across waves to increase battle density", () => {
      const earlyDelay = attackRotationDelay(1);
      const midDelay = attackRotationDelay(5);
      const lateDelay = attackRotationDelay(9);
      const overdriveDelay = attackRotationDelay(15, true, 2.0);

      expect(earlyDelay).toBeGreaterThan(midDelay);
      expect(midDelay).toBeGreaterThan(lateDelay);
      expect(lateDelay).toBeGreaterThan(overdriveDelay);
      expect(overdriveDelay).toBeGreaterThanOrEqual(0.15);
    });

    it("modulates micro-lulls: shorter duration and tighter intervals as waves rise", () => {
      const earlyLull = microLullConfig(1);
      const lateLull = microLullConfig(9);
      const overdriveLull = microLullConfig(15, true);

      expect(earlyLull.duration).toBe(3.5);
      expect(earlyLull.interval).toBe(28.0);
      expect(lateLull.duration).toBe(2.2);
      expect(overdriveLull.duration).toBe(1.8);
      expect(overdriveLull.interval).toBe(24.0);
    });

    it("escalates directional pressure complexity", () => {
      expect(director.getDirectionalMode(1)).toBe(DirectionalPressureMode.SINGLE_SECTOR);
      expect(director.getDirectionalMode(5)).toBe(DirectionalPressureMode.DOMINANT_AND_FLANK);
      expect(director.getDirectionalMode(8)).toBe(DirectionalPressureMode.DUAL_SECTORS);
      expect(director.getDirectionalMode(12, true)).toBe(DirectionalPressureMode.PINCER_SURROUND);
    });
  });

  describe("5. Hard Performance Caps", () => {
    it("strictly bounds active entities, projectiles, and queues", () => {
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_ENEMIES).toBe(48);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_AIR).toBe(12);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_GROUND).toBe(36);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_AIR_ATTACKERS).toBe(6);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_HEAVY_ATTACKS).toBe(3);
      expect(PERFORMANCE_CAPS.MAX_PROJECTILES).toBe(180);
      expect(PERFORMANCE_CAPS.MAX_PARTICLES).toBe(600);
      expect(PERFORMANCE_CAPS.MAX_SPAWN_QUEUE).toBe(18);
    });

    it("calculates dynamic spawn intervals without dropping below safe floors", () => {
      const earlyCadence = calculateSpawnInterval(1, 1.0, 1.0, 0.2, false);
      const lateCadence = calculateSpawnInterval(9, 1.0, 1.0, 1.0, false);
      const lullCadence = calculateSpawnInterval(9, 1.0, 1.0, 1.0, true);

      expect(earlyCadence).toBeGreaterThan(lateCadence);
      expect(lateCadence).toBeGreaterThanOrEqual(0.14);
      expect(lullCadence).toBe(0.55); // Lull pauses aggressive influx
    });
  });

  describe("6. Wave Flow & Variant Progression", () => {
    it("enforces intended unlock waves for specialized archetypes", () => {
      // Light attack helis from Wave 1, Scout drones from Wave 2
      expect(ENEMY_VARIANTS[EnemyVariant.STANDARD].minWave).toBe(1);
      expect(ENEMY_VARIANTS[EnemyVariant.SCOUT_DRONE].minWave).toBe(2);

      // Tanks appear from Wave 3
      expect(ENEMY_VARIANTS[EnemyVariant.FLAK_TANK].minWave).toBe(3);

      // Attack Gunships introduced Wave 6
      expect(ENEMY_VARIANTS[EnemyVariant.ATTACK_GUNSHIP].minWave).toBe(6);

      // Rocket Gunships introduced Wave 7
      expect(ENEMY_VARIANTS[EnemyVariant.ROCKET_GUNSHIP].minWave).toBe(7);

      // Kamikaze Drones introduced sparingly in Wave 8
      expect(ENEMY_VARIANTS[EnemyVariant.KAMIKAZE_DRONE].minWave).toBe(8);
    });

    it("defines proper threat cost ratings", () => {
      expect(AIR_THREAT_COSTS.COMBAT_DRONE).toBe(1.5);
      expect(AIR_THREAT_COSTS.ATTACK_GUNSHIP).toBe(3.0);
      expect(AIR_THREAT_COSTS.ROCKET_GUNSHIP).toBe(3.5);
      expect(AIR_THREAT_COSTS.KAMIKAZE_DRONE).toBe(1.25);

      expect(GROUND_THREAT_COSTS.INFANTRY).toBe(1.0);
      expect(GROUND_THREAT_COSTS.TANK).toBe(2.0);
      expect(GROUND_THREAT_COSTS.SAM).toBe(3.0);
    });
  });

  describe("7. Priority Target System & Directional Sector Spawning", () => {
    let director: CombatDirector;

    beforeEach(() => {
      director = new CombatDirector();
    });

    it("gates priority targets to wave 4+ and scales rewards per wave", () => {
      expect(PRIORITY_TARGET_WAVE_CHANCE[1]).toBe(0);
      expect(PRIORITY_TARGET_WAVE_CHANCE[2]).toBe(0);
      expect(PRIORITY_TARGET_WAVE_CHANCE[3]).toBe(0);
      expect(PRIORITY_TARGET_WAVE_CHANCE[4]).toBeGreaterThan(0);
      expect(PRIORITY_TARGET_WAVE_CHANCE[9]).toBeGreaterThan(PRIORITY_TARGET_WAVE_CHANCE[4]);
      expect(PRIORITY_TARGET_OVERDRIVE_CHANCE).toBe(0.18);

      const earlyReward = priorityTargetReward(4);
      const lateReward = priorityTargetReward(9);

      expect(earlyReward.credits).toBeGreaterThanOrEqual(200);
      expect(lateReward.credits).toBeGreaterThan(earlyReward.credits);
      expect(lateReward.salvage).toBeGreaterThanOrEqual(earlyReward.salvage);
    });

    it("generates deterministic sector spawn angles per directional mode", () => {
      const angle1 = director.getSectorSpawnAngle(101, 1);
      const angle2 = director.getSectorSpawnAngle(102, 5);
      const angle3 = director.getSectorSpawnAngle(103, 8);
      const angleOverdrive = director.getSectorSpawnAngle(104, 12, true);

      expect(Number.isFinite(angle1)).toBe(true);
      expect(Number.isFinite(angle2)).toBe(true);
      expect(Number.isFinite(angle3)).toBe(true);
      expect(Number.isFinite(angleOverdrive)).toBe(true);
    });
  });
});
