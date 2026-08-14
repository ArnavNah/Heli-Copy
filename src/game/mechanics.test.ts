import { describe, expect, it } from "vitest";
import {
  CountermeasureState,
  countermeasureConfig,
  settleExtraction,
  threatBonusFor,
  threatLevelForPoints,
  threatRewardMultiplier,
} from "./mechanics";

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
});
