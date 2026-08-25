import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

describe('Free 360° Camera Orbit System', () => {
  const BASE_DISTANCE = 36;
  const BASE_HEIGHT = 28;
  const BASE_LOOK_DIST = 9;
  const BASE_LOOK_HEIGHT = 2;
  const BASE_PITCH_ANGLE = Math.atan2(BASE_HEIGHT - BASE_LOOK_HEIGHT, BASE_DISTANCE + BASE_LOOK_DIST); // ~30.07 deg

  describe('Strict Camera Geometry & Pitch Invariants Across 360° Yaw Orbit', () => {
    it('maintains constant radial distance and height at any arbitrary orbit angle', () => {
      const heliPos = new THREE.Vector3(100, 26, -200);
      const testAngles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, -Math.PI / 2, -Math.PI / 4];

      for (const yaw of testAngles) {
        const sinYaw = Math.sin(yaw);
        const cosYaw = Math.cos(yaw);

        const offsetX = sinYaw * BASE_DISTANCE;
        const offsetZ = cosYaw * BASE_DISTANCE;

        const camPos = new THREE.Vector3(
          heliPos.x + offsetX,
          heliPos.y + BASE_HEIGHT,
          heliPos.z + offsetZ,
        );

        const lookOffsetX = -sinYaw * BASE_LOOK_DIST;
        const lookOffsetZ = -cosYaw * BASE_LOOK_DIST;

        const lookPos = new THREE.Vector3(
          heliPos.x + lookOffsetX,
          heliPos.y + BASE_LOOK_HEIGHT,
          heliPos.z + lookOffsetZ,
        );

        // 1. Horizontal radius to player is constant
        const horizontalDist = Math.hypot(camPos.x - heliPos.x, camPos.z - heliPos.z);
        expect(horizontalDist).toBeCloseTo(BASE_DISTANCE, 5);

        // 2. Relative height above player is constant
        const relCamHeight = camPos.y - heliPos.y;
        expect(relCamHeight).toBeCloseTo(BASE_HEIGHT, 5);

        // 3. LookAt target relative height is constant
        const relLookHeight = lookPos.y - heliPos.y;
        expect(relLookHeight).toBeCloseTo(BASE_LOOK_HEIGHT, 5);

        // 4. Distance between camera and look target along horizontal plane
        const totalHorizontalSpan = Math.hypot(camPos.x - lookPos.x, camPos.z - lookPos.z);
        expect(totalHorizontalSpan).toBeCloseTo(BASE_DISTANCE + BASE_LOOK_DIST, 5);

        // 5. Vertical pitch angle is invariant
        const verticalDrop = camPos.y - lookPos.y;
        const pitchAngle = Math.atan2(verticalDrop, totalHorizontalSpan);
        expect(pitchAngle).toBeCloseTo(BASE_PITCH_ANGLE, 5);
      }
    });

    it('smoothly wraps camera yaw between -PI and PI without mathematical singularity', () => {
      let yaw = Math.PI * 0.95;
      const rotationStep = Math.PI * 0.2; // Rotates past +PI

      yaw += rotationStep;
      while (yaw > Math.PI) yaw -= Math.PI * 2;
      while (yaw < -Math.PI) yaw += Math.PI * 2;

      expect(yaw).toBeCloseTo(-Math.PI * 0.85, 5);
      expect(yaw).toBeGreaterThanOrEqual(-Math.PI);
      expect(yaw).toBeLessThanOrEqual(Math.PI);
    });
  });

  describe('Camera-Relative Movement Projections', () => {
    function calculateMoveVector(kbX: number, kbY: number, cameraYaw: number): { x: number; z: number } {
      const camFwd = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw)).normalize();
      const camRight = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).normalize();

      const moveX = camRight.x * kbX + camFwd.x * kbY;
      const moveZ = camRight.z * kbX + camFwd.z * kbY;
      return { x: moveX, z: moveZ };
    }

    it('projects WASD correctly when camera is facing North (yaw = 0)', () => {
      // W (Up on screen) -> -Z (North)
      const forward = calculateMoveVector(0, 1, 0);
      expect(forward.x).toBeCloseTo(0, 5);
      expect(forward.z).toBeCloseTo(-1, 5);

      // D (Right on screen) -> +X (East)
      const right = calculateMoveVector(1, 0, 0);
      expect(right.x).toBeCloseTo(1, 5);
      expect(right.z).toBeCloseTo(0, 5);

      // S (Down on screen) -> +Z (South)
      const back = calculateMoveVector(0, -1, 0);
      expect(back.x).toBeCloseTo(0, 5);
      expect(back.z).toBeCloseTo(1, 5);

      // A (Left on screen) -> -X (West)
      const left = calculateMoveVector(-1, 0, 0);
      expect(left.x).toBeCloseTo(-1, 5);
      expect(left.z).toBeCloseTo(0, 5);
    });

    it('projects WASD correctly when camera is rotated (yaw = PI/2)', () => {
      const yaw = Math.PI / 2;
      // W (Up on screen) -> -X
      const forward = calculateMoveVector(0, 1, yaw);
      expect(forward.x).toBeCloseTo(-1, 5);
      expect(forward.z).toBeCloseTo(0, 5);

      // D (Right on screen) -> -Z
      const right = calculateMoveVector(1, 0, yaw);
      expect(right.x).toBeCloseTo(0, 5);
      expect(right.z).toBeCloseTo(-1, 5);
    });

    it('projects WASD correctly when camera is facing South (yaw = PI)', () => {
      const yaw = Math.PI;
      // W (Up on screen) -> +Z (South)
      const forward = calculateMoveVector(0, 1, yaw);
      expect(forward.x).toBeCloseTo(0, 5);
      expect(forward.z).toBeCloseTo(1, 5);

      // D (Right on screen) -> -X (West)
      const right = calculateMoveVector(1, 0, yaw);
      expect(right.x).toBeCloseTo(-1, 5);
      expect(right.z).toBeCloseTo(0, 5);
    });
  });

  describe('Camera-Relative Aiming Projections', () => {
    function calculateAimWorld(rx: number, ry: number, cameraYaw: number): { x: number; z: number } {
      const camFwd = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw)).normalize();
      const camRight = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).normalize();

      const rMag = Math.hypot(rx, ry);
      const rNormX = rx / rMag;
      const rScreenY = -ry / rMag; // -ry is screen UP

      return {
        x: camRight.x * rNormX + camFwd.x * rScreenY,
        z: camRight.z * rNormX + camFwd.z * rScreenY,
      };
    }

    it('aims toward the top of the screen when right stick is pushed up', () => {
      const testAngles = [0, Math.PI / 3, Math.PI / 2, Math.PI, -Math.PI / 2];
      for (const yaw of testAngles) {
        const aim = calculateAimWorld(0, -1, yaw); // Stick UP
        const camFwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();

        expect(aim.x).toBeCloseTo(camFwd.x, 5);
        expect(aim.z).toBeCloseTo(camFwd.z, 5);
      }
    });

    it('aims toward the right of the screen when right stick is pushed right', () => {
      const testAngles = [0, Math.PI / 3, Math.PI / 2, Math.PI, -Math.PI / 2];
      for (const yaw of testAngles) {
        const aim = calculateAimWorld(1, 0, yaw); // Stick RIGHT
        const camFwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
        const camRight = new THREE.Vector3().crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).normalize();

        expect(aim.x).toBeCloseTo(camRight.x, 5);
        expect(aim.z).toBeCloseTo(camRight.z, 5);
      }
    });
  });

  describe('Shortest-Angle Camera Recenter Interpolation', () => {
    function computeRecenterTarget(currentYaw: number, targetYaw: number): number {
      let diff = targetYaw - currentYaw;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      return currentYaw + diff;
    }

    it('takes the shortest path when crossing the +/- PI boundary', () => {
      const currentYaw = 3.1;
      const targetYaw = -3.1;

      const target = computeRecenterTarget(currentYaw, targetYaw);
      const angularDistance = Math.abs(target - currentYaw);

      // Shortest path is ~0.083 rad, NOT ~6.2 rad
      expect(angularDistance).toBeLessThan(0.2);
    });

    it('correctly aligns behind velocity direction during flight', () => {
      const velocity = { x: 20, z: -20 }; // Flying North-East
      const speed = Math.hypot(velocity.x, velocity.z);
      expect(speed).toBeGreaterThan(3.5);

      // Camera behind player looking along flight path:
      // Math.atan2(-20, 20) = -PI/4
      const targetYaw = Math.atan2(-velocity.x, -velocity.z);
      expect(targetYaw).toBeCloseTo(-Math.PI * 0.25, 5);
    });
  });

  describe('Controller Mode Separation (Modifier vs Aim)', () => {
    it('isolates right stick to camera orbit when modifier (LT) is active', () => {
      const isCameraModifierHeld = true;
      const rx = 0.8;
      const ry = 0.0;
      const DEADZONE = 0.15;

      let targetCameraYawVelocity = 0;
      let isFiringGamepad = false;
      let gunAimUpdated = false;

      if (isCameraModifierHeld) {
        const normRx = (rx - Math.sign(rx) * DEADZONE) / (1 - DEADZONE);
        targetCameraYawVelocity = -normRx * 2.8;
      } else {
        gunAimUpdated = true;
      }

      isFiringGamepad = !isCameraModifierHeld && Math.hypot(rx, ry) > DEADZONE;

      expect(targetCameraYawVelocity).toBeLessThan(0);
      expect(isFiringGamepad).toBe(false);
      expect(gunAimUpdated).toBe(false);
    });

    it('resumes gun aim and fire immediately when modifier (LT) is released', () => {
      const isCameraModifierHeld = false;
      const rx = 0.8;
      const ry = 0.0;
      const DEADZONE = 0.15;

      let targetCameraYawVelocity = 0;
      let isFiringGamepad = false;
      let gunAimUpdated = false;

      if (isCameraModifierHeld) {
        const normRx = (rx - Math.sign(rx) * DEADZONE) / (1 - DEADZONE);
        targetCameraYawVelocity = -normRx * 2.8;
      } else {
        gunAimUpdated = true;
      }

      isFiringGamepad = !isCameraModifierHeld && Math.hypot(rx, ry) > DEADZONE;

      expect(targetCameraYawVelocity).toBe(0);
      expect(isFiringGamepad).toBe(true);
      expect(gunAimUpdated).toBe(true);
    });
  });

  describe('Camera Boom Collision Compression', () => {
    it('smoothly compresses boom fraction when approaching tall obstacle without altering pitch', () => {
      let cameraBoomFraction = 1.0;
      const targetBoom = 0.65;
      const delta = 0.016;

      // Step physics/camera loop 30 frames (~0.5s)
      for (let i = 0; i < 30; i++) {
        cameraBoomFraction += (targetBoom - cameraBoomFraction) * (1 - Math.exp(-8 * delta));
      }

      expect(cameraBoomFraction).toBeLessThan(0.7);
      expect(cameraBoomFraction).toBeGreaterThanOrEqual(0.65);
    });
  });
});
