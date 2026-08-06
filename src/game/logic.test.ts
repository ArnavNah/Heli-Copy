import { describe, expect, it } from "vitest";
import {
  accuracyFor,
  bossPhaseForRatio,
  bossVolleyConfig,
  clamp,
  coinsForScore,
  comboMultiplier,
  DIFFICULTIES,
  formatDuration,
  MAX_WEAPON_LEVEL,
  multikillTier,
  objectiveConfig,
  pickUpgrades,
  readMastery,
  riskMultiplier,
  waveEnemyCount,
  waveEnemyDamage,
  waveEnemyFireRate,
  waveEnemyPower,
  waveDuration,
  weaponLevelBonus,
  weaponLevelForXp,
  weaponXpForLevel,
  writeMastery,
} from "./logic";

describe("waveEnemyCount", () => {
  it("scales with wave", () => {
    expect(waveEnemyCount(1)).toBe(14);
    expect(waveEnemyCount(5)).toBe(40);
    expect(waveEnemyCount(10)).toBe(73);
  });
});

describe("procedural wave scaling", () => {
  it("waveEnemyPower grows with wave and caps at 9x", () => {
    expect(waveEnemyPower(1)).toBe(1);
    expect(waveEnemyPower(2)).toBeCloseTo(1.18);
    expect(waveEnemyPower(10)).toBeCloseTo(2.62);
    expect(waveEnemyPower(20)).toBeCloseTo(4.42);
    expect(waveEnemyPower(100)).toBe(9);
  });

  it("waveEnemyDamage grows slower than HP and caps at 3.2x", () => {
    expect(waveEnemyDamage(1)).toBe(1);
    expect(waveEnemyDamage(10)).toBeCloseTo(1.63);
    expect(waveEnemyDamage(20)).toBeCloseTo(2.33);
    expect(waveEnemyDamage(100)).toBe(3.2);
  });

  it("waveEnemyFireRate gets faster (mult < 1) and floors at 0.45", () => {
    expect(waveEnemyFireRate(1)).toBe(1);
    expect(waveEnemyFireRate(10)).toBeCloseTo(0.64);
    expect(waveEnemyFireRate(20)).toBeCloseTo(0.45);
    expect(waveEnemyFireRate(100)).toBe(0.45);
  });

  it("HP outpaces damage so later waves feel tankier but fair", () => {
    expect(waveEnemyPower(15)).toBeGreaterThan(waveEnemyDamage(15));
  });
});

describe("waveDuration", () => {
  it("shrinks from 45s toward a 30s floor", () => {
    expect(waveDuration(1)).toBe(45);
    expect(waveDuration(2)).toBe(43.5);
    expect(waveDuration(10)).toBe(31.5);
    expect(waveDuration(11)).toBe(30);
    expect(waveDuration(50)).toBe(30);
  });
  it("is monotonic non-increasing", () => {
    for (let w = 1; w < 20; w++) {
      expect(waveDuration(w + 1)).toBeLessThanOrEqual(waveDuration(w));
    }
  });
});

describe("comboMultiplier", () => {
  it("caps at 6x", () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(10)).toBe(2);
    expect(comboMultiplier(50)).toBe(6);
  });
});

describe("coinsForScore / accuracyFor / clamp / formatDuration", () => {
  it("coins: 1 per 100 pts", () => {
    expect(coinsForScore(0)).toBe(0);
    expect(coinsForScore(250)).toBe(2);
  });
  it("accuracy clamps to 0..1 and handles no shots", () => {
    expect(accuracyFor(0, 0)).toBe(0);
    expect(accuracyFor(5, 10)).toBe(0.5);
    expect(accuracyFor(10, 10)).toBe(1);
  });
  it("clamp", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
  it("formatDuration", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3600)).toBe("60:00");
  });
});

describe("weapon XP", () => {
  it("weaponXpForLevel thresholds are cumulative", () => {
    expect(weaponXpForLevel(1)).toBe(0);
    expect(weaponXpForLevel(2)).toBe(6); // 2+4
    expect(weaponXpForLevel(3)).toBe(14); // + (2+6)=8
  });
  it("weaponLevelForXp", () => {
    expect(weaponLevelForXp(0)).toBe(1);
    expect(weaponLevelForXp(5)).toBe(1);
    expect(weaponLevelForXp(6)).toBe(2);
    expect(weaponLevelForXp(100, 5)).toBe(5);
  });
  it("weaponLevelBonus scales stats and stays bounded", () => {
    const lvl2 = weaponLevelBonus(2);
    expect(lvl2.damageMult).toBe(1.18);
    expect(lvl2.fireRateMult).toBeLessThan(1);
    expect(lvl2.reloadMult).toBeLessThan(1);
    expect(weaponLevelBonus(10).damageMult).toBeGreaterThan(1);
    expect(weaponLevelBonus(1).extraProjectiles).toBe(0);
    expect(weaponLevelBonus(4).extraProjectiles).toBe(1);
  });
});

describe("riskMultiplier", () => {
  it("returns 1 at 40%+ health", () => {
    expect(riskMultiplier(40, 100)).toBe(1);
    expect(riskMultiplier(100, 100)).toBe(1);
  });
  it("scales up as health drops", () => {
    const low = riskMultiplier(10, 100);
    expect(low).toBeGreaterThan(1);
    expect(riskMultiplier(1, 100)).toBeGreaterThan(riskMultiplier(20, 100));
  });
  it("stays within bounds", () => {
    expect(riskMultiplier(0, 100)).toBeLessThanOrEqual(1.75);
  });
});

describe("multikillTier", () => {
  it("returns null below 2 kills", () => {
    expect(multikillTier(1)).toBeNull();
  });
  it("escalates with streak", () => {
    expect(multikillTier(2)?.label).toBe("DOUBLE KILL");
    expect(multikillTier(3)?.label).toBe("TRIPLE KILL");
    expect(multikillTier(4)?.label).toBe("QUAD KILL");
    expect(multikillTier(6)?.label).toBe("KILLING SPREE");
    expect(multikillTier(9)?.label).toBe("RAMPAGE!");
  });
});

describe("pickUpgrades", () => {
  it("picks distinct options", () => {
    const picks = pickUpgrades(3, () => 0.1);
    expect(picks).toHaveLength(3);
    const ids = new Set(picks.map((p) => p.id));
    expect(ids.size).toBe(3);
  });
  it("clamps to pool size", () => {
    expect(pickUpgrades(999).length).toBeLessThanOrEqual(10);
    expect(pickUpgrades(0)).toHaveLength(1);
  });
});

describe("boss phases", () => {
  it("maps hp ratio to phases", () => {
    expect(bossPhaseForRatio(1)).toBe(3);
    expect(bossPhaseForRatio(0.9)).toBe(3);
    expect(bossPhaseForRatio(0.67)).toBe(3);
    expect(bossPhaseForRatio(0.66)).toBe(2);
    expect(bossPhaseForRatio(0.5)).toBe(2);
    expect(bossPhaseForRatio(0.34)).toBe(2);
    expect(bossPhaseForRatio(0.33)).toBe(1);
    expect(bossPhaseForRatio(0)).toBe(1);
  });
  it("volley config scales with phase", () => {
    const p1 = bossVolleyConfig(1);
    const p2 = bossVolleyConfig(2);
    const p3 = bossVolleyConfig(3);
    expect(p1.shots).toBeGreaterThan(p2.shots);
    expect(p2.shots).toBeGreaterThan(p3.shots);
    expect(p1.spread).toBeLessThan(p3.spread);
  });
});

describe("objective config", () => {
  it("defines SAM / radar / depot", () => {
    expect(objectiveConfig(0).label).toBe('SAM SITE');
    expect(objectiveConfig(1).label).toBe('RADAR TOWER');
    expect(objectiveConfig(2).label).toBe('AMMO DEPOT');
    expect(objectiveConfig(2).points).toBeLessThan(objectiveConfig(0).points);
    expect(objectiveConfig(0).hp).toBeGreaterThan(0);
  });
});

describe("difficulty", () => {
  it("escalates from casual to hard", () => {
    expect(DIFFICULTIES.casual.enemyHp).toBeLessThan(DIFFICULTIES.normal.enemyHp);
    expect(DIFFICULTIES.normal.enemyHp).toBeLessThan(DIFFICULTIES.hard.enemyHp);
    expect(DIFFICULTIES.hard.enemyDamage).toBeGreaterThan(DIFFICULTIES.casual.enemyDamage);
    expect(DIFFICULTIES.hard.maxRisk).toBeGreaterThan(DIFFICULTIES.casual.maxRisk);
  });
  it("risk multiplier respects the difficulty max bonus", () => {
    // At 1 HP, danger ≈ 0.975 → 1 + 0.975 * maxBonus
    expect(riskMultiplier(1, 100, DIFFICULTIES.casual.maxRisk)).toBeCloseTo(1.4875);
    expect(riskMultiplier(1, 100, DIFFICULTIES.hard.maxRisk)).toBeCloseTo(1.975);
    expect(riskMultiplier(40, 100, 1)).toBe(1);
    // Hard difficulty ceiling stays above casual
    expect(riskMultiplier(1, 100, DIFFICULTIES.hard.maxRisk)).toBeGreaterThan(
      riskMultiplier(1, 100, DIFFICULTIES.casual.maxRisk),
    );
  });
});

describe("weapon mastery persistence", () => {
  const storage = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as Storage;
  };

  it("reads empty mastery as zeros", () => {
    expect(readMastery(storage())).toEqual([0, 0, 0, 0]);
  });
  it("persists max level per weapon and never regresses", () => {
    const s = storage();
    writeMastery(0, 2, s);
    writeMastery(0, 1, s);
    writeMastery(2, 5, s);
    const m = readMastery(s);
    expect(m[0]).toBe(2);
    expect(m[2]).toBe(MAX_WEAPON_LEVEL);
    expect(m[1]).toBe(0);
  });
  it("clamps levels to MAX_WEAPON_LEVEL", () => {
    const s = storage();
    writeMastery(1, 99, s);
    expect(readMastery(s)[1]).toBe(MAX_WEAPON_LEVEL);
  });
});
