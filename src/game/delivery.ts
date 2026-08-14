import * as THREE from "three";
import { createBox, createGlowBox, createGlowMaterial, disposeObject3D } from "./materials";
import { districtForChunk } from "./logic";
import type { DistrictName } from "./logic";

export enum CargoType {
  MEDICAL_SUPPLIES = "MEDICAL_SUPPLIES",
  AMMUNITION = "AMMUNITION",
  FUEL = "FUEL",
  ELECTRONICS = "ELECTRONICS",
  MACHINE_PARTS = "MACHINE_PARTS",
  MILITARY_SUPPLIES = "MILITARY_SUPPLIES",
}

export enum CargoState {
  WAITING = "WAITING",
  LOADING = "LOADING",
  ATTACHED = "ATTACHED",
  UNLOADING = "UNLOADING",
  DELIVERED = "DELIVERED",
}

export enum DeliveryState {
  AVAILABLE = "AVAILABLE",
  ACCEPTED = "ACCEPTED",
  PICKUP_READY = "PICKUP_READY",
  CARRYING = "CARRYING",
  DELIVERING = "DELIVERING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

export type ContractDifficulty = "STANDARD" | "RISKY" | "HIGH_VALUE";

export interface WorldPosition {
  x: number;
  y: number;
  z: number;
}

export interface DepotHub {
  id: string;
  chunkId: number;
  district: DistrictName;
  displayName: string;
  position: WorldPosition;
  loadingRadius: number;
}

export interface CargoDefinition {
  displayName: string;
  icon: string;
  color: number;
  baseValue: number;
  riskModifier: number;
}

export interface DeliveryContract {
  id: string;
  cargoType: CargoType;
  cargoState: CargoState;
  originDepotId: string;
  destinationDepotId: string;
  originPosition: WorldPosition;
  destinationPosition: WorldPosition;
  originDistrict: DistrictName;
  destinationDistrict: DistrictName;
  destinationName: string;
  distance: number;
  baseReward: number;
  bonusReward: number;
  timeLimit?: number;
  difficulty: ContractDifficulty;
  state: DeliveryState;
  acceptedTime?: number;
  pickupTime?: number;
  cargoHealth?: number;
  rewardCredits: number;
  samExposure: boolean;
  samRiskBonus: number;
}

export interface DeliveryHudSnapshot {
  state: DeliveryState;
  cargoName: string;
  cargoIcon: string;
  difficulty: ContractDifficulty;
  action: "PICKUP" | "DELIVER" | "COMPLETE";
  destinationName: string;
  distance: number;
  reward: number;
  samRiskBonus: number;
  timeBonusRemaining: number | null;
  progress: number;
  bearing: number;
}

export interface HangarUpgrades {
  armor: number;
  fuelSystems: number;
  cargoRig: number;
  countermeasures: number;
}

export type HangarUpgradeId = keyof HangarUpgrades;

export const HANGAR_UPGRADE_INFO: Record<
  HangarUpgradeId,
  { name: string; description: string; costs: number[] }
> = {
  armor: {
    name: "Reinforced Armor",
    description: "+10 maximum hull integrity per rank",
    costs: [300, 650, 1100],
  },
  fuelSystems: {
    name: "Efficient Turbines",
    description: "6% lower fuel consumption per rank",
    costs: [250, 550, 950],
  },
  cargoRig: {
    name: "Cargo Stabilizer",
    description: "Reduces the cargo handling penalty",
    costs: [275, 600, 1000],
  },
  countermeasures: {
    name: "Countermeasures",
    description: "Improves flare capacity, cooldown, and decoy effectiveness",
    costs: [220, 450, 800, 1250, 1850],
  },
};

export const CARGO_DEFINITIONS: Record<CargoType, CargoDefinition> = {
  [CargoType.MEDICAL_SUPPLIES]: {
    displayName: "Medical Supplies",
    icon: "+",
    color: 0xff5d73,
    baseValue: 150,
    riskModifier: 1.05,
  },
  [CargoType.AMMUNITION]: {
    displayName: "Ammunition",
    icon: "AM",
    color: 0xffb23f,
    baseValue: 170,
    riskModifier: 1.12,
  },
  [CargoType.FUEL]: {
    displayName: "Aviation Fuel",
    icon: "FL",
    color: 0xffd23f,
    baseValue: 160,
    riskModifier: 1.16,
  },
  [CargoType.ELECTRONICS]: {
    displayName: "Electronics",
    icon: "EL",
    color: 0x68e5ff,
    baseValue: 215,
    riskModifier: 1.08,
  },
  [CargoType.MACHINE_PARTS]: {
    displayName: "Machine Parts",
    icon: "MP",
    color: 0xaab5c4,
    baseValue: 185,
    riskModifier: 1.04,
  },
  [CargoType.MILITARY_SUPPLIES]: {
    displayName: "Military Supplies",
    icon: "MS",
    color: 0x9bd35b,
    baseValue: 245,
    riskModifier: 1.2,
  },
};

export const MIN_DELIVERY_DISTANCE = 320;
export const MAX_DELIVERY_DISTANCE = 1580;
export const PICKUP_HOLD_SECONDS = 1.0;
export const DELIVERY_HOLD_SECONDS = 0.75;
export const CONTRACT_COOLDOWN_SECONDS = 14;
export const BASE_CARGO_MOVEMENT_MULTIPLIER = 0.91;

// Pickup/delivery hit zones are deliberately wider than the marker ring so a
// fast pass doesn't thread the needle; holds decay slowly so brief combat
// drifts don't wipe progress. Contracts that are never completed must not pin
// the player forever, so abandoned pickups expire and over-long carries fail.
export const PICKUP_RADIUS = 22;
export const DELIVERY_RADIUS = 20;
export const CONTRACT_ABANDON_DISTANCE = 520;
export const PICKUP_ABANDON_SECONDS = 60;
export const CARRY_ABANDON_SECONDS = 240;

const CREDIT_STORAGE_KEY = "helistrike:credits";
const UPGRADE_STORAGE_KEY = "helistrike:hangarUpgrades";
const DEFAULT_UPGRADES: HangarUpgrades = { armor: 0, fuelSystems: 0, cargoRig: 0, countermeasures: 0 };

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function setStorageItem(key: string, value: string) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Private browsing / disabled storage should not break a delivery payout.
  }
}

export function readDeliveryCredits(): number {
  const value = Number(storage()?.getItem(CREDIT_STORAGE_KEY) ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function writeDeliveryCredits(credits: number) {
  setStorageItem(CREDIT_STORAGE_KEY, String(Math.max(0, Math.floor(credits))));
}

export function readHangarUpgrades(): HangarUpgrades {
  try {
    const raw = storage()?.getItem(UPGRADE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UPGRADES };
    const parsed = JSON.parse(raw) as Partial<HangarUpgrades>;
    return {
      armor: clampUpgradeRank(parsed.armor),
      fuelSystems: clampUpgradeRank(parsed.fuelSystems),
      cargoRig: clampUpgradeRank(parsed.cargoRig),
      countermeasures: clampUpgradeRank(parsed.countermeasures, 5),
    };
  } catch {
    return { ...DEFAULT_UPGRADES };
  }
}

function clampUpgradeRank(value: unknown, max = 3): number {
  const rank = Number(value);
  return Number.isFinite(rank) ? Math.max(0, Math.min(max, Math.floor(rank))) : 0;
}

export function buyHangarUpgrade(
  credits: number,
  upgrades: HangarUpgrades,
  id: HangarUpgradeId,
): { purchased: boolean; credits: number; upgrades: HangarUpgrades } {
  const rank = clampUpgradeRank(upgrades[id], HANGAR_UPGRADE_INFO[id].costs.length);
  const cost = HANGAR_UPGRADE_INFO[id].costs[rank];
  if (cost === undefined || credits < cost) {
    return { purchased: false, credits, upgrades };
  }
  const next = { ...upgrades, [id]: rank + 1 };
  const nextCredits = credits - cost;
  writeDeliveryCredits(nextCredits);
  setStorageItem(UPGRADE_STORAGE_KEY, JSON.stringify(next));
  return { purchased: true, credits: nextCredits, upgrades: next };
}

export function cargoMovementMultiplier(cargoRigRank: number): number {
  return Math.min(0.98, BASE_CARGO_MOVEMENT_MULTIPLIER + clampUpgradeRank(cargoRigRank) * 0.023);
}

function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x51f15e5d, 0x45d9f3b) ^ Math.imul(b + 0x27d4eb2d, 0x119de1f3);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function depotProbability(district: DistrictName): number {
  switch (district) {
    case "industrial": return 0.94;
    case "waterfront": return 0.98;
    case "midtown": return 0.32;
    case "downtown": return 0.16;
    case "residential": return 0.07;
    case "base": return 0.58;
    case "ruins": return 0.34;
    case "desert": return 0.22;
    case "forest": return 0.06;
  }
}

function isDepotCandidate(chunkId: number): boolean {
  const district = districtForChunk(chunkId);
  return hash(chunkId, 7717) < depotProbability(district);
}

function depotPriority(chunkId: number): number {
  return depotProbability(districtForChunk(chunkId)) * 2 + hash(chunkId, 7721);
}

/**
 * A depot is a pure function of chunk id. The previous-candidate guard prevents
 * adjacent facilities, so unloading a chunk can never erase or move a route endpoint.
 */
export function depotHubForChunk(chunkId: number, chunkDepth = 132): DepotHub | null {
  if (!isDepotCandidate(chunkId)) return null;
  const priority = depotPriority(chunkId);
  if (isDepotCandidate(chunkId - 1) && depotPriority(chunkId - 1) > priority) return null;
  if (isDepotCandidate(chunkId + 1) && depotPriority(chunkId + 1) > priority) return null;
  const district = districtForChunk(chunkId);
  const side = hash(chunkId, 7727) < 0.5 ? -1 : 1;
  const x = side * (72 + Math.round(hash(chunkId, 7739) * 12));
  const localZ = hash(chunkId, 7753) < 0.5 ? -38 : 38;
  const id = `depot-${chunkId}`;
  return {
    id,
    chunkId,
    district,
    displayName: `${districtName(district)} Depot ${Math.abs(chunkId).toString(36).toUpperCase()}`,
    position: { x, y: 0.2, z: chunkId * chunkDepth + localZ },
    loadingRadius: 17,
  };
}

export function districtName(district: DistrictName): string {
  return district.charAt(0).toUpperCase() + district.slice(1);
}

function distanceBetween(a: WorldPosition, b: WorldPosition): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function difficultyFor(wave: number, sequence: number): ContractDifficulty {
  if (wave <= 2) return "STANDARD";
  const roll = hash(sequence + wave * 17, 7919);
  if (wave >= 5 && roll > 0.88) return "HIGH_VALUE";
  if (wave >= 3 && roll > 0.56) return "RISKY";
  return "STANDARD";
}

function cargoFor(sequence: number, difficulty: ContractDifficulty): CargoType {
  if (difficulty === "HIGH_VALUE") {
    return hash(sequence, 7933) < 0.5 ? CargoType.ELECTRONICS : CargoType.MILITARY_SUPPLIES;
  }
  const types = Object.values(CargoType);
  return types[Math.floor(hash(sequence, 7949) * types.length) % types.length];
}

export function createDeliveryContract(
  origin: DepotHub,
  destination: DepotHub,
  wave: number,
  sequence: number,
): DeliveryContract | null {
  if (origin.id === destination.id) return null;
  const distance = distanceBetween(origin.position, destination.position);
  if (distance < MIN_DELIVERY_DISTANCE || distance > MAX_DELIVERY_DISTANCE) return null;
  const difficulty = difficultyFor(wave, sequence);
  const cargoType = cargoFor(sequence, difficulty);
  const cargo = CARGO_DEFINITIONS[cargoType];
  const distanceMultiplier = 1 + Math.min(1.15, distance / 900);
  const difficultyMultiplier = difficulty === "HIGH_VALUE" ? 1.65 : difficulty === "RISKY" ? 1.3 : 1;
  const rewardCredits = Math.round(
    (cargo.baseValue * cargo.riskModifier * distanceMultiplier * difficultyMultiplier) / 10,
  ) * 10;
  const bonusReward = Math.round((rewardCredits * 0.25) / 5) * 5;
  return {
    id: `contract-${sequence}-${origin.chunkId}-${destination.chunkId}`,
    cargoType,
    cargoState: CargoState.WAITING,
    originDepotId: origin.id,
    destinationDepotId: destination.id,
    originPosition: { ...origin.position },
    destinationPosition: { ...destination.position },
    originDistrict: origin.district,
    destinationDistrict: destination.district,
    destinationName: destination.displayName,
    distance: Math.round(distance),
    baseReward: cargo.baseValue,
    bonusReward,
    timeLimit: Math.max(42, Math.round(distance / 42 + 24)),
    difficulty,
    state: DeliveryState.AVAILABLE,
    rewardCredits,
    samExposure: false,
    samRiskBonus: 0,
  };
}

export function findContractForPlayer(
  player: WorldPosition,
  wave: number,
  sequence: number,
  chunkDepth: number,
  getDepot: (chunkId: number) => DepotHub | null,
): DeliveryContract | null {
  const center = Math.floor(player.z / chunkDepth);
  const origins: DepotHub[] = [];
  for (let id = center - 4; id <= center + 2; id++) {
    const depot = getDepot(id);
    if (depot) origins.push(depot);
  }
  origins.sort(
    (a, b) => {
      const aBehindPenalty = a.position.z > player.z + 45 ? 280 : 0;
      const bBehindPenalty = b.position.z > player.z + 45 ? 280 : 0;
      return distanceBetween(player, a.position) + aBehindPenalty
        - (distanceBetween(player, b.position) + bBehindPenalty);
    },
  );
  for (const origin of origins) {
    const destinations: DepotHub[] = [];
    for (let offset = 3; offset <= 12; offset++) {
      const depot = getDepot(origin.chunkId - offset);
      if (!depot) continue;
      const routeDistance = distanceBetween(origin.position, depot.position);
      if (routeDistance >= MIN_DELIVERY_DISTANCE && routeDistance <= MAX_DELIVERY_DISTANCE) {
        destinations.push(depot);
      }
    }
    if (destinations.length === 0) continue;
    const desiredBand = wave <= 2 ? 0 : Math.min(0.85, 0.35 + wave * 0.045);
    destinations.sort((a, b) => distanceBetween(origin.position, a.position) - distanceBetween(origin.position, b.position));
    const index = Math.min(destinations.length - 1, Math.floor(desiredBand * destinations.length));
    return createDeliveryContract(origin, destinations[index], wave, sequence);
  }
  return null;
}

interface DeliveryCallbacks {
  announce: (text: string, sub: string, color: string) => void;
  creditsChanged: (credits: number) => void;
  settleRewards?: (
    contract: DeliveryContract,
    earnedTimeBonus: boolean,
  ) => { secured: number; unsecured: number };
  completed?: (contract: DeliveryContract, secured: number, unsecured: number) => void;
}

export class DeliverySystem {
  activeContract: DeliveryContract | null = null;
  lastContract: DeliveryContract | null = null;
  credits = readDeliveryCredits();
  private sequence = 0;
  private cooldown = 2.5;
  private holdProgress = 0;
  private completedLinger = 0;
  private carrierRoot: THREE.Object3D | null = null;
  private cargoVisual: THREE.Group | null = null;
  private originMarker: THREE.Group | null = null;
  private destinationMarker: THREE.Group | null = null;

  constructor(
    private scene: THREE.Scene,
    private chunkDepth: number,
    private getDepot: (chunkId: number) => DepotHub | null,
    private callbacks: DeliveryCallbacks,
  ) {}

  setCarrierRoot(root: THREE.Object3D) {
    if (this.carrierRoot === root) return;
    this.removeCargoVisual();
    this.carrierRoot = root;
    if (
      this.activeContract &&
      (this.activeContract.state === DeliveryState.CARRYING || this.activeContract.state === DeliveryState.DELIVERING)
    ) {
      this.attachCargoVisual(this.activeContract.cargoType);
    }
  }

  reset() {
    this.clearContractVisuals();
    this.activeContract = null;
    this.lastContract = null;
    this.sequence = 0;
    this.cooldown = 2.5;
    this.holdProgress = 0;
    this.completedLinger = 0;
    this.credits = readDeliveryCredits();
  }

  dispose() {
    this.clearContractVisuals();
    this.activeContract = null;
    this.carrierRoot = null;
  }

  isCarrying(): boolean {
    const state = this.activeContract?.state;
    return state === DeliveryState.CARRYING || state === DeliveryState.DELIVERING;
  }

  /** Add the route-risk bonus once when carried cargo enters a live SAM envelope. */
  markSamExposure(bonus = 80): boolean {
    const contract = this.activeContract;
    if (!contract || !this.isCarrying() || contract.samExposure) return false;
    contract.samExposure = true;
    contract.samRiskBonus = Math.max(0, Math.round(bonus));
    return true;
  }

  awardCredits(amount: number) {
    const award = Math.max(0, Math.round(amount));
    if (award === 0) return;
    this.credits += award;
    writeDeliveryCredits(this.credits);
    this.callbacks.creditsChanged(this.credits);
  }

  fail(reason = "PLAYER DOWN") {
    if (!this.activeContract || this.activeContract.state === DeliveryState.COMPLETED) return;
    if (this.activeContract.state !== DeliveryState.AVAILABLE) {
      this.activeContract.state = DeliveryState.FAILED;
      this.lastContract = this.activeContract;
      this.callbacks.announce("DELIVERY FAILED", reason, "#ff5566");
    }
    this.removeCargoVisual();
    this.hideMarkers();
  }

  update(time: number, delta: number, player: WorldPosition, wave: number) {
    if (!this.activeContract) {
      this.cooldown = Math.max(0, this.cooldown - delta);
      if (this.cooldown === 0) this.offerContract(player, wave);
      return;
    }

    const contract = this.activeContract;
    this.animateMarkers(time, player);
    this.animateCargo(time);

    if (contract.state === DeliveryState.COMPLETED) {
      this.completedLinger -= delta;
      if (this.completedLinger <= 0) {
        this.lastContract = contract;
        this.clearContractVisuals();
        this.activeContract = null;
        this.cooldown = CONTRACT_COOLDOWN_SECONDS;
      }
      return;
    }
    if (contract.state === DeliveryState.FAILED) return;

    const originDistance = distanceBetween(player, contract.originPosition);
    const awaitingPickup =
      contract.state === DeliveryState.AVAILABLE ||
      contract.state === DeliveryState.ACCEPTED ||
      contract.state === DeliveryState.PICKUP_READY;
    // Leaving the pickup area abandons the contract instead of leaving the
    // player permanently stuck after a high-speed overshoot of the depot.
    if (awaitingPickup && originDistance > CONTRACT_ABANDON_DISTANCE) {
      const wasEngaged = contract.state !== DeliveryState.AVAILABLE;
      this.clearContractVisuals();
      this.activeContract = null;
      this.cooldown = wasEngaged ? 2 : 1;
      if (wasEngaged) {
        this.callbacks.announce("CONTRACT EXPIRED", "Return to the pickup zone", "#ffbd3f");
      }
      return;
    }

    if (contract.state === DeliveryState.AVAILABLE && originDistance <= PICKUP_RADIUS) {
      contract.state = DeliveryState.ACCEPTED;
      contract.acceptedTime = time;
      this.holdProgress = 0;
      this.callbacks.announce("CONTRACT ACCEPTED", CARGO_DEFINITIONS[contract.cargoType].displayName, "#ffbd3f");
      return;
    }

    if (contract.state === DeliveryState.ACCEPTED) {
      contract.state = DeliveryState.PICKUP_READY;
      contract.cargoState = CargoState.LOADING;
    }

    // A pickup that is never completed (player hovers at the edge, gets drawn
    // into combat, never fills the bar) must expire so a new contract appears.
    // `awaitingPickup` + acceptedTime set means ACCEPTED/PICKUP_READY only.
    if (
      awaitingPickup &&
      contract.acceptedTime !== undefined &&
      time - contract.acceptedTime > PICKUP_ABANDON_SECONDS
    ) {
      this.clearContractVisuals();
      this.activeContract = null;
      this.cooldown = 2;
      this.callbacks.announce("CONTRACT EXPIRED", "Pickup timed out", "#ffbd3f");
      return;
    }

    if (contract.state === DeliveryState.PICKUP_READY) {
      if (originDistance <= PICKUP_RADIUS) {
        this.holdProgress = Math.min(1, this.holdProgress + delta / PICKUP_HOLD_SECONDS);
      } else {
        this.holdProgress = Math.max(0, this.holdProgress - delta * 0.7);
      }
      if (this.holdProgress >= 1) this.pickupCargo(time, contract);
      return;
    }

    const destinationDistance = distanceBetween(player, contract.destinationPosition);

    // Escape hatch: cargo carried far beyond any deadline (e.g. after
    // overshooting the destination) must not pin the player forever. A generous
    // timeout fails the contract and frees the slot for a new one.
    if (
      (contract.state === DeliveryState.CARRYING || contract.state === DeliveryState.DELIVERING) &&
      contract.pickupTime !== undefined &&
      time - contract.pickupTime > CARRY_ABANDON_SECONDS
    ) {
      contract.state = DeliveryState.FAILED;
      this.lastContract = contract;
      this.removeCargoVisual();
      this.hideMarkers();
      this.activeContract = null;
      this.cooldown = CONTRACT_COOLDOWN_SECONDS;
      this.callbacks.announce("DELIVERY FAILED", "Cargo lost in transit", "#ff5566");
      return;
    }

    if (contract.state === DeliveryState.CARRYING && destinationDistance <= DELIVERY_RADIUS) {
      contract.state = DeliveryState.DELIVERING;
      contract.cargoState = CargoState.UNLOADING;
      this.holdProgress = 0;
      this.callbacks.announce("DESTINATION REACHED", "Hold position", "#55f2c2");
      return;
    }

    if (contract.state === DeliveryState.DELIVERING) {
      if (destinationDistance <= DELIVERY_RADIUS) {
        this.holdProgress = Math.min(1, this.holdProgress + delta / DELIVERY_HOLD_SECONDS);
      } else {
        contract.state = DeliveryState.CARRYING;
        contract.cargoState = CargoState.ATTACHED;
        this.holdProgress = 0;
      }
      if (this.holdProgress >= 1) this.completeDelivery(time, contract);
    }
  }

  getHudSnapshot(player: WorldPosition, time: number): DeliveryHudSnapshot | null {
    const contract = this.activeContract;
    if (!contract || contract.state === DeliveryState.FAILED) return null;
    const cargo = CARGO_DEFINITIONS[contract.cargoType];
    const delivering = contract.state === DeliveryState.CARRYING || contract.state === DeliveryState.DELIVERING;
    const target = delivering ? contract.destinationPosition : contract.originPosition;
    const dx = target.x - player.x;
    const dz = target.z - player.z;
    const bonusRemaining = contract.pickupTime !== undefined && contract.timeLimit !== undefined
      ? Math.max(0, contract.timeLimit - (time - contract.pickupTime))
      : null;
    return {
      state: contract.state,
      cargoName: cargo.displayName,
      cargoIcon: cargo.icon,
      difficulty: contract.difficulty,
      action: contract.state === DeliveryState.COMPLETED ? "COMPLETE" : delivering ? "DELIVER" : "PICKUP",
      destinationName: delivering ? contract.destinationName : districtName(contract.originDistrict) + " Depot",
      distance: Math.round(Math.hypot(dx, dz)),
      reward: contract.rewardCredits + (bonusRemaining !== null && bonusRemaining > 0 ? contract.bonusReward : 0) + contract.samRiskBonus,
      samRiskBonus: contract.samRiskBonus,
      timeBonusRemaining: bonusRemaining,
      progress: this.holdProgress,
      bearing: Math.atan2(dx, -dz) * 180 / Math.PI,
    };
  }

  private offerContract(player: WorldPosition, wave: number) {
    const contract = findContractForPlayer(
      player,
      wave,
      this.sequence++,
      this.chunkDepth,
      this.getDepot,
    );
    if (!contract) {
      this.cooldown = 3;
      return;
    }
    this.activeContract = contract;
    this.holdProgress = 0;
    this.createContractMarkers(contract);
    const cargo = CARGO_DEFINITIONS[contract.cargoType];
    this.callbacks.announce(
      contract.difficulty === "HIGH_VALUE" ? "HIGH VALUE CARGO" : "NEW CONTRACT",
      `${cargo.displayName} - ${contract.rewardCredits + contract.bonusReward} CR`,
      contract.difficulty === "HIGH_VALUE" ? "#d78cff" : "#ffbd3f",
    );
  }

  private pickupCargo(time: number, contract: DeliveryContract) {
    contract.state = DeliveryState.CARRYING;
    contract.cargoState = CargoState.ATTACHED;
    contract.pickupTime = time;
    this.holdProgress = 0;
    this.attachCargoVisual(contract.cargoType);
    const distance = Math.round(
      Math.hypot(contract.destinationPosition.x - contract.originPosition.x, contract.destinationPosition.z - contract.originPosition.z),
    );
    this.callbacks.announce(
      "CARGO LOADED",
      `Fly to ${contract.destinationName} · ${distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${distance} m`} · follow the green beacon`,
      "#55f2c2",
    );
  }

  private completeDelivery(time: number, contract: DeliveryContract) {
    if (contract.state === DeliveryState.COMPLETED) return;
    const earnedBonus =
      contract.pickupTime !== undefined &&
      contract.timeLimit !== undefined &&
      time - contract.pickupTime <= contract.timeLimit;
    const settlement = this.callbacks.settleRewards?.(contract, earnedBonus) ?? {
      secured: contract.rewardCredits + (earnedBonus ? contract.bonusReward : 0) + contract.samRiskBonus,
      unsecured: 0,
    };
    const award = Math.max(0, Math.round(settlement.secured));
    contract.state = DeliveryState.COMPLETED;
    contract.cargoState = CargoState.DELIVERED;
    this.credits += award;
    writeDeliveryCredits(this.credits);
    this.callbacks.creditsChanged(this.credits);
    this.callbacks.completed?.(contract, award, Math.max(0, Math.round(settlement.unsecured)));
    this.removeCargoVisual();
    this.hideMarkers();
    this.holdProgress = 1;
    this.completedLinger = 2.5;
    const rewards = [`+${contract.rewardCredits} CR`];
    if (earnedBonus && contract.bonusReward > 0) rewards.push(`+${contract.bonusReward} time`);
    if (contract.samRiskBonus > 0) rewards.push(`+${contract.samRiskBonus} SAM risk`);
    const breakdown = rewards.join(" ");
    this.callbacks.announce("DELIVERY COMPLETE", breakdown, "#55f2c2");
  }

  private createContractMarkers(contract: DeliveryContract) {
    this.clearContractVisuals();
    this.originMarker = this.createMarker(0xffbd3f, "PICKUP");
    this.originMarker.position.set(contract.originPosition.x, 0.15, contract.originPosition.z);
    this.destinationMarker = this.createMarker(0x55f2c2, "DELIVER");
    this.destinationMarker.position.set(contract.destinationPosition.x, 0.15, contract.destinationPosition.z);
    this.scene.add(this.originMarker, this.destinationMarker);
  }

  private createMarker(color: number, label: string): THREE.Group {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(11.5, 13, 32),
      createGlowMaterial(color, 0.72),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    ring.userData.markerRing = true;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 2.4, 42, 8, 1, true),
      createGlowMaterial(color, 0.2),
    );
    beam.position.y = 21;
    beam.userData.markerBeam = true;
    const cap = createGlowBox(2.2, 0.35, 2.2, color, 0.85);
    cap.position.y = 8;
    cap.userData.markerCap = true;
    const sprite = this.createLabelSprite(label, color);
    sprite.position.y = 30;
    group.add(ring, beam, cap, sprite);
    return group;
  }

  private createLabelSprite(label: string, color: number): THREE.Sprite {
    if (typeof document === "undefined") {
      const material = new THREE.SpriteMaterial({ color, transparent: true, opacity: 0.9 });
      const sprite = new THREE.Sprite(material);
      sprite.name = label;
      sprite.scale.set(20, 5, 1);
      return sprite;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgba(4, 11, 30, 0.86)";
    context.fillRect(2, 2, 252, 60);
    context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.lineWidth = 5;
    context.strokeRect(2, 2, 252, 60);
    context.fillStyle = "white";
    context.font = "900 29px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, 128, 33);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(20, 5, 1);
    return sprite;
  }

  private animateMarkers(time: number, player: WorldPosition) {
    const contract = this.activeContract;
    if (!contract) return;
    const originActive =
      contract.state === DeliveryState.AVAILABLE ||
      contract.state === DeliveryState.ACCEPTED ||
      contract.state === DeliveryState.PICKUP_READY;
    const destinationActive =
      contract.state === DeliveryState.CARRYING || contract.state === DeliveryState.DELIVERING;
    // The pickup ring only needs to read nearby; the destination beacon stays
    // visible across the whole route once cargo is loaded so the player always
    // has a sky marker (42-tall beam + DELIVER label) to fly toward.
    this.animateMarker(this.originMarker, originActive, player, time, 380);
    this.animateMarker(this.destinationMarker, destinationActive, player, time + 0.8, 900);
  }

  private animateMarker(
    marker: THREE.Group | null,
    active: boolean,
    player: WorldPosition,
    time: number,
    range: number,
  ) {
    if (!marker) return;
    const distance = Math.hypot(marker.position.x - player.x, marker.position.z - player.z);
    marker.visible = active && distance < range;
    if (!marker.visible) return;
    const pulse = 1 + Math.sin(time * 4) * 0.08;
    const ring = marker.children.find((child) => child.userData.markerRing);
    const cap = marker.children.find((child) => child.userData.markerCap);
    if (ring) ring.scale.setScalar(pulse);
    if (cap) cap.rotation.y = time * 1.8;
  }

  private hideMarkers() {
    if (this.originMarker) this.originMarker.visible = false;
    if (this.destinationMarker) this.destinationMarker.visible = false;
  }

  private attachCargoVisual(type: CargoType) {
    if (!this.carrierRoot || this.cargoVisual) return;
    const definition = CARGO_DEFINITIONS[type];
    const group = new THREE.Group();
    group.name = "CargoMount";
    group.position.set(0, -2.15, -0.35);
    const pod = createBox(2.25, 1.35, 2.7, definition.color);
    const base = createBox(2.55, 0.22, 3, 0x20242c);
    base.position.y = -0.75;
    const strapA = createBox(0.18, 1.55, 2.85, 0x252b32);
    const strapB = strapA.clone();
    strapA.position.x = -0.72;
    strapB.position.x = 0.72;
    const lamp = createGlowBox(0.35, 0.35, 0.2, definition.color, 0.9);
    lamp.position.set(0, 0, 1.45);
    group.add(pod, base, strapA, strapB, lamp);
    this.carrierRoot.add(group);
    this.cargoVisual = group;
  }

  private animateCargo(time: number) {
    if (!this.cargoVisual) return;
    this.cargoVisual.rotation.z = Math.sin(time * 2.2) * 0.035;
    this.cargoVisual.rotation.x = Math.sin(time * 1.7 + 0.9) * 0.025;
  }

  private removeCargoVisual() {
    if (!this.cargoVisual) return;
    this.cargoVisual.parent?.remove(this.cargoVisual);
    disposeObject3D(this.cargoVisual);
    this.cargoVisual = null;
  }

  private clearContractVisuals() {
    this.removeCargoVisual();
    for (const marker of [this.originMarker, this.destinationMarker]) {
      if (!marker) continue;
      marker.parent?.remove(marker);
      marker.traverse((child) => {
        if (child instanceof THREE.Sprite) child.material.map?.dispose();
      });
      disposeObject3D(marker);
    }
    this.originMarker = null;
    this.destinationMarker = null;
  }
}
