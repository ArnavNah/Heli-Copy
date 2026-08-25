import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ENV_PALETTE, createBox, createPrism, getPrismGeometry, createSkyDome } from './materials';
import {
  PROP_COLORS,
  buildPalmTree,
  buildShrub,
  buildRoadArrow,
  buildTrafficCone,
  buildStripedBarricade,
  buildRadarTruck,
  buildMissileLauncherTruck,
  buildFuelTankerTruck,
  buildPickupTruck,
  buildUtilityVan,
  buildSedan,
  buildSteelTrussBridge,
  buildWoodenDock,
  buildSandbagBunker,
  buildSandbagWall,
  buildOilDrumStack,
  buildGasStation,
  buildCanalSegment,
  buildWreckedCar,
  buildCraterDecal,
  buildTireStack,
  buildRazorWire,
  buildFireHydrant,
  buildStreetLamp,
} from './props';

describe('Environment & Props Visual System', () => {
  it('defines coastal and military color tokens in ENV_PALETTE', () => {
    expect(ENV_PALETTE.asphalt).toBeDefined();
    expect(ENV_PALETTE.roadWhite).toBe(0xf5f7fa);
    expect(ENV_PALETTE.roadYellow).toBe(0xf5ba2c);
    expect(ENV_PALETTE.grass).toBe(0x4e9138);
    expect(ENV_PALETTE.sand).toBe(0xe5be82);
    expect(ENV_PALETTE.water).toBe(0x22a0dc);
    expect(ENV_PALETTE.accentOrange).toBe(0xde5932);
    expect(ENV_PALETTE.military).toBe(0x4d5f36);
  });

  it('builds low-poly palm trees with trunk and fronds', () => {
    const palm = buildPalmTree(0);
    expect(palm).toBeInstanceOf(THREE.Group);
    expect(palm.children.length).toBeGreaterThan(5);
  });

  it('builds low-poly shrubs and bushes', () => {
    const shrub = buildShrub(1);
    expect(shrub).toBeInstanceOf(THREE.Group);
    expect(shrub.children.length).toBeGreaterThanOrEqual(3);
  });

  it('builds painted road arrows of different types', () => {
    const straight = buildRoadArrow('straight');
    expect(straight).toBeInstanceOf(THREE.Group);
    expect(straight.children.length).toBeGreaterThan(0);

    const turn = buildRoadArrow('turn');
    expect(turn).toBeInstanceOf(THREE.Group);

    const combo = buildRoadArrow('combo');
    expect(combo).toBeInstanceOf(THREE.Group);
  });

  it('builds traffic cones and striped barricades', () => {
    const cone = buildTrafficCone();
    expect(cone).toBeInstanceOf(THREE.Group);
    expect(cone.children.length).toBeGreaterThanOrEqual(4);

    const barricade = buildStripedBarricade();
    expect(barricade).toBeInstanceOf(THREE.Group);
    expect(barricade.children.length).toBeGreaterThan(4);
  });

  it('builds military vehicles (Radar Truck and Missile Launcher Truck)', () => {
    const radarTruck = buildRadarTruck();
    expect(radarTruck).toBeInstanceOf(THREE.Group);
    const dish = radarTruck.getObjectByName('RadarDishGroup');
    expect(dish).toBeDefined();

    const missileTruck = buildMissileLauncherTruck();
    expect(missileTruck).toBeInstanceOf(THREE.Group);
    expect(missileTruck.children.length).toBeGreaterThan(3);
  });

  it('builds civilian and transport vehicles (Tanker, Pickup, Van, Sedan)', () => {
    const tanker = buildFuelTankerTruck();
    expect(tanker).toBeInstanceOf(THREE.Group);
    expect(tanker.children.length).toBeGreaterThan(5);

    const pickup = buildPickupTruck(PROP_COLORS.orange);
    expect(pickup).toBeInstanceOf(THREE.Group);

    const van = buildUtilityVan(PROP_COLORS.white);
    expect(van).toBeInstanceOf(THREE.Group);

    const sedan = buildSedan(PROP_COLORS.yellow);
    expect(sedan).toBeInstanceOf(THREE.Group);
  });

  it('builds coastal bridges, docks, and military fortifications', () => {
    const bridge = buildSteelTrussBridge(28, 10);
    expect(bridge).toBeInstanceOf(THREE.Group);
    expect(bridge.children.length).toBeGreaterThan(10);

    const dock = buildWoodenDock(18, 6);
    expect(dock).toBeInstanceOf(THREE.Group);
    expect(dock.children.length).toBeGreaterThan(4);

    const bunker = buildSandbagBunker();
    expect(bunker).toBeInstanceOf(THREE.Group);

    const wall = buildSandbagWall(8);
    expect(wall).toBeInstanceOf(THREE.Group);

    const drums = buildOilDrumStack();
    expect(drums).toBeInstanceOf(THREE.Group);
  });

  it('builds full procedural gas station landmark', () => {
    const station = buildGasStation('VOLT FUEL');
    expect(station).toBeInstanceOf(THREE.Group);
    expect(station.children.length).toBeGreaterThanOrEqual(3);
  });

  it('builds canal channel segments with retaining walls and water', () => {
    const canal = buildCanalSegment(24, 40, 3.5);
    expect(canal).toBeInstanceOf(THREE.Group);
    expect(canal.children.length).toBeGreaterThanOrEqual(4);
  });

  it('builds battlefield damage props (wrecked car, crater, tire stack, razor wire, streetlamp, hydrant)', () => {
    const wreck = buildWreckedCar();
    expect(wreck).toBeInstanceOf(THREE.Group);

    const crater = buildCraterDecal(4.0);
    expect(crater).toBeInstanceOf(THREE.Group);

    const tires = buildTireStack();
    expect(tires).toBeInstanceOf(THREE.Group);

    const wire = buildRazorWire(6.0);
    expect(wire).toBeInstanceOf(THREE.Group);

    const hydrant = buildFireHydrant();
    expect(hydrant).toBeInstanceOf(THREE.Group);

    const lamp = buildStreetLamp();
    expect(lamp).toBeInstanceOf(THREE.Group);
  });

  it('caches prism geometry and generates sky dome', () => {
    const prismGeo = getPrismGeometry(2, 1, 2);
    expect(prismGeo).toBeDefined();
    expect(prismGeo.userData.shared).toBe(true);

    const dome = createSkyDome();
    expect(dome).toBeInstanceOf(THREE.Mesh);
  });
});
