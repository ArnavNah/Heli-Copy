import { describe, expect, it } from "vitest";
import { armorMitigation, resolvePlayerDamage, resolveRepair } from "./combat";

describe("central player damage", () => {
  it("applies bounded armor and clamps health", () => {
    expect(armorMitigation(3, 2)).toBeCloseTo(0.24);
    const hit = resolvePlayerDamage(100, 100, 20, armorMitigation(3));
    expect(hit.applied).toBe(17);
    expect(hit.health).toBe(83);
    expect(resolvePlayerDamage(4, 100, 1000, 0).health).toBe(0);
  });

  it("blocks shielded hits without invalid damage", () => {
    expect(resolvePlayerDamage(80, 100, Number.NaN, 0).applied).toBe(0);
    expect(resolvePlayerDamage(80, 100, 20, 0.2, true)).toMatchObject({ applied: 0, health: 80, blocked: true });
  });
});

describe("repair", () => {
  it("uses efficiency and never exceeds max health", () => {
    expect(resolveRepair(50, 100, 20, 1.25)).toBe(75);
    expect(resolveRepair(95, 100, 30)).toBe(100);
  });
});
