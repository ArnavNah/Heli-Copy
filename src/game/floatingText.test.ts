import { describe, it, expect, beforeEach } from 'vitest';
import { FloatingCombatTextManager } from './floatingText';

describe('FloatingCombatTextManager', () => {
  let manager: FloatingCombatTextManager;

  beforeEach(() => {
    manager = new FloatingCombatTextManager();
  });

  it('initializes with a pre-allocated pool and zero active numbers', () => {
    expect(manager.getActiveCount()).toBe(0);
    expect(FloatingCombatTextManager.MAX_ITEMS).toBe(60);
  });

  it('spawns floating damage numbers with upward velocity and active state', () => {
    manager.spawnDamage(101, { x: 10, y: 5, z: 20 }, 25, 'NORMAL', 1.0);

    expect(manager.getActiveCount()).toBe(1);
    const item = manager.getPoolItem(0);
    expect(item.active).toBe(true);
    expect(item.text).toBe('25');
    expect(item.type).toBe('NORMAL');
    expect(Math.abs(item.worldPos.x - 10)).toBeLessThanOrEqual(1.0);
    expect(item.worldPos.y).toBeGreaterThanOrEqual(6.5);
    expect(item.velocity.y).toBeGreaterThan(0);
  });

  it('assigns distinct colors and fonts for damage hierarchy', () => {
    manager.spawnDamage(1, { x: 0, y: 0, z: 0 }, 10, 'NORMAL', 1.0);
    manager.spawnDamage(2, { x: 0, y: 0, z: 0 }, 50, 'CRITICAL', 1.0);
    manager.spawnDamage(3, { x: 0, y: 0, z: 0 }, 15, 'SHIELD', 1.0);
    manager.spawnDamage(4, { x: 0, y: 0, z: 0 }, 120, 'HEAVY', 1.0);

    const normal = manager.getPoolItem(0);
    const crit = manager.getPoolItem(1);
    const shield = manager.getPoolItem(2);
    const heavy = manager.getPoolItem(3);

    expect(normal.color).toBe('#f0f2f5');
    expect(crit.color).toBe('#ffd000');
    expect(shield.color).toBe('#50ebff');
    expect(heavy.color).toBe('#ff4d4d');

    expect(heavy.fontSize).toBeGreaterThan(normal.fontSize);
    expect(crit.fontSize).toBeGreaterThan(normal.fontSize);
  });

  it('aggregates rapid damage on the same target within the aggregation window', () => {
    const enemyId = 42;
    const pos = { x: 5, y: 2, z: 10 };

    // Rapid machine gun hits at t = 1.00, 1.03, 1.06, 1.09
    manager.spawnDamage(enemyId, pos, 13, 'NORMAL', 1.00);
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getPoolItem(0).text).toBe('13');

    manager.spawnDamage(enemyId, pos, 13, 'NORMAL', 1.03);
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getPoolItem(0).text).toBe('26');

    manager.spawnDamage(enemyId, pos, 13, 'NORMAL', 1.06);
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getPoolItem(0).text).toBe('39');

    manager.spawnDamage(enemyId, pos, 13, 'NORMAL', 1.09);
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getPoolItem(0).text).toBe('52');
  });

  it('aggregates shotgun pellets from one blast into a single value', () => {
    const enemyId = 88;
    const pos = { x: 12, y: 3, z: -15 };
    const t = 2.5;

    // 6 shotgun pellets hit simultaneously at t = 2.5
    for (let i = 0; i < 6; i++) {
      manager.spawnDamage(enemyId, pos, 14, 'NORMAL', t);
    }

    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getPoolItem(0).text).toBe('84');
    expect(manager.getPoolItem(0).type).toBe('HEAVY'); // Automatically upgraded to HEAVY due to >=70 dmg
  });

  it('spawns separate numbers when hits exceed the aggregation window', () => {
    const enemyId = 42;
    const pos = { x: 5, y: 2, z: 10 };

    manager.spawnDamage(enemyId, pos, 13, 'NORMAL', 1.00);
    // Hit arrives 250ms later (> 140ms window)
    manager.spawnDamage(enemyId, pos, 13, 'NORMAL', 1.25);

    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getPoolItem(0).text).toBe('13');
    expect(manager.getPoolItem(1).text).toBe('13');
  });

  it('aggregates rapid XP and Salvage pickups within the reward aggregation window', () => {
    const playerPos = { x: 0, y: 10, z: 0 };
    const t = 3.0;

    // Rapid XP gem pickups
    manager.spawnReward(playerPos, '+1 XP', 'XP', undefined, 1, t);
    manager.spawnReward(playerPos, '+2 XP', 'XP', undefined, 2, t + 0.05);
    manager.spawnReward(playerPos, '+3 XP', 'XP', undefined, 3, t + 0.10);

    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getPoolItem(0).text).toBe('+6 XP');

    // Salvage pickups
    manager.spawnReward(playerPos, '+2 SALVAGE', 'SALVAGE', undefined, 2, t + 0.02);
    manager.spawnReward(playerPos, '+5 SALVAGE', 'SALVAGE', undefined, 5, t + 0.08);

    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getPoolItem(1).text).toBe('+7 SALVAGE');
  });

  it('spawns grouped kill popups alongside killing damage numbers on dead target', () => {
    const enemyId = 99;
    const pos = { x: 20, y: 4, z: 30 };

    // Damage ticks on kill
    manager.spawnDamage(enemyId, pos, 30, 'NORMAL', 1.0);
    expect(manager.getActiveCount()).toBe(1);

    // Special kill event occurs
    manager.spawnGroupedKill(enemyId, pos, 'MISSILE CARRIER DESTROYED', '+6 XP  +12 SALVAGE', '#ffd000', 1.5);

    // Both damage number and grouped kill popup float up
    expect(manager.getActiveCount()).toBe(2);
    const killItem = manager.getPoolItem(1);
    expect(killItem.active).toBe(true);
    expect(killItem.text).toBe('MISSILE CARRIER DESTROYED');
    expect(killItem.subText).toBe('+6 XP  +12 SALVAGE');
  });

  it('updates position and expires numbers when their lifetime ends', () => {
    manager.spawnDamage(1, { x: 0, y: 0, z: 0 }, 50, 'NORMAL', 0);
    const item = manager.getPoolItem(0);
    const initialY = item.worldPos.y;

    // Step 0.2s
    manager.update(0.2);
    expect(item.active).toBe(true);
    expect(item.worldPos.y).toBeGreaterThan(initialY);

    // Step past max duration (0.55s total)
    manager.update(0.4);
    expect(item.active).toBe(false);
    expect(manager.getActiveCount()).toBe(0);
  });

  it('clears all active numbers on clear()', () => {
    manager.spawnDamage(1, { x: 0, y: 0, z: 0 }, 10, 'NORMAL', 0);
    manager.spawnDamage(2, { x: 10, y: 0, z: 0 }, 20, 'CRITICAL', 0);
    manager.spawnReward({ x: 0, y: 0, z: 0 }, '+3 XP', 'XP');
    expect(manager.getActiveCount()).toBe(3);

    manager.clear();
    expect(manager.getActiveCount()).toBe(0);
  });
});
