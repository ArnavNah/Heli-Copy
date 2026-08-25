import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Enemy } from './entities';
import {
  EnemyMovementClass,
  EnemyType,
} from './types';
import {
  GROUND_THREAT_COSTS,
  GROUND_COMPOSITIONS,
  pickGroundComposition,
} from './logic';

describe('Phase 1 Ground Combat Foundation', () => {
  let scene: THREE.Scene;
  let world: CANNON.World;

  beforeEach(() => {
    scene = new THREE.Scene();
    world = new CANNON.World();
  });

  describe('Enemy Movement Classes', () => {
    it('assigns GROUND class to Infantry Cluster (BASIC)', () => {
      const infantry = new Enemy(scene, world, 0, 0, EnemyType.BASIC, 1.0);
      expect(infantry.movementClass).toBe(EnemyMovementClass.GROUND);
      expect(infantry.type).toBe(EnemyType.BASIC);
    });

    it('assigns GROUND class to Tank', () => {
      const tank = new Enemy(scene, world, 0, 0, EnemyType.TANK, 1.5);
      expect(tank.movementClass).toBe(EnemyMovementClass.GROUND);
      expect(tank.type).toBe(EnemyType.TANK);
    });

    it('assigns FLYING class to aerial types', () => {
      const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 20);
      expect(drone.movementClass).toBe(EnemyMovementClass.FLYING);
    });
  });

  describe('Infantry Cluster Architecture', () => {
    it('creates Infantry Cluster model with visible squad members', () => {
      const cluster = new Enemy(scene, world, 10, 20, EnemyType.BASIC, 1.0);
      expect(cluster.ring).toBeDefined();
      expect(cluster.ring.children.length).toBe(4);
      expect(cluster.maxHp).toBe(25);
    });

    it('clamps grounded Infantry position to terrain height', () => {
      const cluster = new Enemy(scene, world, 10, 20, EnemyType.BASIC, 1.0);
      const mockCity = {
        blocks: [],
        getHeightAt: (_x: number, _z: number, _clearance?: number) => 3.5,
        hasLineOfSight: () => true,
      };

      const targetPos = new CANNON.Vec3(10, 20, 40);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      cluster.updateDirection(
        targetPos,
        1.0,
        null as any,
        [],
        [],
        mockCity as any,
        1.0,
        0.016,
        new CANNON.Body(),
        targetVel,
      );

      expect(cluster.body.position.y).toBeGreaterThanOrEqual(4.0);
      expect(cluster.body.velocity.y).toBe(0);
    });
  });

  describe('Tank Decoupled Chassis and Turret', () => {
    it('creates Tank model with chassis, turret yaw pivot, cannon pitch pivot, and muzzle point', () => {
      const tank = new Enemy(scene, world, 0, 0, EnemyType.TANK, 1.5);
      expect(tank.ring).toBeDefined();
      expect(tank.turretYawPivot).not.toBeNull();
      expect(tank.cannonPitchPivot).not.toBeNull();
      expect(tank.muzzlePoint).not.toBeNull();
      expect(tank.tankTelegraphMesh).not.toBeNull();
      expect(tank.maxHp).toBe(100);
    });

    it('decouples chassis heading from turret aiming angle', () => {
      const tank = new Enemy(scene, world, 0, 0, EnemyType.TANK, 1.5);

      const mockCity = {
        blocks: [],
        getHeightAt: () => 0,
        hasLineOfSight: () => true,
      };

      // Player to the East (+X, dist 80 > 45) and up in air (y = 15)
      const targetPos = new CANNON.Vec3(80, 15, 0);
      const targetVel = new CANNON.Vec3(0, 0, 0);

      tank.updateDirection(
        targetPos,
        1.0,
        null as any,
        [],
        [],
        mockCity as any,
        1.0,
        0.05,
        new CANNON.Body(),
        targetVel,
      );

      // Chassis should face movement direction (+X)
      expect(tank.mesh.rotation.y).toBeCloseTo(Math.PI / 2, 1);
      expect(tank.turretYawPivot).not.toBeNull();
      // Turret tracks target
      expect(tank.cannonPitchPivot).not.toBeNull();
      expect(tank.cannonPitchPivot!.rotation.x).toBeLessThan(0);
    });
  });

  describe('Ground Threat Budget & Compositions', () => {
    it('defines accurate ground threat weights', () => {
      expect(GROUND_THREAT_COSTS.INFANTRY).toBe(1.0);
      expect(GROUND_THREAT_COSTS.TANK).toBe(2.0);
      expect(GROUND_THREAT_COSTS.SAM).toBe(3.0);
    });

    it('contains all ground compositions A through H', () => {
      const names = GROUND_COMPOSITIONS.map((c) => c.name);
      expect(names).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

      const compA = GROUND_COMPOSITIONS.find((c) => c.name === 'A')!;
      expect(compA.infantry).toBe(2);
      expect(compA.tanks).toBe(0);

      const compB = GROUND_COMPOSITIONS.find((c) => c.name === 'B')!;
      expect(compB.infantry).toBe(2);
      expect(compB.tanks).toBe(1);

      const compC = GROUND_COMPOSITIONS.find((c) => c.name === 'C')!;
      expect(compC.tanks).toBe(3);

      const compD = GROUND_COMPOSITIONS.find((c) => c.name === 'D')!;
      expect(compD.tanks).toBe(1);
      expect(compD.sam).toBe(1);

      const compE = GROUND_COMPOSITIONS.find((c) => c.name === 'E')!;
      expect(compE.tanks).toBe(3);
      expect(compE.sam).toBe(1);
    });

    it('picks wave-appropriate ground compositions', () => {
      const earlyComp = pickGroundComposition(1, () => 0.1);
      expect(['A']).toContain(earlyComp.name);

      const lateComp = pickGroundComposition(5, () => 0.99);
      expect(lateComp).toBeDefined();
      expect(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']).toContain(lateComp.name);
    });
  });
});
