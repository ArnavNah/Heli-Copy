import { describe, expect, it } from "vitest";
import { BonusObjectiveType, MissionManager, MissionState, MissionType } from "./mission";

const runtime = (healthRatio = 1, carryingCargo = false) => ({ player: { x: 0, y: 20, z: 0 }, healthRatio, carryingCargo });
const context = (wave = 1) => ({
  wave,
  threat: 1,
  player: { x: 0, y: 20, z: 0 },
  sams: [{ id: "sam-1", x: 70, y: 8, z: -150 }],
  radars: [{ id: "radar-1", x: -70, y: 8, z: -170 }],
  delivery: { id: "delivery-1", x: 90, y: 0, z: -220 },
});

function generateType(type: MissionType) {
  const manager = new MissionManager();
  let mission = null;
  for (let i = 0; i < 6; i++) {
    mission = manager.tryGenerate(10 + i * 40, context(4));
    if (mission?.type === type) return { manager, mission };
    if (mission) manager.failActive(mission.id, 10 + i * 40);
  }
  throw new Error(`Mission ${type} was not generated`);
}

describe("MissionManager", () => {
  it("runs the six reusable mission types with one active mission", () => {
    const expected = [MissionType.DESTROY_SAM, MissionType.DESTROY_RADAR, MissionType.HIGH_VALUE_TARGET, MissionType.CLEAR_AIRSPACE, MissionType.DEFEND, MissionType.DELIVERY];
    const manager = new MissionManager();
    const found: MissionType[] = [];
    for (let i = 0; i < 6; i++) {
      const mission = manager.tryGenerate(10 + i * 40, context(5));
      expect(mission).toBeTruthy();
      found.push(mission!.type);
      expect(manager.tryGenerate(11 + i * 40, context(5))).toBeNull();
      manager.failActive(mission!.id, 10 + i * 40);
    }
    expect(found).toEqual(expected);
  });

  it("completes SAM and Radar missions only for their assigned target", () => {
    const sam = generateType(MissionType.DESTROY_SAM);
    expect(sam.manager.reportObjectiveDestroyed("wrong", "SAM", 20, runtime())).toBe(false);
    expect(sam.manager.reportObjectiveDestroyed("sam-1", "SAM", 20, runtime())).toBe(true);
    expect(sam.mission.state).toBe(MissionState.COMPLETE);

    const radar = generateType(MissionType.DESTROY_RADAR);
    expect(radar.manager.reportObjectiveDestroyed("radar-1", "RADAR", 30, runtime())).toBe(true);
    expect(radar.mission.state).toBe(MissionState.COMPLETE);
  });

  it("supports delivery, high-value target, clear-airspace and defend completion", () => {
    const delivery = generateType(MissionType.DELIVERY);
    expect(delivery.manager.reportDeliveryComplete("delivery-1", 50, runtime())).toBe(true);

    const hvt = generateType(MissionType.HIGH_VALUE_TARGET);
    hvt.manager.reportEnemyDestroyed(hvt.mission.targetId, true, 30, runtime());
    expect(hvt.mission.state).toBe(MissionState.COMPLETE);

    const clear = generateType(MissionType.CLEAR_AIRSPACE);
    for (let i = 0; i < clear.mission.targetProgress; i++) clear.manager.reportEnemyDestroyed(undefined, false, 25, runtime(), clear.mission.destination);
    expect(clear.mission.state).toBe(MissionState.COMPLETE);

    const defend = generateType(MissionType.DEFEND);
    const inside = { ...runtime(), player: { ...defend.mission.origin! } };
    defend.manager.update(40, defend.mission.targetProgress, inside);
    expect(defend.mission.state).toBe(MissionState.COMPLETE);
  });

  it("fails an optional bonus without failing the main mission", () => {
    const { manager, mission } = generateType(MissionType.DESTROY_SAM);
    manager.reportPlayerDamage("SAM_MISSILE");
    expect(mission.bonusObjectives[0].state).toBe("FAILED");
    expect(mission.state).toBe(MissionState.ACTIVE);
    manager.reportObjectiveDestroyed("sam-1", "SAM", 25, runtime());
    expect(mission.state).toBe(MissionState.COMPLETE);
    expect(manager.claimReward(mission)!.bonus.credits).toBe(0);
  });

  it("completes cargo-kill bonus and prevents duplicate reward claims", () => {
    const { manager, mission } = generateType(MissionType.DELIVERY);
    for (let i = 0; i < 10; i++) manager.reportEnemyDestroyed(undefined, false, 20, runtime(1, true));
    expect(mission.bonusObjectives.find((item) => item.type === BonusObjectiveType.CARGO_KILLS)?.state).toBe("COMPLETE");
    manager.reportDeliveryComplete("delivery-1", 30, runtime());
    expect(manager.claimReward(mission)).not.toBeNull();
    expect(manager.claimReward(mission)).toBeNull();
  });

  it("keeps mission state bounded through a deterministic ten-minute simulation", () => {
    const manager = new MissionManager();
    let completions = 0;
    for (let time = 0; time <= 600; time++) {
      const mission = manager.tryGenerate(time, context(8));
      const active = mission ?? manager.activeMission;
      if (active?.type === MissionType.DESTROY_SAM) manager.reportObjectiveDestroyed("sam-1", "SAM", time, runtime());
      else if (active?.type === MissionType.DESTROY_RADAR) manager.reportObjectiveDestroyed("radar-1", "RADAR", time, runtime());
      else if (active?.type === MissionType.HIGH_VALUE_TARGET) manager.reportEnemyDestroyed(active.targetId, true, time, runtime());
      else if (active?.type === MissionType.CLEAR_AIRSPACE) manager.reportEnemyDestroyed(undefined, false, time, runtime(), active.destination);
      else if (active?.type === MissionType.DEFEND) manager.update(time, 1, { ...runtime(), player: { ...active.origin! } });
      else if (active?.type === MissionType.DELIVERY) manager.reportDeliveryComplete("delivery-1", time, runtime());
      let completed = manager.takeCompleted();
      while (completed) {
        expect(manager.claimReward(completed)).not.toBeNull();
        expect(manager.claimReward(completed)).toBeNull();
        completions++;
        completed = manager.takeCompleted();
      }
      expect(manager.activeMission === null || manager.activeMission.state === MissionState.ACTIVE).toBe(true);
    }
    expect(completions).toBeGreaterThan(10);
  });
});
