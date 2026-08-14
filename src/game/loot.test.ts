import { describe, expect, it } from "vitest";
import { canUseDepotService, collectSalvage, rollLoot, salvageCreditValue } from "./loot";

describe("controlled loot", () => {
  it("keeps basic drops sparse and makes elite/boss rewards useful", () => {
    expect(rollLoot("BASIC", 0.5, 0.2)).toEqual({ salvage: 0, powerup: null, countermeasure: false });
    expect(rollLoot("ELITE", 0.2, 0.1).salvage).toBeGreaterThanOrEqual(2);
    const boss = rollLoot("BOSS", 0.9, 0.7);
    expect(boss.salvage).toBe(6);
    expect(boss.powerup).not.toBeNull();
    expect(boss.countermeasure).toBe(true);
  });

  it("converts run salvage only through a bounded extraction value", () => {
    expect(collectSalvage(4, 3)).toBe(7);
    expect(collectSalvage(4, -3)).toBe(4);
    expect(salvageCreditValue(0)).toBe(0);
    expect(salvageCreditValue(7)).toBe(35);
    expect(salvageCreditValue(-4)).toBe(0);
  });

  it("gates depot service by proximity, cooldown, and actual need", () => {
    expect(canUseDepotService(17.9, 0, true)).toBe(true);
    expect(canUseDepotService(19, 0, true)).toBe(false);
    expect(canUseDepotService(10, 2, true)).toBe(false);
    expect(canUseDepotService(10, 0, false)).toBe(false);
  });
});
