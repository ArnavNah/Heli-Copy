import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CityEnvironment } from './city';

describe('CityEnvironment Spatial Grid & Movement Performance Optimization', () => {
  const scene = new THREE.Scene();
  const world = new CANNON.World();
  const city = new CityEnvironment(scene, world);

  it('pre-warms initial active chunks on creation', () => {
    expect(city.chunks.size).toBeGreaterThanOrEqual(5);
    expect(city.chunks.has(0)).toBe(true);
    expect(city.chunks.has(-1)).toBe(true);
    expect(city.chunks.has(1)).toBe(true);
  });

  it('populates spatial hash grid with active city blocks', () => {
    expect(city.blocks.length).toBeGreaterThan(0);
    const sampleBlock = city.blocks[0];
    const nearby = city.getBlocksNear(sampleBlock.x, sampleBlock.z, 20);
    expect(nearby.length).toBeGreaterThan(0);
    expect(nearby.some((b) => b === sampleBlock)).toBe(true);
  });

  it('getBlocksInAABB returns blocks within spatial cells without duplicates', () => {
    const minX = -50;
    const maxX = 50;
    const minZ = -100;
    const maxZ = 100;
    const blocks = city.getBlocksInAABB(minX, maxX, minZ, maxZ);

    expect(blocks.length).toBeGreaterThan(0);
    const uniqueSet = new Set(blocks);
    expect(uniqueSet.size).toBe(blocks.length); // Zero duplicates
  });

  it('getHeightAt accurately finds height using spatial grid', () => {
    for (let i = 0; i < Math.min(10, city.blocks.length); i++) {
      const block = city.blocks[i];
      if (block.destroyed) continue;
      const queryH = city.getHeightAt(block.x, block.z, 0);
      expect(queryH).toBeGreaterThanOrEqual(block.height);
    }
  });

  it('resets cleanly and maintains pre-warmed chunks', () => {
    city.reset(world);
    expect(city.chunks.size).toBeGreaterThanOrEqual(5);
    expect(city.blocks.length).toBeGreaterThan(0);
  });
});
