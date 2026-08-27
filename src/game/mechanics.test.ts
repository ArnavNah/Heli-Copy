import { describe, expect, it } from "vitest";
import {
  CountermeasureState,
  countermeasureConfig,
  settleExtraction,
  salvageCreditsFor,
  salvageForEnemy,
  salvageForObjective,
  securedEnemyBounty,
  securedObjectiveReward,
  threatBonusFor,
  threatDirectorConfig,
  threatLevelForPoints,
  threatRewardMultiplier,
} from "./mechanics";
import { runLevelForXp, pickUpgrades } from "./logic";
import { EnemyType, ObjectiveType } from "./types";

describe("countermeasures", () => {
  it("uses one charge per valid edge and observes cooldown", () => {
    const state = new CountermeasureState(countermeasureConfig(0));
    expect(state.deploy(10)).toBe(true);
    expect(state.charges).toBe(2);
    expect(state.deploy(10.1)).toBe(false);
    state.update(state.cooldown);
    expect(state.deploy(17)).toBe(true);
    expect(state.charges).toBe(1);
  });

  it("caps replenishment and applies restrained permanent upgrades", () => {
    const base = countermeasureConfig(0);
    const maxed = countermeasureConfig(5);
    expect(base.maxCharges).toBe(3);
    expect(maxed.maxCharges).toBe(4);
    expect(maxed.cooldown).toBeLessThan(base.cooldown);
    const state = new CountermeasureState(maxed);
    state.deploy(0);
    expect(state.replenish(99)).toBe(1);
    expect(state.charges).toBe(state.maxCharges);
  });
});

describe("threat economy", () => {
  it("uses five centralized gradual thresholds", () => {
    expect([0, 29, 30, 79, 80, 149, 150, 239, 240].map(threatLevelForPoints))
      .toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it("raises rewards without exponential scaling", () => {
    expect(threatRewardMultiplier(1)).toBe(1);
    expect(threatRewardMultiplier(5)).toBe(1.7);
    expect(threatBonusFor(300, 1)).toBe(0);
    expect(threatBonusFor(300, 5)).toBe(210);
  });

  it("moves unsecured credits into the wallet exactly once", () => {
    const result = settleExtraction(2460, 780);
    expect(result).toEqual({ wallet: 3240, securedBonus: 780, unsecured: 0 });
    expect(settleExtraction(result.wallet, result.unsecured).wallet).toBe(3240);
  });

  it("converts salvage linearly only when extraction settles", () => {
    expect(salvageCreditsFor(28)).toBe(140);
    expect(settleExtraction(1000, 120, 28)).toEqual({ wallet: 1260, securedBonus: 260, unsecured: 0 });
  });

  it("keeps basic enemies from becoming a direct credit grind", () => {
    expect(securedEnemyBounty(EnemyType.BASIC, false)).toBe(0);
    expect(securedEnemyBounty(EnemyType.SHOOTER, false)).toBe(0);
    expect(securedEnemyBounty(EnemyType.DRONE, true)).toBeGreaterThan(0);
    expect(securedEnemyBounty(EnemyType.BOSS, false)).toBeGreaterThan(securedEnemyBounty(EnemyType.DRONE, true));
  });

  it("pays objectives and salvage at bounded values", () => {
    expect(securedObjectiveReward(ObjectiveType.SAM_SITE)).toBeGreaterThan(securedObjectiveReward(ObjectiveType.AMMO_DEPOT));
    expect(securedObjectiveReward(ObjectiveType.RADAR_TOWER)).toBeGreaterThan(0);
    expect(salvageForObjective(ObjectiveType.SAM_SITE)).toBeGreaterThan(0);
    expect(salvageForEnemy(EnemyType.BASIC, false)).toBe(0);
    expect(salvageForEnemy(EnemyType.BOSS, false)).toBeGreaterThan(salvageForEnemy(EnemyType.TANK, false));
  });

  it("raises composition pressure through threat without exploding active counts", () => {
    const low = threatDirectorConfig(1);
    const extreme = threatDirectorConfig(5);
    expect(extreme.directorWaveBonus).toBeGreaterThan(low.directorWaveBonus);
    expect(extreme.eliteChanceBonus).toBeGreaterThan(low.eliteChanceBonus);
    expect(extreme.activeEnemyCapBonus).toBeLessThanOrEqual(8);
    expect(extreme.spawnIntervalMult).toBeGreaterThanOrEqual(0.78);
  });

  it("calculates level up progression thresholds and guarantees non-empty upgrade offers", () => {
    // Level 1 at 0 XP
    expect(runLevelForXp(0)).toBe(1);
    // Level 2 threshold is 10 XP
    expect(runLevelForXp(10)).toBe(2);
    // Level 3 threshold is 25 XP (10 + 15)
    expect(runLevelForXp(25)).toBe(3);

    const offers = pickUpgrades(3);
    expect(offers.length).toBe(3);
    for (const opt of offers) {
      expect(opt.id).toBeDefined();
      expect(opt.title).toBeDefined();
    }
  });
});
