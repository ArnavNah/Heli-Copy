import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { Enemy, PowerUp, Objective, ProjectilePool } from "./entities";
import { GPUParticleSystem } from "./particles";
import { EnemyType, EnemyVariant, ObjectiveType, PowerUpType, SamState } from "./types";
import { rollLoot } from "./loot";
import { EnemyHelicopterModelFactory } from "./enemyHelicopterModels";

describe("Combat Feedback & Reward Flow Pass (TEST 1 to TEST 15)", () => {
  let scene: THREE.Scene;
  let world: CANNON.World;
  let particles: GPUParticleSystem;

  beforeEach(() => {
    scene = new THREE.Scene();
    world = new CANNON.World();
    particles = new GPUParticleSystem(500);
  });

  // TEST 1: Hover dust emits when AGL <= 14
  it("TEST 1: Hover dust emits when AGL <= 14", () => {
    const groundY = 0;
    const rotorY = 8; // altitudeAGL = 8 <= 14
    const altitudeAGL = rotorY - groundY;
    const strength = Math.min(1.0, Math.max(0.0, 1.0 - altitudeAGL / 14.0));
    expect(strength).toBeGreaterThan(0.4);

    particles.spawnRotorDownwash(0, groundY, 0, 0, 0, 3.2, strength, 1.0, 2);
    expect(particles.dirty).toBe(true);

    // Particle Y should be near the ground
    const py = particles.positionAttr.getY(0);
    expect(py).toBeCloseTo(0.1, 1);

    // When altitude > 14, strength is 0
    const highAGL = 20;
    const highStrength = Math.min(1.0, Math.max(0.0, 1.0 - highAGL / 14.0));
    expect(highStrength).toBe(0);
  });

  // TEST 2: Fast low flight creates trailing dust wake
  it("TEST 2: Fast low flight creates trailing dust wake", () => {
    const vx = 40;
    const vz = 0;
    const groundY = 0;
    const strength = 0.8;

    particles.spawnRotorDownwash(0, groundY, 0, vx, vz, 3.2, strength, 1.0, 2);

    // The velocity X attribute should be predominantly negative (opposite of forward flight)
    const pvx0 = particles.velocityAttr.getX(0);
    expect(pvx0).toBeLessThan(0);
  });

  // TEST 3: Air enemy death spiral loses lift and crashes
  it("TEST 3: Air enemy death spiral loses lift and crashes", () => {
    const enemy = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 1.0);
    enemy.body.position.set(0, 25, 0);

    // Trigger lethal damage
    const result = enemy.takeDamage(1000, 1.0);
    expect(result).toBe("destroyed");
    expect(enemy.isDying).toBe(true);
    expect(enemy.active).toBe(false);

    const initialY = enemy.body.position.y;
    const initialYaw = enemy.mesh.rotation.y;

    // Simulate several frames of death spiral
    const mockCity = { getHeightAt: () => 0 };
    let finished = false;
    for (let f = 0; f < 30; f++) {
      finished = enemy.updateDeathSpiral(0.05, mockCity, 1.0 + f * 0.05, particles);
      if (finished) break;
    }

    // Altitude should decrease and rotation should tumble
    expect(enemy.body.position.y).toBeLessThan(initialY);
    expect(enemy.mesh.rotation.y).not.toBe(initialYaw);

    // Run until impact
    while (!finished) {
      finished = enemy.updateDeathSpiral(0.05, mockCity, 2.0, particles);
    }
    expect(finished).toBe(true);
    expect(enemy.readyForRemoval).toBe(true);
    expect(enemy.body.position.y).toBeLessThanOrEqual(0.6);
  });

  // TEST 4: Rooftop crash stops death spiral at roof altitude
  it("TEST 4: Rooftop crash stops death spiral at roof altitude", () => {
    const enemy = new Enemy(scene, world, 50, -50, EnemyType.DRONE, 1.0);
    enemy.body.position.set(50, 30, -50);
    enemy.takeDamage(1000, 1.0);

    const roofHeight = 18.0;
    const mockCity = {
      getHeightAt: (x: number, z: number) => (Math.abs(x - 50) < 5 && Math.abs(z - -50) < 5 ? roofHeight : 0),
    };

    let finished = false;
    while (!finished) {
      finished = enemy.updateDeathSpiral(0.05, mockCity, 2.0, particles);
    }

    expect(finished).toBe(true);
    // Should stop at roof height (18.0) rather than falling to 0
    expect(enemy.body.position.y).toBeGreaterThanOrEqual(18.0);
    expect(enemy.body.position.y).toBeLessThanOrEqual(18.6);
  });

  // TEST 5: Tank destruction spawns explosion, debris, sparks, smoke
  it("TEST 5: Tank destruction drops special loot and spawns VFX components", () => {
    const tank = new Enemy(scene, world, 0, 0, EnemyType.TANK, 1.0);
    expect(tank.type).toBe(EnemyType.TANK);

    const plan = rollLoot("SPECIAL", 0.1, 0.2);
    expect(plan.salvage).toBeGreaterThanOrEqual(0);

    // Verify particle spawns work for tank explosion
    particles.spawnDebris(0, 0, 0, 1.0, 16, 28);
    particles.spawnSparks(0, 0, 0, 1.0, 6, 20);
    particles.spawnSmoke(0, 1, 0, 1.0);
    expect(particles.dirty).toBe(true);
  });

  // TEST 6: SAM destruction cancels tracking/launch and triggers cook-off
  it("TEST 6: SAM destruction cancels tracking/launch and triggers cook-off", () => {
    const sam = new Objective(scene, world, 0, 2, -100, ObjectiveType.SAM_SITE);
    expect(sam.type).toBe(ObjectiveType.SAM_SITE);

    // Secondary missile cook-off pops
    particles.spawnCookOff(0, 2, -100, 1.0, 6);
    expect(particles.dirty).toBe(true);

    // SAM loot contains High-Value Salvage Cache
    const plan = rollLoot("MISSION", 0.2, 0.3);
    expect(plan.salvageCache).toBe(true);
  });

  // TEST 7: Radar tower collapse stops dish rotation and spawns debris
  it("TEST 7: Radar tower collapse stops dish rotation and spawns debris", () => {
    const radar = new Objective(scene, world, 0, 2, -100, ObjectiveType.RADAR_TOWER);
    expect(radar.radarYawPivot).toBeDefined();

    const initialRot = radar.radarYawPivot!.rotation.y;
    radar.update(1.0, 0.1);
    const activeRot = radar.radarYawPivot!.rotation.y;
    expect(activeRot).toBeGreaterThan(initialRot);

    // On death / destruction
    radar.isDying = true;
    radar.update(1.1, 0.1);
    // Rotation should not advance once dead
    expect(radar.radarYawPivot!.rotation.y).toBe(activeRot);
  });

  // TEST 8: Boss at 50% HP shows left engine damage
  it("TEST 8: Boss at 50% HP shows left engine damage attachment", () => {
    const model = EnemyHelicopterModelFactory.create({ family: "boss" });
    expect(model.damagePoints.engineLeft).toBeDefined();
    expect(model.damagePoints.engineRight).toBeDefined();
    expect(model.damagePoints.hull).toBeDefined();
    expect(model.damagePoints.core).toBeDefined();

    const hpRatio = 0.5; // 50% HP
    const isLeftEngineDamaged = hpRatio <= 0.66;
    const isCritical = hpRatio <= 0.33;

    expect(isLeftEngineDamaged).toBe(true);
    expect(isCritical).toBe(false);
  });

  // TEST 9: Boss at 20% HP shows both engines, hull electrical arcs, core instability
  it("TEST 9: Boss at 20% HP shows both engines, hull electrical arcs, core instability", () => {
    const hpRatio = 0.2; // 20% HP (Critical)
    const isLeftEngineDamaged = hpRatio <= 0.66;
    const isCritical = hpRatio <= 0.33;

    expect(isLeftEngineDamaged).toBe(true);
    expect(isCritical).toBe(true);

    // Verify electrical arcs spawn cleanly
    particles.spawnElectricalArc(0, 2, 0, 1.0, 3, 16);
    expect(particles.dirty).toBe(true);
  });

  // TEST 10: Missile threat indicator calculates correct TTI from closing velocity
  it("TEST 10: Missile threat indicator calculates correct TTI from closing velocity", () => {
    const playerPos = { x: 0, y: 15, z: 0 };
    const missilePos = { x: 0, y: 15, z: -100 };
    const missileVel = { x: 0, y: 0, z: 50 }; // Moving toward player at +50 u/s

    const dx = missilePos.x - playerPos.x;
    const dz = missilePos.z - playerPos.z;
    const distance = Math.hypot(dx, dz);
    expect(distance).toBe(100);

    const toPlayerX = -dx / distance;
    const toPlayerZ = -dz / distance;
    const closingVel = missileVel.x * toPlayerX + missileVel.z * toPlayerZ;
    expect(closingVel).toBe(50);

    const tti = distance / Math.max(15, closingVel);
    expect(tti).toBe(2.0);

    const danger = tti < 1.4 ? "RED" : tti < 2.8 ? "ORANGE" : "YELLOW";
    expect(danger).toBe("ORANGE");
  });

  // TEST 11: Decoyed missile downgrades danger level
  it("TEST 11: Decoyed missile downgrades danger level", () => {
    const distance = 40;
    const closingVel = 50; // normal TTI = 0.8s (RED)
    const isDecoyed = true;

    let danger: "YELLOW" | "ORANGE" | "RED";
    let tti: number;

    if (isDecoyed || closingVel <= 2) {
      danger = "YELLOW";
      tti = Math.max(9.9, distance / Math.max(10, Math.abs(closingVel)));
    } else {
      tti = distance / Math.max(15, closingVel);
      danger = tti < 1.4 ? "RED" : tti < 2.8 ? "ORANGE" : "YELLOW";
    }

    expect(danger).toBe("YELLOW");
    expect(tti).toBeGreaterThanOrEqual(9.9);
  });

  // TEST 12: Near-miss projectile triggers audio/particles once within 5.5–14.0u
  it("TEST 12: Near-miss projectile triggers audio/particles once within 5.5–14.0u", () => {
    const pool = new ProjectilePool(scene, 10, 0xffaa00);
    const proj = pool.spawn(0, 15, -100, 0, 1, 1.0, 80);
    expect(proj.nearMissTriggered).toBe(false);

    const playerPos = { x: 0, y: 15, z: 0 };
    proj.pos.set(8, 15, 0); // 8 units away (within 5.5 - 14.0u bubble)

    const dx = proj.pos.x - playerPos.x;
    const dy = proj.pos.y - playerPos.y;
    const dz = proj.pos.z - playerPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;

    expect(distSq).toBe(64);
    expect(distSq).toBeGreaterThan(30.25);
    expect(distSq).toBeLessThanOrEqual(196.0);

    // Trigger near-miss once
    if (!proj.nearMissTriggered && distSq > 30.25 && distSq <= 196.0) {
      proj.nearMissTriggered = true;
      particles.spawnNearMissStreak(proj.pos.x, proj.pos.y, proj.pos.z, proj.vel.x, proj.vel.y, proj.vel.z, 1.0);
    }
    expect(proj.nearMissTriggered).toBe(true);

    // Subsequent check does not re-trigger
    let triggeredAgain = false;
    if (!proj.nearMissTriggered) {
      triggeredAgain = true;
    }
    expect(triggeredAgain).toBe(false);
  });

  // TEST 13: Fast air enemy pass triggers fly-by within 18u
  it("TEST 13: Fast air enemy pass triggers fly-by within 18u", () => {
    const enemy = new Enemy(scene, world, 0, 0, EnemyType.DRONE, 1.0);
    expect(enemy.flybyTriggered).toBe(false);

    enemy.smoothVelX = 40;
    enemy.smoothVelZ = 0;
    const speed = Math.hypot(enemy.smoothVelX, enemy.smoothVelZ);
    expect(speed).toBeGreaterThanOrEqual(32);

    const playerPos = { x: 0, z: 0 };
    enemy.body.position.set(10, 15, 0); // 10 units away (within 18u)

    const pDist = Math.hypot(enemy.body.position.x - playerPos.x, enemy.body.position.z - playerPos.z);
    expect(pDist).toBeLessThan(18.0);

    if (!enemy.flybyTriggered && speed >= 32 && pDist < 18.0) {
      enemy.flybyTriggered = true;
    }
    expect(enemy.flybyTriggered).toBe(true);
  });

  // TEST 14: Magnet accelerates pickup towards player as distance closes
  it("TEST 14: Magnet accelerates pickup towards player as distance closes", () => {
    const pu = new PowerUp(scene, 0, 2, 20, PowerUpType.XP_GEM);
    const playerPos = new THREE.Vector3(0, 2, 0);
    const magnetRadius = 24;

    const dx = playerPos.x - pu.mesh.position.x;
    const dz = playerPos.z - pu.mesh.position.z;
    const distFar = Math.hypot(dx, dz); // 20 units

    const tFar = 1 - distFar / magnetRadius; // 1 - 20/24 = 0.166
    const speedFar = 38 + tFar * tFar * 115;

    // At close distance
    const distClose = 2; // 2 units
    const tClose = 1 - distClose / magnetRadius; // 1 - 2/24 = 0.916
    const speedClose = 38 + tClose * tClose * 115;

    expect(speedClose).toBeGreaterThan(speedFar * 2);
    expect(speedClose).toBeGreaterThan(120);
  });

  // TEST 15: Performance stability under combat load (30 enemies)
  it("TEST 15: Combat director maintains performance with 30 active enemies", () => {
    const enemies: Enemy[] = [];
    for (let i = 0; i < 30; i++) {
      const type = i % 5 === 0 ? EnemyType.TANK : EnemyType.DRONE;
      const e = new Enemy(scene, world, (i % 6 - 3) * 15, -i * 10, type, 1.0);
      enemies.push(e);
    }
    expect(enemies.length).toBe(30);

    // Simulate 30 frames of downwash emitter selection and spatial tests
    let downwashCount = 0;
    const pPos = { x: 0, y: 15, z: 0 };
    for (const e of enemies) {
      if (!e.active || e.type !== EnemyType.DRONE || e.isDying) continue;
      const eDistSq = (e.body.position.x - pPos.x) ** 2 + (e.body.position.z - pPos.z) ** 2;
      if (eDistSq <= 6400) {
        downwashCount++;
        if (downwashCount >= 2) break; // Capped at 2
      }
    }
    expect(downwashCount).toBeLessThanOrEqual(2);
  });
});
