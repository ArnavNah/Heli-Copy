import { describe, expect, it, beforeEach } from "vitest";
import { CombatDirector, PERFORMANCE_CAPS } from "./combatDirector";
import { DirectionalPressureMode } from "./types";

describe("CombatDirector", () => {
  let director: CombatDirector;

  beforeEach(() => {
    director = new CombatDirector();
  });

  describe("Air Attack Slots", () => {
    it("scales max air attack slots across waves", () => {
      // Early waves: 1 slot
      expect(director.getMaxAirAttackSlots(1)).toBe(1);
      expect(director.getMaxAirAttackSlots(2)).toBe(1);
      expect(director.getMaxAirAttackSlots(3)).toBe(1);

      // Mid waves: 2 slots
      expect(director.getMaxAirAttackSlots(4)).toBe(2);
      expect(director.getMaxAirAttackSlots(6)).toBe(2);

      // Late waves: 3-4 slots
      expect(director.getMaxAirAttackSlots(7)).toBe(3);
      expect(director.getMaxAirAttackSlots(8)).toBe(3);
      expect(director.getMaxAirAttackSlots(9)).toBe(4);

      // Boss active: throttles to 2 support slots
      expect(director.getMaxAirAttackSlots(10, 3, false, 1.0, true)).toBe(2);

      // Overdrive: scales up to 4-6 slots
      expect(director.getMaxAirAttackSlots(11, 3, true, 1.5, false)).toBe(4);
      expect(director.getMaxAirAttackSlots(15, 3, true, 2.5, false)).toBe(6);
    });

    it("grants slots up to max and rejects subsequent requests", () => {
      const time = 10.0;
      const wave = 1; // max 1 slot

      expect(director.requestAirAttackSlot(101, time, wave)).toBe(true);
      expect(director.hasAirAttackSlot(101)).toBe(true);

      // Stagger check / slot cap blocks second enemy
      expect(director.requestAirAttackSlot(102, time, wave)).toBe(false);
      expect(director.hasAirAttackSlot(102)).toBe(false);
    });

    it("releases slots cleanly and enforces personal cooldown and rotation delay", () => {
      const time = 10.0;
      const wave = 1;

      expect(director.requestAirAttackSlot(101, time, wave)).toBe(true);

      // Release slot with 3.0s personal cooldown
      director.releaseAirAttackSlot(101, time, 3.0);
      expect(director.hasAirAttackSlot(101)).toBe(false);

      // Enemy 101 cannot immediately re-acquire (cooldown)
      expect(director.requestAirAttackSlot(101, time + 0.5, wave)).toBe(false);

      // Other enemy 102 can acquire after attack rotation delay (wave 1 rot delay = 1.10s)
      expect(director.requestAirAttackSlot(102, time + 1.2, wave)).toBe(true);

      // Enemy 101 can acquire once cooldown expires and slot is free
      director.releaseAirAttackSlot(102, time + 2.0, 3.0);
      expect(director.requestAirAttackSlot(101, time + 3.5, wave)).toBe(true);
    });

    it("cleans up slots when enemies die or time out", () => {
      const time = 10.0;
      const wave = 4; // max 2 slots

      expect(director.requestAirAttackSlot(101, time, wave)).toBe(true);
      expect(director.requestAirAttackSlot(102, time + 0.3, wave)).toBe(true);

      // Step director with only enemy 101 active (102 died)
      const activeIds = new Set([101]);
      director.update(0.1, time + 0.4, wave, activeIds);

      expect(director.hasAirAttackSlot(101)).toBe(true);
      expect(director.hasAirAttackSlot(102)).toBe(false); // Cleaned!

      // Enemy 103 can now acquire
      expect(director.requestAirAttackSlot(103, time + 0.8, wave)).toBe(true);
    });
  });

  describe("Heavy Attack Budget", () => {
    it("limits concurrent heavy strikes and enforces stagger gap", () => {
      // Wave 1-3: 1 heavy attack, Wave 4-7: 2, Wave 8+: 3, Boss: 1
      expect(director.getMaxHeavyAttackSlots(1)).toBe(1);
      expect(director.getMaxHeavyAttackSlots(5)).toBe(2);
      expect(director.getMaxHeavyAttackSlots(9)).toBe(3);
      expect(director.getMaxHeavyAttackSlots(10, true)).toBe(1);

      const time = 10.0;
      // First heavy attack granted
      expect(director.requestHeavyAttackSlot(501, "TANK", time, 5)).toBe(true);
      expect(director.hasHeavyAttackSlot(501)).toBe(true);

      // Same-frame second heavy attack blocked by 450ms stagger gap
      expect(director.requestHeavyAttackSlot(502, "SAM", time + 0.1, 5)).toBe(false);

      // After stagger gap (0.5s later), second heavy attack granted
      expect(director.requestHeavyAttackSlot(502, "SAM", time + 0.5, 5)).toBe(true);

      // Third heavy attack blocked because max slots is 2 on wave 5
      expect(director.requestHeavyAttackSlot(503, "TANK", time + 1.1, 5)).toBe(false);

      // Release slot 501
      director.releaseHeavyAttackSlot(501, time + 1.2, 2.0);
      expect(director.hasHeavyAttackSlot(501)).toBe(false);

      // Now 503 can acquire after stagger
      expect(director.requestHeavyAttackSlot(503, "TANK", time + 1.7, 5)).toBe(true);
    });
  });

  describe("Directional Pressure Modes", () => {
    it("escalates directional modes by wave", () => {
      expect(director.getDirectionalMode(1)).toBe(DirectionalPressureMode.SINGLE_SECTOR);
      expect(director.getDirectionalMode(3)).toBe(DirectionalPressureMode.SINGLE_SECTOR);
      expect(director.getDirectionalMode(4)).toBe(DirectionalPressureMode.DOMINANT_AND_FLANK);
      expect(director.getDirectionalMode(6)).toBe(DirectionalPressureMode.DOMINANT_AND_FLANK);
      expect(director.getDirectionalMode(7)).toBe(DirectionalPressureMode.DUAL_SECTORS);
      expect(director.getDirectionalMode(9)).toBe(DirectionalPressureMode.DUAL_SECTORS);
      expect(director.getDirectionalMode(11, true)).toBe(DirectionalPressureMode.PINCER_SURROUND);
    });

    it("provides valid approach angles", () => {
      const angle = director.getCurrentDirectionalAngle();
      expect(Number.isFinite(angle)).toBe(true);

      const name = director.getCurrentDirectionalName();
      expect(typeof name).toBe("string");

      const approachA = director.getAssignedApproachAngle(1, 0.5, 1);
      const approachB = director.getAssignedApproachAngle(2, 0.5, 1);
      expect(Number.isFinite(approachA)).toBe(true);
      expect(Number.isFinite(approachB)).toBe(true);
    });
  });

  describe("Micro-Lulls", () => {
    it("blocks new air slots during active micro-lull", () => {
      director.triggerMicroLull(3.0);
      expect(director.isMicroLull()).toBe(true);
      expect(director.getMicroLullRemaining()).toBe(3.0);

      const time = 10.0;
      // First slot granted if 0 active, but subsequent blocked
      expect(director.requestAirAttackSlot(301, time, 5)).toBe(true);
      expect(director.requestAirAttackSlot(302, time + 0.4, 5)).toBe(false);

      // Advance time past micro-lull
      director.update(3.5, time + 3.5, 5, new Set([301, 302]));
      expect(director.isMicroLull()).toBe(false);

      // Now 302 can acquire after rotation delay
      expect(director.requestAirAttackSlot(302, time + 4.5, 5)).toBe(true);
    });
  });

  describe("Performance Caps & Snapshots", () => {
    it("defines strict performance caps", () => {
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_ENEMIES).toBe(48);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_AIR).toBe(12);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_GROUND).toBe(36);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_AIR_ATTACKERS).toBe(6);
      expect(PERFORMANCE_CAPS.MAX_ACTIVE_HEAVY_ATTACKS).toBe(3);
      expect(PERFORMANCE_CAPS.MAX_PROJECTILES).toBe(180);
      expect(PERFORMANCE_CAPS.MAX_PARTICLES).toBe(600);
      expect(PERFORMANCE_CAPS.MAX_SPAWN_QUEUE).toBe(18);
    });

    it("generates comprehensive telemetry snapshot for dev tuning panel", () => {
      const snapshot = director.getSnapshot(4, 18, 10.0, 4.0, 0.85, 7, 2, false, 1.0, false, "normal");
      expect(snapshot.wave).toBe(7);
      expect(snapshot.combatIntensity).toBe(0.85);
      expect(snapshot.activeEnemies).toBe(18);
      expect(snapshot.targetEnemies).toBeGreaterThan(0);
      expect(snapshot.groundThreat).toBe(10.0);
      expect(snapshot.airThreat).toBe(4.0);
      expect(snapshot.maxAirAttackSlots).toBe(3);
      expect(snapshot.maxHeavyAttacks).toBe(2);
      expect(snapshot.directionalMode).toBe(DirectionalPressureMode.DUAL_SECTORS);
      expect(snapshot.hpScale).toBeGreaterThanOrEqual(1.0);
      expect(snapshot.damageScale).toBeGreaterThanOrEqual(1.0);
      expect(snapshot.speedScale).toBeGreaterThanOrEqual(1.0);
    });
  });
});

