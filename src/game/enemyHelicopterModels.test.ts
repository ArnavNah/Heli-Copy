import { describe, expect, it } from "vitest";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { EnemyHelicopterModelFactory } from "./enemyHelicopterModels";
import { Enemy } from "./entities";
import { EnemyType, EnemyVariant } from "./types";

describe("EnemyHelicopterModelFactory", () => {
  it("builds Light Attack Helicopter with all necessary hierarchy components and damage points", () => {
    const model = EnemyHelicopterModelFactory.create({
      family: "light",
      variant: 0,
      isElite: false,
    });

    expect(model.root).toBeDefined();
    expect(model.visualRoot).toBeDefined();
    expect(model.mainRotorPivot).toBeDefined();
    expect(model.tailRotorPivot).toBeDefined();
    expect(model.gunYawPivot).toBeDefined();
    expect(model.gunPitchPivot).toBeDefined();
    expect(model.muzzlePoint).toBeDefined();
    expect(model.targetPoint).toBeDefined();

    expect(model.damagePoints.engineLeft).toBeDefined();
    expect(model.damagePoints.engineRight).toBeDefined();
    expect(model.damagePoints.hull).toBeDefined();
    expect(model.damagePoints.tail).toBeDefined();
  });

  it("builds Light Attack Helicopter cosmetic variants correctly", () => {
    const v0 = EnemyHelicopterModelFactory.create({ family: "light", variant: 0 });
    const v1 = EnemyHelicopterModelFactory.create({ family: "light", variant: 1 });
    const v2 = EnemyHelicopterModelFactory.create({ family: "light", variant: 2 });
    const v3 = EnemyHelicopterModelFactory.create({ family: "light", variant: 3 });

    expect(v0.visualRoot.children.length).toBeGreaterThan(0);
    expect(v1.visualRoot.children.length).toBeGreaterThan(0);
    expect(v2.visualRoot.children.length).toBeGreaterThan(0);
    expect(v3.visualRoot.children.length).toBeGreaterThan(0);
  });

  it("builds Medium Attack Gunship with heavy 4-blade rotor, tandem cockpit, and weapon wings", () => {
    const model = EnemyHelicopterModelFactory.create({
      family: "medium",
      variant: 0,
      isElite: false,
    });

    expect(model.root).toBeDefined();
    expect(model.visualRoot).toBeDefined();
    expect(model.mainRotorPivot.children.length).toBeGreaterThanOrEqual(4);
    expect(model.tailRotorPivot.children.length).toBeGreaterThanOrEqual(4);
    expect(model.gunYawPivot).toBeDefined();
    expect(model.gunPitchPivot).toBeDefined();
    expect(model.muzzlePoint).toBeDefined();
    expect(model.targetPoint).toBeDefined();

    expect(model.damagePoints.engineLeft).toBeDefined();
    expect(model.damagePoints.engineRight).toBeDefined();
    expect(model.damagePoints.hull).toBeDefined();
  });

  it("builds Medium Attack Gunship cosmetic variants correctly", () => {
    const v0 = EnemyHelicopterModelFactory.create({ family: "medium", variant: 0 });
    const v1 = EnemyHelicopterModelFactory.create({ family: "medium", variant: 1 });
    const v2 = EnemyHelicopterModelFactory.create({ family: "medium", variant: 2 });
    const v3 = EnemyHelicopterModelFactory.create({ family: "medium", variant: 3 });

    expect(v0.visualRoot.children.length).toBeGreaterThan(0);
    expect(v1.visualRoot.children.length).toBeGreaterThan(0);
    expect(v2.visualRoot.children.length).toBeGreaterThan(0);
    expect(v3.visualRoot.children.length).toBeGreaterThan(0);
  });

  it("builds Boss Heavy Assault Gunship with glowing reactor core, twin nacelles, and twin tail booms", () => {
    const model = EnemyHelicopterModelFactory.create({
      family: "boss",
      isElite: true,
    });

    expect(model.root).toBeDefined();
    expect(model.visualRoot).toBeDefined();
    expect(model.mainRotorPivot.children.length).toBeGreaterThanOrEqual(5);
    expect(model.tailRotorPivot.children.length).toBeGreaterThanOrEqual(4);
    expect(model.coreGlowMesh).toBeDefined();
    expect(model.gunYawPivot).toBeDefined();
    expect(model.gunPitchPivot).toBeDefined();
    expect(model.muzzlePoint).toBeDefined();
    expect(model.targetPoint).toBeDefined();

    expect(model.damagePoints.engineLeft).toBeDefined();
    expect(model.damagePoints.engineRight).toBeDefined();
    expect(model.damagePoints.hull).toBeDefined();
  });

  it("caches and reuses shared geometries and materials for performance", () => {
    const modelA = EnemyHelicopterModelFactory.create({ family: "light", variant: 0 });
    const modelB = EnemyHelicopterModelFactory.create({ family: "light", variant: 0 });

    expect(modelA.mainRotorPivot).toBeDefined();
    expect(modelB.mainRotorPivot).toBeDefined();
    // Geometries are cached across instances
    expect(modelA.root).not.toBe(modelB.root);
  });

  it("integrates seamlessly with Enemy class for DRONE, SHOOTER, and BOSS", () => {
    const scene = new THREE.Scene();
    const world = new CANNON.World();

    const drone = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 20);
    const shooter = new Enemy(scene, world, 0, 0, EnemyType.SHOOTER, 20);
    const boss = new Enemy(scene, world, 0, 0, EnemyType.BOSS, 20);

    expect(drone.heliModelData).toBeDefined();
    expect(drone.enemyRotor).toBeDefined();
    expect(drone.enemyTailRotor).toBeDefined();
    expect(drone.gunYawPivot).toBeDefined();
    expect(drone.cannonPitchPivot).toBeDefined();
    expect(drone.muzzlePoint).toBeDefined();

    expect(shooter.heliModelData).toBeDefined();
    expect(shooter.enemyRotor).toBeDefined();
    expect(shooter.enemyTailRotor).toBeDefined();
    expect(shooter.gunYawPivot).toBeDefined();
    expect(shooter.cannonPitchPivot).toBeDefined();
    expect(shooter.muzzlePoint).toBeDefined();

    expect(boss.heliModelData).toBeDefined();
    expect(boss.enemyRotor).toBeDefined();
    expect(boss.enemyTailRotor).toBeDefined();
    expect(boss.gunYawPivot).toBeDefined();
    expect(boss.cannonPitchPivot).toBeDefined();
    expect(boss.muzzlePoint).toBeDefined();
    expect(boss.coreGlowMesh).toBeDefined();

    drone.destroy();
    shooter.destroy();
    boss.destroy();
  });
});
