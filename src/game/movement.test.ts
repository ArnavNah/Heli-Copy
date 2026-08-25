import { afterEach, describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { Helicopter, MOVEMENT_CONFIG, type MovementCommand } from './entities';
import { HelicopterModel } from './types';

const NEUTRAL: MovementCommand = { x: 0, y: 0, z: 0, afterburner: 1 };
const FORWARD: MovementCommand = { x: 0, y: 0, z: -1, afterburner: 1 };

interface TestRig {
  scene: THREE.Scene;
  world: CANNON.World;
  helicopter: Helicopter;
  time: number;
}

const rigs: TestRig[] = [];

function createRig(model: HelicopterModel = HelicopterModel.APACHE): TestRig {
  const scene = new THREE.Scene();
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  world.defaultContactMaterial.friction = 0;
  world.defaultContactMaterial.restitution = 0;
  const rig = {
    scene,
    world,
    helicopter: new Helicopter(scene, world, model),
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

describe('handling upgrades', () => {
  it('settles onto the hover floor with a damped spring, never slamming through', () => {
    const rig = createRig();
    const body = rig.helicopter.body;
    body.position.y = 12;
    body.velocity.y = -10;

    let minY = body.position.y;
    const dt = 1 / 60;
    for (let i = 0; i < 240; i++) {
      step(rig, dt, NEUTRAL, false);
      minY = Math.min(minY, body.position.y);
    }

    // Under-damped settle: may dip slightly under the clearance band while
    // the spring absorbs the descent, but never slams through the floor.
    expect(minY).toBeGreaterThan(5.5);
    expect(body.position.y).toBeGreaterThan(MOVEMENT_CONFIG.hoverClearance - 1);
    expect(body.position.y).toBeLessThan(MOVEMENT_CONFIG.hoverClearance + 3);
    expect(Math.abs(body.velocity.y)).toBeLessThan(2);
  });

  it('swings the nose with a yaw-rate limit instead of snapping', () => {
    const rig = createRig();
    const strafeRight: MovementCommand = { x: 1, y: 0, z: 0, afterburner: 1 };

    step(rig, 1 / 60, strafeRight);
    // Starts at Math.PI and turns toward Math.PI/2 with rate limit
    expect(rig.helicopter.mesh.rotation.y).toBeLessThan(Math.PI);
    expect(rig.helicopter.mesh.rotation.y).toBeGreaterThan(Math.PI / 2);

    simulate(rig, 1, 60, strafeRight);
    expect(rig.helicopter.mesh.rotation.y).toBeCloseTo(Math.PI / 2, 1);
  });

  it('moves and aligns body across 360-degree analog angles', () => {
    // Test 8 distinct angles around the circle
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 - Math.PI;
      const cmd: MovementCommand = {
        x: Math.sin(angle),
        y: 0,
        z: Math.cos(angle),
        afterburner: 1,
      };
      const rig = createRig();
      simulate(rig, 1, 60, cmd);

      // Body yaw should match movement angle
      let yawDiff = rig.helicopter.mesh.rotation.y - angle;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      expect(Math.abs(yawDiff)).toBeLessThan(0.15);

      // Velocity direction should match movement angle
      const speed = Math.hypot(rig.helicopter.body.velocity.x, rig.helicopter.body.velocity.z);
      expect(speed).toBeCloseTo(MOVEMENT_CONFIG.maxHorizontalSpeed, 0);
    }
  });

  it('scales desired speed with analog stick magnitude', () => {
    const halfRig = createRig();
    const fullRig = createRig();
    const halfForward: MovementCommand = { x: 0, y: 0, z: -0.5, afterburner: 1 };

    simulate(halfRig, 1, 60, halfForward);
    simulate(fullRig, 1, 60, FORWARD);

    const halfSpeed = -halfRig.helicopter.body.velocity.z;
    const fullSpeed = -fullRig.helicopter.body.velocity.z;

    expect(halfSpeed).toBeCloseTo(fullSpeed * 0.5, 0);
  });

  it('pitches the nose up when climbing and down when descending', () => {
    const climber = createRig();
    simulate(climber, 0.4, 60, { ...NEUTRAL, y: 1 });
    expect(climber.helicopter.mesh.rotation.x).toBeLessThan(-0.02);

    const diver = createRig();
    simulate(diver, 0.25, 60, { ...NEUTRAL, y: -1 });
    expect(diver.helicopter.mesh.rotation.x).toBeGreaterThan(0.01);
  });

  it('drifts with storm gusts while hovering', () => {
    const rig = createRig();
    const wind = new CANNON.Vec3(150, 0, 0);
    const dt = 1 / 60;
    for (let i = 0; i < 90; i++) {
      rig.time += dt;
      rig.helicopter.setHoverFloor(0);
      rig.helicopter.update(rig.time, dt, wind, undefined, false, false, false, NEUTRAL);
      rig.world.step(1 / 60, dt, 3);
      rig.helicopter.syncBodyTransform();
    }

    expect(rig.helicopter.body.velocity.x).toBeGreaterThan(4);
    expect(rig.helicopter.body.position.x).toBeGreaterThan(4);
  });

  it('gives Warlock and Nighthawk distinct speed envelopes', () => {
    const warlock = createRig(HelicopterModel.WARLOCK);
    const nighthawk = createRig(HelicopterModel.NIGHTHAWK);

    simulate(warlock, 2, 60, FORWARD);
    simulate(nighthawk, 2, 60, FORWARD);

    const warlockSpeed = -warlock.helicopter.body.velocity.z;
    const nighthawkSpeed = -nighthawk.helicopter.body.velocity.z;
    expect(warlockSpeed).toBeLessThan(MOVEMENT_CONFIG.maxHorizontalSpeed);
    expect(nighthawkSpeed).toBeGreaterThan(MOVEMENT_CONFIG.maxHorizontalSpeed);
    expect(nighthawkSpeed - warlockSpeed).toBeGreaterThan(8);
  });

  it('accelerates Warlock slower than Nighthawk off the line', () => {
    const warlock = createRig(HelicopterModel.WARLOCK);
    const nighthawk = createRig(HelicopterModel.NIGHTHAWK);

    simulate(warlock, 0.12, 60, FORWARD);
    simulate(nighthawk, 0.12, 60, FORWARD);

    expect(-nighthawk.helicopter.body.velocity.z).toBeGreaterThan(
      -warlock.helicopter.body.velocity.z,
    );
  });

  it('transitions through a curved path during 90-degree turn instead of instant snapping', () => {
    const rig = createRig();
    // 1. Establish full speed forward (North: -Z)
    simulate(rig, 1, 60, FORWARD);
    expect(-rig.helicopter.body.velocity.z).toBeGreaterThan(60);

    // 2. Instantly steer Right (East: +X)
    const rightCmd: MovementCommand = { x: 1, y: 0, z: 0, afterburner: 1 };
    // Step 0.15s into the turn
    simulate(rig, 0.15, 60, rightCmd);

    // Physical arc: velocity still has forward momentum (-Z) while building lateral velocity (+X)
    expect(-rig.helicopter.body.velocity.z).toBeGreaterThan(15);
    expect(rig.helicopter.body.velocity.x).toBeGreaterThan(15);

    // Complete the turn over ~0.6s
    simulate(rig, 0.6, 60, rightCmd);
    expect(rig.helicopter.body.velocity.x).toBeCloseTo(MOVEMENT_CONFIG.maxHorizontalSpeed, 0);
    expect(Math.abs(rig.helicopter.body.velocity.z)).toBeLessThan(2);
  });

  it('brakes and accelerates physically during 180-degree reversal', () => {
    const rig = createRig();
    // 1. Establish full speed forward (North: -Z)
    simulate(rig, 1, 60, FORWARD);
    expect(-rig.helicopter.body.velocity.z).toBeGreaterThan(60);

    // 2. Reverse to backward (South: +Z)
    const backCmd: MovementCommand = { x: 0, y: 0, z: 1, afterburner: 1 };
    // Step 0.12s — aircraft should be braking hard (reversal acceleration active)
    simulate(rig, 0.12, 60, backCmd);
    expect(-rig.helicopter.body.velocity.z).toBeLessThan(45);

    // Step to 0.8s — fully reversed to South (+Z)
    simulate(rig, 0.8, 60, backCmd);
    expect(rig.helicopter.body.velocity.z).toBeCloseTo(MOVEMENT_CONFIG.maxHorizontalSpeed, 0);
  });

  it('builds angular velocity smoothly with critically damped spring', () => {
    const rig = createRig();
    const strafeRight: MovementCommand = { x: 1, y: 0, z: 0, afterburner: 1 };

    // Initial angular velocity is 0
    expect(rig.helicopter.bodyYawVelocity).toBe(0);

    // Step 2 frames (0.033s)
    step(rig, 1 / 60, strafeRight);
    step(rig, 1 / 60, strafeRight);

    // Angular velocity builds up gradually without instantly teleporting to max
    expect(Math.abs(rig.helicopter.bodyYawVelocity)).toBeGreaterThan(0.2);
    expect(Math.abs(rig.helicopter.bodyYawVelocity)).toBeLessThanOrEqual(MOVEMENT_CONFIG.maxYawSpeed);

    // After settling, angular velocity returns to 0
    simulate(rig, 1.2, 60, strafeRight);
    expect(Math.abs(rig.helicopter.bodyYawVelocity)).toBeLessThan(0.05);
    expect(rig.helicopter.mesh.rotation.y).toBeCloseTo(Math.PI / 2, 1);
  });
});

describe('gun hierarchy & cross-aim independence', () => {
  it('rotates only the gun and derives direction from the real muzzle', () => {
    const rig = createRig();
    rig.helicopter.setGunAim(60, 26, 0, true);
    simulate(rig, 0.5, 60, NEUTRAL);

    const muzzlePosition = rig.helicopter.getMuzzlePosition(new THREE.Vector3());
    const muzzleDirection = rig.helicopter.getMuzzleDirection(new THREE.Vector3());

    expect(rig.helicopter.mesh.rotation.y).toBeCloseTo(Math.PI, 6);
    expect(rig.helicopter.gunYawPivot.rotation.y).toBeLessThan(-1);
    expect(muzzlePosition.distanceTo(rig.helicopter.mesh.position)).toBeGreaterThan(3);
    expect(muzzleDirection.x).toBeGreaterThan(0.85);
    expect(Math.abs(muzzleDirection.z)).toBeLessThan(0.35);
  });

  it('passes critical cross-aim: moving UP-LEFT while aiming RIGHT', () => {
    const rig = createRig();
    // Enemy is at RIGHT (+X)
    rig.helicopter.setGunAim(60, 26, 0, true);
    // Player pushes UP-LEFT (world -X, -Z)
    const upLeft: MovementCommand = {
      x: -1 / Math.SQRT2,
      y: 0,
      z: -1 / Math.SQRT2,
      afterburner: 1,
    };

    simulate(rig, 1, 60, upLeft);

    // 1. Helicopter moves UP-LEFT
    expect(rig.helicopter.body.velocity.x).toBeLessThan(-10);
    expect(rig.helicopter.body.velocity.z).toBeLessThan(-10);

    // 2. Helicopter body faces UP-LEFT (Math.atan2(-0.707, -0.707) = -3*PI/4)
    const expectedYaw = Math.atan2(-1 / Math.SQRT2, -1 / Math.SQRT2);
    let yawDiff = rig.helicopter.mesh.rotation.y - expectedYaw;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    expect(Math.abs(yawDiff)).toBeLessThan(0.15);

    // 3. Gun turret aims RIGHT in world space
    const muzzleDirection = rig.helicopter.getMuzzleDirection(new THREE.Vector3());
    expect(muzzleDirection.x).toBeGreaterThan(0.85);
  });
});
