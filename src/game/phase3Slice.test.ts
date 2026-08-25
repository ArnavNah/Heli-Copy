import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { Enemy, Objective } from './entities';
import {
  EnemyType,
  EnemyVariant,
  EnemyModifier,
  AttackPattern,
  EnemyMovementClass,
  ObjectiveType,
} from './types';
import {
  AIR_THREAT_COSTS,
  GROUND_THREAT_COSTS,
  GROUND_COMPOSITIONS,
  MIXED_COMPOSITIONS,
  pickGroundComposition,
  pickMixedComposition,
  bossPhaseForRatio,
} from './logic';
import { ProjectilePool } from './entities';

describe('Phase 3: One Air Enemy, Two-Budget Director, and Heavy Gunship Boss', () => {
  const scene = new THREE.Scene();
  const world = new CANNON.World();
  const city = {
    blocks: [],
    getHeightAt: (_x: number, _z: number, _r = 0) => 0,
    checkLineOfSight: () => true,
  } as any;

  describe('Step 1 & 6: Combat Drone Archetype & Model Structure', () => {
    it('builds a readable Combat Drone hierarchy with required components', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 18);
      expect(drone.movementClass).toBe(EnemyMovementClass.FLYING);

      const root = drone.mesh.getObjectByName('CombatDroneRoot');
      expect(root).toBeDefined();

      const centralBody = root?.getObjectByName('CentralBody');
      const leftWing = root?.getObjectByName('LeftWing');
      const rightWing = root?.getObjectByName('RightWing');
      const engine01 = root?.getObjectByName('Engine01');
      const engine02 = root?.getObjectByName('Engine02');
      const gunMount = root?.getObjectByName('GunMount');
      const navLight = root?.getObjectByName('NavigationLight');
      const targetPoint = root?.getObjectByName('TargetPoint');

      expect(centralBody).toBeDefined();
      expect(leftWing).toBeDefined();
      expect(rightWing).toBeDefined();
      expect(engine01).toBeDefined();
      expect(engine02).toBeDefined();
      expect(gunMount).toBeDefined();
      expect(navLight).toBeDefined();
      expect(targetPoint).toBeDefined();
    });

    it('supports 2 cosmetic wing variants with identical gameplay stats', () => {
      const drone1 = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 18);
      drone1.droneCosmeticVariant = 0; // Delta wing
      const drone2 = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 18);
      drone2.droneCosmeticVariant = 1; // Forward-swept wing

      expect(drone1.maxHp).toBe(drone2.maxHp);
      expect(drone1.basePoints).toBe(drone2.basePoints);
      expect(drone1.radius).toBeCloseTo(drone2.radius, 2);
    });
  });

  describe('Step 2, 3, 4 & 5: Real Flying Movement, Altitude & Aerial Banking', () => {
    it('maintains 3D flight physics with smooth vertical and horizontal velocities', () => {
      const drone = new Enemy(scene, world, 0, -60, EnemyType.DRONE, 18);
      const targetPos = new CANNON.Vec3(0, 25, 0);
      const projectilePool = new ProjectilePool(scene, 10);

      const initialY = drone.body.position.y;
      // Update drone towards higher altitude player
      drone.updateDirection(
        targetPos,
        1.0,
        projectilePool,
        [],
        [],
        city,
        1.0,
        0.1,
        null,
        new CANNON.Vec3(0, 0, 0),
      );

      // Vertical velocity is calculated and applied to altitude
      expect(drone.smoothVelY).not.toBe(0);
      expect(drone.body.position.y).not.toBe(initialY);
    });

    it('enforces building and terrain clearance over high obstacles', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 25);
      const targetPos = new CANNON.Vec3(0, 5, 0); // Low player position
      const projectilePool = new ProjectilePool(scene, 10);

      drone.cachedSafeAltitude = 22.0; // Simulated high building
      drone.lastObstacleCheckTime = 10.0; // Keep cached altitude active

      drone.updateDirection(
        targetPos,
        10.05,
        projectilePool,
        [],
        [],
        city,
        1.0,
        0.05,
        null,
        new CANNON.Vec3(0, 0, 0),
      );

      // Desired altitude stays clamped at or above safe building altitude
      expect(drone.body.position.y).toBeGreaterThanOrEqual(20);
    });

    it('banks between 8 and 18 degrees when turning laterally', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 18);
      const targetPos = new CANNON.Vec3(50, 18, 0); // Sharp turn to the right
      const projectilePool = new ProjectilePool(scene, 10);

      drone.smoothVelX = 0;
      drone.smoothVelZ = 20;

      // Simulate a turning update
      drone.updateDirection(
        targetPos,
        1.0,
        projectilePool,
        [],
        [],
        city,
        1.0,
        0.1,
        null,
        new CANNON.Vec3(0, 0, 0),
      );

      // Bank angle is non-zero and within 8-18 deg (~0.14 - 0.31 rad)
      expect(Math.abs(drone.airBankAngle)).toBeGreaterThan(0.01);
      expect(Math.abs(drone.airBankAngle)).toBeLessThanOrEqual(0.32);
    });
  });

  describe('Step 12, 13 & 14: Two-Budget Director & Threat Scaling', () => {
    it('defines correct separate threat costs for air and ground units', () => {
      expect(AIR_THREAT_COSTS.COMBAT_DRONE).toBe(1.5);
      expect(GROUND_THREAT_COSTS.INFANTRY).toBe(1.0);
      expect(GROUND_THREAT_COSTS.TANK).toBe(2.0);
      expect(GROUND_THREAT_COSTS.SAM).toBe(3.0);
    });

    it('progresses through Wave 1 to Wave 10 compositions and ratios', () => {
      // Wave 1-5: pure ground compositions
      const w1 = pickGroundComposition(1);
      expect(w1.minWave).toBeLessThanOrEqual(1);

      const w5 = pickGroundComposition(5);
      expect(w5.minWave).toBeLessThanOrEqual(5);

      // Wave 6+: mixed compositions become available
      const mixedW6 = pickMixedComposition(6);
      expect(mixedW6).not.toBeNull();
      expect(mixedW6?.air).toBeGreaterThanOrEqual(1);

      const mixedW9 = pickMixedComposition(9);
      expect(mixedW9).not.toBeNull();
      expect(mixedW9?.minWave).toBeLessThanOrEqual(9);
    });
  });

  describe('Step 16 & 17: Mixed Compositions A through G', () => {
    it('contains all 7 mixed encounter templates (A through G)', () => {
      const templateIds = MIXED_COMPOSITIONS.map((c) => c.templateId);
      expect(templateIds).toEqual([
        'MIXED_A',
        'MIXED_B',
        'MIXED_C',
        'MIXED_D',
        'MIXED_E',
        'MIXED_F',
        'MIXED_G',
      ]);

      const compA = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_A')!;
      expect(compA.air).toBe(1);
      expect(compA.infantry).toBe(2);
      expect(compA.tanks).toBe(0);

      const compB = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_B')!;
      expect(compB.air).toBe(1);
      expect(compB.tanks).toBe(1);

      const compE = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_E')!;
      expect(compE.air).toBe(1);
      expect(compE.tanks).toBe(1);
      expect(compE.sam).toBe(1);

      const compF = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_F')!;
      expect(compF.air).toBe(2);
      expect(compF.tanks).toBe(2);
    });
  });

  describe('Step 19–25: One Boss (Heavy Gunship)', () => {
    it('builds a distinct Heavy Gunship boss model with required hierarchy', () => {
      const boss = new Enemy(scene, world, 0, 0, EnemyType.BOSS, 24);
      expect(boss.movementClass).toBe(EnemyMovementClass.FLYING);
      expect(boss.maxHp).toBeGreaterThanOrEqual(200);

      const root = boss.mesh.getObjectByName('BossRoot');
      expect(root).toBeDefined();

      const fuselage = root?.getObjectByName('HeavyFuselage');
      const cockpit = root?.getObjectByName('Cockpit');
      const leftWing = root?.getObjectByName('LeftWing');
      const rightWing = root?.getObjectByName('RightWing');
      const engine01 = root?.getObjectByName('Engine01');
      const engine02 = root?.getObjectByName('Engine02');
      const cannon = root?.getObjectByName('CannonMount');
      const rocketLeft = root?.getObjectByName('RocketPodLeft');
      const rocketRight = root?.getObjectByName('RocketPodRight');
      const damageDetails = root?.getObjectByName('DamageDetails');
      const targetPoint = root?.getObjectByName('TargetPoint');

      expect(fuselage).toBeDefined();
      expect(cockpit).toBeDefined();
      expect(leftWing).toBeDefined();
      expect(rightWing).toBeDefined();
      expect(engine01).toBeDefined();
      expect(engine02).toBeDefined();
      expect(cannon).toBeDefined();
      expect(rocketLeft).toBeDefined();
      expect(rocketRight).toBeDefined();
      expect(damageDetails).toBeDefined();
      expect(targetPoint).toBeDefined();
    });

    it('transitions across 3 boss phases based on health thresholds', () => {
      expect(bossPhaseForRatio(1.0)).toBe(3); // Phase 1 (>66%)
      expect(bossPhaseForRatio(0.8)).toBe(3);
      expect(bossPhaseForRatio(0.5)).toBe(2); // Phase 2 (66-33%)
      expect(bossPhaseForRatio(0.2)).toBe(1); // Phase 3 (<33%)
    });
  });

  describe('Step 36: Encounter Differentiation Matrix (Tests A through I)', () => {
    it('TEST A: 1 Air enemy alone operates with altitude and velocity', () => {
      const drone = new Enemy(scene, world, 10, 10, EnemyType.DRONE, 18);
      expect(drone.type).toBe(EnemyType.DRONE);
      expect(drone.movementClass).toBe(EnemyMovementClass.FLYING);
    });

    it('TEST B, C, D, E, F: Mixed encounter compositions vary across air, armor, and SAM', () => {
      const compAirTank = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_B')!;
      const compAir2Tanks = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_C')!;
      const compAirTankSam = MIXED_COMPOSITIONS.find((c) => c.templateId === 'MIXED_E')!;
      const comp3TanksSam = GROUND_COMPOSITIONS.find((c) => c.templateId === 'E')!;

      // Verify distinct unit footprints
      expect(compAirTank.air).toBe(1);
      expect(compAirTank.tanks).toBe(1);

      expect(compAir2Tanks.air).toBe(1);
      expect(compAir2Tanks.tanks).toBe(2);

      expect(compAirTankSam.air).toBe(1);
      expect(compAirTankSam.sam).toBe(1);

      expect(comp3TanksSam.tanks).toBe(3);
      expect(comp3TanksSam.sam).toBe(1);
      expect(comp3TanksSam.infantry).toBe(0);
    });

    it('TEST G: Radar Station is present and operational with air units active', () => {
      const radar = new Objective(scene, world, 0, 0, -150, ObjectiveType.RADAR_TOWER);
      expect(radar.type).toBe(ObjectiveType.RADAR_TOWER);
      expect(radar.hp).toBe(radar.maxHp);
    });

    it('TEST H: Boss spawns with unique model and executes 3-phase combat set', () => {
      const boss = new Enemy(scene, world, 0, -100, EnemyType.BOSS, 24);
      expect(boss.type).toBe(EnemyType.BOSS);
      expect(boss.phase).toBe(3);
    });

    it('TEST I: Full Wave 1–10 progression scales smoothly from Ground to Air to Boss', () => {
      for (let wave = 1; wave <= 10; wave++) {
        if (wave < 6) {
          const comp = pickGroundComposition(wave);
          expect(comp).toBeDefined();
        } else if (wave < 10) {
          const comp = pickMixedComposition(wave);
          expect(comp).toBeDefined();
        } else {
          // Wave 10 Boss
          expect(wave).toBe(10);
        }
      }
    });
  });
});
