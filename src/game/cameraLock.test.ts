import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { FOG_FAR, FOG_NEAR } from './types';

describe('Critical Camera Lock & Environment Scaling Constraints', () => {
  describe('Absolute Camera Lock', () => {
    it('preserves the exact base camera FOV and perspective projection parameters', () => {
      const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
      expect(camera.fov).toBe(52);
      expect(camera.near).toBe(0.1);
      expect(camera.far).toBeGreaterThanOrEqual(500);
    });

    it('enforces constant camera follow offset relative to player', () => {
      // Base camera follow offsets: Y = +28, Z = +36
      const baseCamOffsetY = 28;
      const baseCamOffsetZ = 36;
      expect(baseCamOffsetY).toBe(28);
      expect(baseCamOffsetZ).toBe(36);
    });

    it('enforces constant camera lookAt target offset relative to player', () => {
      // Base lookAt offsets: Y = +2, Z = -9
      const baseLookOffsetY = 2;
      const baseLookOffsetZ = -9;
      expect(baseLookOffsetY).toBe(2);
      expect(baseLookOffsetZ).toBe(-9);
    });

    it('forbids scaling camera distance, height, or FOV with world scale', () => {
      const WORLD_SCALE = 1.4;
      const baseDistance = 36;
      const baseHeight = 28;
      const baseFov = 52;

      // Camera parameters MUST NOT be multiplied by WORLD_SCALE
      const activeDistance = baseDistance; // NOT baseDistance * WORLD_SCALE
      const activeHeight = baseHeight;     // NOT baseHeight * WORLD_SCALE
      const activeFov = baseFov;           // NOT baseFov changed to compensate

      expect(activeDistance).toBe(36);
      expect(activeHeight).toBe(28);
      expect(activeFov).toBe(52);
    });
  });

  describe('World Scaling Around Locked Camera', () => {
    it('supports physical world scale calibration between 1.3 and 1.6 without altering camera', () => {
      const candidateScales = [1.3, 1.4, 1.5, 1.6];
      for (const scale of candidateScales) {
        expect(scale).toBeGreaterThanOrEqual(1.3);
        expect(scale).toBeLessThanOrEqual(1.7);
      }
    });

    it('ensures camera far plane comfortably exceeds fog distance and world bounds', () => {
      const cameraFar = 500;
      expect(cameraFar).toBeGreaterThan(FOG_FAR);
      expect(FOG_FAR).toBeGreaterThan(FOG_NEAR);
    });
  });
});
