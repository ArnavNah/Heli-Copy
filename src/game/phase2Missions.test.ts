import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { Objective } from "./entities";
import { ObjectiveType } from "./types";
import {
  GROUND_COMPOSITIONS,
  pickGroundComposition,
} from "./logic";
import {
  MissionManager,
  MissionType,
  MissionState,
  BonusObjectiveType,
} from "./mission";

describe("Phase 2: Radar Station, SAM Tactical Synergy, and Ground Composition Director", () => {
  let scene: THREE.Scene;
  let world: CANNON.World;

  beforeEach(() => {
    scene = new THREE.Scene();
    world = new CANNON.World();
  });

  describe("Step 3 & 6: Radar Model Hierarchy & Targeting", () => {
    it("builds a complete desert military radar installation hierarchy", () => {
      const radar = new Objective(scene, world, 10, 2, -150, ObjectiveType.RADAR_TOWER);
      
      expect(radar.mesh).toBeDefined();
      expect(radar.type).toBe(ObjectiveType.RADAR_TOWER);

      // Verify key hierarchical subcomponents
      const technicalBuilding = radar.mesh.getObjectByName("TechnicalBuilding");
      const radarYawPivot = radar.mesh.getObjectByName("RadarYawPivot");
      const largeRadarDish = radar.mesh.getObjectByName("LargeRadarDish");
      const secondaryAntenna = radar.mesh.getObjectByName("SecondaryAntenna");
      const cabinet01 = radar.mesh.getObjectByName("EquipmentCabinet01");
      const cabinet02 = radar.mesh.getObjectByName("EquipmentCabinet02");
      const generator = radar.mesh.getObjectByName("Generator");
      const sandBarriers = radar.mesh.getObjectByName("SandBarriers");
      const healthBar = radar.mesh.getObjectByName("RadarHealthBar");

      expect(technicalBuilding).toBeDefined();
      expect(radarYawPivot).toBeDefined();
      expect(largeRadarDish).toBeDefined();
      expect(secondaryAntenna).toBeDefined();
      expect(cabinet01).toBeDefined();
      expect(cabinet02).toBeDefined();
      expect(generator).toBeDefined();
      expect(sandBarriers).toBeDefined();
      expect(healthBar).toBeDefined();
      expect(radar.warningLights.length).toBe(4);

      // Target point is elevated around the central dish/building
      expect(radar.targetPoint.y).toBeCloseTo(2 + 4.2, 1);
    });

    it("rotates radar dish on update and remains firmly on ground without vertical bobbing", () => {
      const radar = new Objective(scene, world, 0, 3, -100, ObjectiveType.RADAR_TOWER);
      const initialDishYaw = radar.radarYawPivot?.rotation.y ?? 0;

      radar.update(1.0, 0.1);

      // Sits firmly on terrain height (no bobbing)
      expect(radar.mesh.position.y).toBe(3);
      // Dish rotates
      expect(radar.radarYawPivot?.rotation.y).toBeGreaterThan(initialDishYaw);
    });

    it("displays health bar when targeted or recently damaged", () => {
      const radar = new Objective(scene, world, 0, 2, -100, ObjectiveType.RADAR_TOWER);
      expect(radar.samHealthBar?.visible).toBe(false);

      radar.setTargeted(true);
      radar.update(0.5, 0.016);
      expect(radar.samHealthBar?.visible).toBe(true);

      // Reset targeted and verify damage flash keeps it visible
      radar.setTargeted(false);
      radar.recentHitTimer = 0.5;
      radar.update(0.6, 0.016);
      expect(radar.samHealthBar?.visible).toBe(true);
    });
  });

  describe("Step 4 & 5: Radar Tactical Synergy & SAM Support", () => {
    it("boosts SAM lock speed by 1.2x when radar is alive and in range", () => {
      const sam = new Objective(scene, world, 0, 2, -100, ObjectiveType.SAM_SITE);
      // Place target directly forward from SAM inside fire envelope (60m distance)
      const target = new CANNON.Vec3(0, 15, -40);

      // Standard lock without radar
      sam.updateSam(target, 1.0, 0.1, 4, { radarSupported: false });
      const normalLock = sam.samLockProgress;

      // Reset SAM state machine
      const samWithRadar = new Objective(scene, world, 0, 2, -100, ObjectiveType.SAM_SITE);
      samWithRadar.updateSam(target, 1.0, 0.1, 4, { radarSupported: true });
      const boostedLock = samWithRadar.samLockProgress;

      expect(boostedLock).toBeGreaterThan(normalLock);
      expect(boostedLock / normalLock).toBeCloseTo(1.2, 1);
    });
  });

  describe("Step 8, 9 & 10: Radar Mission Flow, Reward & Single Bonus Objective", () => {
    it("generates Destroy Radar Station mission with single bonus 'Take no SAM missile damage'", () => {
      const missionMgr = new MissionManager();
      const context = {
        wave: 3,
        threat: 2,
        player: { x: 0, y: 15, z: 0 },
        sams: [],
        radars: [{ id: "radar-1", x: -20, z: -200 }],
        delivery: null,
      };

      const mission = missionMgr.tryGenerate(10.0, context);
      expect(mission).not.toBeNull();
      expect(mission?.type).toBe(MissionType.DESTROY_RADAR);
      expect(mission?.title).toBe("Destroy Radar Station");
      expect(mission?.reward.credits).toBeGreaterThanOrEqual(350);

      // Exactly one bonus objective
      expect(mission?.bonusObjectives.length).toBe(1);
      expect(mission?.bonusObjectives[0].type).toBe(BonusObjectiveType.NO_MISSILE_DAMAGE);
      expect(mission?.bonusObjectives[0].label).toBe("Take no SAM missile damage");
    });

    it("completes mission and awards bonus when radar is destroyed without taking SAM damage", () => {
      const missionMgr = new MissionManager();
      const context = {
        wave: 3,
        threat: 2,
        player: { x: 0, y: 15, z: 0 },
        sams: [],
        radars: [{ id: "radar-1", x: 0, z: -150 }],
        delivery: null,
      };

      const mission = missionMgr.tryGenerate(10.0, context)!;
      expect(mission.state).toBe(MissionState.ACTIVE);

      // Destroy radar
      missionMgr.reportObjectiveDestroyed("radar-1", "RADAR", 12.0, { player: { x: 0, y: 15, z: 0 }, healthRatio: 1.0, carryingCargo: false });

      expect(mission.state).toBe(MissionState.COMPLETE);
      expect(mission.bonusObjectives[0].state).toBe("COMPLETE");
    });

    it("completes mission even if bonus objective fails from SAM missile damage", () => {
      const missionMgr = new MissionManager();
      const context = {
        wave: 4,
        threat: 2,
        player: { x: 0, y: 15, z: 0 },
        sams: [],
        radars: [{ id: "radar-1", x: 0, z: -150 }],
        delivery: null,
      };

      const mission = missionMgr.tryGenerate(10.0, context)!;

      // Player takes SAM missile damage
      missionMgr.reportPlayerDamage("SAM_MISSILE");
      expect(mission.bonusObjectives[0].state).toBe("FAILED");
      expect(mission.state).toBe(MissionState.ACTIVE); // Mission itself is not failed

      // Player destroys radar afterwards
      missionMgr.reportObjectiveDestroyed("radar-1", "RADAR", 15.0, { player: { x: 0, y: 15, z: 0 }, healthRatio: 0.6, carryingCargo: false });

      expect(mission.state).toBe(MissionState.COMPLETE); // Primary mission succeeds
      expect(mission.bonusObjectives[0].state).toBe("FAILED"); // Bonus failed
    });
  });

  describe("Step 12–16: Ground Encounter Composition Templates A through H", () => {
    it("contains all templates A through H with correct unit compositions", () => {
      const templateMap = new Map(GROUND_COMPOSITIONS.map((c) => [c.templateId, c]));

      expect(templateMap.has("A")).toBe(true);
      expect(templateMap.has("B")).toBe(true);
      expect(templateMap.has("C")).toBe(true);
      expect(templateMap.has("D")).toBe(true);
      expect(templateMap.has("E")).toBe(true);
      expect(templateMap.has("F")).toBe(true);
      expect(templateMap.has("G")).toBe(true);
      expect(templateMap.has("H")).toBe(true);

      // A: 2 Infantry
      const compA = templateMap.get("A")!;
      expect(compA.infantry).toBe(2);
      expect(compA.tanks).toBe(0);
      expect(compA.sam).toBe(0);
      expect(compA.radar).toBe(0);

      // B: 1 Tank + 2 Infantry
      const compB = templateMap.get("B")!;
      expect(compB.infantry).toBe(2);
      expect(compB.tanks).toBe(1);

      // C: 3 Tanks
      const compC = templateMap.get("C")!;
      expect(compC.tanks).toBe(3);
      expect(compC.infantry).toBe(0);

      // D: 1 SAM + 1 Tank + 1 Infantry
      const compD = templateMap.get("D")!;
      expect(compD.sam).toBe(1);
      expect(compD.tanks).toBe(1);
      expect(compD.infantry).toBe(1);

      // E: 1 SAM + 3 Tanks
      const compE = templateMap.get("E")!;
      expect(compE.sam).toBe(1);
      expect(compE.tanks).toBe(3);

      // F: Radar + 2 Infantry
      const compF = templateMap.get("F")!;
      expect(compF.radar).toBe(1);
      expect(compF.infantry).toBe(2);

      // G: Radar + 1 Tank + 2 Infantry
      const compG = templateMap.get("G")!;
      expect(compG.radar).toBe(1);
      expect(compG.tanks).toBe(1);
      expect(compG.infantry).toBe(2);

      // H: Radar + 1 SAM + 1 Tank + 2 Infantry
      const compH = templateMap.get("H")!;
      expect(compH.radar).toBe(1);
      expect(compH.sam).toBe(1);
      expect(compH.tanks).toBe(1);
      expect(compH.infantry).toBe(2);
    });

    it("restricts Wave 1 to Infantry only (Template A)", () => {
      for (let i = 0; i < 20; i++) {
        const comp = pickGroundComposition(1, () => Math.random());
        expect(comp.templateId).toBe("A");
        expect(comp.tanks).toBe(0);
        expect(comp.sam).toBe(0);
        expect(comp.radar).toBe(0);
      }
    });

    it("allows Armored Patrol on Wave 2 (Templates A and B)", () => {
      const picked = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const comp = pickGroundComposition(2, () => Math.random());
        picked.add(comp.templateId);
      }
      expect(picked.has("A") || picked.has("B")).toBe(true);
      // Templates D, E, H (SAM) must not appear in Wave 2
      expect(picked.has("D")).toBe(false);
      expect(picked.has("E")).toBe(false);
      expect(picked.has("H")).toBe(false);
    });

    it("allows Radar compound templates starting in Wave 3 and SAM starting in Wave 4", () => {
      const wave3Templates = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const comp = pickGroundComposition(3, () => Math.random());
        wave3Templates.add(comp.templateId);
      }
      expect(wave3Templates.has("F")).toBe(true); // Radar light defense allowed

      const wave4Templates = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const comp = pickGroundComposition(4, () => Math.random());
        wave4Templates.add(comp.templateId);
      }
      expect(wave4Templates.has("D") || wave4Templates.has("G")).toBe(true); // SAM / Radar armored defense
    });
  });
});
