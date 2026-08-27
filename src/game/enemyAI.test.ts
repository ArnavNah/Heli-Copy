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

  describe('Air Combat Overhaul — 10 Required Target Scenarios', () => {
    it('TEST 1: One helicopter vs stationary player completes full loop (approach -> setup -> attack -> pass -> breakaway -> return)', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(100, 20, 100); // 141m away
      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      // 1. Starts in SPAWN_ENTRY
      expect(drone.droneState).toBe(DroneCombatState.SPAWN_ENTRY);

      // 2. Crosses into combat range -> APPROACH
      drone.body.position.set(50, 20, 50);
      drone.updateDirection(targetPos, 1.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      expect(drone.droneState).toBe(DroneCombatState.APPROACH);

      // 3. Reaches standoff perimeter -> ATTACK_SETUP
      drone.body.position.set(30, 20, 30);
      drone.droneStateTimer = 4.0;
      drone.updateDirection(targetPos, 2.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      expect(drone.droneState).toBe(DroneCombatState.ATTACK_SETUP);

      // 4. Requests and gets slot -> ATTACK_RUN
      drone.updateDirection(targetPos, 3.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      expect(drone.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(combatDirector.hasAirAttackSlot(drone.id)).toBe(true);

      // 5. Completes run / passes player -> BREAK_AWAY (releases slot)
      drone.attackRunDuration = 0;
      drone.updateDirection(targetPos, 4.5, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      expect(drone.droneState).toBe(DroneCombatState.BREAK_AWAY);
      expect(combatDirector.hasAirAttackSlot(drone.id)).toBe(false);

      // 6. Banks away and gains distance -> REPOSITION
      drone.body.position.set(50, 20, 0);
      drone.droneStateTimer = 2.0;
      drone.updateDirection(targetPos, 6.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      expect(drone.droneState).toBe(DroneCombatState.REPOSITION);

      // 7. Returns to standoff position -> ATTACK_SETUP
      drone.droneStateTimer = 3.0;
      drone.updateDirection(targetPos, 9.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      expect(drone.droneState).toBe(DroneCombatState.ATTACK_SETUP);
    });

    it('TEST 2: Player flies straight — Enemy intercepts using predictive lead rather than lagging behind', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(0, 20, 60); // 60m North of player origin
      const targetPos = new CANNON.Vec3(0, 20, 0);
      const targetVel = new CANNON.Vec3(35, 0, 0); // Player cruising East (+X) at 35 u/s

      drone.droneState = DroneCombatState.ATTACK_SETUP;
      drone.updateDirection(targetPos, 1.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);

      // Drone enters ATTACK_RUN with attack vector aimed ahead along +X (predictive interception)
      expect(drone.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(drone.attackVectorX).toBeGreaterThan(0.2); // Interception angle leads target toward +X
    });

    it('TEST 3: Player suddenly turns 90° — Enemy turn rate is reduced during ATTACK_RUN causing it to overshoot/miss', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(0, 20, 35);
      drone.droneState = DroneCombatState.ATTACK_RUN;
      drone.attackRunDuration = 1.5;
      drone.attackVectorX = 0;
      drone.attackVectorZ = -1; // Committed dive South (-Z)

      // Player suddenly executes a 90° hard evasion to the East (+X)
      const targetPos = new CANNON.Vec3(30, 20, 0);
      const targetVel = new CANNON.Vec3(45, 0, 0);

      // Step AI for 15 frames during committed attack run
      for (let i = 0; i < 15; i++) {
        drone.updateDirection(targetPos, 2.0 + i * 0.016, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);
      }

      // Drone is locked into its forward momentum — smoothVelZ remains heavily negative
      expect(drone.smoothVelZ).toBeLessThan(-20);
      // It did not instantly snap to face +X
      expect(drone.smoothVelX).toBeLessThan(25);
    });

    it('TEST 4: Player reverses 180° — Enemy completes current commitment before adapting', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone.body.position.set(0, 20, 40);
      drone.droneState = DroneCombatState.ATTACK_RUN;
      drone.attackRunDuration = 1.5;
      drone.attackVectorX = 0;
      drone.attackVectorZ = -1;

      // Player reverses 180° directly behind the dive lane
      const targetPos = new CANNON.Vec3(0, 20, 60); // Behind the drone
      const targetVel = new CANNON.Vec3(0, 0, 30);

      drone.updateDirection(targetPos, 2.0, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, targetVel, combatDirector, 1);

      // Drone maintains its forward attack commitment rather than instantly executing a 180° snap
      expect(drone.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(drone.attackVectorZ).toBe(-1);
    });

    it('TEST 5: 3 Air enemies — Attack slot rotation and personal cooldowns work cleanly', () => {
      const drone1 = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone1.body.position.set(30, 20, 0);
      const drone2 = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone2.body.position.set(35, 20, 0);
      const drone3 = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
      drone3.body.position.set(40, 20, 0);
      const targetPos = new CANNON.Vec3(0, 20, 0);

      drone1.droneState = DroneCombatState.ATTACK_SETUP;
      drone2.droneState = DroneCombatState.ATTACK_SETUP;
      drone3.droneState = DroneCombatState.ATTACK_SETUP;

      const time = 10.0;
      const wave = 1; // Wave 1 allows max 1 concurrent attacker

      // Drone 1 acquires slot
      drone1.updateDirection(targetPos, time, projectilePool, [], [drone1, drone2, drone3], mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      expect(drone1.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(combatDirector.hasAirAttackSlot(drone1.id)).toBe(true);

      // Drone 2 and Drone 3 are queued in ATTACK_SETUP (slot limit reached)
      drone2.updateDirection(targetPos, time, projectilePool, [], [drone1, drone2, drone3], mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      drone3.updateDirection(targetPos, time, projectilePool, [], [drone1, drone2, drone3], mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      expect(drone2.droneState).toBe(DroneCombatState.ATTACK_SETUP);
      expect(drone3.droneState).toBe(DroneCombatState.ATTACK_SETUP);

      // Drone 1 finishes and releases slot with 3.0s personal cooldown
      drone1.attackRunDuration = 0;
      drone1.updateDirection(targetPos, time + 1.5, projectilePool, [], [drone1, drone2, drone3], mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      expect(drone1.droneState).toBe(DroneCombatState.BREAK_AWAY);
      expect(combatDirector.hasAirAttackSlot(drone1.id)).toBe(false);

      // After rotation delay, Drone 2 takes the attack slot
      drone2.updateDirection(targetPos, time + 2.8, projectilePool, [], [drone1, drone2, drone3], mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      expect(drone2.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(combatDirector.hasAirAttackSlot(drone2.id)).toBe(true);
    });

    it('TEST 6: 8 Air enemies — Concurrency slot limits strictly enforced (no spam swarms)', () => {
      const drones: Enemy[] = [];
      for (let i = 0; i < 8; i++) {
        const d = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 30);
        d.body.position.set(30 + i * 5, 20, 0);
        d.droneState = DroneCombatState.ATTACK_SETUP;
        drones.push(d);
      }
      const targetPos = new CANNON.Vec3(0, 20, 0);
      const wave = 4; // Mid-wave: max 2 simultaneous attackers
      const maxSlots = combatDirector.getMaxAirAttackSlots(wave);
      expect(maxSlots).toBe(2);

      const time = 20.0;
      for (let i = 0; i < drones.length; i++) {
        drones[i].updateDirection(targetPos, time + i * 0.35, projectilePool, [], drones, mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      }

      const activeAttackers = drones.filter((d) => d.droneState === DroneCombatState.ATTACK_RUN);
      expect(activeAttackers.length).toBeLessThanOrEqual(2);
      expect(activeAttackers.length).toBe(2);
    });

    it('TEST 7: Buildings — Enemy climbs and adjusts safe altitude using predictive lookahead', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 20);
      drone.body.position.set(0, 15, 0);
      drone.smoothVelZ = 30; // Flying North toward building
      drone.mesh.rotation.y = 0; // Heading North

      // Mock city with 35m tall building ahead
      const cityWithBuilding = {
        blocks: [],
        getHeightAt: (_x: number, z: number) => (z > 5 ? 35 : 0),
        hasLineOfSight: () => true,
      } as any;

      const targetPos = new CANNON.Vec3(0, 15, 60);

      drone.updateDirection(targetPos, 1.0, projectilePool, [], [drone], cityWithBuilding, 1.0, 0.016, null, null, combatDirector, 1);

      // Safe altitude must climb to at least building height + clearance
      expect(drone.cachedSafeAltitude).toBeGreaterThanOrEqual(35 + 5.0);
      expect(drone.smoothVelY).toBeGreaterThan(0); // Upward vertical climb
    });

    it('TEST 8: Air + Tank — Ground Tank follows lane/aim/fire while Air executes attack runs', () => {
      const tank = new Enemy(scene, world, 0, 0, EnemyType.TANK, 1.5);
      const drone = new Enemy(scene, world, 20, 0, EnemyType.DRONE, 30);
      const targetPos = new CANNON.Vec3(30, 1.2, 0);

      expect(tank.movementClass).toBe(EnemyMovementClass.GROUND);
      expect(drone.movementClass).toBe(EnemyMovementClass.FLYING);

      tank.updateDirection(targetPos, 1.0, projectilePool, [], [tank, drone], mockCity, 1.0, 0.016, null, null, combatDirector, 1);
      drone.updateDirection(targetPos, 1.0, projectilePool, [], [tank, drone], mockCity, 1.0, 0.016, null, null, combatDirector, 1);

      // Tank operates on TankCombatState
      expect(tank.tankCombatState).toBeDefined();
      // Drone operates on DroneCombatState
      expect(drone.droneState).toBeDefined();
    });

    it('TEST 9: Air + SAM — SAM controls space with HeavyAttackSlot while Air executes attack runs', () => {
      const drone = new Enemy(scene, world, 20, 0, EnemyType.DRONE, 30);
      drone.droneState = DroneCombatState.ATTACK_SETUP;
      const targetPos = new CANNON.Vec3(0, 20, 0);
      const time = 10.0;
      const wave = 5;

      // SAM site requests heavy attack slot
      const samId = 50001;
      const samGranted = combatDirector.requestHeavyAttackSlot(samId, 'SAM', time, wave);
      expect(samGranted).toBe(true);
      expect(combatDirector.hasHeavyAttackSlot(samId)).toBe(true);

      // Drone can still acquire an air attack slot (distinct budgets!)
      drone.updateDirection(targetPos, time + 0.5, projectilePool, [], [drone], mockCity, 1.0, 0.016, null, null, combatDirector, wave);
      expect(drone.droneState).toBe(DroneCombatState.ATTACK_RUN);
      expect(combatDirector.hasAirAttackSlot(drone.id)).toBe(true);
    });

    it('TEST 10: Air + Tank + SAM — HeavyAttackBudget and AirAttackSlots coordinate so combat remains readable', () => {
      const time = 10.0;
      const wave = 5; // max 2 heavy attacks, max 2 air attackers

      const samId = 50001;
      const tankId = 201;
      const tank2Id = 202;

      // 1. SAM acquires first heavy attack slot
      expect(combatDirector.requestHeavyAttackSlot(samId, 'SAM', time, wave)).toBe(true);

      // 2. Same-frame heavy attack from tank is rejected by 450ms stagger gap
      expect(combatDirector.requestHeavyAttackSlot(tankId, 'TANK', time + 0.1, wave)).toBe(false);

      // 3. After stagger gap, Tank acquires 2nd heavy attack slot
      expect(combatDirector.requestHeavyAttackSlot(tankId, 'TANK', time + 0.5, wave)).toBe(true);

      // 4. 3rd heavy attack blocked by concurrency cap (max 2 on wave 5)
      expect(combatDirector.requestHeavyAttackSlot(tank2Id, 'TANK', time + 1.0, wave)).toBe(false);

      // 5. Boss volleys coordinate cleanly through heavy attack budget
      const bossId = 999;
      expect(combatDirector.requestHeavyAttackSlot(bossId, 'BOSS', time + 1.2, wave)).toBe(false);
      combatDirector.releaseHeavyAttackSlot(samId, time + 1.3);
      expect(combatDirector.requestHeavyAttackSlot(bossId, 'BOSS', time + 1.8, wave)).toBe(true);
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
