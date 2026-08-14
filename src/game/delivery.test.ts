import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  CargoState,
  CARRY_ABANDON_SECONDS,
  DeliveryState,
  DeliverySystem,
  MAX_DELIVERY_DISTANCE,
  MIN_DELIVERY_DISTANCE,
  HANGAR_UPGRADE_INFO,
  PICKUP_ABANDON_SECONDS,
  buyHangarUpgrade,
  cargoMovementMultiplier,
  createDeliveryContract,
  depotHubForChunk,
  depotProbability,
  findContractForPlayer,
} from "./delivery";

const systems: DeliverySystem[] = [];

afterEach(() => {
  for (const system of systems.splice(0)) system.dispose();
});

function createSystem() {
  const announcements: { text: string; sub: string }[] = [];
  const scene = new THREE.Scene();
  const carrier = new THREE.Group();
  scene.add(carrier);
  const system = new DeliverySystem(
    scene,
    132,
    (chunkId) => depotHubForChunk(chunkId),
    {
      announce: (text, sub) => announcements.push({ text, sub }),
      creditsChanged: () => undefined,
    },
  );
  system.setCarrierRoot(carrier);
  systems.push(system);
  return { system, carrier, announcements };
}

describe("procedural depot registration", () => {
  it("is deterministic and favors cargo-compatible districts", () => {
    expect(depotProbability("industrial")).toBeGreaterThan(depotProbability("midtown"));
    expect(depotProbability("waterfront")).toBeGreaterThan(depotProbability("downtown"));
    expect(depotProbability("downtown")).toBeGreaterThan(depotProbability("residential"));

    for (let chunkId = -40; chunkId <= 40; chunkId++) {
      expect(depotHubForChunk(chunkId)).toEqual(depotHubForChunk(chunkId));
    }
  });

  it("keeps generated facilities separated and clear of the central corridor", () => {
    const depots = [];
    for (let chunkId = -80; chunkId <= 20; chunkId++) {
      const depot = depotHubForChunk(chunkId);
      if (depot) depots.push(depot);
    }
    expect(depots.length).toBeGreaterThan(8);
    for (let i = 0; i < depots.length; i++) {
      expect(Math.abs(depots[i].position.x)).toBeGreaterThanOrEqual(72);
      for (let j = i + 1; j < depots.length; j++) {
        expect(Math.hypot(
          depots[i].position.x - depots[j].position.x,
          depots[i].position.z - depots[j].position.z,
        )).toBeGreaterThan(120);
      }
    }
  });
});

describe("delivery contract generation", () => {
  it("selects distinct valid endpoints with a useful route distance", () => {
    const contract = findContractForPlayer(
      { x: 0, y: 26, z: 0 },
      1,
      0,
      132,
      (chunkId) => depotHubForChunk(chunkId),
    );
    expect(contract).not.toBeNull();
    expect(contract!.originDepotId).not.toBe(contract!.destinationDepotId);
    expect(contract!.distance).toBeGreaterThanOrEqual(MIN_DELIVERY_DISTANCE);
    expect(contract!.distance).toBeLessThanOrEqual(MAX_DELIVERY_DISTANCE);
    expect(contract!.state).toBe(DeliveryState.AVAILABLE);
  });

  it("rejects identical endpoints", () => {
    const depot = depotHubForChunk(-2)!;
    expect(createDeliveryContract(depot, depot, 1, 0)).toBeNull();
  });

  it("regenerates the same unloaded destination from its chunk seed", () => {
    const contract = findContractForPlayer(
      { x: 0, y: 26, z: 0 },
      4,
      12,
      132,
      (chunkId) => depotHubForChunk(chunkId),
    )!;
    const chunkId = Number(contract.destinationDepotId.replace("depot-", ""));
    const regenerated = depotHubForChunk(chunkId)!;
    expect(regenerated.id).toBe(contract.destinationDepotId);
    expect(regenerated.position).toEqual(contract.destinationPosition);
  });
});

describe("delivery lifecycle", () => {
  it("loads a visible cargo pod, completes, and awards credits exactly once", () => {
    const { system, carrier, announcements } = createSystem();
    const start = { x: 0, y: 26, z: 0 };
    system.update(3, 3, start, 1);
    const contract = system.activeContract!;
    expect(contract).toBeTruthy();

    system.update(3.1, 0.1, contract.originPosition, 1);
    expect(contract.state).toBe(DeliveryState.ACCEPTED);
    system.update(3.2, 0.1, contract.originPosition, 1);
    system.update(4.2, 1, contract.originPosition, 1);
    expect(contract.state).toBe(DeliveryState.CARRYING);
    expect(contract.cargoState).toBe(CargoState.ATTACHED);
    expect(carrier.getObjectByName("CargoMount")).toBeTruthy();

    system.update(5, 0.1, contract.destinationPosition, 1);
    expect(contract.state).toBe(DeliveryState.DELIVERING);
    system.update(5.8, 0.8, contract.destinationPosition, 1);
    expect(contract.state).toBe(DeliveryState.COMPLETED);
    expect(carrier.getObjectByName("CargoMount")).toBeFalsy();
    const creditsAfterDelivery = system.credits;
    expect(creditsAfterDelivery).toBe(contract.rewardCredits + contract.bonusReward);

    system.update(6.2, 0.4, contract.destinationPosition, 1);
    expect(system.credits).toBe(creditsAfterDelivery);
    expect(announcements.some((event) => event.text === "CARGO LOADED")).toBe(true);
    expect(announcements.some((event) => event.text === "DELIVERY COMPLETE")).toBe(true);
  });

  it("awards the SAM route-risk bonus once per carried contract", () => {
    const { system } = createSystem();
    system.update(3, 3, { x: 0, y: 26, z: 0 }, 1);
    const contract = system.activeContract!;
    system.update(3.1, 0.1, contract.originPosition, 1);
    system.update(4.2, 1.1, contract.originPosition, 1);
    expect(system.markSamExposure()).toBe(true);
    expect(system.markSamExposure()).toBe(false);
    expect(contract.samRiskBonus).toBe(80);
    const before = system.credits;
    system.update(5, 0.1, contract.destinationPosition, 1);
    system.update(5.8, 0.8, contract.destinationPosition, 1);
    expect(system.credits - before).toBe(contract.rewardCredits + contract.bonusReward + 80);
  });

  it("fails safely on player death and clears the cargo visual on reset", () => {
    const { system, carrier } = createSystem();
    system.update(3, 3, { x: 0, y: 26, z: 0 }, 1);
    const contract = system.activeContract!;
    system.update(3.1, 0.1, contract.originPosition, 1);
    system.update(4.2, 1.1, contract.originPosition, 1);
    expect(system.isCarrying()).toBe(true);

    system.fail("PLAYER DOWN");
    expect(contract.state).toBe(DeliveryState.FAILED);
    expect(carrier.getObjectByName("CargoMount")).toBeFalsy();
    system.reset();
    expect(system.activeContract).toBeNull();
  });

  it("abandons a pickup the player overshoots instead of sticking forever", () => {
    const { system } = createSystem();
    system.update(3, 3, { x: 0, y: 26, z: 0 }, 1);
    const contract = system.activeContract!;

    // Touch the pickup zone (ACCEPTED → PICKUP_READY), then fly far away.
    system.update(3.1, 0.1, contract.originPosition, 1);
    system.update(3.2, 0.1, contract.originPosition, 1);
    expect(contract.state).toBe(DeliveryState.PICKUP_READY);

    const farAway = {
      x: contract.originPosition.x,
      y: 26,
      z: contract.originPosition.z - 600,
    };
    system.update(4, 0.8, farAway, 1);
    expect(system.activeContract).toBeNull();
  });

  it("times out a pickup that is never completed", () => {
    const { system } = createSystem();
    system.update(3, 3, { x: 0, y: 26, z: 0 }, 1);
    const contract = system.activeContract!;

    system.update(3.1, 0.1, contract.originPosition, 1);
    system.update(3.2, 0.1, contract.originPosition, 1);
    expect(contract.state).toBe(DeliveryState.PICKUP_READY);

    // Still hovering at the depot, but the bar was never filled.
    system.update(3.2 + PICKUP_ABANDON_SECONDS + 1, 1, contract.originPosition, 1);
    expect(system.activeContract).toBeNull();
  });

  it("fails cargo carried past the deadline instead of pinning the player", () => {
    const { system, announcements } = createSystem();
    system.update(3, 3, { x: 0, y: 26, z: 0 }, 1);
    const contract = system.activeContract!;
    system.update(3.1, 0.1, contract.originPosition, 1);
    system.update(4.2, 1.1, contract.originPosition, 1);
    expect(system.isCarrying()).toBe(true);

    // Never reach the destination; wait out the generous carry deadline.
    system.update(4.2 + CARRY_ABANDON_SECONDS + 1, 1, { x: 0, y: 26, z: 0 }, 1);
    expect(system.isCarrying()).toBe(false);
    expect(system.activeContract).toBeNull();
    expect(announcements.some((event) => event.text === "DELIVERY FAILED")).toBe(true);
  });

  it("keeps the handling effect subtle and upgradeable", () => {
    expect(cargoMovementMultiplier(0)).toBeGreaterThanOrEqual(0.88);
    expect(cargoMovementMultiplier(0)).toBeLessThan(1);
    expect(cargoMovementMultiplier(3)).toBeGreaterThan(cargoMovementMultiplier(0));
    expect(cargoMovementMultiplier(3)).toBeLessThan(1);
  });

  it("spends delivery credits on bounded permanent hangar ranks", () => {
    const upgrades = { armor: 0, fuelSystems: 0, cargoRig: 0, countermeasures: 0 };
    const cost = HANGAR_UPGRADE_INFO.armor.costs[0];
    const purchased = buyHangarUpgrade(cost, upgrades, "armor");
    expect(purchased.purchased).toBe(true);
    expect(purchased.credits).toBe(0);
    expect(purchased.upgrades.armor).toBe(1);

    const rejected = buyHangarUpgrade(0, purchased.upgrades, "armor");
    expect(rejected.purchased).toBe(false);
    expect(rejected.upgrades.armor).toBe(1);
  });
});
