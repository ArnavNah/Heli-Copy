export enum MissionType {
  DESTROY_SAM = "DESTROY_SAM",
  DESTROY_RADAR = "DESTROY_RADAR",
  DELIVERY = "DELIVERY",
  HIGH_VALUE_TARGET = "HIGH_VALUE_TARGET",
  CLEAR_AIRSPACE = "CLEAR_AIRSPACE",
  DEFEND = "DEFEND",
}

export enum MissionState {
  AVAILABLE = "AVAILABLE",
  ACTIVE = "ACTIVE",
  COMPLETE = "COMPLETE",
  FAILED = "FAILED",
}

export enum BonusObjectiveType {
  NO_MISSILE_DAMAGE = "NO_MISSILE_DAMAGE",
  TIME_LIMIT = "TIME_LIMIT",
  HEALTH_ABOVE_50 = "HEALTH_ABOVE_50",
  CARGO_KILLS = "CARGO_KILLS",
}

export interface MissionReward {
  credits: number;
  xp: number;
  salvage: number;
  countermeasures?: number;
  repair?: number;
}

export interface MissionBonus {
  type: BonusObjectiveType;
  label: string;
  state: "ACTIVE" | "COMPLETE" | "FAILED";
  progress: number;
  targetProgress: number;
  deadline?: number;
  reward: MissionReward;
}

export interface MissionPosition { x: number; y?: number; z: number }

export interface Mission {
  id: string;
  type: MissionType;
  state: MissionState;
  title: string;
  targetId?: string;
  targetKind?: "SAM" | "RADAR" | "DELIVERY" | "ELITE" | "AREA";
  origin?: MissionPosition;
  destination?: MissionPosition;
  progress: number;
  targetProgress: number;
  reward: MissionReward;
  bonusObjectives: MissionBonus[];
  startedAt: number;
  rewardGranted: boolean;
}

export interface MissionCandidate extends MissionPosition {
  id: string;
}

export interface MissionGenerationContext {
  wave: number;
  threat: number;
  player: MissionPosition;
  sams: MissionCandidate[];
  radars: MissionCandidate[];
  delivery?: MissionCandidate | null;
}

export interface MissionRuntimeSnapshot {
  player: MissionPosition;
  healthRatio: number;
  carryingCargo: boolean;
}

export interface MissionHudSnapshot {
  id: string;
  type: MissionType;
  title: string;
  progress: number;
  targetProgress: number;
  rewardCredits: number;
  rewardSalvage: number;
  bonus: { label: string; state: MissionBonus["state"]; progress: number; targetProgress: number; rewardCredits: number } | null;
}

const ZERO_REWARD: MissionReward = { credits: 0, xp: 0, salvage: 0 };

function reward(credits: number, xp: number, salvage: number, extra: Partial<MissionReward> = {}): MissionReward {
  return { credits, xp, salvage, ...extra };
}

function bonus(type: BonusObjectiveType, label: string, targetProgress: number, rewardValue: MissionReward, deadline?: number): MissionBonus {
  return { type, label, state: "ACTIVE", progress: 0, targetProgress, reward: rewardValue, deadline };
}

export class MissionManager {
  activeMission: Mission | null = null;
  lastMission: Mission | null = null;
  private sequence = 0;
  private nextMissionAt = 8;
  private completedQueue: Mission[] = [];
  private claimed = new Set<string>();

  reset() {
    this.activeMission = null;
    this.lastMission = null;
    this.sequence = 0;
    this.nextMissionAt = 8;
    this.completedQueue.length = 0;
    this.claimed.clear();
  }

  tryGenerate(time: number, context: MissionGenerationContext): Mission | null {
    if (this.activeMission || time < this.nextMissionAt || context.wave <= 0) return null;
    const available: MissionType[] = [];
    if (context.sams.length) available.push(MissionType.DESTROY_SAM);
    if (context.radars.length) available.push(MissionType.DESTROY_RADAR);
    if (context.delivery) available.push(MissionType.DELIVERY);
    available.push(MissionType.HIGH_VALUE_TARGET, MissionType.CLEAR_AIRSPACE, MissionType.DEFEND);
    const desired = [
      MissionType.DESTROY_SAM,
      MissionType.DESTROY_RADAR,
      MissionType.HIGH_VALUE_TARGET,
      MissionType.CLEAR_AIRSPACE,
      MissionType.DEFEND,
      MissionType.DELIVERY,
    ][this.sequence % 6];
    const type = available.includes(desired) ? desired : available[this.sequence % available.length];
    const id = `mission-${++this.sequence}`;
    const scale = Math.min(1.45, 1 + Math.max(0, context.wave - 1) * 0.035 + Math.max(0, context.threat - 1) * 0.04);
    const make = (partial: Omit<Mission, "id" | "state" | "progress" | "startedAt" | "rewardGranted">): Mission => ({
      id,
      state: MissionState.ACTIVE,
      progress: 0,
      startedAt: time,
      rewardGranted: false,
      ...partial,
    });
    let mission: Mission;
    if (type === MissionType.DESTROY_SAM) {
      const target = context.sams[0];
      mission = make({ type, title: "Destroy SAM Battery", targetId: target.id, targetKind: "SAM", destination: target, targetProgress: 1,
        reward: reward(Math.round(300 * scale), 18, 2), bonusObjectives: [bonus(BonusObjectiveType.NO_MISSILE_DAMAGE, "Take no SAM missile damage", 1, reward(100, 0, 1))] });
    } else if (type === MissionType.DESTROY_RADAR) {
      const target = context.radars[0];
      mission = make({ type, title: "Destroy Radar Uplink", targetId: target.id, targetKind: "RADAR", destination: target, targetProgress: 1,
        reward: reward(Math.round(280 * scale), 16, 2), bonusObjectives: [bonus(BonusObjectiveType.TIME_LIMIT, "Destroy before uplink relocates", 1, reward(90, 0, 1), time + 55)] });
    } else if (type === MissionType.DELIVERY && context.delivery) {
      const target = context.delivery;
      mission = make({ type, title: "Complete Cargo Run", targetId: target.id, targetKind: "DELIVERY", destination: target, targetProgress: 1,
        reward: reward(0, 12, 2), bonusObjectives: [bonus(BonusObjectiveType.CARGO_KILLS, "Destroy 10 enemies while carrying", 10, reward(80, 0, 1))] });
    } else if (type === MissionType.HIGH_VALUE_TARGET) {
      const targetId = `${id}-hvt`;
      const destination = { x: context.player.x + (this.sequence % 2 ? 88 : -88), y: context.player.y, z: context.player.z - 175 };
      mission = make({ type, title: "Eliminate High Value Target", targetId, targetKind: "ELITE", destination, targetProgress: 1,
        reward: reward(Math.round(360 * scale), 24, 3, { countermeasures: 1 }), bonusObjectives: [bonus(BonusObjectiveType.TIME_LIMIT, "Eliminate target before escape", 1, reward(120, 0, 1), time + 65)] });
    } else if (type === MissionType.CLEAR_AIRSPACE) {
      const targetProgress = 8 + Math.min(5, Math.floor(context.wave / 3));
      mission = make({ type, title: "Clear Hostile Airspace", targetKind: "AREA", destination: { x: context.player.x, y: context.player.y, z: context.player.z - 150 }, targetProgress,
        reward: reward(Math.round(240 * scale), 20, 2), bonusObjectives: [bonus(BonusObjectiveType.HEALTH_ABOVE_50, "Finish above 50% hull", 1, reward(75, 0, 1))] });
    } else {
      const origin = { x: context.player.x + (this.sequence % 2 ? 64 : -64), y: context.player.y, z: context.player.z - 145 };
      mission = make({ type: MissionType.DEFEND, title: "Defend Forward Beacon", targetKind: "AREA", origin, destination: origin, targetProgress: 25,
        reward: reward(Math.round(320 * scale), 22, 3, { repair: 12 }), bonusObjectives: [bonus(BonusObjectiveType.HEALTH_ABOVE_50, "Hold above 50% hull", 1, reward(90, 0, 1))] });
    }
    this.activeMission = mission;
    return mission;
  }

  update(time: number, delta: number, snapshot: MissionRuntimeSnapshot) {
    const mission = this.activeMission;
    if (!mission || mission.state !== MissionState.ACTIVE) return;
    for (const objective of mission.bonusObjectives) {
      if (objective.state === "ACTIVE" && objective.deadline !== undefined && time > objective.deadline) objective.state = "FAILED";
    }
    if (mission.type === MissionType.DEFEND && mission.origin) {
      const inside = Math.hypot(snapshot.player.x - mission.origin.x, snapshot.player.z - mission.origin.z) <= 34;
      if (inside) mission.progress = Math.min(mission.targetProgress, mission.progress + Math.max(0, delta));
      if (mission.progress >= mission.targetProgress) this.complete(time, snapshot);
    }
  }

  reportObjectiveDestroyed(targetId: string, kind: "SAM" | "RADAR", time: number, snapshot: MissionRuntimeSnapshot) {
    const mission = this.activeMission;
    if (!mission || mission.targetId !== targetId) return false;
    if ((kind === "SAM" && mission.type !== MissionType.DESTROY_SAM) || (kind === "RADAR" && mission.type !== MissionType.DESTROY_RADAR)) return false;
    mission.progress = 1;
    this.complete(time, snapshot);
    return true;
  }

  reportEnemyDestroyed(
    targetId: string | undefined,
    isElite: boolean,
    time: number,
    snapshot: MissionRuntimeSnapshot,
    enemyPosition?: MissionPosition,
  ) {
    const mission = this.activeMission;
    if (!mission) return false;
    if (mission.type === MissionType.HIGH_VALUE_TARGET && isElite && targetId === mission.targetId) {
      mission.progress = 1;
      this.complete(time, snapshot);
      return true;
    }
    if (
      mission.type === MissionType.CLEAR_AIRSPACE &&
      mission.destination && enemyPosition &&
      Math.hypot(enemyPosition.x - mission.destination.x, enemyPosition.z - mission.destination.z) <= 140
    ) {
      mission.progress = Math.min(mission.targetProgress, mission.progress + 1);
      if (mission.progress >= mission.targetProgress) this.complete(time, snapshot);
    }
    if (mission.type === MissionType.DELIVERY && snapshot.carryingCargo) {
      const cargoBonus = mission.bonusObjectives.find((item) => item.type === BonusObjectiveType.CARGO_KILLS && item.state === "ACTIVE");
      if (cargoBonus) {
        cargoBonus.progress = Math.min(cargoBonus.targetProgress, cargoBonus.progress + 1);
        if (cargoBonus.progress >= cargoBonus.targetProgress) cargoBonus.state = "COMPLETE";
      }
    }
    return false;
  }

  reportDeliveryComplete(contractId: string, time: number, snapshot: MissionRuntimeSnapshot) {
    const mission = this.activeMission;
    if (!mission || mission.type !== MissionType.DELIVERY || mission.targetId !== contractId) return false;
    mission.progress = 1;
    this.complete(time, snapshot);
    return true;
  }

  reportPlayerDamage(source: "SAM_MISSILE" | "OTHER") {
    const mission = this.activeMission;
    if (!mission || source !== "SAM_MISSILE") return;
    for (const objective of mission.bonusObjectives) {
      if (objective.type === BonusObjectiveType.NO_MISSILE_DAMAGE && objective.state === "ACTIVE") objective.state = "FAILED";
    }
  }

  reportTargetLost(targetId: string) {
    const mission = this.activeMission;
    if (!mission || mission.targetId !== targetId || mission.state !== MissionState.ACTIVE) return;
    mission.state = MissionState.FAILED;
    this.lastMission = mission;
    this.activeMission = null;
    this.nextMissionAt = mission.startedAt + 12;
  }

  failActive(missionId: string, time = 0): boolean {
    const mission = this.activeMission;
    if (!mission || mission.id !== missionId || mission.state !== MissionState.ACTIVE) return false;
    mission.state = MissionState.FAILED;
    this.lastMission = mission;
    this.activeMission = null;
    this.nextMissionAt = Math.max(time, mission.startedAt) + 12;
    return true;
  }

  private complete(time: number, snapshot: MissionRuntimeSnapshot) {
    const mission = this.activeMission;
    if (!mission || mission.state !== MissionState.ACTIVE) return;
    for (const objective of mission.bonusObjectives) {
      if (objective.state !== "ACTIVE") continue;
      if (objective.type === BonusObjectiveType.HEALTH_ABOVE_50) objective.state = snapshot.healthRatio > 0.5 ? "COMPLETE" : "FAILED";
      else if (objective.type === BonusObjectiveType.TIME_LIMIT) objective.state = objective.deadline === undefined || time <= objective.deadline ? "COMPLETE" : "FAILED";
      else if (objective.type === BonusObjectiveType.NO_MISSILE_DAMAGE) objective.state = "COMPLETE";
      else if (objective.progress >= objective.targetProgress) objective.state = "COMPLETE";
      else objective.state = "FAILED";
    }
    mission.state = MissionState.COMPLETE;
    this.completedQueue.push(mission);
    this.lastMission = mission;
    this.activeMission = null;
    this.nextMissionAt = time + 20;
  }

  takeCompleted(): Mission | null {
    return this.completedQueue.shift() ?? null;
  }

  claimReward(mission: Mission): { main: MissionReward; bonus: MissionReward } | null {
    if (mission.state !== MissionState.COMPLETE || mission.rewardGranted || this.claimed.has(mission.id)) return null;
    mission.rewardGranted = true;
    this.claimed.add(mission.id);
    const earned = mission.bonusObjectives.filter((item) => item.state === "COMPLETE");
    const bonusReward = earned.reduce<MissionReward>((total, item) => ({
      credits: total.credits + item.reward.credits,
      xp: total.xp + item.reward.xp,
      salvage: total.salvage + item.reward.salvage,
      countermeasures: (total.countermeasures ?? 0) + (item.reward.countermeasures ?? 0),
      repair: (total.repair ?? 0) + (item.reward.repair ?? 0),
    }), { ...ZERO_REWARD });
    return { main: mission.reward, bonus: bonusReward };
  }

  getHudSnapshot(): MissionHudSnapshot | null {
    const mission = this.activeMission;
    if (!mission) return null;
    const optional = mission.bonusObjectives[0] ?? null;
    return {
      id: mission.id,
      type: mission.type,
      title: mission.title,
      progress: mission.progress,
      targetProgress: mission.targetProgress,
      rewardCredits: mission.reward.credits,
      rewardSalvage: mission.reward.salvage,
      bonus: optional ? { label: optional.label, state: optional.state, progress: optional.progress, targetProgress: optional.targetProgress, rewardCredits: optional.reward.credits } : null,
    };
  }
}
