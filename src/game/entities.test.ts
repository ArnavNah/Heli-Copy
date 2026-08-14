import * as CANNON from "cannon-es";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Enemy } from "./entities";
import { EnemyModifier, EnemyType, EnemyVariant } from "./types";

function makeEnemy(type: EnemyType, options: ConstructorParameters<typeof Enemy>[6] = {}) {
  const scene = new THREE.Scene();
  const world = new CANNON.World();
  return new Enemy(scene, world, 0, -100, type, 20, options);
}

describe("high-value enemy construction", () => {
  it("keeps elites within the intended health range and gives them a strong accent scale", () => {
    const normal = makeEnemy(EnemyType.SHOOTER);
    const elite = makeEnemy(EnemyType.SHOOTER, { isElite: true });
    expect(elite.maxHp / normal.maxHp).toBeGreaterThanOrEqual(1.4);
    expect(elite.maxHp / normal.maxHp).toBeLessThanOrEqual(1.8);
    expect(elite.radius).toBeGreaterThan(normal.radius);
    normal.destroy();
    elite.destroy();
  });

  it("constructs shield and regeneration elites with visible, functional traits", () => {
    const shield = makeEnemy(EnemyType.DRONE, { isElite: true, modifier: EnemyModifier.SHIELDED });
    const regen = makeEnemy(EnemyType.DRONE, { isElite: true, modifier: EnemyModifier.REGENERATING });
    expect(shield.shieldHp).toBeGreaterThan(0);
    expect(shield.shieldMesh).not.toBeNull();
    expect(regen.regenPerSecond).toBeGreaterThan(0);
    expect(regen.regenMesh).not.toBeNull();
    shield.destroy();
    regen.destroy();
  });

  it("keeps repair drones visually readable and bosses initialized in phase three", () => {
    const repair = makeEnemy(EnemyType.DRONE, { variant: EnemyVariant.REPAIR_DRONE });
    const boss = makeEnemy(EnemyType.BOSS);
    expect(repair.variant).toBe(EnemyVariant.REPAIR_DRONE);
    expect(repair.ring.children.length).toBeGreaterThan(0);
    expect(boss.phase).toBe(3);
    expect(boss.telegraphMesh).not.toBeNull();
    repair.destroy();
    boss.destroy();
  });
});
