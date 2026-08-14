import { afterEach, describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { Helicopter, MOVEMENT_CONFIG, type MovementCommand } from './entities';

const NEUTRAL: MovementCommand = { x: 0, y: 0, z: 0, afterburner: 1 };
const FORWARD: MovementCommand = { x: 0, y: 0, z: -1, afterburner: 1 };

interface TestRig {
  scene: THREE.Scene;
  world: CANNON.World;
  helicopter: Helicopter;
  time: number;
}

const rigs: TestRig[] = [];

function createRig(): TestRig {
  const scene = new THREE.Scene();
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  world.defaultContactMaterial.friction = 0;
  world.defaultContactMaterial.restitution = 0;
  const rig = {
    scene,
    world,
    helicopter: new Helicopter(scene, world),
    time: 0,
  };
  rigs.push(rig);
  return rig;
}

function step(rig: TestRig, dt: number, move: MovementCommand, hasInput = true) {
  rig.time += dt;
  rig.helicopter.setHoverFloor(0);
  rig.helicopter.update(
    rig.time,
    dt,
    undefined,
    undefined,
    false,
    false,
    hasInput,
    move,
  );
  rig.world.step(1 / 60, dt, 3);
  rig.helicopter.syncBodyTransform();
}

function simulate(rig: TestRig, seconds: number, hz: number, move: MovementCommand) {
  const dt = 1 / hz;
  const frames = Math.round(seconds * hz);
  for (let i = 0; i < frames; i++) step(rig, dt, move, move !== NEUTRAL);
}

afterEach(() => {
  for (const rig of rigs.splice(0)) rig.helicopter.destroy();
});

describe('arcade helicopter movement', () => {
  it('holds a stable idle hover without drift', () => {
    const rig = createRig();
    simulate(rig, 60, 60, NEUTRAL);

    expect(rig.helicopter.body.position.x).toBeCloseTo(0, 6);
    expect(rig.helicopter.body.position.y).toBeCloseTo(26, 6);
    expect(rig.helicopter.body.position.z).toBeCloseTo(0, 6);
    expect(rig.helicopter.body.velocity.length()).toBeCloseTo(0, 6);
  });

  it('responds immediately and reaches cruise speed quickly', () => {
    const rig = createRig();
    step(rig, 1 / 60, FORWARD);
    expect(rig.helicopter.body.velocity.z).toBeLessThan(-1);

    simulate(rig, 0.34, 60, FORWARD);
    expect(-rig.helicopter.body.velocity.z).toBeCloseTo(
      MOVEMENT_CONFIG.maxHorizontalSpeed,
      0,
    );
  });

  it('keeps short momentum then brakes to hover in the target window', () => {
    const rig = createRig();
    rig.helicopter.body.velocity.z = -MOVEMENT_CONFIG.maxHorizontalSpeed;

    const dt = 1 / 120;
    step(rig, dt, NEUTRAL, false);
    expect(rig.helicopter.body.velocity.z).toBeLessThan(0);

    let stopTime = dt;
    while (Math.abs(rig.helicopter.body.velocity.z) > 0.01 && stopTime < 1) {
      step(rig, dt, NEUTRAL, false);
      stopTime += dt;
    }

    expect(stopTime).toBeGreaterThanOrEqual(0.25);
    expect(stopTime).toBeLessThanOrEqual(0.45);
    expect(rig.helicopter.body.velocity.z).toBe(0);
  });

  it('counter-steers through zero instead of flipping velocity instantly', () => {
    const rig = createRig();
    rig.helicopter.body.velocity.z = -MOVEMENT_CONFIG.maxHorizontalSpeed;
    const reverse: MovementCommand = { ...NEUTRAL, z: 1 };

    step(rig, 1 / 60, reverse);
    expect(rig.helicopter.body.velocity.z).toBeLessThan(0);

    simulate(rig, 0.25, 60, reverse);
    expect(rig.helicopter.body.velocity.z).toBeGreaterThan(0);
  });

  it('normalizes diagonal input to the same speed cap', () => {
    const forwardRig = createRig();
    const diagonalRig = createRig();
    const diagonal = 1 / Math.sqrt(2);

    simulate(forwardRig, 1, 60, FORWARD);
    simulate(
      diagonalRig,
      1,
      60,
      { x: diagonal, y: 0, z: -diagonal, afterburner: 1 },
    );

    const forwardSpeed = Math.hypot(
      forwardRig.helicopter.body.velocity.x,
      forwardRig.helicopter.body.velocity.z,
    );
    const diagonalSpeed = Math.hypot(
      diagonalRig.helicopter.body.velocity.x,
      diagonalRig.helicopter.body.velocity.z,
    );
    expect(diagonalSpeed).toBeCloseTo(forwardSpeed, 5);
  });

  it('uses weighted vertical acceleration and returns to auto-hover', () => {
    const rig = createRig();
    const climb: MovementCommand = { ...NEUTRAL, y: 1 };

    step(rig, 1 / 60, climb);
    expect(rig.helicopter.body.velocity.y).toBeGreaterThan(0);
    expect(rig.helicopter.body.velocity.y).toBeLessThan(
      MOVEMENT_CONFIG.maxVerticalSpeed,
    );

    simulate(rig, 0.5, 60, climb);
    expect(rig.helicopter.body.velocity.y).toBeCloseTo(
      MOVEMENT_CONFIG.maxVerticalSpeed,
      1,
    );

    simulate(rig, 0.5, 60, NEUTRAL);
    expect(rig.helicopter.body.velocity.y).toBe(0);
  });

  it.each([30, 60, 120])('keeps two-second travel consistent at %i Hz', (hz) => {
    const rig = createRig();
    simulate(rig, 2, hz, FORWARD);
    const referenceDistance = 127;
    expect(-rig.helicopter.body.position.z).toBeGreaterThan(referenceDistance - 4);
    expect(-rig.helicopter.body.position.z).toBeLessThan(referenceDistance + 4);
  });
});

describe('gun hierarchy', () => {
  it('rotates only the gun and derives direction from the real muzzle', () => {
    const rig = createRig();
    rig.helicopter.setGunAim(60, 26, 0, true);
    simulate(rig, 0.5, 60, NEUTRAL);

    const muzzlePosition = rig.helicopter.getMuzzlePosition(new THREE.Vector3());
    const muzzleDirection = rig.helicopter.getMuzzleDirection(new THREE.Vector3());

    expect(rig.helicopter.mesh.rotation.y).toBeCloseTo(0, 6);
    expect(rig.helicopter.gunYawPivot.rotation.y).toBeGreaterThan(1);
    expect(muzzlePosition.distanceTo(rig.helicopter.mesh.position)).toBeGreaterThan(3);
    expect(muzzleDirection.x).toBeGreaterThan(0.85);
    expect(Math.abs(muzzleDirection.z)).toBeLessThan(0.35);
  });
});
