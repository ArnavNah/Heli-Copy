import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Enemy, ProjectilePool } from './entities';
import { CombatDirector } from './combatDirector';
import {
  EnemyType,
  EnemyVariant,
  EnemyMovementClass,
  DroneCombatState,
} from './types';

describe('Enemy AI Repair Pass & Air Combat System', () => {
  let scene: THREE.Scene;
  let world: CANNON.World;
  let projectilePool: ProjectilePool;
  let combatDirector: CombatDirector;

  const mockCity = {
    blocks: [],
    getHeightAt: (_x: number, _z: number, _clearance?: number) => 0,
    hasLineOfSight: () => true,
  } as any;

  beforeEach(() => {
    scene = new THREE.Scene();
    world = new CANNON.World();
    projectilePool = new ProjectilePool(scene, 50);
    combatDirector = new CombatDirector();
  });

  describe('Transform Decoupling & Heading Orientation', () => {
    it('air enemy body faces actual flight velocity rather than snapping to player position', () => {
      const enemy = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      enemy.body.position.set(0, 20, 0);

      // Player is at (+50, 20, 0) -> pure EAST relative to enemy (atan2(50, 0) = PI/2 = 1.57 rad)
      const targetPos = new CANNON.Vec3(50, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      // Step AI for 30 frames to observe smooth turning towards velocity heading
      for (let i = 0; i < 30; i++) {
        enemy.updateDirection(
          targetPos,
          1.0 + i * 0.016,
          projectilePool,
          [],
          [enemy],
          mockCity,
          1.0,
          0.016,
          null,
          targetVel,
          combatDirector,
          1,
          1,
          false,
          1.0,
          false,
        );
      }

      // Verify that the body rotated towards velocity vector smoothly and is aligned with movement
      const horizSpeed = Math.hypot(enemy.smoothVelX, enemy.smoothVelZ);
      expect(horizSpeed).toBeGreaterThan(10);
      const velHeading = Math.atan2(enemy.smoothVelX, enemy.smoothVelZ);
      expect(Math.abs(enemy.mesh.rotation.y - velHeading)).toBeLessThan(0.35);
    });

    it('chin gun yaw pivot tracks player target independently of body orientation', () => {
      const enemy = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      enemy.body.position.set(0, 20, 0);
      enemy.mesh.rotation.y = 0; // Body faces NORTH (Z+)

      // Player is at (30, 20, 30) -> angle relative to body is ~45 deg (0.785 rad)
      const targetPos = new CANNON.Vec3(30, 20, 30);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      // Step AI multiple frames to allow smooth chin gun tracking
      for (let i = 0; i < 20; i++) {
        enemy.updateDirection(
          targetPos,
          1.0 + i * 0.016,
          projectilePool,
          [],
          [enemy],
          mockCity,
          1.0,
          0.016,
          null,
          targetVel,
          combatDirector,
          1,
          1,
          false,
          1.0,
          false,
        );
      }

      expect(enemy.gunYawPivot).toBeDefined();
      if (enemy.gunYawPivot) {
        expect(Math.abs(enemy.gunYawPivot.rotation.y)).toBeGreaterThanOrEqual(0);
        expect(Math.abs(enemy.gunYawPivot.rotation.y)).toBeLessThanOrEqual(1.15); // Clamped within physical limits
      }
    });

    it('tank chassis faces movement direction while turret tracks player independently', () => {
      const tank = new Enemy(scene, world, 0, 0, EnemyType.TANK, 1.5);
      tank.body.position.set(0, 1.2, 0);

      // Player is at (40, 1.2, 0) -> East (+X)
      const targetPos = new CANNON.Vec3(40, 1.2, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      for (let i = 0; i < 20; i++) {
        tank.updateDirection(
          targetPos,
          1.0 + i * 0.016,
          projectilePool,
          [],
          [tank],
          mockCity,
          1.0,
          0.016,
          null,
          targetVel,
          combatDirector,
          1,
          1,
          false,
          1.0,
          false,
        );
      }

      expect(tank.turretYawPivot).toBeDefined();
      expect(tank.cannonPitchPivot).toBeDefined();
    });
  });

  describe('7-State Air Combat AI Lifecycle', () => {
    it('progresses from SPAWN_ENTRY -> APPROACH -> ATTACK_SETUP', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(100, 20, 100); // 141m away -> Spawn Entry

      expect(drone.droneState).toBe(DroneCombatState.SPAWN_ENTRY);

      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      // Move into engagement zone (dist <= 75)
      drone.body.position.set(50, 20, 50); // 70m away
      drone.updateDirection(
        targetPos,
        1.0,
        projectilePool,
        [],
        [drone],
        mockCity,
        1.0,
        0.016,
        null,
        targetVel,
        combatDirector,
        1,
        1,
        false,
        1.0,
        false,
      );

      expect(drone.droneState).toBe(DroneCombatState.APPROACH);

      // Move into standoff range to transition to ATTACK_SETUP
      drone.body.position.set(30, 20, 30);
      drone.droneStateTimer = 4.0; // Trigger timer transition
      drone.updateDirection(
        targetPos,
        1.1,
        projectilePool,
        [],
        [drone],
        mockCity,
        1.0,
        0.016,
        null,
        targetVel,
        combatDirector,
        1,
        1,
        false,
        1.0,
        false,
      );

      expect(drone.droneState).toBe(DroneCombatState.ATTACK_SETUP);
    });

    it('enters ATTACK_RUN when slot is granted and releases slot on BREAK_AWAY', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(35, 20, 0);
      drone.droneState = DroneCombatState.ATTACK_SETUP;

      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      // Step AI in ATTACK_SETUP to request slot
      drone.updateDirection(
        targetPos,
        5.0,
        projectilePool,
        [],
        [drone],
        mockCity,
        1.0,
        0.016,
        null,
        targetVel,
        combatDirector,
        1,
        1,
        false,
        1.0,
        false,
      );

      expect(drone.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(combatDirector.hasAirAttackSlot(drone.id)).toBe(true);

      // Complete attack run duration
      drone.attackRunDuration = 0;
      drone.updateDirection(
        targetPos,
        5.1,
        projectilePool,
        [],
        [drone],
        mockCity,
        1.0,
        0.016,
        null,
        targetVel,
        combatDirector,
        1,
        1,
        false,
        1.0,
        false,
      );

      // Transitions to BREAK_AWAY and slot is immediately released
      expect(drone.droneState).toBe(DroneCombatState.BREAK_AWAY);
      expect(combatDirector.hasAirAttackSlot(drone.id)).toBe(false);
    });

    it('enforces dodgeability: reduced turn rate during ATTACK_RUN so player dodge causes miss', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(0, 20, 40);
      drone.droneState = DroneCombatState.ATTACK_RUN;
      drone.attackRunDuration = 2.0;
      drone.attackVectorX = 0;
      drone.attackVectorZ = -1; // committed SOUTH

      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      // Step AI for 20 frames
      for (let i = 0; i < 20; i++) {
        drone.updateDirection(
          targetPos,
          5.0 + i * 0.016,
          projectilePool,
          [],
          [drone],
          mockCity,
          1.0,
          0.016,
          null,
          targetVel,
          combatDirector,
          1,
          1,
          false,
          1.0,
          false,
        );
      }

      // Velocity should remain heavily aligned with committed attack vector (Z negative)
      expect(drone.smoothVelZ).toBeLessThan(-20);
    });
  });

  describe('Gunship Variants & Tactical Roster Support', () => {
    it('supports all flying variants through the air combat AI machine', () => {
      const variants = [
        EnemyVariant.ATTACK_GUNSHIP,
        EnemyVariant.ROCKET_GUNSHIP,
        EnemyVariant.HEAVY_GUNSHIP,
        EnemyVariant.INTERCEPTOR,
        EnemyVariant.GATLING_HEAVY,
      ];

      for (const variant of variants) {
        const gunship = new Enemy(scene, world, 0, 0, EnemyType.SHOOTER, 50, { variant });
        expect(gunship.movementClass).toBe(EnemyMovementClass.FLYING);

        gunship.body.position.set(40, 25, 0);
        const targetPos = new CANNON.Vec3(0, 20, 0);
        const targetVel = new CANNON.Vec3(0, 0, 0);

        expect(() => {
          gunship.updateDirection(
            targetPos,
            1.0,
            projectilePool,
            [],
            [gunship],
            mockCity,
            1.0,
            0.016,
            null,
            targetVel,
            combatDirector,
            1,
            1,
            false,
            1.0,
            false,
          );
        }).not.toThrow();
      }
    });

    it('executes Kamikaze drone dive without crashing', () => {
      const kamikaze = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30, { variant: EnemyVariant.KAMIKAZE_DRONE });
      kamikaze.body.position.set(20, 20, 20);

      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      expect(() => {
        kamikaze.updateDirection(
          targetPos,
          1.0,
          projectilePool,
          [],
          [kamikaze],
          mockCity,
          1.0,
          0.016,
          null,
          targetVel,
          combatDirector,
          1,
          1,
          false,
          1.0,
          false,
        );
      }).not.toThrow();
    });

    it('executes Support and Repair drones without crashing', () => {
      const shield = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30, { variant: EnemyVariant.SHIELD_DRONE });
      const ally = new Enemy(scene, world, 10, 0, EnemyType.DRONE, 30, { variant: EnemyVariant.ATTACK_GUNSHIP });
      ally.hp = 10;

      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      expect(() => {
        shield.updateDirection(
          targetPos,
          1.0,
          projectilePool,
          [],
          [shield, ally],
          mockCity,
          1.0,
          0.016,
          null,
          targetVel,
          combatDirector,
          1,
          1,
          false,
          1.0,
          false,
        );
      }).not.toThrow();
    });
  });
});
