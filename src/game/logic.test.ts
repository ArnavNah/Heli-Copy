import { describe, expect, it } from "vitest";
import { EnemyType, EnemyVariant, WeaponType } from "./types";
import {
  accuracyFor,
  affixChancesForWave,
  bossPhaseForRatio,
  bossVolleyConfig,
  buildingArchetype,
  buildingMassing,
  calculateDamageAffinity,
  canOfferExtraction,
  clamp,
  coinsForScore,
  comboMultiplier,
  compositionFitsBudget,
  compositionThreatCost,
  createQualityGovernor,
  DIFFICULTIES,
  DISTRICT_CONFIGS,
  DISTRICT_SCHEDULE,
  districtForChunk,
  ENEMY_VARIANTS,
  footprintTier,
  formatDuration,
  formatScorecard,
  GOVERNOR_MAX_LEVEL,
  governorBloomAllowed,
  governorParticleScale,
  governorPixelScale,
  MAX_PERK_RANK,
  MAX_WEAPON_LEVEL,
  multikillTier,
  nightOpForWave,
  NIGHT_OPS_MIN_WAVE,
  objectiveConfig,
  occlusionStrength,
  PERK_INFO,
  perkEffect,
  pickEnemyVariant,
  pickSquadForWave,
  pickUpgrades,
  readMastery,
  readPerks,
  readRunHistory,
  readWeaponMods,
  recordRun,
  riskMultiplier,
  RUN_HISTORY_LIMIT,
  runLevelForXp,
  runXpForLevel,
  rhythmDensity,
  sceneRhythmForChunk,
  SPAWN_CONFIG,
  SQUAD_TEMPLATES,
  statusProcChance,
  STATUS_DURATIONS,
  SUPER_MAX_CHARGE,
  superChargeForKill,
  updateQualityGovernor,
  UPGRADE_POOL,
  variantAtCap,
  WEAPON_MODS,
  writeMastery,
  writePerkRank,
  writeWeaponMod,
  xpForEnemyType,
  enemyAimAccuracy,
  enemySpeedScale,
  waveEnemyCount,
  waveEnemyDamage,
  waveEnemyFireRate,
  waveEnemyPower,
  waveSpawnBudget,
  waveComposition,
  waveStatScale,
  waveThreatBudget,
  waveDuration,
  weaponLevelBonus,
  weaponLevelForXp,
  weaponXpForLevel,
} from "./logic";

describe("occlusionStrength", () => {
  it("fully ghosts a building right in front of the camera", () => {
    expect(occlusionStrength(0.1)).toBe(1);
    expect(occlusionStrength(0.2)).toBe(1);
  });
  it("tapers as the blocker sits closer to the player end of the view line", () => {
    expect(occlusionStrength(0.5)).toBeCloseTo(0.625);
    expect(occlusionStrength(0.8)).toBeCloseTo(0.25);
    expect(occlusionStrength(0.9)).toBeCloseTo(0.125);
  });
  it("returns 0 for misses / degenerate entry points", () => {
    expect(occlusionStrength(0)).toBe(0);
    expect(occlusionStrength(1)).toBe(0);
    expect(occlusionStrength(-0.5)).toBe(0);
    expect(occlusionStrength(1.4)).toBe(0);
  });
});

describe("waveEnemyCount and enemyPopulationTarget", () => {
  it("scales with wave without flooding early game", () => {
    expect(waveEnemyCount(1)).toBe(5);
    expect(waveEnemyCount(5)).toBe(14);
    expect(waveEnemyCount(9)).toBe(24);
  });
});

describe("procedural wave scaling (non-sponge design)", () => {
  it("waveEnemyPower / enemyHPScale grows conservatively and caps at 2.35x", () => {
    expect(waveEnemyPower(1)).toBe(1);
    expect(waveEnemyPower(5)).toBeCloseTo(1.20);
    expect(waveEnemyPower(9)).toBeCloseTo(1.40);
    expect(waveEnemyPower(15)).toBeCloseTo(1.75);
    expect(waveEnemyPower(100)).toBeLessThanOrEqual(2.35);
  });

  it("waveEnemyDamage / enemyDamageScale grows slower than HP and caps at 1.70x", () => {
    expect(waveEnemyDamage(1)).toBe(1);
    expect(waveEnemyDamage(5)).toBeCloseTo(1.12);
    expect(waveEnemyDamage(9)).toBeCloseTo(1.24);
    expect(waveEnemyDamage(15)).toBeCloseTo(1.45);
    expect(waveEnemyDamage(100)).toBeLessThanOrEqual(1.70);
  });

  it("enemySpeedScale scales conservatively and caps at 1.18x", () => {
    expect(enemySpeedScale(1)).toBe(1.0);
    expect(enemySpeedScale(5)).toBeCloseTo(1.04);
    expect(enemySpeedScale(9)).toBeCloseTo(1.12);
    expect(enemySpeedScale(50)).toBe(1.18);
  });

  it("waveEnemyFireRate maintains readable attack loops", () => {
    expect(waveEnemyFireRate(1)).toBe(1);
    expect(waveEnemyFireRate(5)).toBeCloseTo(0.90);
    expect(waveEnemyFireRate(10)).toBeCloseTo(0.775);
    expect(waveEnemyFireRate(100)).toBe(0.68);
  });

  it("enemyAimAccuracy tightens shot cones as waves rise, capped below 1", () => {
    expect(enemyAimAccuracy(1)).toBeCloseTo(0.45);
    expect(enemyAimAccuracy(5)).toBeCloseTo(0.63);
    expect(enemyAimAccuracy(9)).toBeCloseTo(0.764);
    expect(enemyAimAccuracy(30)).toBe(0.80); // capped for normal waves
    expect(enemyAimAccuracy(10, true)).toBe(0.82); // Boss accuracy
    expect(enemyAimAccuracy(0)).toBe(0.45); // clamped to wave 1
    expect(enemyAimAccuracy(NaN)).toBe(0.45); // non-finite guard
  });

  it("HP outpaces damage so later waves feel tankier but fair without bullet sponges", () => {
    expect(waveEnemyPower(15)).toBeGreaterThan(waveEnemyDamage(15));
    expect(waveEnemyPower(9)).toBeLessThan(2.0); // Never 4x sponge on wave 9
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

describe("run-level XP (Vampire-Survivors style)", () => {
  it("runXpForLevel thresholds are cumulative and escalating", () => {
    expect(runXpForLevel(1)).toBe(0);
    expect(runXpForLevel(2)).toBe(10); // +10
    expect(runXpForLevel(3)).toBe(25); // +15
    expect(runXpForLevel(4)).toBe(45); // +20
    expect(runXpForLevel(5)).toBe(70); // +25
  });
  it("runLevelForXp respects thresholds and caps", () => {
    expect(runLevelForXp(0)).toBe(1);
    expect(runLevelForXp(9)).toBe(1);
    expect(runLevelForXp(10)).toBe(2);
    expect(runLevelForXp(24)).toBe(2);
    expect(runLevelForXp(25)).toBe(3);
    expect(runLevelForXp(1e9, 15)).toBe(15);
  });
  it("xpForEnemyType values scale by threat", () => {
    expect(xpForEnemyType(EnemyType.BASIC, false)).toBe(1);
    expect(xpForEnemyType(EnemyType.SHOOTER, false)).toBe(2);
    expect(xpForEnemyType(EnemyType.DRONE, false)).toBe(3);
    expect(xpForEnemyType(EnemyType.TANK, false)).toBe(5);
    expect(xpForEnemyType(EnemyType.BASIC, true)).toBe(15); // ELITE
    expect(xpForEnemyType(EnemyType.BOSS, false)).toBe(50);
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
    expect(new Set(picks.map((p) => p.category)).size).toBe(3);
  });
  it("clamps to pool size", () => {
    expect(pickUpgrades(999).length).toBeLessThanOrEqual(UPGRADE_POOL.length);
    expect(pickUpgrades(0)).toHaveLength(1);
  });
});

describe("threat-budgeted spawning", () => {
  it("grows by wave and threat without unbounded per-tick bursts", () => {
    expect(waveThreatBudget(2, 1)).toBeGreaterThan(waveThreatBudget(1, 1));
    expect(waveThreatBudget(5, 3)).toBeGreaterThan(waveThreatBudget(5, 1));
    expect(SPAWN_CONFIG.maxPerTick).toBe(1);
    expect(SPAWN_CONFIG.maxQueue).toBeLessThanOrEqual(24);
    expect(SPAWN_CONFIG.minDistance).toBeGreaterThanOrEqual(70);
  });

  it("prices squad compositions before committing them", () => {
    const members: EnemyVariant[] = [EnemyVariant.STANDARD, EnemyVariant.MISSILE_CARRIER];
    const cost = compositionThreatCost(members);
    expect(cost).toBe(ENEMY_VARIANTS[EnemyVariant.STANDARD].threat + ENEMY_VARIANTS[EnemyVariant.MISSILE_CARRIER].threat);
    expect(compositionFitsBudget(members, cost)).toBe(true);
    expect(compositionFitsBudget(members, cost - 1)).toBe(false);
  });
});

describe("public wave API (budget → composition → stat scale)", () => {
  it("waveSpawnBudget grows with wave and threat", () => {
    expect(waveSpawnBudget(1, 1)).toBeGreaterThan(15);
    expect(waveSpawnBudget(10, 1)).toBeGreaterThan(waveSpawnBudget(1, 1));
    expect(waveSpawnBudget(5, 3)).toBeGreaterThan(waveSpawnBudget(5, 1));
    expect(waveSpawnBudget(5, 1)).toBe(waveThreatBudget(5, 1));
  });

  it("waveComposition respects the remaining budget and wave gates", () => {
    // Low wave + tiny budget: only the cheap STANDARD hull fits.
    const early = waveComposition(1, 0.5, () => 0.99);
    expect(early).toBe(EnemyVariant.STANDARD);
    // High wave + generous budget: a heavy variant can be picked.
    const late = waveComposition(12, 20, () => 0.99);
    expect(ENEMY_VARIANTS[late].threat).toBeLessThanOrEqual(20);
    // New variants stay locked until their minWave.
    const w8 = waveComposition(8, 20, () => 0.99);
    expect(w8).not.toBe(EnemyVariant.GATLING_HEAVY);
    expect(w8).not.toBe(EnemyVariant.INTERCEPTOR);
    expect(w8).not.toBe(EnemyVariant.MINELAYER);
  });

  it("waveStatScale unifies hp/damage/fire-rate growth with caps", () => {
    const s1 = waveStatScale(1);
    const s20 = waveStatScale(20);
    expect(s1.hp).toBe(1);
    expect(s1.damage).toBe(1);
    expect(s1.fireRate).toBe(1);
    expect(s20.hp).toBe(waveEnemyPower(20));
    expect(s20.damage).toBe(waveEnemyDamage(20));
    expect(s20.fireRate).toBe(waveEnemyFireRate(20));
    expect(waveStatScale(200).damage).toBe(1.70);
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

describe("city districts", () => {
  it("defines every district with complete, valid configs", () => {
    for (const name of Object.keys(DISTRICT_CONFIGS) as (keyof typeof DISTRICT_CONFIGS)[]) {
      const c = DISTRICT_CONFIGS[name];
      expect(c.name).toBe(name);
      expect(c.palette.length).toBeGreaterThan(0);
      expect(c.detailPalette.length).toBeGreaterThan(0);
      expect(c.heightBand[0]).toBeGreaterThan(0);
      expect(c.heightBand[0]).toBeLessThanOrEqual(c.heightBand[1]);
      expect(c.skyscraperHeight[0]).toBeGreaterThanOrEqual(c.heightBand[1]);
      expect(c.density).toBeGreaterThan(0);
      expect(c.density).toBeLessThanOrEqual(1);
      expect(c.skyscraperChance).toBeGreaterThanOrEqual(0);
      expect(c.skyscraperChance).toBeLessThanOrEqual(1);
      // Footprint weights must be a valid distribution (sum to 1)
      expect(c.footprintWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      expect(c.footprintWeights.every((w) => w >= 0)).toBe(true);
    }
  });

  it("covers every district in the schedule at least once", () => {
    const scheduled = new Set(DISTRICT_SCHEDULE);
    expect(scheduled.size).toBe(Object.keys(DISTRICT_CONFIGS).length);
  });

  it("returns a valid district for any chunk id (stable per id)", () => {
    for (const id of [-40, -1, 0, 1, 7, 13, 14, 27, 99]) {
      expect(DISTRICT_CONFIGS[districtForChunk(id)]).toBeDefined();
      expect(districtForChunk(id)).toBe(districtForChunk(id));
    }
  });

  it("schedule alternates so the same district never repeats back-to-back", () => {
    for (let i = 0; i < DISTRICT_SCHEDULE.length - 1; i++) {
      expect(DISTRICT_SCHEDULE[i]).not.toBe(DISTRICT_SCHEDULE[i + 1]);
    }
  });

  it("keeps LARGE footprints uncommon in every district", () => {
    for (const name of Object.keys(DISTRICT_CONFIGS) as (keyof typeof DISTRICT_CONFIGS)[]) {
      const [, m, l] = DISTRICT_CONFIGS[name].footprintWeights;
      expect(l).toBeLessThanOrEqual(m); // LARGE never outnumbers MEDIUM
      expect(l).toBeLessThan(0.2); // and stays a clear minority
    }
  });
});

describe("district identity (Pass 4)", () => {
  it("every district defines readable identity knobs within sane ranges", () => {
    for (const name of Object.keys(DISTRICT_CONFIGS) as (keyof typeof DISTRICT_CONFIGS)[]) {
      const c = DISTRICT_CONFIGS[name];
      expect(c.rooftopClutter).toBeGreaterThanOrEqual(0);
      expect(c.rooftopClutter).toBeLessThanOrEqual(1);
      expect(c.openSpaceChance).toBeGreaterThanOrEqual(0);
      expect(c.openSpaceChance).toBeLessThanOrEqual(1);
      expect(c.landmarkChance).toBeGreaterThan(0);
      expect(c.landmarkChance).toBeLessThanOrEqual(1);
      expect(c.billboardCount).toBeGreaterThanOrEqual(1);
      expect(c.crossStreetHalf).toBeGreaterThanOrEqual(6);
      expect(c.crossStreetHalf).toBeLessThanOrEqual(20);
      expect(c.signColors.length).toBeGreaterThanOrEqual(1);
      expect(c.propDensity).toBeGreaterThanOrEqual(0);
      expect(c.propDensity).toBeLessThanOrEqual(1);
    }
  });

  it("rooftop prop weights are non-negative with at least one pickable type", () => {
    for (const name of Object.keys(DISTRICT_CONFIGS) as (keyof typeof DISTRICT_CONFIGS)[]) {
      const props = DISTRICT_CONFIGS[name].rooftopProps;
      const weights = Object.values(props);
      expect(weights.every((w) => w >= 0)).toBe(true);
      expect(weights.some((w) => w > 0)).toBe(true);
    }
  });

  it("district personalities differ on the identity axes", () => {
    const downtown = DISTRICT_CONFIGS.downtown;
    const industrial = DISTRICT_CONFIGS.industrial;
    const residential = DISTRICT_CONFIGS.residential;
    const waterfront = DISTRICT_CONFIGS.waterfront;
    // Downtown: densest signage + antennas; industrial: chimneys, wide roads
    expect(downtown.billboardCount).toBeGreaterThan(residential.billboardCount);
    expect(downtown.rooftopProps.antenna).toBeGreaterThan(residential.rooftopProps.antenna);
    expect(industrial.rooftopProps.smokeStack).toBeGreaterThan(downtown.rooftopProps.smokeStack);
    expect(industrial.crossStreetHalf).toBeGreaterThan(residential.crossStreetHalf);
    // Waterfront + residential read more open than downtown
    expect(waterfront.openSpaceChance).toBeGreaterThan(downtown.openSpaceChance);
    expect(residential.openSpaceChance).toBeGreaterThan(downtown.openSpaceChance);
    // Pass 5: developed districts are prop-dense, wilderness is sparse
    expect(downtown.propDensity).toBeGreaterThan(DISTRICT_CONFIGS.forest.propDensity);
    expect(industrial.propDensity).toBeGreaterThan(DISTRICT_CONFIGS.desert.propDensity);
  });

  it("every district has at least one rooftop prop kind available (Pass 5)", () => {
    for (const name of Object.keys(DISTRICT_CONFIGS) as (keyof typeof DISTRICT_CONFIGS)[]) {
      const props = DISTRICT_CONFIGS[name].rooftopProps;
      expect(Object.values(props).some((w) => w > 0)).toBe(true);
    }
    // New Pass 5 kinds are actually used somewhere
    const used = Object.keys(DISTRICT_CONFIGS).filter((name) => {
      const p = DISTRICT_CONFIGS[name as keyof typeof DISTRICT_CONFIGS].rooftopProps;
      return p.vent > 0 || p.maintenanceHut > 0;
    });
    expect(used.length).toBeGreaterThanOrEqual(5);
  });
});

describe("footprintTier", () => {
  const weights: [number, number, number] = [0.5, 0.35, 0.15];
  it("maps roll ranges to tiers", () => {
    expect(footprintTier(0.0, weights)).toBe(0);
    expect(footprintTier(0.49, weights)).toBe(0);
    expect(footprintTier(0.5, weights)).toBe(1);
    expect(footprintTier(0.84, weights)).toBe(1);
    expect(footprintTier(0.85, weights)).toBe(2);
    expect(footprintTier(0.99, weights)).toBe(2);
  });
  it("handles extreme weight distributions", () => {
    expect(footprintTier(0.0, [1, 0, 0])).toBe(0);
    expect(footprintTier(0.999, [0, 0, 1])).toBe(2);
    expect(footprintTier(0.5, [0.5, 0.5, 0])).toBe(1);
  });
});

describe("buildingMassing (Pass 10)", () => {
  it("keeps SMALL footprints as single boxes", () => {
    for (let r = 0; r < 1; r += 0.05) {
      expect(buildingMassing(r, 0)).toBe("mono");
    }
  });

  it("maps roll ranges to composite massings on larger footprints", () => {
    expect(buildingMassing(0.0, 1)).toBe("mono");
    expect(buildingMassing(0.51, 2)).toBe("mono");
    expect(buildingMassing(0.52, 1)).toBe("podium");
    expect(buildingMassing(0.69, 2)).toBe("podium");
    expect(buildingMassing(0.7, 1)).toBe("lshape");
    expect(buildingMassing(0.82, 2)).toBe("lshape");
    expect(buildingMassing(0.83, 1)).toBe("twins");
    expect(buildingMassing(0.91, 2)).toBe("twins");
    expect(buildingMassing(0.92, 1)).toBe("stepped");
    expect(buildingMassing(0.99, 2)).toBe("stepped");
  });

  it("keeps mono the most common massing so the skyline keeps anchors", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const m = buildingMassing((i * 0.6180339887) % 1, 1 + (i % 2));
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    expect(counts.get("mono")).toBeGreaterThan(480);
    for (const kind of ["podium", "lshape", "twins", "stepped"]) {
      expect(counts.get(kind) ?? 0).toBeGreaterThan(30);
    }
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

describe("buildingArchetype (Pass 6)", () => {
  it("routes skyscrapers to the stepped tower", () => {
    expect(
      buildingArchetype({ district: "downtown", tier: 1, skyscraper: true, height: 40, roll: 0.1 }),
    ).toBe("steppedTower");
  });

  it("keeps industrial LARGE footprints to warehouse/factory", () => {
    for (let r = 0; r < 1; r += 0.1) {
      const a = buildingArchetype({ district: "industrial", tier: 2, skyscraper: false, height: 12, roll: r });
      expect(["warehouse", "factory"]).toContain(a);
    }
  });

  it("residential MEDIUM footprints are resBlocks", () => {
    expect(
      buildingArchetype({ district: "residential", tier: 1, skyscraper: false, height: 8, roll: 0.3 }),
    ).toBe("resBlock");
  });

  it("downtown MEDIUM buildings pick from the office family", () => {
    for (let r = 0; r < 1; r += 0.1) {
      const a = buildingArchetype({ district: "downtown", tier: 1, skyscraper: false, height: 10, roll: r });
      expect(["office", "comm", "slab", "parking"]).toContain(a);
    }
  });

  it("small footprints default to plain boxes", () => {
    expect(
      buildingArchetype({ district: "midtown", tier: 0, skyscraper: false, height: 6, roll: 0.5 }),
    ).toBe("plain");
  });

  it("district beats tier: industrial SMALL can still be a shed", () => {
    expect(
      buildingArchetype({ district: "industrial", tier: 0, skyscraper: false, height: 5, roll: 0.1 }),
    ).toBe("warehouse");
  });
});

describe("scene rhythm (Pass 9)", () => {
  it("is deterministic per chunk id", () => {
    for (let id = -60; id < 60; id++) {
      expect(sceneRhythmForChunk(id)).toBe(sceneRhythmForChunk(id));
    }
  });

  it("never places landmark chunks back to back", () => {
    for (let id = -60; id <= 60; id++) {
      if (sceneRhythmForChunk(id) === "landmark") {
        expect(sceneRhythmForChunk(id - 1)).not.toBe("landmark");
      }
    }
  });

  it("keeps landmarks rare enough for navigation memory", () => {
    const ids = Array.from({ length: 70 }, (_, i) => i);
    const landmarks = ids.filter((id) => sceneRhythmForChunk(id) === "landmark").length;
    expect(landmarks).toBeGreaterThanOrEqual(3);
    expect(landmarks).toBeLessThanOrEqual(18);
  });

  it("offers all five rhythms across a window", () => {
    const seen = new Set(Array.from({ length: 70 }, (_, i) => sceneRhythmForChunk(i)));
    for (const r of ["dense", "medium", "open", "objective", "landmark"] as const) {
      expect(seen.has(r)).toBe(true);
    }
  });

  it("rhythmDensity orders intensity dense > medium > landmark > open", () => {
    expect(rhythmDensity("dense")).toBeGreaterThan(rhythmDensity("medium"));
    expect(rhythmDensity("medium")).toBeGreaterThan(rhythmDensity("landmark"));
    expect(rhythmDensity("landmark")).toBeGreaterThan(rhythmDensity("objective"));
    expect(rhythmDensity("objective")).toBeGreaterThan(rhythmDensity("open"));
  });
});

describe("enemy variants", () => {
  it("configures all fourteen variants with sane stats", () => {
    expect(Object.keys(ENEMY_VARIANTS)).toHaveLength(14);
    for (const variant of Object.keys(ENEMY_VARIANTS) as EnemyVariant[]) {
      const cfg = ENEMY_VARIANTS[variant];
      expect(cfg.threat).toBeGreaterThan(0);
      expect(cfg.minWave).toBeGreaterThanOrEqual(1);
      expect(cfg.hpMult).toBeGreaterThan(0);
      expect(cfg.speedMult).toBeGreaterThan(0);
      expect(cfg.damageMult).toBeGreaterThan(0);
      expect(cfg.baseType).not.toBe(EnemyType.BOSS);
    }
  });

  it("matches the spec threat-cost ladder", () => {
    const threat = (v: EnemyVariant) => ENEMY_VARIANTS[v].threat;
    expect(threat(EnemyVariant.STANDARD)).toBe(1.0);
    expect(threat(EnemyVariant.SCOUT_DRONE)).toBe(1.0);
    expect(threat(EnemyVariant.KAMIKAZE_DRONE)).toBe(1.25);
    expect(threat(EnemyVariant.FLAK_TANK)).toBe(1.5);
    expect(threat(EnemyVariant.ATTACK_GUNSHIP)).toBe(1.75);
    expect(threat(EnemyVariant.ROCKET_GUNSHIP)).toBe(2.0);
    expect(threat(EnemyVariant.MISSILE_CARRIER)).toBe(2.0);
    expect(threat(EnemyVariant.SHIELD_DRONE)).toBe(2.0);
    expect(threat(EnemyVariant.REPAIR_DRONE)).toBe(2.25);
    expect(threat(EnemyVariant.SIEGE_TANK)).toBe(2.5);
    expect(threat(EnemyVariant.HEAVY_GUNSHIP)).toBe(3.0);
    expect(threat(EnemyVariant.INTERCEPTOR)).toBe(2.0);
    expect(threat(EnemyVariant.MINELAYER)).toBe(2.25);
    expect(threat(EnemyVariant.GATLING_HEAVY)).toBe(2.5);
  });

  it("unlocks the late-war variants on their tier ladder", () => {
    expect(ENEMY_VARIANTS[EnemyVariant.GATLING_HEAVY].minWave).toBe(9);
    expect(ENEMY_VARIANTS[EnemyVariant.INTERCEPTOR].minWave).toBe(10);
    expect(ENEMY_VARIANTS[EnemyVariant.MINELAYER].minWave).toBe(11);
  });

  it("caps the new specialist variants so they never swarm", () => {
    expect(ENEMY_VARIANTS[EnemyVariant.INTERCEPTOR].maxActive).toBe(4);
    expect(ENEMY_VARIANTS[EnemyVariant.MINELAYER].maxActive).toBe(2);
    expect(ENEMY_VARIANTS[EnemyVariant.GATLING_HEAVY].maxActive).toBe(2);
  });

  it("never rolls new variants before their unlock wave", () => {
    for (let i = 0; i < 400; i++) {
      const w8 = pickEnemyVariant(8);
      expect(w8).not.toBe(EnemyVariant.GATLING_HEAVY);
      expect(w8).not.toBe(EnemyVariant.INTERCEPTOR);
      expect(w8).not.toBe(EnemyVariant.MINELAYER);
      const w9 = pickEnemyVariant(9);
      expect(w9).not.toBe(EnemyVariant.INTERCEPTOR);
      expect(w9).not.toBe(EnemyVariant.MINELAYER);
      const w10 = pickEnemyVariant(10);
      expect(w10).not.toBe(EnemyVariant.MINELAYER);
    }
  });

  it("eventually fields the new variants once unlocked", () => {
    const seen = new Set<EnemyVariant>();
    for (let i = 0; i < 4000; i++) seen.add(pickEnemyVariant(12));
    expect(seen.has(EnemyVariant.GATLING_HEAVY)).toBe(true);
    expect(seen.has(EnemyVariant.INTERCEPTOR)).toBe(true);
    expect(seen.has(EnemyVariant.MINELAYER)).toBe(true);
  });

  it("gates variants by wave — nothing appears before its minWave", () => {
    const rng = () => 0.999; // pick the last candidate every time
    for (let wave = 1; wave <= 12; wave++) {
      const picked = pickEnemyVariant(wave, rng);
      expect(ENEMY_VARIANTS[picked].minWave).toBeLessThanOrEqual(wave);
    }
  });

  it("never picks rare units (heavy gunship / siege tank) individually", () => {
    const rng = () => 0.999;
    for (let wave = 1; wave <= 20; wave++) {
      const picked = pickEnemyVariant(wave, rng);
      expect(picked).not.toBe(EnemyVariant.HEAVY_GUNSHIP);
      expect(picked).not.toBe(EnemyVariant.SIEGE_TANK);
    }
  });

  it("keeps early waves gentle — wave 1 only produces STANDARD", () => {
    for (let i = 0; i < 200; i++) {
      expect(pickEnemyVariant(1)).toBe(EnemyVariant.STANDARD);
    }
  });

  it("enforces per-variant soft caps via variantAtCap", () => {
    const carrier = ENEMY_VARIANTS[EnemyVariant.MISSILE_CARRIER];
    expect(carrier.maxActive).toBe(2);
    expect(variantAtCap(carrier, {})).toBe(false);
    expect(variantAtCap(carrier, { [EnemyVariant.MISSILE_CARRIER]: 1 })).toBe(false);
    expect(variantAtCap(carrier, { [EnemyVariant.MISSILE_CARRIER]: 2 })).toBe(true);
    // Un-capped variants never trip the check
    const standard = ENEMY_VARIANTS[EnemyVariant.STANDARD];
    expect(variantAtCap(standard, { [EnemyVariant.STANDARD]: 999 })).toBe(false);
  });

  it("support units are hard-capped so the battlefield never stacks them", () => {
    expect(ENEMY_VARIANTS[EnemyVariant.SHIELD_DRONE].maxActive).toBe(2);
    expect(ENEMY_VARIANTS[EnemyVariant.REPAIR_DRONE].maxActive).toBe(1);
    expect(ENEMY_VARIANTS[EnemyVariant.HEAVY_GUNSHIP].maxActive).toBe(1);
    expect(ENEMY_VARIANTS[EnemyVariant.SIEGE_TANK].maxActive).toBe(1);
    expect(ENEMY_VARIANTS[EnemyVariant.MISSILE_CARRIER].maxActive).toBe(2);
  });

  it("squads are wave-gated and bounded in size", () => {
    for (let wave = 1; wave <= 14; wave++) {
      const squad = pickSquadForWave(wave, () => 0); // force a squad roll
      if (!squad) continue;
      expect(squad.length).toBeGreaterThan(1);
      expect(squad.length).toBeLessThanOrEqual(5);
      for (const member of squad) {
        expect(ENEMY_VARIANTS[member].minWave).toBeLessThanOrEqual(wave);
      }
    }
  });

  it("no squad template references a unit before its own minWave", () => {
    for (const squad of SQUAD_TEMPLATES) {
      for (const member of squad.members) {
        expect(ENEMY_VARIANTS[member].minWave).toBeLessThanOrEqual(squad.minWave);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// New systems (mega polish pack)
// ---------------------------------------------------------------------------

const memStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as Storage;
};

describe("status effects", () => {
  it("defines durations for all three effects", () => {
    expect(STATUS_DURATIONS.burn).toBeGreaterThan(0);
    expect(STATUS_DURATIONS.emp).toBeGreaterThan(0);
    expect(STATUS_DURATIONS.shock).toBeGreaterThan(0);
  });
  it("proc chance clamps to [0, 0.95] and stacks bonuses", () => {
    expect(statusProcChance(0.18, 0.1)).toBeCloseTo(0.28);
    expect(statusProcChance(0.9, 0.5)).toBe(0.95);
    expect(statusProcChance(0.1, -1)).toBeCloseTo(0.1);
  });
});

describe("elite affixes", () => {
  it("are all zero before their debut waves", () => {
    const c = affixChancesForWave(5);
    expect(c.explosive).toBe(0);
    expect(c.splitter).toBe(0);
    expect(c.vampiric).toBe(0);
  });
  it("ramp in order: explosive (6) → splitter (8) → vampiric (9)", () => {
    expect(affixChancesForWave(6).explosive).toBeGreaterThan(0);
    expect(affixChancesForWave(7).splitter).toBe(0);
    expect(affixChancesForWave(8).splitter).toBeGreaterThan(0);
    expect(affixChancesForWave(9).vampiric).toBeGreaterThan(0);
  });
  it("never exceed their caps even at extreme waves", () => {
    const c = affixChancesForWave(60);
    expect(c.explosive).toBeLessThanOrEqual(0.18);
    expect(c.splitter).toBeLessThanOrEqual(0.14);
    expect(c.vampiric).toBeLessThanOrEqual(0.12);
  });
});

describe("devastation super meter", () => {
  it("charges more for elites and much more for bosses", () => {
    expect(superChargeForKill(0, false, false)).toBe(4);
    expect(superChargeForKill(0, true, false)).toBe(12);
    expect(superChargeForKill(0, false, true)).toBe(40);
  });
  it("combo accelerates charge, capped at +6", () => {
    expect(superChargeForKill(4, false, false)).toBe(5);
    expect(superChargeForKill(400, false, false)).toBe(10);
  });
  it("SUPER_MAX_CHARGE is reachable in a reasonable fight", () => {
    let charge = 0;
    for (let i = 0; i < 25; i++) charge += superChargeForKill(i, false, false);
    expect(charge).toBeGreaterThanOrEqual(SUPER_MAX_CHARGE);
  });
});

describe("adaptive quality governor", () => {
  it("steps down after two consecutive low-FPS windows", () => {
    let g = createQualityGovernor();
    g = updateQualityGovernor(g, 40, 0);
    expect(g.level).toBe(0);
    g = updateQualityGovernor(g, 40, 1.5);
    expect(g.level).toBe(1);
  });
  it("respects the cooldown — no double step-down inside 5s", () => {
    let g = createQualityGovernor();
    g = updateQualityGovernor(g, 40, 0);
    g = updateQualityGovernor(g, 40, 1.5); // → level 1
    g = updateQualityGovernor(g, 40, 3);
    g = updateQualityGovernor(g, 40, 4.5);
    expect(g.level).toBe(1);
  });
  it("recovers after four consecutive high-FPS windows past cooldown", () => {
    let g = createQualityGovernor();
    g = updateQualityGovernor(g, 40, 0);
    g = updateQualityGovernor(g, 40, 1.5); // level 1
    for (let i = 0; i < 4; i++) g = updateQualityGovernor(g, 60, 8 + i * 1.5);
    expect(g.level).toBe(0);
  });
  it("hysteresis: mid-band FPS resets both counters", () => {
    let g = createQualityGovernor();
    g = updateQualityGovernor(g, 40, 0);
    expect(g.lowWindows).toBe(1);
    g = updateQualityGovernor(g, 53, 1.5);
    expect(g.lowWindows).toBe(0);
    expect(g.level).toBe(0);
  });
  it("never exceeds the max level", () => {
    let g = createQualityGovernor();
    for (let i = 0; i < 20; i++) g = updateQualityGovernor(g, 30, i * 1.5 + (i > 1 ? 60 : 0));
    expect(g.level).toBeLessThanOrEqual(GOVERNOR_MAX_LEVEL);
  });
  it("scales pixel ratio and particles down with level, never below floors", () => {
    expect(governorPixelScale(0)).toBe(1);
    expect(governorPixelScale(3)).toBeCloseTo(0.55);
    expect(governorParticleScale(3)).toBeGreaterThan(0.4);
    expect(governorPixelScale(99)).toBeCloseTo(0.55); // clamped
  });
  it("bloom survives level 1 but is cut at level 2", () => {
    expect(governorBloomAllowed(1, true)).toBe(true);
    expect(governorBloomAllowed(2, true)).toBe(false);
    expect(governorBloomAllowed(0, false)).toBe(false); // respects user preset
  });
});

describe("pilot perks", () => {
  it("reads empty storage as all-zero ranks", () => {
    const perks = readPerks(memStorage());
    expect(Object.values(perks).every((r) => r === 0)).toBe(true);
  });
  it("persists ranks and clamps to MAX_PERK_RANK", () => {
    const s = memStorage();
    writePerkRank("magnet", 2, s);
    writePerkRank("dash", 99, s);
    const perks = readPerks(s);
    expect(perks.magnet).toBe(2);
    expect(perks.dash).toBe(MAX_PERK_RANK);
  });
  it("perkEffect scales linearly with rank", () => {
    expect(perkEffect("magnet", 0)).toBe(0);
    expect(perkEffect("magnet", 2)).toBeCloseTo(PERK_INFO.magnet.perRank * 2);
  });
  it("every perk has rank costs up to MAX_PERK_RANK", () => {
    for (const info of Object.values(PERK_INFO)) {
      expect(info.costs.length).toBe(MAX_PERK_RANK);
      expect(info.costs[1]).toBeGreaterThan(info.costs[0]);
    }
  });
});

describe("damage affinities", () => {
  it("computes weapon vs target category multipliers properly", () => {
    // Machine gun favors Air (1.25x), weaker vs armor (0.85x)
    expect(calculateDamageAffinity(WeaponType.MACHINE_GUN, 'AIR', 20)).toBe(25);
    expect(calculateDamageAffinity(WeaponType.MACHINE_GUN, 'ARMORED', 20)).toBe(17);

    // Rocket favors Armored (1.4x) and Structures (1.4x)
    expect(calculateDamageAffinity(WeaponType.ROCKET, 'ARMORED', 50)).toBe(70);
    expect(calculateDamageAffinity(WeaponType.ROCKET, 'STRUCTURE', 50)).toBe(70);

    // Missile favors Armored (1.45x) and Boss Core (1.3x)
    expect(calculateDamageAffinity(WeaponType.MISSILE, 'BOSS_CORE', 100)).toBe(130);
    expect(calculateDamageAffinity(WeaponType.MISSILE, 'ARMORED', 100)).toBe(145);
  });
});

describe("weapon mods", () => {
  it("reads empty storage as all factory (0)", () => {
    expect(readWeaponMods(memStorage())).toEqual([0, 0, 0, 0]);
  });
  it("persists a choice per weapon, clamped to [0,2]", () => {
    const s = memStorage();
    writeWeaponMod(0, 1, s);
    writeWeaponMod(2, 7, s);
    expect(readWeaponMods(s)).toEqual([1, 0, 2, 0]);
  });
  it("every weapon offers exactly two mods", () => {
    expect(Object.keys(WEAPON_MODS).length).toBe(4);
    for (const pair of Object.values(WEAPON_MODS)) expect(pair.length).toBe(2);
  });
});

describe("extraction", () => {
  it("requires the minimum wave AND objectives AND a fresh run", () => {
    expect(canOfferExtraction(6, 2, false)).toBe(true);
    expect(canOfferExtraction(5, 2, false)).toBe(false);
    expect(canOfferExtraction(6, 1, false)).toBe(false);
    expect(canOfferExtraction(6, 2, true)).toBe(false);
  });
});

describe("run history", () => {
  const rec = (score: number) => ({
    score,
    wave: 5,
    kills: 100,
    accuracy: 0.5,
    survivalTime: 120,
    victory: false,
    at: Date.now(),
  });
  it("records most-recent-first and caps at the limit", () => {
    const s = memStorage();
    for (let i = 1; i <= 15; i++) recordRun(rec(i * 100), s);
    const history = readRunHistory(s);
    expect(history.length).toBe(RUN_HISTORY_LIMIT);
    expect(history[0].score).toBe(1500);
  });
  it("drops malformed entries when reading", () => {
    const s = memStorage();
    s.setItem("helistrike:history", JSON.stringify([rec(100), { nope: true }, null]));
    expect(readRunHistory(s).length).toBe(1);
  });
  it("scorecard mentions score and NEW BEST", () => {
    const text = formatScorecard(rec(5000), 5000);
    expect(text).toContain("5000");
    expect(text).toContain("NEW BEST");
    expect(text).toContain("2:00");
  });
});

describe("nightOpForWave", () => {
  it("never triggers before the minimum wave", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(nightOpForWave(NIGHT_OPS_MIN_WAVE - 1, seed)).toBe(false);
    }
  });
  it("is deterministic for a given wave and seed", () => {
    for (let wave = NIGHT_OPS_MIN_WAVE; wave < NIGHT_OPS_MIN_WAVE + 12; wave++) {
      const a = nightOpForWave(wave, 7);
      expect(nightOpForWave(wave, 7)).toBe(a);
    }
  });
  it("lands roughly near the 25% chance across many waves", () => {
    let hits = 0;
    const total = 400;
    for (let wave = NIGHT_OPS_MIN_WAVE; wave < NIGHT_OPS_MIN_WAVE + total; wave++) {
      if (nightOpForWave(wave, 1234)) hits++;
    }
    // Loose bounds — the hash should sit near the intended probability.
    expect(hits).toBeGreaterThan(total * 0.1);
    expect(hits).toBeLessThan(total * 0.45);
  });
});
