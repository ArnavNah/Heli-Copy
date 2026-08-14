import * as THREE from "three";
import * as CANNON from "cannon-es";
import { createBox, createGlowBox, disposeObject3D, getLowPolyMaterial, mergeBoxMeshes, ENV_PALETTE } from "./materials";
import {
  addInstancedProps,
  barrierGeometry,
  bollardGeometry,
  buildAntennaArray,
  buildBarricade,
  buildContainer,
  buildCrate,
  buildDumpster,
  buildEquipmentCrate,
  buildFloodlight,
  buildGenerator,
  buildLightPole,
  buildLoadingBay,
  buildPerimeterMarker,
  buildPipeRun,
  buildRoadSign,
  buildRooftopProp,
  buildStorageTank,
  buildTrafficLight,
  buildUtilityBox,
  PROP_COLORS,
} from "./props";
import { Turret } from "./entities";
import {
  DISTRICT_CONFIGS,
  buildingArchetype,
  districtForChunk,
  footprintTier,
  occlusionStrength,
  rhythmDensity,
  sceneRhythmForChunk,
} from "./logic";
import type { BuildingArchetype, DistrictConfig, RooftopPropType } from "./logic";

/** Cached color for the building damage-darken lerp (Phase 3). */
let tempDamageTint: THREE.Color | null = null;
import { ObjectiveType } from "./types";
import type { CityBlock, RooftopSpot, WorldChunk } from "./types";
import { depotHubForChunk } from "./delivery";
import type { DepotHub } from "./delivery";

/** An animated car driving along a road lane (moves inside its chunk band). */
interface TrafficCar {
  x: number;
  baseX: number;
  z: number;
  speed: number;
  baseSpeed: number;
  minZ: number;
  maxZ: number;
  parts: THREE.Object3D[];
  /** Headlight + taillight meshes, flashed while honking. */
  lights: THREE.Mesh[];
  dodgeDir: number;
  dodgeTimer: number;
  dodgeCooldown: number;
  honkTimer: number;
}

/** A roadside ad board with a scrolling marquee ticker. */
interface Billboard {
  tex: THREE.CanvasTexture;
  scrollSpeed: number;
  phase: number;
  glow: THREE.Mesh;
}

/** A puffy low-poly cloud that drifts slowly and wraps around the player. */
interface Cloud {
  group: THREE.Group;
  speed: number;
  driftY: number;
}

export class CityEnvironment {
  group = new THREE.Group();
  rooftopSpots: RooftopSpot[] = [];
  blocks: CityBlock[] = [];
  chunks: Map<number, WorldChunk> = new Map();
  /** Logical depot registry survives chunk unloads; positions are also reproducible from the chunk seed. */
  depotHubs: Map<string, DepotHub> = new Map();
  particles: any = null;
  cellSize = 22;
  chunkDepth = 132;
  /** The city is wider than the original build: 1024 units of ground per
   * chunk (was 640) with two extra building rows on each flank. The map is
   * fully procedural — every chunk derives deterministically from its id via
   * hash() — and endless along the flight path (chunks stream in ahead,
   * unload behind). */
  worldHalfWidth = 512;
  halfWidthCells = 12;

  // Road hierarchy (Pass 2): a grand central avenue under the flight corridor,
  // two fixed flanking avenues, a cross street every chunk, and a service road.
  // All positions are constants so chunk seams always line up when streaming.
  grandAvenueHalf = 15; // 30-wide central spine
  sideAvenueX = 34; // flanking avenues, both sides, fixed (no per-chunk flip)
  sideAvenueHalf = 8; // 16 wide
  serviceRoadX = 104; // dirt service road, fixed alignment (clear of gx=4 buildings)
  serviceRoadHalf = 3; // 6 wide
  activeBehind = 1;
  activeAhead = 2;
  onBuildingDestroyed: ((x: number, y: number, z: number) => void) | null = null;

  // Drifting cloud layer — a global sky feature, not chunked
  clouds: Cloud[] = [];
  cloudGroup = new THREE.Group();

  // Ambient life: rooftop turrets, moving traffic, birds, pulsing beacons, ad boards
  turrets: Turret[] = [];
  chunkTurrets: Map<number, Turret[]> = new Map();
  chunkTraffic: Map<number, TrafficCar[]> = new Map();
  chunkBeacons: Map<number, THREE.Mesh[]> = new Map();
  chunkBillboards: Map<number, Billboard[]> = new Map();
  time: number = 0;
  /** Called (throttled) when a car honks its horn. Wired to the audio engine. */
  onHonk: (() => void) | null = null;
  private honkCooldown = 0;

  /** Lazy per-mesh material clones so shared cached materials are never mutated. */
  private damageMats = new WeakMap<THREE.Mesh, THREE.MeshLambertMaterial>();

  /** Camera-occlusion clone-on-ghost map (shared materials are never faded in place). */
  private occlusionMats = new WeakMap<THREE.Mesh, THREE.MeshLambertMaterial | THREE.MeshBasicMaterial>();
  /** Reused detection buffer — no per-frame allocations. */
  private occlusionScratch: { block: CityBlock; strength: number }[] = [];
  private occlusionTimer = 0;
  private occlusionBlockCount = -1;

  /** Environment debug overlay — chunk bounds, roads, combat corridor, buildings, landmarks. OFF by default. */
  debugEnv: boolean = false;
  private envDebugGroup: THREE.Group | null = null;
  private landmarkSet = new WeakSet<CityBlock>();

  constructor(scene: THREE.Scene, world: CANNON.World) {
    this.group.name = "ModularBlockCity";
    scene.add(this.group);

    this.cloudGroup.name = "DriftingClouds";
    this.cloudGroup.position.set(0, 0, 0);
    scene.add(this.cloudGroup);
    this.buildCloudLayer();

    this.update({ x: 0, y: 20, z: 0 }, world);
  }

  /** Build a field of puffy low-poly clouds scattered around the origin. */
  private buildCloudLayer() {
    for (let i = 0; i < 26; i++) {
      const group = new THREE.Group();
      // Cluster of 2-4 flattened boxes makes a puffy low-poly cloud
      const puffs = 2 + Math.floor(this.hash(i, 31) * 3);
      for (let p = 0; p < puffs; p++) {
        const w = 16 + this.hash(i * 3 + p, 7) * 26;
        const d = 10 + this.hash(i * 5 + p, 11) * 18;
        const h = 4 + this.hash(i * 7 + p, 13) * 4;
        const puff = createBox(w, h, d, 0xffffff);
        const m = puff.material as THREE.MeshLambertMaterial;
        m.opacity = 0.9;
        m.transparent = true;
        m.depthWrite = false;
        puff.position.set(
          (this.hash(i * 11 + p, 17) - 0.5) * 60,
          (this.hash(i * 13 + p, 19) - 0.5) * 5,
          (this.hash(i * 17 + p, 23) - 0.5) * 40,
        );
        group.add(puff);
      }
      const spread = 460;
      group.position.set(
        (this.hash(i, 29) - 0.5) * spread * 2,
        95 + this.hash(i, 37) * 75,
        (this.hash(i, 41) - 0.5) * spread * 2,
      );
      group.scale.setScalar(0.8 + this.hash(i, 43) * 0.9);
      this.cloudGroup.add(group);
      this.clouds.push({
        group,
        speed: 1.6 + this.hash(i, 47) * 3.2,
        driftY: this.hash(i, 53) * Math.PI * 2,
      });
    }
  }

  /** Drift clouds and wrap them around the player so the sky always has them. */
  private updateClouds(playerX: number, playerZ: number, delta: number) {
    const t = this.time;
    for (const cloud of this.clouds) {
      const g = cloud.group;
      // Slow horizontal drift + a gentle vertical bob
      g.position.x += cloud.speed * delta * 0.35;
      g.position.z += cloud.speed * delta * 0.12;
      g.position.y += Math.sin(t * 0.12 + cloud.driftY) * delta * 0.5;

      // Wrap into a 900-unit box centered on the player
      const bound = 450;
      const dx = g.position.x - playerX;
      const dz = g.position.z - playerZ;
      if (dx > bound) g.position.x = playerX - bound + (dx - bound);
      else if (dx < -bound) g.position.x = playerX + bound + (dx + bound);
      if (dz > bound) g.position.z = playerZ - bound + (dz - bound);
      else if (dz < -bound) g.position.z = playerZ + bound + (dz + bound);
    }
  }

  reset(world: CANNON.World) {
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.group);
      this.disposeChunkResources(chunk);
      for (const body of chunk.bodies) {
        world.removeBody(body);
      }
    }
    this.chunks.clear();
    this.blocks = [];
    this.rooftopSpots = [];
    this.turrets = [];
    this.chunkTurrets.clear();
    this.chunkTraffic.clear();
    this.chunkBeacons.clear();
    this.disposeBillboardTextures(this.chunkBillboards);
    this.depotHubs.clear();
    this.update({ x: 0, y: 20, z: 0 }, world);
  }

  /** Return and register the deterministic depot for a chunk, loaded or not. */
  getDepotHub(chunkId: number): DepotHub | null {
    const id = `depot-${chunkId}`;
    const registered = this.depotHubs.get(id);
    if (registered) return registered;
    const depot = depotHubForChunk(chunkId, this.chunkDepth);
    if (depot) {
      this.depotHubs.set(depot.id, depot);
      // Long endless runs scan new route candidates forever; deterministic
      // regeneration lets this logical cache remain bounded without losing a destination.
      if (this.depotHubs.size > 256) {
        const oldest = this.depotHubs.keys().next().value as string | undefined;
        if (oldest) this.depotHubs.delete(oldest);
      }
    }
    return depot;
  }

  getSpawnSpot(playerPos: CANNON.Vec3): RooftopSpot {
    const candidates = this.rooftopSpots.filter((spot) => {
      const dx = spot.x - playerPos.x;
      const dz = spot.z - playerPos.z;
      const distSq = dx * dx + dz * dz;
      return spot.z < playerPos.z - 22 && distSq > 1600 && distSq < 22000;
    });
    const pool = candidates.length > 0 ? candidates : this.rooftopSpots;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  getAmbushSpot(playerPos: CANNON.Vec3, aheadMin = 45, aheadMax = 165) {
    const candidates = this.rooftopSpots.filter((spot) => {
      const ahead = playerPos.z - spot.z;
      return ahead > aheadMin && ahead < aheadMax && Math.abs(spot.x - playerPos.x) < 145;
    });
    return candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : this.getSpawnSpot(playerPos);
  }

  update(player: { x: number; y: number; z: number }, world: CANNON.World, delta = 0.016) {
    const playerZ = player.z;
    const center = Math.floor(playerZ / this.chunkDepth);
    let cacheDirty = false;
    for (let id = center - this.activeAhead; id <= center + this.activeBehind; id++) {
      if (!this.chunks.has(id)) {
        this.generateChunk(id, world);
        cacheDirty = true;
      }
    }

    for (const [id, chunk] of this.chunks) {
      if (id < center - this.activeAhead - 1 || id > center + this.activeBehind + 1) {
        this.group.remove(chunk.group);
        // Phase 1: release the chunk's unique GPU buffers (merged building /
        // road / landmark geometries, per-chunk materials). Shared cached
        // resources are skipped by disposeObject3D's userData.shared check.
        this.disposeChunkResources(chunk);
        for (const body of chunk.bodies) world.removeBody(body);
        this.chunks.delete(id);
        this.chunkTurrets.delete(id);
        this.chunkTraffic.delete(id);
        this.chunkBeacons.delete(id);
        this.disposeBillboardTextures(this.chunkBillboards, id);
        cacheDirty = true;
      }
    }

    if (cacheDirty) {
      this.rebuildCaches();
      if (this.debugEnv) this.rebuildEnvDebug();
    }
    this.animateWorld(player.x, player.z, delta);
    this.animateCollapses(delta);
  }

  /**
   * Tallest building whose AABB the camera→helicopter view segment passes
   * through (3D slab test, exact). Returns 0 when nothing blocks the view —
   * the engine raises the camera above the returned top so buildings between
   * the camera and the player never swallow the action.
   */
  /**
   * Toggle the environment debug overlay (chunk bounds, road cells, combat
   * corridor, building bounds, landmark cells). OFF by default.
   */
  setEnvDebug(on: boolean) {
    this.debugEnv = on;
    this.rebuildEnvDebug();
  }

  private rebuildEnvDebug() {
    if (this.envDebugGroup) {
      // Release GPU buffers — removing from the scene alone does not free them.
      this.envDebugGroup.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments) {
          child.geometry?.dispose();
          const m = child.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      this.group.remove(this.envDebugGroup);
      this.envDebugGroup = null;
    }
    if (!this.debugEnv) return;
    const g = new THREE.Group();
    g.name = 'EnvDebug';
    this.envDebugGroup = g;
    const mat = (color: number, opacity = 0.9) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const rect = (cx: number, cz: number, w: number, d: number, color: number, y = 0.2) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx - w / 2, y, cz - d / 2),
        new THREE.Vector3(cx + w / 2, y, cz - d / 2),
        new THREE.Vector3(cx + w / 2, y, cz + d / 2),
        new THREE.Vector3(cx - w / 2, y, cz + d / 2),
        new THREE.Vector3(cx - w / 2, y, cz - d / 2),
      ]);
      const line = new THREE.Line(geo, mat(color));
      line.frustumCulled = false;
      g.add(line);
    };

    for (const chunk of this.chunks.values()) {
      const cz = chunk.id * this.chunkDepth;
      // Chunk boundary (white)
      rect(0, cz, this.worldHalfWidth * 2, this.chunkDepth - 0.4, 0xffffff, 0.25);
      // Open combat corridor — flight lane (green)
      rect(0, cz, 58, this.chunkDepth, 0x35e66d, 0.18);
      // Road cells — grand avenue, flanking avenues, cross street (yellow)
      const dbgCfg = DISTRICT_CONFIGS[districtForChunk(chunk.id)];
      rect(0, cz, this.grandAvenueHalf * 2, this.chunkDepth, 0xffd23b, 0.15);
      rect(-this.sideAvenueX, cz, this.sideAvenueHalf * 2, this.chunkDepth, 0xffd23b, 0.15);
      rect(this.sideAvenueX, cz, this.sideAvenueHalf * 2, this.chunkDepth, 0xffd23b, 0.15);
      rect(0, cz, this.worldHalfWidth * 2, dbgCfg.crossStreetHalf * 2, 0xffd23b, 0.15);
      // Service road (orange)
      if (
        dbgCfg.name === 'industrial' ||
        dbgCfg.name === 'base' ||
        dbgCfg.name === 'ruins' ||
        dbgCfg.name === 'desert'
      ) {
        rect(this.serviceRoadX, cz, this.serviceRoadHalf * 2, this.chunkDepth, 0xff9a3b, 0.15);
      }
      // Building bounds (cyan) and landmark cells (magenta)
      for (const block of chunk.blocks) {
        const box = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(block.width, block.height, block.depth)),
          mat(this.landmarkSet.has(block) ? 0xff4dd8 : 0x39d4ff, 0.75),
        );
        box.position.set(block.x, block.height / 2, block.z);
        box.frustumCulled = false;
        g.add(box);
      }
    }
    this.group.add(g);
  }

  getCameraBlockedHeight(
    camX: number,
    camY: number,
    camZ: number,
    tx: number,
    ty: number,
    tz: number,
  ): number {
    const dx = tx - camX;
    const dy = ty - camY;
    const dz = tz - camZ;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return 0;
    let top = 0;
    for (const block of this.blocks) {
      if (block.destroyed) continue;
      if (Math.abs(block.z - camZ) > 80 || Math.abs(block.x - camX) > 80) continue;
      const blockTop = block.height + 1;
      let tMin = 0;
      let tMax = 1;
      // X slab
      const minX = block.x - block.width * 0.5 - 1.5;
      const maxX = block.x + block.width * 0.5 + 1.5;
      if (Math.abs(dx) < 1e-6) {
        if (camX < minX || camX > maxX) continue;
      } else {
        const t1 = (minX - camX) / dx;
        const t2 = (maxX - camX) / dx;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
        if (tMax < tMin) continue;
      }
      // Z slab
      const minZ = block.z - block.depth * 0.5 - 1.5;
      const maxZ = block.z + block.depth * 0.5 + 1.5;
      if (Math.abs(dz) < 1e-6) {
        if (camZ < minZ || camZ > maxZ) continue;
      } else {
        const t1 = (minZ - camZ) / dz;
        const t2 = (maxZ - camZ) / dz;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
        if (tMax < tMin) continue;
      }
      // Y slab (building volume spans 0..blockTop)
      if (Math.abs(dy) < 1e-6) {
        if (camY < 0 || camY > blockTop) continue;
      } else {
        const t1 = (0 - camY) / dy;
        const t2 = (blockTop - camY) / dy;
        const yMin = Math.max(tMin, Math.min(t1, t2));
        const yMax = Math.min(tMax, Math.max(t1, t2));
        if (yMax < yMin) continue;
      }
      if (blockTop > top) top = blockTop;
    }
    return top;
  }

  /**
   * Clone-on-write for shared cached glow materials that pulse per-instance
   * (beacons, car lights, board glows). The cached material is never mutated
   * in place — the first animation clones it for this mesh only (the same
   * pattern the occlusion ghost system uses). Returns the mesh's own material.
   */
  private animatedGlowMaterial(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
    const cached = mesh.userData.animGlow as THREE.MeshBasicMaterial | undefined;
    if (cached) return cached;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (mat.userData.shared) {
      const clone = mat.clone();
      clone.userData = { shared: false };
      mesh.material = clone;
      mesh.userData.animGlow = clone;
      return clone;
    }
    mesh.userData.animGlow = mat;
    return mat;
  }

  /** Animate the living city: dodging traffic, animated ad boards, pulsing beacons. */
  private animateWorld(playerX: number, playerZ: number, delta: number) {
    this.time += delta;
    const t = this.time;
    this.updateClouds(playerX, playerZ, delta);
    this.honkCooldown = Math.max(0, this.honkCooldown - delta);

    // Traffic — cars cruise along the road, swerve away from the player and honk
    for (const cars of this.chunkTraffic.values()) {
      for (const car of cars) {
        car.z += car.speed * delta;
        if (car.z > car.maxZ) car.z = car.minZ;
        else if (car.z < car.minZ) car.z = car.maxZ;

        // Buzz a car and it swerves out of your way, braking and honking
        car.dodgeCooldown = Math.max(0, car.dodgeCooldown - delta);
        car.honkTimer = Math.max(0, car.honkTimer - delta);
        if (
          car.dodgeTimer <= 0 &&
          car.dodgeCooldown <= 0 &&
          Math.abs(car.x - playerX) < 24 &&
          Math.abs(car.z - playerZ) < 30
        ) {
          car.dodgeDir = car.x <= playerX ? -1 : 1;
          car.dodgeTimer = 0.85;
          car.dodgeCooldown = 3.5 + Math.random() * 4;
          car.honkTimer = 0.45;
          if (this.honkCooldown <= 0) {
            this.honkCooldown = 0.8;
            this.onHonk?.();
          }
        }
        if (car.dodgeTimer > 0) {
          car.dodgeTimer -= delta;
          car.speed = car.baseSpeed * 0.55; // brake while swerving
          const prog = 1 - car.dodgeTimer / 0.85;
          car.x = car.baseX + car.dodgeDir * 2.9 * Math.sin(prog * Math.PI);
        } else {
          car.speed = car.baseSpeed;
          car.x += (car.baseX - car.x) * Math.min(1, delta * 5); // ease back into lane
        }

        for (const part of car.parts) {
          part.position.z = car.z;
          part.position.x = car.x;
        }

        // Horn flash: headlights + taillights flicker while honking
        for (let i = 0; i < car.lights.length; i++) {
          const light = car.lights[i];
          const mat = this.animatedGlowMaterial(light);
          const base = (light.userData.baseOpacity as number) ?? 0.7;
          mat.opacity =
            car.honkTimer > 0
              ? base * (0.35 + Math.abs(Math.sin(t * 36 + i * 2.4)) * 0.65)
              : base;
        }
      }
    }

    // Animated ad boards — marquee tickers scroll, neon borders pulse
    for (const boards of this.chunkBillboards.values()) {
      for (const board of boards) {
        board.tex.offset.x = (t * board.scrollSpeed) % 1;
        const s = 1 + Math.sin(t * 2.2 + board.phase) * 0.05;
        board.glow.scale.set(s, s * 1.35, 1);
        const gmat = this.animatedGlowMaterial(board.glow);
        gmat.opacity = 0.5 + Math.sin(t * 2.2 + board.phase) * 0.35;
      }
    }

    // Rooftop beacons + runway glows gently pulse
    for (const beacons of this.chunkBeacons.values()) {
      for (const beacon of beacons) {
        const ph = (beacon.userData.phase as number) ?? 0;
        const mat = this.animatedGlowMaterial(beacon);
        mat.opacity = 0.42 + Math.sin(t * 3.2 + ph) * 0.34;
        const s = 1 + Math.sin(t * 3.2 + ph) * 0.12;
        beacon.scale.set(s, s, s);
      }
    }
  }

  damageNearby(x: number, z: number, radius: number, amount: number) {
    for (const block of this.blocks) {
      if (block.destroyed) continue;
      const distSq = this.distanceToBlockFootprintSq(x, z, block);
      if (distSq > radius * radius) continue;
      const falloff = 1 - Math.sqrt(distSq) / Math.max(radius, 0.001);
      this.damageBlock(block, amount * (0.35 + falloff * 0.65));
    }
  }

  damageProjectilePath(
    from: CANNON.Vec3,
    to: CANNON.Vec3,
    amount: number,
  ): CityBlock | null {
    let closestBlock: CityBlock | null = null;
    let closestT = Infinity;
    // Skip shots that originate on/inside a building — enemy and rooftop turret
    // fire would otherwise instantly damage (and burst) their own building. This
    // also keeps the player's own fire from chipping the roof they're hovering over.
    const pad = 1.5;

    for (const block of this.blocks) {
      if (block.destroyed) continue;
      // Arcade style: Projectiles hit any building in their path, regardless of height
      if (Math.max(from.y, to.y) < -1) {
        continue;
      }
      if (
        Math.abs(from.x - block.x) <= block.width * 0.5 + pad &&
        Math.abs(from.z - block.z) <= block.depth * 0.5 + pad
      ) {
        continue;
      }
      const t = this.segmentIntersectsBlockFootprint(from, to, block, 1.1);
      if (t === null || t >= closestT) continue;
      closestT = t;
      closestBlock = block;
    }

    if (closestBlock) this.damageBlock(closestBlock, amount);
    return closestBlock;
  }

  getHeightAt(x: number, z: number, clearanceRadius = 0) {
    let height = 0;
    for (const block of this.blocks) {
      if (block.destroyed) continue;
      if (
        Math.abs(x - block.x) <= block.width * 0.5 + clearanceRadius &&
        Math.abs(z - block.z) <= block.depth * 0.5 + clearanceRadius
      ) {
        height = Math.max(height, block.height);
      }
    }
    return height;
  }

  /**
   * Best extraction pad ahead of the player. Priority: an intact helipad-tower
   * deck (the military LZ landmark), then a flat reachable rooftop (existing
   * H-marked helipad props win ties; otherwise the pad is painted there), then
   * the lowest open surface on the usual lanes (waterfront / parks / loading
   * yards read as near-zero ground). All honor the existing distance band
   * (140–330 ahead, same spirit as the old fixed z-220) and never land inside
   * a building or on a hostile turret roof — decks/pads sit on real rooftops,
   * the fallback is the lowest surface on a lane.
   */
  findExtractionSpot(playerZ: number): { x: number; z: number; height: number; kind: "tower" | "rooftop" | "ground" } {
    const minDist = 140;
    const maxDist = 330;
    // 1) Helipad-tower decks ahead of the player — the ideal LZ.
    let bestTower: { x: number; z: number; height: number; dist: number } | null = null;
    for (const chunk of this.chunks.values()) {
      for (const block of chunk.blocks) {
        if (block.destroyed || block.landmarkKind !== "HELIPAD_TOWER") continue;
        const dz = block.z - playerZ;
        if (dz < minDist || dz > maxDist) continue;
        const dist = Math.abs(dz);
        if (!bestTower || dist < bestTower.dist) {
          // Deck surface sits 4.6 below the block's top (mast + edge lights).
          bestTower = { x: block.x, z: block.z, height: block.height - 4.6, dist };
        }
      }
    }
    if (bestTower) {
      return { x: bestTower.x, z: bestTower.z, height: bestTower.height, kind: "tower" };
    }
    // 2) A flat, reachable rooftop ahead — real helipad props win ties.
    let bestRoof: { x: number; z: number; height: number; dist: number; pad: boolean } | null = null;
    for (const spot of this.rooftopSpots) {
      const dz = spot.z - playerZ;
      if (dz < minDist || dz > maxDist) continue;
      if (Math.abs(spot.x) > 105) continue; // keep it near the flight corridor
      const roof = this.getHeightAt(spot.x, spot.z);
      if (roof < 6 || roof > 48) continue; // shacks too low, spires not a pad
      // Wide flat roof: nothing taller within ~5 units of the spot center.
      if (this.getHeightAt(spot.x, spot.z, 5) > roof + 0.01) continue;
      // Hostile turret roofs are not LZs.
      let nearTurret = false;
      for (const turret of this.turrets) {
        if (
          Math.abs(turret.position.x - spot.x) < 9 &&
          Math.abs(turret.position.z - spot.z) < 9
        ) {
          nearTurret = true;
          break;
        }
      }
      if (nearTurret) continue;
      const dist = Math.abs(dz);
      const pad = Boolean(spot.helipad);
      if (!bestRoof || dist < bestRoof.dist || (pad && !bestRoof.pad)) {
        bestRoof = { x: spot.x, z: spot.z, height: roof, dist, pad };
      }
    }
    if (bestRoof) {
      return { x: bestRoof.x, z: bestRoof.z, height: bestRoof.height, kind: "rooftop" };
    }
    // 3) Open ground: the lowest surface on the fixed lanes wins (open yards,
    //    waterfront and parks are the shortest). Same lanes/distance as before.
    const lanes = [0, -72, 72, -36, 36];
    let bestGround: { x: number; z: number; height: number } | null = null;
    const z = playerZ - 220;
    for (const x of lanes) {
      const height = this.getHeightAt(x, z, 0.5);
      if (!bestGround || height < bestGround.height) {
        bestGround = { x, z, height };
      }
    }
    const fallback = bestGround ?? { x: 0, z, height: 0 };
    return { x: fallback.x, z: fallback.z, height: fallback.height, kind: "ground" };
  }

  private generateChunk(id: number, world: CANNON.World) {
    const chunk: WorldChunk = {
      id,
      group: new THREE.Group(),
      bodies: [],
      blocks: [],
      spots: [],
    };
    chunk.group.name = `BattlefieldChunk_${id}`;
    this.group.add(chunk.group);

    const district = districtForChunk(id);
    const config = DISTRICT_CONFIGS[district];
    // Neighbor districts drive the seam transitions so zones blend across the
    // chunk boundary instead of snapping (Pass 4).
    const prevConfig = DISTRICT_CONFIGS[districtForChunk(id - 1)];
    const nextConfig = DISTRICT_CONFIGS[districtForChunk(id + 1)];
    const chunkCenterZ = id * this.chunkDepth;
    const depot = this.getDepotHub(id);

    const ground = createBox(this.worldHalfWidth * 2, 0.8, this.chunkDepth - 0.4, config.ground);
    ground.position.set(0, -0.62, chunkCenterZ);
    chunk.group.add(ground);

    // Ground transition strips: a thin band of each neighbor's ground color at
    // the chunk edges grades the ground-color jump across the seam. Visual only.
    // The strip top (y≈-0.13) clears below the road surfaces (asphalt top ≈-0.10)
    // so roads win the depth test and no band is stamped across the avenues.
    const stripAt = (groundColor: number, z: number) => {
      const strip = createBox(this.worldHalfWidth * 2, 0.34, 6, groundColor);
      strip.position.set(0, -0.3, z);
      chunk.group.add(strip);
    };
    stripAt(prevConfig.ground, chunkCenterZ - this.chunkDepth / 2);
    stripAt(nextConfig.ground, chunkCenterZ + this.chunkDepth / 2);

    this.chunkTurrets.set(id, []);
    this.chunkTraffic.set(id, []);
    this.chunkBeacons.set(id, []);
    this.chunkBillboards.set(id, []);

    // Road hierarchy (Pass 2): grand central avenue under the flight corridor,
    // fixed flanking avenues, a cross street every chunk, plus a service road.
    this.addRoadNetwork(chunk, id, chunkCenterZ, config);

    // Buildings FIRST, so ground dressing, parks and landmarks can dodge them.
    const rhythm = sceneRhythmForChunk(id);
    for (let gx = -this.halfWidthCells; gx <= this.halfWidthCells; gx++) {
      for (let local = -2; local <= 3; local++) {
        // Flight corridor: always keep the center clear, only low-rise at the edges.
        const nearLane = Math.abs(gx) <= 1;
        const laneEdge = Math.abs(gx) === 2;
        if (nearLane) continue;
        if (laneEdge && this.hash(id, gx * 53 + local * 19) < 0.42) continue;
        // Cross-street clearance: the row the avenue intersects stays open.
        if (local === 0) continue;
        const x = gx * this.cellSize + (this.hash(id, gx + local) - 0.5) * 4;
        const z = chunkCenterZ + local * this.cellSize + (this.hash(id, gx - local) - 0.5) * 5;
        // Reserve a broad, obstacle-free cargo apron around the deterministic depot.
        if (
          depot &&
          Math.abs(x - depot.position.x) < 30 &&
          Math.abs(z - depot.position.z) < 23
        ) continue;
        const roll = this.hash(id, gx * 13 + local * 37);
        // Skyline density tapers toward the field edges.
        const edgeFactor = 1 - Math.min(1, (Math.abs(gx) - 3) / 6) * 0.35;
        // Pass 9: per-chunk scene rhythm modulates density — dense blocks,
        // open plazas and objective clearings alternate along the flight path.
        const density = config.density * edgeFactor * rhythmDensity(rhythm);
        if (roll > density) {
          // Empty cell -> breathing room: parking lot, rubble lot, courtyard, or bare ground.
          this.addOpenLot(chunk, id, x, z, gx, local, config);
          continue;
        }
        this.addProceduralStructure(chunk, world, config, prevConfig, nextConfig, x, z, gx, local);
      }
    }

    // Dressing after buildings: patches/rocks skip footprints, parks dodge real blocks.
    this.addGroundDressing(chunk, config, chunkCenterZ, id);
    this.addBillboards(chunk, id, chunkCenterZ, config);
    this.addStreetProps(chunk, id, config, chunkCenterZ);
    if (depot) this.addDepotFacility(chunk, depot, config);
    if (config.name === 'base' || config.name === 'ruins') {
      this.addMilitaryProps(chunk, id, config, chunkCenterZ);
    }
    this.addDistrictLandmark(chunk, world, id, config);

    if (Math.abs(id) % 5 === 2) this.addBridge(chunk, chunkCenterZ);
    if (Math.abs(id) % 7 === 4) this.addSmokeColumn(chunk, chunkCenterZ);

    this.chunks.set(id, chunk);
  }

  /**
   * Compose a readable low-poly cargo facility around an open loading apron.
   * The visual belongs to the chunk; the DepotHub data above does not.
   */
  private addDepotFacility(chunk: WorldChunk, depot: DepotHub, config: DistrictConfig) {
    const g = new THREE.Group();
    g.name = `DepotFacility_${depot.id}`;
    g.position.set(depot.position.x, 0, depot.position.z);
    const outward = depot.position.x < 0 ? -1 : 1;

    const yard = createBox(34, 0.18, 28, PROP_COLORS.concreteDark);
    yard.position.y = 0.02;
    g.add(yard);

    // Open helicopter loading area: amber corner lamps and inset ground bars.
    const loadingPad = createBox(18, 0.12, 18, 0x303842);
    loadingPad.position.set(-outward * 4, 0.14, 0);
    g.add(loadingPad);
    for (const side of [-1, 1]) {
      const stripe = createBox(0.7, 0.08, 15, 0xe5a83c);
      stripe.position.set(-outward * 4 + side * 7.5, 0.24, 0);
      g.add(stripe);
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lamp = createGlowBox(0.65, 0.35, 0.65, 0xffbd3f, 0.82);
        lamp.position.set(-outward * 4 + sx * 7.3, 0.48, sz * 7.3);
        lamp.userData.isBeacon = true;
        g.add(lamp);
      }
    }

    // Warehouse and covered loading bay frame the outside edge, leaving the approach open.
    const warehouse = createBox(15, 6.5, 15, config.palette[0]);
    warehouse.position.set(outward * 19, 3.35, 0);
    g.add(warehouse);
    const roof = createBox(16.5, 0.7, 16.5, PROP_COLORS.darkSteel);
    roof.position.set(outward * 19, 6.75, 0);
    g.add(roof);
    const door = createBox(0.35, 3.5, 5.5, 0x2b313b);
    door.position.set(outward * 11.35, 1.8, 0);
    g.add(door);
    const bay = buildLoadingBay();
    bay.position.set(outward * 9.4, 0.22, -7.5);
    bay.rotation.y = outward > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(bay);

    const containerA = buildContainer(PROP_COLORS.blue);
    containerA.position.set(outward * 8.5, 0.2, 10.6);
    containerA.rotation.y = Math.PI / 2;
    const containerB = buildContainer(PROP_COLORS.rust);
    containerB.position.set(outward * 14, 0.2, 10.6);
    containerB.rotation.y = Math.PI / 2;
    g.add(containerA, containerB);

    for (let i = 0; i < 3; i++) {
      const crate = buildCrate(i, i === 1 ? PROP_COLORS.olive : PROP_COLORS.tan);
      crate.position.set(outward * (9 + i * 2), 0.2, -11);
      crate.rotation.y = i * 0.45;
      g.add(crate);
    }

    const tank = buildStorageTank(Math.abs(depot.chunkId) % 3, config.accentColor);
    tank.position.set(outward * 27, 0.2, 9.5);
    g.add(tank);
    for (const z of [-11, 11]) {
      const light = buildFloodlight();
      light.position.set(-outward * 13.5, 0.2, z);
      light.rotation.y = outward > 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(light);
    }

    // Chunky roadside signage is legible as a depot silhouette even before a contract is active.
    const sign = buildRoadSign(config.name === "waterfront" || config.name === "industrial");
    sign.position.set(-outward * 15, 0.2, -9);
    sign.rotation.y = outward > 0 ? -Math.PI / 2 : Math.PI / 2;
    const signGlow = createGlowBox(2.4, 0.35, 0.25, 0xffbd3f, 0.72);
    signGlow.position.set(-outward * 15, 3.65, -9);
    g.add(sign, signGlow);

    chunk.group.add(g);
  }

  /**
   * Road hierarchy (Pass 2): a wide grand avenue running under the flight
   * corridor, two fixed flanking avenues, a cross street every chunk, and a
   * dirt service road in industrial zones. Lane markings are merged into a
   * handful of meshes (shared geometry/materials, near-zero draw-call cost).
   * Avenue positions are FIXED constants — no per-chunk side flips — so every
   * chunk seam lines up when a new chunk streams in.
   */
  private addRoadNetwork(chunk: WorldChunk, id: number, chunkCenterZ: number, config: DistrictConfig) {
    const cz = chunkCenterZ;
    const len = this.chunkDepth - 0.4;
    const lineY = -0.06;
    const asphaltY = -0.16;
    const cream = 0xe9e3cd;
    const yellow = 0xf2c14e;
    const crossHalf = config.crossStreetHalf;

    // ---- Grand avenue (central spine under the flight corridor) ----
    const grand = createBox(this.grandAvenueHalf * 2, 0.12, len, ENV_PALETTE.asphalt);
    grand.position.set(0, asphaltY, cz);
    chunk.group.add(grand);

    const grandEdges: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const edge = createBox(0.55, 0.1, len, cream);
      edge.position.set(side * (this.grandAvenueHalf - 1.4), lineY, cz);
      grandEdges.push(edge);
    }
    const mergedGrandEdges = mergeBoxMeshes(grandEdges);
    if (mergedGrandEdges) chunk.group.add(mergedGrandEdges);

    const grandDashes: THREE.Mesh[] = [];
    for (let i = -3; i <= 3; i++) {
      const dash = createBox(0.5, 0.1, 2.6, yellow);
      dash.position.set(0, lineY, cz + i * 20);
      grandDashes.push(dash);
    }
    const mergedGrandDashes = mergeBoxMeshes(grandDashes);
    if (mergedGrandDashes) chunk.group.add(mergedGrandDashes);

    // Warning chevrons just before/after each cross-street crossing (kept
    // unmerged — mergeBoxMeshes ignores rotation). Spaced to the district's
    // cross-street width so they sit on the pavement edge, not on it.
    for (const side of [-1, 1]) {
      for (const zOff of [-(crossHalf + 2), crossHalf + 2]) {
        for (const lane of [-6.5, 6.5]) {
          const chev = createBox(2.6, 0.1, 0.5, yellow);
          chev.position.set(lane, lineY, cz + zOff);
          chev.rotation.y = side * 0.5;
          chunk.group.add(chev);
        }
      }
    }

    // ---- Flanking avenues (fixed at ±sideAvenueX, both sides every chunk) ----
    for (const side of [-1, 1]) {
      const ax = side * this.sideAvenueX;
      const ave = createBox(this.sideAvenueHalf * 2, 0.12, len, ENV_PALETTE.asphaltDark);
      ave.position.set(ax, asphaltY, cz);
      chunk.group.add(ave);

      // Sidewalk + curb on the outer edge only (inner edge faces open ground)
      const sidewalk = createBox(2.2, 0.06, len, config.sidewalk);
      sidewalk.position.set(ax + side * (this.sideAvenueHalf + 2.4), -0.05, cz);
      chunk.group.add(sidewalk);
      const curb = createBox(0.4, 0.2, len, 0x39465c);
      curb.position.set(ax + side * (this.sideAvenueHalf + 3.5), -0.02, cz);
      chunk.group.add(curb);

      const aveEdges: THREE.Mesh[] = [];
      for (const eSide of [-1, 1]) {
        const edge = createBox(0.4, 0.09, len, 0xded8c2);
        edge.position.set(ax + eSide * (this.sideAvenueHalf - 1.1), lineY, cz);
        aveEdges.push(edge);
      }
      const mergedAveEdges = mergeBoxMeshes(aveEdges);
      if (mergedAveEdges) chunk.group.add(mergedAveEdges);

      const aveDashes: THREE.Mesh[] = [];
      for (let i = -3; i <= 3; i++) {
        const dash = createBox(0.4, 0.09, 2.2, yellow);
        dash.position.set(ax, lineY, cz + i * 20 + 10);
        aveDashes.push(dash);
      }
      const mergedAveDashes = mergeBoxMeshes(aveDashes);
      if (mergedAveDashes) chunk.group.add(mergedAveDashes);
    }

    // ---- Cross street (runs along X through every chunk center) — width is
    // the district's seam-safe road tendency: the street is interior to the
    // chunk, so industrial gets wider avenues without breaking chunk seams ----
    const cross = createBox(this.worldHalfWidth * 2, 0.12, crossHalf * 2, ENV_PALETTE.asphaltDark);
    cross.position.set(0, asphaltY, cz);
    chunk.group.add(cross);
    for (const side of [-1, 1]) {
      const walk = createBox(this.worldHalfWidth * 2, 0.06, 2.2, config.sidewalk);
      walk.position.set(0, -0.05, cz + side * (crossHalf + 1.4));
      chunk.group.add(walk);
      const curb = createBox(this.worldHalfWidth * 2, 0.2, 0.4, 0x39465c);
      curb.position.set(0, -0.02, cz + side * (crossHalf + 2.6));
      chunk.group.add(curb);
    }

    const crossDashes: THREE.Mesh[] = [];
    for (let i = -14; i <= 14; i++) {
      if (Math.abs(i) % 2 === 1) continue; // sparse dashes
      const dash = createBox(7, 0.09, 1.1, 0xe9df9a);
      dash.position.set(i * 22, lineY, cz);
      crossDashes.push(dash);
    }
    const mergedCrossDashes = mergeBoxMeshes(crossDashes);
    if (mergedCrossDashes) chunk.group.add(mergedCrossDashes);

    // Crosswalks across each avenue where it meets the cross street
    const crosswalks: THREE.Mesh[] = [];
    for (const ax of [0, -this.sideAvenueX, this.sideAvenueX]) {
      const span = (ax === 0 ? this.grandAvenueHalf : this.sideAvenueHalf) * 2 - 2;
      for (const zSide of [-1, 1]) {
        for (let s = 0; s < 4; s++) {
          const stripe = createBox(span, 0.08, 0.7, cream);
          stripe.position.set(ax, lineY, cz + zSide * (crossHalf + 2.4 + s * 1.7));
          crosswalks.push(stripe);
        }
      }
    }
    const mergedCrosswalks = mergeBoxMeshes(crosswalks);
    if (mergedCrosswalks) chunk.group.add(mergedCrosswalks);

    // Small median islands + bushes at the flanking intersections (breathing props)
    const islands: THREE.Mesh[] = [];
    const bushes: THREE.Mesh[] = [];
    for (const ax of [-this.sideAvenueX, this.sideAvenueX]) {
      for (const zSide of [-1, 1]) {
        const bx = ax + (ax > 0 ? -1 : 1) * 2.4;
        const bz = cz + zSide * (crossHalf + 2.8);
        const island = createBox(1.7, 0.55, 1.7, 0x4c525e);
        island.position.set(bx, 0.16, bz);
        islands.push(island);
        const bush = createBox(1.0, 0.9, 1.0, 0x2f7a4a);
        bush.position.set(bx, 0.85, bz);
        bushes.push(bush);
      }
    }
    const mergedIslands = mergeBoxMeshes(islands);
    if (mergedIslands) chunk.group.add(mergedIslands);
    const mergedBushes = mergeBoxMeshes(bushes);
    if (mergedBushes) chunk.group.add(mergedBushes);

    // ---- Service road: dirt industrial lane, fixed alignment at x = +96 ----
    if (
      config.name === 'industrial' ||
      config.name === 'base' ||
      config.name === 'ruins' ||
      config.name === 'desert'
    ) {
      const service = createBox(this.serviceRoadHalf * 2, 0.1, len, 0x55442e);
      service.position.set(this.serviceRoadX, -0.12, cz);
      chunk.group.add(service);
      const ruts: THREE.Mesh[] = [];
      for (const side of [-1, 1]) {
        const rut = createBox(0.5, 0.08, len, 0x3a2f1f);
        rut.position.set(this.serviceRoadX + side * 1.6, -0.05, cz);
        ruts.push(rut);
      }
      const mergedRuts = mergeBoxMeshes(ruts);
      if (mergedRuts) chunk.group.add(mergedRuts);
    }

    // ---- Street lamps along the grand avenue (modular prop library) ----
    for (let i = 0; i < 6; i++) {
      const seed = this.hash(id, 109 + i * 7);
      const side = seed > 0.5 ? 1 : -1;
      const lampX = side * (this.grandAvenueHalf + 2.2 + this.hash(id, 113 + i * 3) * 3);
      const lampZ = cz - this.chunkDepth * 0.42 + this.hash(id, 127 + i * 5) * this.chunkDepth * 0.84;
      const lamp = buildLightPole(config.name === 'desert');
      lamp.position.set(lampX, 0, lampZ);
      lamp.rotation.y = side > 0 ? 0 : Math.PI; // arm points toward the road
      chunk.group.add(lamp);
    }

    // ---- Traffic: two-way lanes on both flanking avenues + a few on the grand ----
    for (const side of [-1, 1]) {
      const ax = side * this.sideAvenueX;
      for (let i = -2; i <= 2; i++) {
        for (const lane of [4.5, -4.5]) {
          const laneKey = lane > 0 ? (side > 0 ? 7 : 29) : side > 0 ? 13 : 31;
          if (this.hash(id, i * 43 + laneKey) < 0.35) continue;
          const forward = lane > 0; // right lane drives forward (away from player)
          const speed = (forward ? -1 : 1) * (26 + this.hash(id, i * 29 + laneKey) * 16);
          const startZ = cz - this.chunkDepth * 0.5 + this.hash(id, i * 17 + laneKey) * this.chunkDepth * 0.9;
          const carX = ax + lane + (this.hash(id, i * 7 + laneKey) - 0.5) * 1.4;
          this.addTrafficCar(chunk, id, carX, startZ, speed, cz, laneKey);
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const laneKey = 43 + i * 2;
      if (this.hash(id, i * 57 + laneKey) < 0.4) continue;
      const side = this.hash(id, i * 61 + laneKey) > 0.5 ? 1 : -1;
      const forward = this.hash(id, i * 67 + laneKey) > 0.5;
      const speed = (forward ? -1 : 1) * (24 + this.hash(id, i * 71 + laneKey) * 12);
      const startZ = cz - this.chunkDepth * 0.5 + this.hash(id, i * 73 + laneKey) * this.chunkDepth * 0.9;
      const carX = side * 6.5 + (this.hash(id, i * 79 + laneKey) - 0.5) * 1.2;
      this.addTrafficCar(chunk, id, carX, startZ, speed, cz, laneKey);
    }
  }

  /** Blend two hex colors by t (0..1) — used for seam transitions. */
  private mixColor(a: number, b: number, t: number): number {
    const ca = new THREE.Color(a);
    ca.lerp(new THREE.Color(b), t);
    return ca.getHex();
  }

  private addProceduralStructure(
    chunk: WorldChunk,
    world: CANNON.World,
    config: DistrictConfig,
    prevConfig: DistrictConfig,
    nextConfig: DistrictConfig,
    x: number,
    z: number,
    gx: number,
    local: number,
  ) {
    const seed = this.hash(chunk.id, gx * 97 + local * 131);
    const palette = config.palette;
    let color = palette[Math.floor(seed * palette.length)];

    // Seam transition (Pass 4): the outer building rows ease toward the
    // neighbor district — palette blends, heights cap — so zones crossfade
    // instead of hard-cutting at the chunk boundary. Mid-chunk is untouched.
    const neighborCfg = local <= -1 ? prevConfig : local >= 2 ? nextConfig : null;
    let seamT = 0;
    if (neighborCfg) {
      const rowsFromSeam = local <= -1 ? local + 2 : 3 - local; // 0 = seam row
      seamT = Math.max(0, (2 - rowsFromSeam) * 0.45);
      if (seamT > 0) {
        const nbPalette = neighborCfg.palette;
        color = this.mixColor(color, nbPalette[Math.floor(seed * nbPalette.length)], seamT);
      }
    }

    // --- Footprint category (SMALL / MEDIUM / LARGE) ---
    // Combat-corridor band: everything inside |x| < 58 is forced SMALL + low so
    // the flight lane and avenues never turn into narrow building canyons.
    const corridor = Math.abs(x) < 58;
    let tier = footprintTier(this.hash(chunk.id, gx * 173 + local * 211), config.footprintWeights);
    if (corridor) tier = 0;
    else if (tier === 2 && Math.abs(x) < 72) tier = 1; // LARGE footprints stay far from the roads

    // Dimensions per tier (the helicopter is ~8 units wide — SMALL is the default)
    const wHash = this.hash(chunk.id, gx + local * 3);
    const dHash = this.hash(chunk.id, gx * 3 - local);
    let width: number;
    let depth: number;
    if (tier === 0) {
      width = 4.5 + wHash * 3.5; // SMALL  4.5-8
      depth = 4.5 + dHash * 3.5;
    } else if (tier === 1) {
      width = 8 + wHash * 4; // MEDIUM 8-12
      depth = 8 + dHash * 4;
    } else {
      width = 12 + wHash * 5; // LARGE  12-17
      depth = 12 + dHash * 5;
    }
    width = this.snap(width);
    depth = this.snap(depth);

    // Flanking avenues stay visually clear: buildings on the adjacent row are
    // SMALL and set back off the right-of-way so the sidewalk + curb always
    // read as a clean strip between the avenue and the street-side buildings.
    const nearAvenue = Math.abs(Math.abs(x) - this.sideAvenueX) < 14;
    if (nearAvenue) {
      tier = 0;
      width = this.snap(4.5 + wHash * 3.5); // shrink back to SMALL
      depth = this.snap(4.5 + dHash * 3.5);
      const side = x < 0 ? -1 : 1;
      const minInner = this.sideAvenueX + this.sideAvenueHalf + 4; // 4u setback
      if (Math.abs(x) < minInner + width * 0.5) {
        x = side * (minInner + width * 0.5);
      }
    }

    // Service road stays clear: cells beside it shrink to SMALL and set back
    // off the dirt lane (applies on both sides; harmless where no road exists).
    const nearService = Math.abs(Math.abs(x) - this.serviceRoadX) < 18;
    if (nearService) {
      if (tier !== 0) {
        tier = 0;
        width = this.snap(4.5 + wHash * 3.5);
        depth = this.snap(4.5 + dHash * 3.5);
      }
      if (x > 0) {
        const minInner = this.serviceRoadX + this.serviceRoadHalf + 1.5; // 108.5
        if (x < minInner + width * 0.5) x = minInner + width * 0.5;
      }
    }

    // --- Height distribution: mostly low/medium, occasional towers, rare landmarks ---
    const [hMin, hMax] = config.heightBand;
    const [sMin, sMax] = config.skyscraperHeight;
    const towerRoll = this.hash(chunk.id, gx * 61 + local * 7);
    const skyscraper =
      tier >= 1 && towerRoll > 1 - config.skyscraperChance && Math.abs(x) > 60;
    let height: number;
    if (skyscraper) {
      height = this.snap(sMin + seed * (sMax - sMin)); // rare tall towers
    } else if (tier === 0) {
      height = this.snap(hMin + seed * (hMax - hMin) * 0.4); // SMALL stays low
    } else if (tier === 1) {
      height = this.snap(hMin + (hMax - hMin) * 0.25 + seed * (hMax - hMin) * 0.75); // MEDIUM mid band
    } else {
      height = this.snap(Math.max(hMin + 2, hMax - 2) + seed * 4); // LARGE upper band (no tiers)
    }
    if (corridor) height = Math.min(height, 10); // gentle 2-3 story canyon walls

    // Seam transition: cap heights near the boundary so a downtown tower never
    // looms directly beside a low residential row in the next chunk.
    if (seamT > 0 && neighborCfg) {
      const seamCap = neighborCfg.heightBand[1] + 6;
      if (height > seamCap) height = this.snap(seamCap - seed * 2);
    }

    // Core body + cap + structural forms share one color -> merged into a
    // single draw call. The silhouette language (Pass 6) composes from a small
    // set of modular forms; every part shrinks inside the collision footprint,
    // so the conservative collision box / getHeightAt / damage / destruction
    // behavior is untouched.
    const coreParts: THREE.Mesh[] = [];
    const extraMeshes: THREE.Mesh[] = [];
    const building = createBox(width, height, depth, color);
    building.position.set(x, height / 2, z);
    coreParts.push(building);

    const cap = createBox(width + 1.8, 1, depth + 1.8, color);
    cap.position.set(x, height + 0.5, z);
    coreParts.push(cap);

    const archetype = buildingArchetype({
      district: config.name,
      tier,
      skyscraper,
      height,
      roll: seed,
    });
    let roofY = height + 1.8; // rooftop spawn height (raised above any structure)

    if (archetype === 'steppedTower' && height > 20) {
      // Setback tower: shrinking tiers + spire + blinking aviation light.
      let tierWidth = width * 0.72;
      let tierDepth = depth * 0.72;
      let tierY = height + 0.5;
      const tierCount = 1 + Math.floor(seed * 3);
      for (let i = 0; i < tierCount; i++) {
        const tierH = this.snap(5 + this.hash(chunk.id, i * 17 + 5) * 7);
        const tier = createBox(tierWidth, tierH, tierDepth, color);
        tier.position.set(x, tierY + tierH / 2, z);
        coreParts.push(tier);

        // A thin lit band on each tier catches the eye at dusk
        const band = createGlowBox(tierWidth * 0.9, 0.3, tierDepth * 0.9, config.windowColor, 0.42);
        band.position.set(x, tierY + tierH - 0.1, z);
        chunk.group.add(band);
        extraMeshes.push(band);

        tierY += tierH;
        tierWidth *= 0.78;
        tierDepth *= 0.78;
      }
      roofY = tierY + 1.8; // enemies/turrets spawn on the tier top, not inside it
      // Spire + blinking aviation warning light on top
      const spireH = this.snap(7 + seed * 9);
      const spire = createBox(0.6, spireH, 0.6, 0x151b2c);
      spire.position.set(x, tierY + spireH / 2, z);
      chunk.group.add(spire);
      extraMeshes.push(spire);

      const warnLight = createGlowBox(1.0, 0.4, 1.0, 0xff3344, 0.95);
      warnLight.position.set(x, tierY + spireH + 0.3, z);
      warnLight.userData.phase = seed * Math.PI * 2;
      chunk.group.add(warnLight);
      this.chunkBeacons.get(chunk.id)?.push(warnLight);
      extraMeshes.push(warnLight);
    } else if (archetype === 'office') {
      // Narrow office tower: a crown cap steps the head above the body.
      const crown = createBox(width * 0.8, 1.6, depth * 0.8, color);
      crown.position.set(x, height + 1.6, z);
      coreParts.push(crown);
      roofY = height + 3.6;
    } else if (archetype === 'slab' || (archetype === 'resBlock' && tier >= 1)) {
      // Slab / apartment block: a corner mechanical penthouse breaks the flat
      // roofline while leaving the center clear for props and turrets. Only on
      // MEDIUM+ footprints — small resBlocks stay plain so a centered turret
      // or prop never grazes the penthouse edge.
      const side = seed > 0.5 ? 1 : -1;
      const pent = createBox(width * 0.32, 1.8, depth * 0.32, color);
      pent.position.set(x + side * width * 0.28, height + 1.4, z + side * depth * 0.28);
      coreParts.push(pent);
      roofY = height + 3.5;
    } else if (archetype === 'warehouse') {
      // Warehouse: a low ridge running the length reads as a shed roof.
      const ridge = createBox(width * 0.92, 2.2, depth * 0.5, color);
      ridge.position.set(x, height + 1.1, z);
      coreParts.push(ridge);
      roofY = height + 3.4;
    } else if (archetype === 'factory') {
      // Factory: sawtooth parapet boxes + a corner chimney.
      for (let i = 0; i < 3; i++) {
        const toothH = this.snap(1.8 + this.hash(chunk.id, i * 31 + 7) * 1.4);
        const tooth = createBox(width * 0.26, toothH, depth * 0.9, color);
        tooth.position.set(x + (i - 1) * width * 0.34, height + 0.9 + (i === 1 ? 0.5 : 0), z);
        coreParts.push(tooth);
      }
      // Chimney at the far back corner — clear of the sawtooth teeth (they run
      // the full depth at x ± 0.34w, so a centered or front-side chimney would
      // be buried inside the tooth geometry).
      const chimney = createBox(0.7, 4.5, 0.7, color);
      chimney.position.set(x - width * 0.48, height + 2.25, z - depth * 0.48);
      coreParts.push(chimney);
      roofY = height + 5.7;
    } else if (archetype === 'parking') {
      // Parking structure: two stacked setbacks read as ramps.
      const p1 = createBox(width * 0.85, 2.2, depth * 0.85, color);
      p1.position.set(x, height + 1.1, z);
      coreParts.push(p1);
      const p2 = createBox(width * 0.7, 1.8, depth * 0.7, color);
      p2.position.set(x, height + 3.1, z);
      coreParts.push(p2);
      roofY = height + 5.2;
    } else if (archetype === 'comm') {
      // Communications building: a corner mast + dish above the block.
      const mast = createBox(0.5, 6, 0.5, color);
      mast.position.set(x + width * 0.3, height + 3, z + depth * 0.3);
      coreParts.push(mast);
      const dish = createBox(1.6, 0.5, 1.6, color);
      dish.position.set(x - width * 0.25, height + 0.75, z - depth * 0.25);
      coreParts.push(dish);
      roofY = height + 7.2;
    }
    // 'plain' keeps exactly the old box + cap silhouette.

    const facadeDetails = this.addBuildingFacadeDetails(
      chunk,
      config,
      x,
      z,
      height,
      width,
      depth,
      seed,
      archetype,
    );

    // Rooftop props + turrets need a flat, unobstructed roof center. Archetypes
    // with raised structure (office crown, warehouse ridge, factory parapet,
    // parking steps, tower tiers) skip both — they already carry their own
    // silhouette. Corridor roofs stay clean for flight readability.
    const turretRoll = this.hash(chunk.id, gx * 61 + local * 73);
    const developed = config.name !== 'desert' && config.name !== 'forest';
    const flatRoof =
      archetype === 'plain' ||
      archetype === 'slab' ||
      archetype === 'resBlock' ||
      archetype === 'comm';
    const turretHere =
      developed && flatRoof && !skyscraper && height < 38 && turretRoll > 0.45 && Math.abs(x) > 38;
    const rooftopMeshes =
      seed > 1 - config.rooftopClutter && flatRoof && !skyscraper && Math.abs(x) > 34
        ? this.addRooftopDetail(chunk, config, x, z, height, width, depth, seed, turretHere)
        : [];

    const body = this.addStaticBox(
      world,
      width + 1.8,
      height + 1,
      depth + 1.8,
      x,
      (height + 1) / 2,
      z,
      true,
    );
    const maxHp = 45 + height * 2.0;
    chunk.bodies.push(body);

    // Merge same-color core parts into one mesh (1 draw call instead of 2-6).
    const mergedCore = mergeBoxMeshes(coreParts);
    if (mergedCore) {
      chunk.group.add(mergedCore);
    } else {
      for (const part of coreParts) chunk.group.add(part);
    }

    const block: CityBlock = {
      x,
      z,
      width: width + 1.8,
      depth: depth + 1.8,
      height: height + 1,
      chunkId: chunk.id,
      meshes: [mergedCore ?? coreParts[0], ...extraMeshes, ...facadeDetails, ...rooftopMeshes],
      body,
      hp: maxHp,
      maxHp,
      destroyed: false,
    };
    chunk.blocks.push(block);
    chunk.spots.push({ x, y: roofY, z });

    // Ambient rooftop turrets on mid-rise buildings in developed zones (~55% of eligible roofs),
    // kept away from the flight corridor and tiered skyscrapers (would clip into the tiers).
    if (turretHere) {
      const turret = new Turret(chunk.group, x, height + 1.35, z, chunk.id, block);
      this.chunkTurrets.get(chunk.id)?.push(turret);
    }
  }

  private addBuildingFacadeDetails(
    chunk: WorldChunk,
    config: DistrictConfig,
    x: number,
    z: number,
    height: number,
    width: number,
    depth: number,
    seed: number,
    archetype: BuildingArchetype,
  ) {
    const details: THREE.Mesh[] = [];
    const isLitZone = config.name !== 'desert' && config.name !== 'forest';
    const windowColor = config.windowColor;
    const trimColor = config.trimColor;
    const bandCount = isLitZone ? Math.max(1, Math.min(3, Math.floor(height / 8))) : 1;

    for (let i = 0; i < bandCount; i++) {
      const y = 3.4 + i * (height / (bandCount + 0.45));
      const bandHeight = isLitZone ? 0.34 : 0.22;
      // Pass 8: windows stay controlled accents — fewer lit bands, softer
      // opacity — so facades read as texture, never as glowing grids.
      const lit = isLitZone && this.hash(chunk.id, Math.floor(seed * 1000) + i * 29) > 0.3;
      const materialColor = lit ? windowColor : trimColor;
      const opacity = lit ? 0.5 : 0.22;

      const front = createGlowBox(width * 0.62, bandHeight, 0.08, materialColor, opacity);
      front.position.set(x, y, z + depth * 0.5 + 0.08);
      chunk.group.add(front);
      details.push(front);

      // Side bands only off the corridor — less near-field clutter in the lane
      if (isLitZone && i % 2 === 0 && Math.abs(x) > 34) {
        const side = seed > 0.5 ? 1 : -1;
        const sideBand = createGlowBox(0.08, bandHeight, depth * 0.42, materialColor, opacity * 0.3);
        sideBand.position.set(x + side * (width * 0.5 + 0.08), y, z);
        chunk.group.add(sideBand);
        details.push(sideBand);
      }
    }

    if (height > 14 && seed > 0.42) {
      const beacon = createGlowBox(1.2, 0.5, 1.2, seed > 0.7 ? 0xff3344 : 0xffe66d, 0.9);
      beacon.position.set(x, height + 1.22, z + depth * 0.18);
      beacon.userData.phase = seed * Math.PI * 2;
      chunk.group.add(beacon);
      this.chunkBeacons.get(chunk.id)?.push(beacon);
      details.push(beacon);
    }

    // Archetype accents (Pass 6): a few cheap emissive strips that make the
    // form read at a glance without hundreds of window meshes.
    const frontZ = z + depth * 0.5 + 0.08;
    if (archetype === 'office' && isLitZone) {
      // Signage panel high on the front face of office towers
      const sign = createGlowBox(width * 0.5, 1.1, 0.08, windowColor, 0.72);
      sign.position.set(x, height * 0.72, frontZ);
      chunk.group.add(sign);
      details.push(sign);
    } else if (archetype === 'parking') {
      // Front floor bands read as parking ramps
      for (let i = 0; i < 3; i++) {
        const fy = 3.4 + i * (height / 3.6);
        const band = createGlowBox(width * 0.6, 0.26, 0.08, trimColor, 0.4);
        band.position.set(x, fy, frontZ);
        chunk.group.add(band);
        details.push(band);
      }
    } else if (archetype === 'resBlock' && isLitZone) {
      // Balcony trim strips near the top of apartment blocks
      const trim = createGlowBox(width * 0.72, 0.3, depth * 0.72, trimColor, 0.35);
      trim.position.set(x, height - 0.6, z);
      chunk.group.add(trim);
      details.push(trim);
    }

    return details;
  }

  private addRooftopDetail(
    chunk: WorldChunk,
    config: DistrictConfig,
    x: number,
    z: number,
    height: number,
    width: number,
    depth: number,
    seed: number,
    hasTurret: boolean,
  ): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    const weights = config.rooftopProps;
    const types = (Object.keys(weights) as RooftopPropType[]).filter((k) => weights[k] > 0);
    if (types.length === 0) return meshes;
    let total = 0;
    for (const k of types) total += weights[k];
    let roll = seed * total;
    let kind: RooftopPropType = types[types.length - 1];
    for (const k of types) {
      roll -= weights[k];
      if (roll <= 0) {
        kind = k;
        break;
      }
    }
    // Turret avoidance: center-occupying props never share a roof with a turret.
    if (hasTurret && (kind === 'helipad' || kind === 'waterTank' || kind === 'maintenanceHut')) {
      kind = seed > 0.5 ? 'acUnit' : 'vent';
    }

    // Modular prop library — shared geometry/materials, variant from the seed.
    const group = buildRooftopProp(kind, seed, width, depth, config.accentColor);
    // Turrets own the roof center — offset the prop group so they never clip.
    const propX = x + (hasTurret ? width * 0.22 : 0);
    group.position.set(propX, height + 0.55, z);
    chunk.group.add(group);
    // Real rooftop helipads double as extraction LZs — record the pad's world
    // position (roof surface + pad height) so the spawner can land on it.
    if (kind === "helipad") {
      chunk.spots.push({ x: propX, y: height + 0.8, z: chunk.id * this.chunkDepth + z, helipad: true });
    }
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      meshes.push(child);
      child.userData.propGroup = group; // collapse animates the group as a unit
      if (child.userData.isBeacon) this.chunkBeacons.get(chunk.id)?.push(child);
    });
    return meshes;
  }

  // ---------------------------------------------------------------------------
  // District landmarks — one signature structure per chunk (Phase 2)
  // ---------------------------------------------------------------------------

  private addDistrictLandmark(chunk: WorldChunk, world: CANNON.World, id: number, config: DistrictConfig) {
    // Pass 9: the scene rhythm is the PRIMARY rarity control — landmarks only
    // spawn in rhythm 'landmark' chunks (~1 in 7, never adjacent), so they act
    // as navigation memory instead of filling every chunk of a district.
    if (sceneRhythmForChunk(id) !== 'landmark') return;
    // Secondary gate: rare districts (mesa, giant tree) skip some landmark
    // chunks and read as open park space instead.
    if (this.hash(id, 409) > config.landmarkChance) return;
    const chunkCenterZ = chunk.id * this.chunkDepth;
    // The military district alternates between a radar installation and a
    // helipad landing tower so repeated base chunks don't repeat themselves.
    const landmark =
      config.name === 'base' && this.hash(id, 811) > 0.5 ? 'helipadTower' : config.landmark;
    switch (landmark) {
      case 'centralTower':
        this.buildCentralTower(chunk, world, id, chunkCenterZ);
        break;
      case 'observationTower':
        this.buildObservationTower(chunk, world, id, chunkCenterZ);
        break;
      case 'coolingTowers':
        this.buildCoolingTowers(chunk, world, id, chunkCenterZ);
        break;
      case 'clockTower':
        this.buildClockTower(chunk, world, id, chunkCenterZ);
        break;
      case 'marina':
        this.buildMarina(chunk, world, id, chunkCenterZ);
        break;
      case 'radarBase':
        this.buildRadarBase(chunk, world, id, chunkCenterZ);
        break;
      case 'mesa':
        this.buildMesa(chunk, world, id, chunkCenterZ);
        break;
      case 'giantTree':
        this.buildGiantTree(chunk, world, id, chunkCenterZ);
        break;
      case 'fallenTower':
        this.buildFallenTower(chunk, world, id, chunkCenterZ);
        break;
      case 'helipadTower':
        this.buildHelipadTower(chunk, world, id, chunkCenterZ);
        break;
    }
  }

  /** True if a (w × d) footprint at (x, z) stays off every road in the hierarchy. */
  private roadClear(x: number, z: number, w: number, d: number, crossHalf: number) {
    const hw = w * 0.5;
    const hd = d * 0.5;
    // Grand avenue + flanking avenues (run along Z)
    for (const ax of [0, -this.sideAvenueX, this.sideAvenueX]) {
      const half = ax === 0 ? this.grandAvenueHalf : this.sideAvenueHalf;
      if (Math.abs(x - ax) < half + hw) return false;
    }
    // Cross street (runs along X through every chunk center)
    const nearestCross = Math.round(z / this.chunkDepth) * this.chunkDepth;
    if (Math.abs(z - nearestCross) < crossHalf + hd) return false;
    // Service road
    if (Math.abs(Math.abs(x) - this.serviceRoadX) < this.serviceRoadHalf + hw) return false;
    return true;
  }

  /**
   * Pick the least-crowded landmark spot off the flight corridor (|x| in
   * [56, 98]) and clear a plaza around it. Landmarks ALWAYS place — a dense
   * district just gets a small plaza carved out instead of failing to build.
   */
  private findLandmarkSpot(chunk: WorldChunk, world: CANNON.World, id: number, w: number, d: number) {
    const chunkCenterZ = chunk.id * this.chunkDepth;
    const crossHalf = DISTRICT_CONFIGS[districtForChunk(chunk.id)].crossStreetHalf;
    let best: { x: number; z: number } | null = null;
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 16; attempt++) {
      const side = attempt % 2 === 0 ? 1 : -1;
      const x = side * (56 + this.hash(id, 331 + attempt * 13) * 42);
      const z = chunkCenterZ - 30 + this.hash(id, 347 + attempt * 7) * 60;
      if (!this.roadClear(x, z, w, d, crossHalf)) continue;
      let score = 0;
      for (const block of chunk.blocks) {
        if (
          Math.abs(x - block.x) < (w + block.width) * 0.5 + 2 &&
          Math.abs(z - block.z) < (d + block.depth) * 0.5 + 2
        ) {
          score += 1 + block.height * 0.1;
        }
      }
      if (score < bestScore) {
        bestScore = score;
        best = { x, z };
      }
      if (score === 0) break;
    }
    if (!best) best = { x: 78, z: chunkCenterZ + 40 }; // fallback — never fail

    // Carve the plaza: remove any buildings overlapping the landmark footprint.
    for (let i = chunk.blocks.length - 1; i >= 0; i--) {
      const block = chunk.blocks[i];
      if (
        Math.abs(best.x - block.x) >= (w + block.width) * 0.5 + 1.5 ||
        Math.abs(best.z - block.z) >= (d + block.depth) * 0.5 + 1.5
      ) {
        continue;
      }
      // Kill any rooftop turret on this building — it would otherwise float
      // in the plaza with no host and keep shooting the player.
      for (const t of this.chunkTurrets.get(chunk.id) ?? []) {
        if (t.block === block) {
          t.active = false;
          t.mesh.visible = false;
        }
      }
      // Drop the building's rooftop spawn spot so enemies don't spawn mid-air.
      for (let s = chunk.spots.length - 1; s >= 0; s--) {
        if (
          Math.abs(chunk.spots[s].x - block.x) < 0.5 &&
          Math.abs(chunk.spots[s].z - block.z) < 0.5
        ) {
          chunk.spots.splice(s, 1);
        }
      }
      for (const mesh of block.meshes) mesh.visible = false;
      if (block.body) world.removeBody(block.body);
      const bi = block.body ? chunk.bodies.indexOf(block.body) : -1;
      if (bi >= 0) chunk.bodies.splice(bi, 1);
      chunk.blocks.splice(i, 1);
    }
    return best;
  }

  /** Register landmark meshes as a solid, destroyable block (reuses all destruction paths). */
  private addLandmarkBlock(
    chunk: WorldChunk,
    world: CANNON.World,
    x: number,
    z: number,
    width: number,
    depth: number,
    height: number,
    hp: number,
    meshes: THREE.Mesh[],
    spotY?: number,
    kind?: string,
  ) {
    const body = this.addStaticBox(world, width, height, depth, x, height / 2, z, true);
    chunk.bodies.push(body);
    const block: CityBlock = {
      x,
      z,
      width,
      depth,
      height,
      chunkId: chunk.id,
      meshes,
      body,
      hp,
      maxHp: hp,
      destroyed: false,
      landmarkKind: kind,
    };
    chunk.blocks.push(block);
    this.landmarkSet.add(block);
    if (spotY !== undefined) chunk.spots.push({ x, y: spotY, z });
  }

  private buildCentralTower(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 22, 18);
    const meshes: THREE.Mesh[] = [];
    const tiers = [
      { w: 16, h: 16, y: 8 },
      { w: 12, h: 13, y: 8 + 16 + 6.5 },
      { w: 8.5, h: 11, y: 8 + 16 + 13 + 5.5 },
      { w: 5.5, h: 10, y: 8 + 16 + 13 + 11 + 5 },
    ];
    for (const t of tiers) {
      const box = createBox(t.w, t.h, t.w, 0x3d4f8f);
      box.position.set(x, t.y, z);
      chunk.group.add(box);
      meshes.push(box);
      const band = createGlowBox(t.w * 0.92, 0.32, t.w * 0.92, 0x9ff7ff, 0.5);
      band.position.set(x, t.y + t.h / 2 - 0.15, z);
      chunk.group.add(band);
      meshes.push(band);
    }
    // Antenna spire + aviation light
    const spire = createBox(0.8, 14, 0.8, 0x151b2c);
    spire.position.set(x, 58, z);
    chunk.group.add(spire);
    meshes.push(spire);
    const light = createGlowBox(1.1, 0.5, 1.1, 0xff3344, 0.95);
    light.position.set(x, 65.5, z);
    light.userData.phase = this.hash(id, 419) * Math.PI * 2;
    chunk.group.add(light);
    this.chunkBeacons.get(chunk.id)?.push(light);
    meshes.push(light);
    const topY = 66;
    this.addLandmarkBlock(chunk, world, x, z, 16, 18, topY, 320, meshes, topY + 1.5);
  }

  private buildObservationTower(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 14, 14);
    const meshes: THREE.Mesh[] = [];
    const shaft = createBox(3.4, 30, 3.4, 0x59606e);
    shaft.position.set(x, 15, z);
    chunk.group.add(shaft);
    meshes.push(shaft);
    const deck = createBox(11, 1.2, 11, 0x67707e);
    deck.position.set(x, 31.2, z);
    chunk.group.add(deck);
    meshes.push(deck);
    const rail = createGlowBox(11.4, 0.5, 11.4, 0x9ff7ff, 0.6);
    rail.position.set(x, 32.2, z);
    chunk.group.add(rail);
    meshes.push(rail);
    const light = createGlowBox(1, 0.4, 1, 0xffe66d, 0.9);
    light.position.set(x, 33.5, z);
    light.userData.phase = this.hash(id, 421) * Math.PI * 2;
    chunk.group.add(light);
    this.chunkBeacons.get(chunk.id)?.push(light);
    meshes.push(light);
    this.addLandmarkBlock(chunk, world, x, z, 14, 14, 34, 260, meshes, 33.8);
  }

  /**
   * Military LZ landmark (Pass 9): a tapered truss tower capped with a lit
   * helipad deck and H marking — instantly readable from the air, and on-theme
   * for a helicopter game. Edge lights blink via the chunk beacon system.
   */
  private buildHelipadTower(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 15, 15);
    const meshes: THREE.Mesh[] = [];
    // Tapered shaft — three stacked segments read as a truss tower.
    const segs = [
      { w: 4.6, h: 14, y: 7 },
      { w: 3.9, h: 14, y: 21 },
      { w: 3.2, h: 15, y: 35.5 },
    ];
    for (const s of segs) {
      const seg = createBox(s.w, s.h, s.w, 0x3a4048);
      seg.position.set(x, s.y, z);
      chunk.group.add(seg);
      meshes.push(seg);
      const ring = createGlowBox(s.w + 0.6, 0.3, s.w + 0.6, 0x9fd0e8, 0.35);
      ring.position.set(x, s.y + s.h / 2 - 0.15, z);
      chunk.group.add(ring);
      meshes.push(ring);
    }
    // Helipad deck + H landing marking
    const deckY = 44.2;
    const deck = createBox(13, 1, 13, 0x555a61);
    deck.position.set(x, deckY, z);
    chunk.group.add(deck);
    meshes.push(deck);
    const hBar = createGlowBox(7.4, 0.4, 1.4, 0xffe66d, 0.85);
    hBar.position.set(x, deckY + 0.65, z);
    chunk.group.add(hBar);
    meshes.push(hBar);
    const hStem = createGlowBox(1.4, 0.4, 7.4, 0xffe66d, 0.85);
    hStem.position.set(x, deckY + 0.65, z);
    chunk.group.add(hStem);
    meshes.push(hStem);
    // Blinking edge lights at the deck corners
    for (const [dx, dz] of [[-5.6, -5.6], [5.6, -5.6], [-5.6, 5.6], [5.6, 5.6]]) {
      const e = createGlowBox(0.9, 0.4, 0.9, 0x35e66d, 0.9);
      e.position.set(x + dx, deckY + 0.55, z + dz);
      e.userData.phase = this.hash(id, dx * 3 + dz * 7 + 97) * Math.PI * 2;
      chunk.group.add(e);
      this.chunkBeacons.get(chunk.id)?.push(e);
      meshes.push(e);
    }
    // Beacon mast above the deck
    const mast = createBox(0.7, 3, 0.7, 0x20242c);
    mast.position.set(x, deckY + 2.5, z);
    chunk.group.add(mast);
    meshes.push(mast);
    const light = createGlowBox(1, 0.4, 1, 0xff3344, 0.95);
    light.position.set(x, deckY + 4.3, z);
    light.userData.phase = this.hash(id, 831) * Math.PI * 2;
    chunk.group.add(light);
    this.chunkBeacons.get(chunk.id)?.push(light);
    meshes.push(light);
    const topY = deckY + 4.6;
    this.addLandmarkBlock(chunk, world, x, z, 13, 13, topY, 300, meshes, deckY + 0.6, "HELIPAD_TOWER");
  }

  private buildCoolingTowers(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 34, 22);
    for (const side of [-10, 10]) {
      const meshes: THREE.Mesh[] = [];
      let y = 0;
      const bands = [
        { w: 8, h: 5 },
        { w: 6.5, h: 8 },
        { w: 5.5, h: 9 },
        { w: 7, h: 5 },
      ];
      for (const b of bands) {
        const ring = createBox(b.w, b.h, b.w, 0x6d5c4a);
        ring.position.set(x + side, y + b.h / 2, z);
        chunk.group.add(ring);
        meshes.push(ring);
        y += b.h;
      }
      this.addLandmarkBlock(chunk, world, x + side, z, 10, 10, 27, 190, meshes);
    }
    // Twin chimneys with glowing exhaust caps
    for (const cx of [x - 22, x + 22]) {
      const chimney = createBox(2.6, 20, 2.6, 0x3f3a34);
      chimney.position.set(cx, 10, z + 4);
      chunk.group.add(chimney);
      const cap = createGlowBox(3, 1.2, 3, 0xff8f2a, 0.75);
      cap.position.set(cx, 20.8, z + 4);
      cap.userData.phase = this.hash(id, cx > x ? 431 : 433);
      chunk.group.add(cap);
      this.chunkBeacons.get(chunk.id)?.push(cap);
      const blk = {
        x: cx,
        z: z + 4,
        width: 3,
        depth: 3,
        height: 21,
        chunkId: chunk.id,
        meshes: [chimney, cap],
        hp: 90,
        maxHp: 90,
        destroyed: false,
      } as CityBlock;
      chunk.blocks.push(blk);
      const body = this.addStaticBox(world, 4, 21, 4, cx, 10.5, z + 4, true);
      chunk.bodies.push(body);
      blk.body = body;
    }
  }

  private buildClockTower(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 16, 14);
    const meshes: THREE.Mesh[] = [];
    const base = createBox(7, 11, 7, 0x9a6b4f);
    base.position.set(x, 5.5, z);
    chunk.group.add(base);
    meshes.push(base);
    const clock = createBox(8.5, 4.5, 8.5, 0xb07c57);
    clock.position.set(x, 13.5, z);
    chunk.group.add(clock);
    meshes.push(clock);
    // Four glowing clock faces
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const face = createGlowBox(2.2, 2.2, 0.25, 0xfff3c4, 0.95);
      face.position.set(x + dx * 4.4, 13.5, z + dz * 4.4);
      chunk.group.add(face);
      meshes.push(face);
    }
    const spire = createBox(2, 9, 2, 0x7d543d);
    spire.position.set(x, 20.5, z);
    chunk.group.add(spire);
    meshes.push(spire);
    const light = createGlowBox(1, 0.4, 1, 0xffe66d, 0.9);
    light.position.set(x, 25.5, z);
    light.userData.phase = this.hash(id, 437) * Math.PI * 2;
    chunk.group.add(light);
    this.chunkBeacons.get(chunk.id)?.push(light);
    meshes.push(light);
    this.addLandmarkBlock(chunk, world, x, z, 16, 14, 26, 240, meshes, 26.5);
  }

  private buildMarina(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 30, 20);
    const meshes: THREE.Mesh[] = [];
    const pier = createBox(26, 1.2, 10, 0x6f6a5e);
    pier.position.set(x, 0.6, z);
    chunk.group.add(pier);
    meshes.push(pier);
    const deck = createBox(24, 0.4, 8, 0x8a8577);
    deck.position.set(x, 1.4, z);
    chunk.group.add(deck);
    meshes.push(deck);
    const boatColors = [0x992222, 0x225599, 0xf2f2f2];
    for (let i = 0; i < 3; i++) {
      const bx = x - 8 + i * 8 + (this.hash(id, 449 + i) - 0.5) * 2;
      const hull = createBox(2.6, 1.6, 6.5, boatColors[i]);
      hull.position.set(bx, 2.2, z + 7);
      chunk.group.add(hull);
      meshes.push(hull);
      const mast = createBox(0.2, 4.5, 0.2, 0x222222);
      mast.position.set(bx, 4.6, z + 7);
      chunk.group.add(mast);
      meshes.push(mast);
      const bow = createGlowBox(0.4, 0.3, 0.4, i % 2 === 0 ? 0x9ff7ff : 0xff3344, 0.9);
      bow.position.set(bx, 3, z + 9.8);
      chunk.group.add(bow);
      meshes.push(bow);
    }
    this.addLandmarkBlock(chunk, world, x, z, 26, 12, 3, 220, meshes);
  }

  private buildRadarBase(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 26, 22);
    const meshes: THREE.Mesh[] = [];
    const hangar = createBox(16, 8, 12, 0x5a6472);
    hangar.position.set(x - 8, 4, z);
    chunk.group.add(hangar);
    meshes.push(hangar);
    const roof = createBox(17, 1, 13, 0x687182);
    roof.position.set(x - 8, 8.6, z);
    chunk.group.add(roof);
    meshes.push(roof);
    // Radar pedestal + dish with glowing center
    const ped = createBox(3.4, 7, 3.4, 0x323946);
    ped.position.set(x + 9, 3.5, z + 2);
    chunk.group.add(ped);
    meshes.push(ped);
    const dish = createBox(7, 0.6, 1.4, 0x9fd0e8);
    dish.position.set(x + 9, 7.6, z + 2);
    dish.rotation.z = Math.PI / 5;
    chunk.group.add(dish);
    meshes.push(dish);
    const hub = createGlowBox(0.8, 0.8, 0.8, 0xff3344, 0.95);
    hub.position.set(x + 9, 8.1, z + 2);
    hub.userData.phase = this.hash(id, 461);
    chunk.group.add(hub);
    this.chunkBeacons.get(chunk.id)?.push(hub);
    meshes.push(hub);
    this.addLandmarkBlock(chunk, world, x, z, 26, 22, 10, 300, meshes);
  }

  private buildMesa(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 30, 24);
    const meshes: THREE.Mesh[] = [];
    const base = createBox(30, 9, 24, 0xb78f42);
    base.position.set(x, 4.5, z);
    chunk.group.add(base);
    meshes.push(base);
    const top = createBox(16, 5, 12, 0xd2bf77);
    top.position.set(x + 2, 11.5, z - 1);
    chunk.group.add(top);
    meshes.push(top);
    const cap = createBox(9, 3, 7, 0xc3a94e);
    cap.position.set(x + 2, 15.5, z - 1);
    chunk.group.add(cap);
    meshes.push(cap);
    // Palms on the plateau
    for (let i = 0; i < 2; i++) {
      const px = x - 4 + i * 8;
      const trunk = createBox(0.7, 4, 0.7, 0x8a6b3d);
      trunk.position.set(px, 17.5, z + 4);
      chunk.group.add(trunk);
      meshes.push(trunk);
      const fronds = createBox(4, 2.6, 4, 0x4e8a4a);
      fronds.position.set(px, 20.4, z + 4);
      chunk.group.add(fronds);
      meshes.push(fronds);
    }
    const topY = 17;
    this.addLandmarkBlock(chunk, world, x, z, 30, 24, topY, 340, meshes, topY + 1.5);
  }

  private buildGiantTree(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 22, 20);
    const meshes: THREE.Mesh[] = [];
    const trunk = createBox(4.5, 14, 4.5, 0x4a3a28);
    trunk.position.set(x, 7, z);
    chunk.group.add(trunk);
    meshes.push(trunk);
    for (const [dx, dz, s] of [[-5, -3, 11], [5, 2, 12], [0, 5, 9]]) {
      const crown = createBox(s, s, s, 0x2f7a4a);
      crown.position.set(x + dx, 18 + s * 0.35, z + dz);
      chunk.group.add(crown);
      meshes.push(crown);
    }
    const glow = createGlowBox(2.5, 0.5, 2.5, 0x7fe09a, 0.8);
    glow.position.set(x, 26.5, z);
    glow.userData.phase = this.hash(id, 467);
    chunk.group.add(glow);
    this.chunkBeacons.get(chunk.id)?.push(glow);
    meshes.push(glow);
    this.addLandmarkBlock(chunk, world, x, z, 20, 18, 27, 300, meshes, 27);
  }

  private buildFallenTower(chunk: WorldChunk, world: CANNON.World, id: number, chunkCenterZ: number) {
    const { x, z } = this.findLandmarkSpot(chunk, world, id, 20, 18);
    const meshes: THREE.Mesh[] = [];
    const segs = [
      { w: 9, h: 7, y: 3.5, tilt: 0 },
      { w: 7.5, h: 8, y: 11, tilt: 0.07 },
      { w: 6, h: 7, y: 18.5, tilt: 0.16 },
      { w: 4.5, h: 6, y: 25, tilt: 0.26 },
    ];
    for (const s of segs) {
      const seg = createBox(s.w, s.h, s.w, 0x555967);
      seg.position.set(x, s.y, z);
      seg.rotation.z = s.tilt;
      chunk.group.add(seg);
      meshes.push(seg);
      const band = createGlowBox(s.w * 0.9, 0.3, s.w * 0.9, 0x8bd0ff, 0.35);
      band.position.set(x, s.y + s.h * 0.45, z);
      band.rotation.z = s.tilt;
      chunk.group.add(band);
      meshes.push(band);
    }
    // Rubble pile at the base
    for (let i = 0; i < 5; i++) {
      const rb = createBox(1.5 + this.hash(id, 473 + i) * 2.5, 1, 1.5 + this.hash(id, 479 + i) * 2, 0x6f6f78);
      rb.position.set(x + 6 + this.hash(id, 483 + i) * 8, 0.6, z + (this.hash(id, 487 + i) - 0.5) * 8);
      chunk.group.add(rb);
      meshes.push(rb);
    }
    this.addLandmarkBlock(chunk, world, x, z, 18, 16, 28, 260, meshes, 29);
  }

  private addBridge(chunk: WorldChunk, z: number) {
    const bridge = createBox(160, 2, 16, 0x4a5369);
    bridge.position.set(0, 5, z);
    chunk.group.add(bridge);
    for (let i = -3; i <= 3; i++) {
      const support = createBox(2, 10, 2, 0x32394a);
      support.position.set(i * 24, 2.2, z);
      chunk.group.add(support);
    }
  }

  private addSmokeColumn(chunk: WorldChunk, z: number) {
    for (let i = 0; i < 4; i++) {
      const smoke = createBox(5 + i * 2, 6 + i * 3, 5 + i * 2, 0x1f252c);
      // Clone the shared cached material — smoke is translucent, and mutating
      // the shared Lambert entry in place would poison every other mesh using
      // the same color (Pass 10 audit).
      const smokeMat = (smoke.material as THREE.MeshLambertMaterial).clone();
      smokeMat.transparent = true;
      smokeMat.opacity = 0.18;
      smoke.material = smokeMat;
      smoke.position.set(-70 + i * 10, 5 + i * 5, z - 18 + i * 4);
      chunk.group.add(smoke);
    }
  }

  /**
   * Breathing-room dressing for a cell that rolled empty: a parking lot, a
   * rubble-strewn empty lot, a paved courtyard plaza, or bare ground. Purely
   * cosmetic — never a physics body, never a block, so all gameplay queries
   * (getHeightAt / damage / rooftop spots) are untouched.
   */
  // -------------------------------------------------------------------------
  // Street furniture (Pass 5): traffic lights, instanced bollards, road signs,
  // dumpsters and utility boxes. All static — zero per-frame cost. Placement is
  // rule-driven: off the roadway, clear of buildings/roads, district density
  // gates, and a hard per-chunk cap against clutter.
  // -------------------------------------------------------------------------
  private addStreetProps(chunk: WorldChunk, id: number, config: DistrictConfig, cz: number) {
    const crossHalf = config.crossStreetHalf;
    let placed = 0;
    const cap = 22;

    // Traffic lights at the grand-avenue / cross-street crossings, on the road
    // EDGE (never mid-road), facing the avenue traffic.
    if (config.propDensity >= 0.45) {
      for (const side of [-1, 1]) {
        const light = buildTrafficLight();
        light.position.set(side * (this.grandAvenueHalf + 2.2), 0, cz);
        light.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2; // face the road
        chunk.group.add(light);
        placed++;
      }
    }

    // Bollards — one InstancedMesh per chunk (grand avenue edges + crosswalk
    // flanks); density-gated so wilderness districts stay bare.
    const bollards: { x: number; y: number; z: number; ry?: number }[] = [];
    for (const side of [-1, 1]) {
      const bx = side * (this.grandAvenueHalf - 1.2);
      for (let zOff = -52; zOff <= 52; zOff += 10.5) {
        if (Math.abs(zOff) < crossHalf + 4) continue; // keep the crosswalk clear
        if (this.hash(id, 2000 + zOff + side * 7) > config.propDensity) continue;
        bollards.push({ x: bx, y: 0.5, z: cz + zOff + (side > 0 ? 2 : -2) });
      }
    }
    for (const side of [-1, 1]) {
      const ax = side * this.sideAvenueX;
      for (const zSide of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          bollards.push({
            x: ax + side * (this.sideAvenueHalf - 1.2),
            y: 0.5,
            z: cz + zSide * (crossHalf + 3 + i * 1.8),
          });
        }
      }
    }
    addInstancedProps(chunk.group, bollardGeometry, getLowPolyMaterial(PROP_COLORS.concrete), bollards);

    // Road signs on the avenue shoulders
    for (let i = 0; i < 3; i++) {
      if (this.hash(id, 1501 + i * 13) > config.propDensity) continue;
      const sign = buildRoadSign(this.hash(id, 1511 + i * 17) > 0.5);
      const side = this.hash(id, 1523 + i * 19) > 0.5 ? 1 : -1;
      const sx = side * (20 + this.hash(id, 1531 + i * 23) * 4);
      const sz = cz - 45 + this.hash(id, 1543 + i * 29) * 90;
      if (Math.abs(sz - cz) < crossHalf + 3) continue;
      sign.position.set(sx, 0, sz);
      sign.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      chunk.group.add(sign);
      placed++;
      if (placed >= cap) return;
    }

    // Dumpsters + utility boxes on open ground outside the flight corridor
    for (let i = 0; i < 4; i++) {
      if (this.hash(id, 1559 + i * 7) > config.propDensity) continue;
      const side = this.hash(id, 1571 + i * 11) > 0.5 ? 1 : -1;
      const px = side * (62 + this.hash(id, 1583 + i * 13) * 70);
      const pz = cz - 48 + this.hash(id, 1597 + i * 17) * 96;
      if (this.overlapsBuilding(chunk, px, pz, 3, 3)) continue;
      if (!this.roadClear(px, pz, 3, 3, crossHalf)) continue;
      const prop = this.hash(id, 1609 + i * 19) > 0.5 ? buildDumpster() : buildUtilityBox(config.accentColor);
      prop.position.set(px, 0, pz);
      prop.rotation.y = this.hash(id, 1621 + i * 23) * Math.PI;
      chunk.group.add(prop);
      placed++;
      if (placed >= cap) return;
    }
  }

  /** Military yard dressing for base/ruins districts (Pass 5). */
  private addMilitaryProps(chunk: WorldChunk, id: number, config: DistrictConfig, cz: number) {
    const crossHalf = config.crossStreetHalf;
    let placed = 0;
    const cap = 14;

    // Concrete barriers — one InstancedMesh per chunk
    const barriers: { x: number; y: number; z: number; ry?: number }[] = [];
    for (let i = 0; i < 9; i++) {
      if (this.hash(id, 1701 + i * 13) > config.propDensity) continue;
      const side = this.hash(id, 1717 + i * 17) > 0.5 ? 1 : -1;
      const bx = side * (48 + this.hash(id, 1731 + i * 19) * 120);
      const bz = cz - 52 + this.hash(id, 1747 + i * 23) * 104;
      if (this.overlapsBuilding(chunk, bx, bz, 3, 3)) continue;
      if (!this.roadClear(bx, bz, 3, 3, crossHalf)) continue;
      barriers.push({ x: bx, y: 0.35, z: bz, ry: this.hash(id, 1759 + i * 29) * Math.PI });
      placed++;
      if (placed >= cap) break;
    }
    addInstancedProps(chunk.group, barrierGeometry, getLowPolyMaterial(PROP_COLORS.concrete), barriers);

    // Barricades / antenna arrays / floodlights
    for (let i = 0; i < 3; i++) {
      if (this.hash(id, 1777 + i * 7) > config.propDensity) continue;
      const side = this.hash(id, 1789 + i * 11) > 0.5 ? 1 : -1;
      const px = side * (50 + this.hash(id, 1801 + i * 13) * 120);
      const pz = cz - 50 + this.hash(id, 1813 + i * 17) * 100;
      if (this.overlapsBuilding(chunk, px, pz, 3, 3)) continue;
      if (!this.roadClear(px, pz, 3, 3, crossHalf)) continue;
      const which = this.hash(id, 1829 + i * 19);
      const prop =
        which < 0.4
          ? buildBarricade()
          : which < 0.7
            ? buildAntennaArray(Math.floor(this.hash(id, 1841 + i * 23) * 4))
            : buildFloodlight();
      prop.position.set(px, 0, pz);
      prop.rotation.y = this.hash(id, 1853 + i * 29) * Math.PI;
      chunk.group.add(prop);
      placed++;
      if (placed >= cap) break;
    }

    // Striped perimeter markers along the yard
    for (let i = 0; i < 6; i++) {
      if (this.hash(id, 1867 + i * 5) > config.propDensity) continue;
      const side = this.hash(id, 1879 + i * 9) > 0.5 ? 1 : -1;
      const px = side * (46 + this.hash(id, 1891 + i * 15) * 130);
      const pz = cz - 56 + this.hash(id, 1903 + i * 21) * 112;
      if (this.overlapsBuilding(chunk, px, pz, 2, 2)) continue;
      if (!this.roadClear(px, pz, 2, 2, crossHalf)) continue;
      const marker = buildPerimeterMarker();
      marker.position.set(px, 0, pz);
      marker.rotation.y = this.hash(id, 1913 + i * 27) * Math.PI;
      chunk.group.add(marker);
      placed++;
      if (placed >= cap) break;
    }
  }

  /**
   * Light military props in a ring around a ground-level objective (Pass 5).
   * Returns the group so the engine can attach it to the objective's lifecycle
   * (removed when the objective dies). Props use shared geometry/materials.
   */
  /**
   * Type-aware environmental framing for destroyable objectives (Pass 7).
   * Each objective gets a recognizable low-poly emplacement — military pad for
   * SAM sites, technical comm layout for radar towers, supply yard for depots —
   * built from shared cached props. Framing starts ~4.8u out and the instanced
   * barrier ring sits at 6.2u, well clear of the objective's own ~4.4u radius,
   * so the center stays open and attack runs are never blocked by clutter. The
   * group attaches to the city graph and dies with the objective via
   * Objective.propGroup (destroy/cull/reset all detach it).
   */
  addObjectiveProps(x: number, z: number, type: ObjectiveType): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);

    // Shared instanced barrier ring — one draw call, cached geometry/material.
    const barrierTransforms: { x: number; y: number; z: number; ry: number }[] = [];
    const barrierCount = type === ObjectiveType.AMMO_DEPOT ? 3 : 4;
    for (let i = 0; i < barrierCount; i++) {
      const ang = (i / barrierCount) * Math.PI * 2 + 0.6;
      barrierTransforms.push({ x: Math.cos(ang) * 6.2, y: 0.35, z: Math.sin(ang) * 6.2, ry: ang });
    }
    addInstancedProps(g, barrierGeometry, getLowPolyMaterial(PROP_COLORS.concrete), barrierTransforms);

    if (type === ObjectiveType.SAM_SITE) {
      // Military launch pad: dark pad + launch ring + radar/support gear
      const pad = createBox(5.6, 0.16, 5.6, PROP_COLORS.concreteDark);
      pad.position.y = 0.09;
      g.add(pad);
      const padMark = createBox(4.2, 0.05, 4.2, PROP_COLORS.oliveDark);
      padMark.position.y = 0.18;
      g.add(padMark);
      const antenna = buildAntennaArray(1);
      antenna.position.set(-5.2, 0, -4.6);
      g.add(antenna);
      const crate1 = buildEquipmentCrate();
      crate1.position.set(5.0, 0, -5.2);
      crate1.rotation.y = 0.8;
      g.add(crate1);
      const crate2 = buildEquipmentCrate();
      crate2.position.set(-5.6, 0, 3.8);
      crate2.rotation.y = -0.4;
      g.add(crate2);
      const flood = buildFloodlight();
      flood.position.set(5.4, 0, 4.6);
      flood.rotation.y = Math.PI * 0.9;
      g.add(flood);
    } else if (type === ObjectiveType.RADAR_TOWER) {
      // Technical layout: dark slab + yellow perimeter markers + comms gear
      const pad = createBox(6.0, 0.14, 6.0, PROP_COLORS.darkSteel);
      pad.position.y = 0.09;
      g.add(pad);
      const markerTransforms: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + 0.8;
        markerTransforms.push({ x: Math.cos(ang) * 5.0, y: 0.4, z: Math.sin(ang) * 5.0 });
      }
      addInstancedProps(g, bollardGeometry, getLowPolyMaterial(PROP_COLORS.yellow), markerTransforms);
      const antenna = buildAntennaArray(0);
      antenna.position.set(-5.4, 0, -4.4);
      g.add(antenna);
      const box = buildUtilityBox(PROP_COLORS.blue);
      box.position.set(5.6, 0, -3.6);
      box.rotation.y = 0.5;
      g.add(box);
      const crate = buildEquipmentCrate();
      crate.position.set(-4.8, 0, 5.0);
      crate.rotation.y = -0.7;
      g.add(crate);
    } else {
      // AMMO_DEPOT: supply yard — containers, crates, fuel tank, generator.
      // Containers sit ~1u farther out than the other props so their long
      // bodies never swing into the objective's marker ring when rotated.
      const pad = createBox(6.4, 0.14, 6.4, PROP_COLORS.concrete);
      pad.position.y = 0.09;
      g.add(pad);
      const c1 = buildContainer(PROP_COLORS.olive);
      c1.position.set(-6.2, 0, -5.4);
      c1.rotation.y = 0.4;
      g.add(c1);
      const c2 = buildContainer(PROP_COLORS.rust);
      c2.position.set(6.4, 0, -5.0);
      c2.rotation.y = -0.3;
      g.add(c2);
      const tank = buildStorageTank(0, PROP_COLORS.yellow);
      tank.position.set(-5.8, 0, 4.4);
      g.add(tank);
      const gen = buildGenerator();
      gen.position.set(4.6, 0, 5.4);
      gen.rotation.y = 0.9;
      g.add(gen);
      const crate = buildCrate(1);
      crate.position.set(4.2, 0, -6.0);
      crate.rotation.y = 1.1;
      g.add(crate);
    }

    this.group.add(g);
    return g;
  }

  private addOpenLot(
    chunk: WorldChunk,
    id: number,
    x: number,
    z: number,
    gx: number,
    local: number,
    config: DistrictConfig,
  ) {
    // Only a share of empty cells become themed lots — the rest stay pure
    // breathing room (openSpaceChance is the district's openness tendency).
    if (this.hash(id, gx * 313 + local * 317) > config.openSpaceChance) return;

    const lotRoll = this.hash(id, gx * 233 + local * 257);
    const w = this.snap(8 + this.hash(id, gx * 263 + local * 271) * 8);
    const d = this.snap(8 + this.hash(id, gx * 277 + local * 283) * 8);

    if (config.name === 'industrial' && lotRoll < 0.82) {
      // Industrial yard (Pass 5): container yard / storage tank + pipes / generator + crates
      const kindRoll = this.hash(id, gx * 351 + local * 359);
      const yard = createBox(w, 0.07, d, 0x4a443d);
      yard.position.set(x, -0.09, z);
      chunk.group.add(yard);
      if (kindRoll < 0.4) {
        // Cargo container yard — stacked containers in muted rust/blue/green
        const containerColors = [0x8a4a35, 0x3a6b9f, 0x4f7a4f, 0x6b6f4a];
        const stacks = 2 + Math.floor(this.hash(id, gx * 331 + local * 337) * 2);
        for (let i = 0; i < stacks; i++) {
          const c = containerColors[Math.floor(this.hash(id, gx * 341 + i * 13) * containerColors.length)];
          const cont = buildContainer(c);
          cont.position.set(
            x - w * 0.35 + this.hash(id, gx + i * 23) * w * 0.7,
            0,
            z - d * 0.3 + this.hash(id, local + i * 29) * d * 0.6,
          );
          cont.rotation.y = i % 2;
          chunk.group.add(cont);
        }
      } else if (kindRoll < 0.7) {
        // Storage tank + pipe run
        const tank = buildStorageTank(Math.floor(this.hash(id, gx * 361 + local * 367) * 4), config.accentColor);
        tank.position.set(x + w * 0.18, 0, z - d * 0.12);
        chunk.group.add(tank);
        const pipes = buildPipeRun();
        pipes.position.set(x - w * 0.25, 0, z + d * 0.22);
        pipes.rotation.y = this.hash(id, gx * 373 + local * 379) * Math.PI;
        chunk.group.add(pipes);
      } else if (kindRoll < 0.85) {
        // Generator + crates
        const gen = buildGenerator();
        gen.position.set(x - w * 0.2, 0, z - d * 0.1);
        chunk.group.add(gen);
        for (let i = 0; i < 2; i++) {
          const crate = buildCrate(Math.floor(this.hash(id, gx + i * 31) * 4));
          crate.position.set(x + w * 0.25 + i * 2.2, 0, z + d * 0.2);
          crate.rotation.y = this.hash(id, local + i * 37) * Math.PI;
          chunk.group.add(crate);
        }
      } else {
        // Loading bay — platform + posts + canopy
        const bay = buildLoadingBay();
        bay.position.set(x, 0, z);
        bay.rotation.y = this.hash(id, gx * 383 + local * 389) * Math.PI;
        chunk.group.add(bay);
      }
      return;
    }

    if (config.name === 'waterfront' && lotRoll >= 0.58 && lotRoll < 0.82) {
      // Dockside yard: timber deck, mooring posts, a stacked crate
      const deck = createBox(w, 0.1, d, 0x6b4f2f);
      deck.position.set(x, -0.07, z);
      chunk.group.add(deck);
      for (let i = 0; i < 4; i++) {
        const post = createBox(0.5, 1.4, 0.5, 0x3f3326);
        post.position.set(
          x - w * 0.42 + this.hash(id, gx + i * 31) * w * 0.84,
          0.55,
          z - d * 0.42 + this.hash(id, local + i * 37) * d * 0.84,
        );
        chunk.group.add(post);
      }
      const crate = createBox(2.2, 1.6, 2.2, 0x8a5f42);
      crate.position.set(x + w * 0.22, 0.8, z + d * 0.18);
      chunk.group.add(crate);
      return;
    }

    if (lotRoll < 0.28) {
      // Parking lot: asphalt + white stall lines (merged into one mesh)
      const asphalt = createBox(w, 0.07, d, 0x2b2f36);
      asphalt.position.set(x, -0.09, z);
      chunk.group.add(asphalt);
      const lines: THREE.Mesh[] = [];
      const stalls = Math.max(2, Math.floor(w / 4));
      for (let i = 1; i < stalls; i++) {
        const line = createBox(0.3, 0.05, d * 0.7, 0xd8d3c0);
        line.position.set(x - w / 2 + (i * w) / stalls, -0.05, z);
        lines.push(line);
      }
      const merged = mergeBoxMeshes(lines);
      if (merged) chunk.group.add(merged);
    } else if (lotRoll < 0.58) {
      // Empty lot: dirt patch + rubble
      const dirt = createBox(w, 0.06, d, 0x57544a);
      dirt.position.set(x, -0.1, z);
      chunk.group.add(dirt);
      for (let i = 0; i < 3; i++) {
        const rb = createBox(
          1 + this.hash(id, gx * 293 + i * 31) * 2,
          0.8 + this.hash(id, gx * 307 + i) * 1.2,
          1 + this.hash(id, local * 311 + i) * 2,
          0x3d4652,
        );
        rb.position.set(
          x + (this.hash(id, gx + i * 17) - 0.5) * (w - 2),
          0.5,
          z + (this.hash(id, local + i * 19) - 0.5) * (d - 2),
        );
        chunk.group.add(rb);
      }
    } else if (lotRoll < 0.82) {
      // Courtyard plaza: light paving + a shade tree
      const plaza = createBox(w, 0.07, d, 0x6e6a60);
      plaza.position.set(x, -0.09, z);
      chunk.group.add(plaza);
      const trunk = createBox(0.7, 3, 0.7, 0x4a3a28);
      trunk.position.set(x + w * 0.2, 1.3, z - d * 0.1);
      const crown = createBox(3.4, 3.2, 3.4, 0x2f7a4a);
      crown.position.set(x + w * 0.2, 3.6, z - d * 0.1);
      chunk.group.add(trunk, crown);
    }
    // else: bare open ground — pure breathing room
  }

  private addGroundDressing(
    chunk: WorldChunk,
    config: DistrictConfig,
    chunkCenterZ: number,
    id: number,
  ) {
    // Roads, markings, lamps and traffic now live in addRoadNetwork — this
    // method only dresses the leftover ground (patches, rocks, craters, parks).

    const palette = config.detailPalette;
    const spread = this.worldHalfWidth - 40;

    for (let i = 0; i < 18; i++) {
      const seed = this.hash(id, i * 41 + 7);
      const x = -spread + this.hash(id, i * 59 + 11) * spread * 2;
      const z = chunkCenterZ - this.chunkDepth * 0.48 + this.hash(id, i * 67 + 17) * this.chunkDepth;
      if (Math.abs(x) < 58 || Math.abs(Math.abs(x) - this.serviceRoadX) < 16) continue;
      if (this.overlapsBuilding(chunk, x, z, 16, 14)) continue;

      const patch = createBox(
        6 + this.hash(id, i * 71 + 19) * 18,
        0.06,
        5 + this.hash(id, i * 73 + 23) * 16,
        palette[Math.floor(seed * palette.length)],
      );
      patch.position.set(x, -0.11 + seed * 0.006, z);
      patch.rotation.y = (seed - 0.5) * 0.45;
      chunk.group.add(patch);
    }

    for (let i = 0; i < 10; i++) {
      const seed = this.hash(id, i * 83 + 31);
      const x = -spread + this.hash(id, i * 89 + 37) * spread * 2;
      const z = chunkCenterZ - this.chunkDepth * 0.45 + this.hash(id, i * 97 + 43) * this.chunkDepth * 0.9;
      if (Math.abs(x) < 50 || Math.abs(Math.abs(x) - this.serviceRoadX) < 14) continue;
      if (this.overlapsBuilding(chunk, x, z, 5, 5)) continue;

      if (config.name === 'forest' && seed > 0.25) {
        const trunk = createBox(0.8, 3.2, 0.8, 0x473820);
        trunk.position.set(x, 1.35, z);
        const crown = createBox(4 + seed * 2, 4 + seed * 2.5, 4 + seed * 2, 0x1e5b39);
        crown.position.set(x, 4.0, z);
        chunk.group.add(trunk, crown);
      } else {
        const rock = createBox(2 + seed * 4, 0.6 + seed * 1.3, 2 + seed * 4, config.name === 'desert' ? 0x8f7646 : 0x3d4652);
        rock.position.set(x, rock.geometry.boundingBox ? 0.2 : 0.25, z);
        rock.rotation.y = seed * Math.PI;
        chunk.group.add(rock);
      }
    }

    if (Math.abs(id) % 3 === 1) {
      const crater = createBox(16, 0.05, 12, 0x242831);
      crater.position.set(this.hash(id, 203) > 0.5 ? -112 : 112, -0.02, chunkCenterZ + (this.hash(id, 207) - 0.5) * 52);
      crater.rotation.y = this.hash(id, 211) * Math.PI;
      chunk.group.add(crater);
    }

    // Occasional city park: a green plaza with trees, benches, and a pond
    if (Math.abs(id) % 4 === 3) {
      this.addCityPark(chunk, id, chunkCenterZ);
    }
  }

  /** True if a w×d footprint centered at (x, z) overlaps any built block. */
  private overlapsBuilding(chunk: WorldChunk, x: number, z: number, w: number, d: number) {
    for (const block of chunk.blocks) {
      if (
        Math.abs(x - block.x) < (w + block.width) * 0.5 + 1 &&
        Math.abs(z - block.z) < (d + block.depth) * 0.5 + 1
      ) {
        return true;
      }
    }
    return false;
  }

  /** A pocket park: lawn, trees, a pond, and a walking path. */
  private addCityPark(chunk: WorldChunk, id: number, chunkCenterZ: number) {
    const seed = this.hash(id, 251);
    // Try a spread of candidates so the park clears surrounding buildings and
    // never lands on a road (buildings occupy the mid columns; avenues are 0/±34)
    let parkX = 0;
    let parkZ = 0;
    let parkW = 0;
    let parkD = 0;
    let placed = false;
    for (let attempt = 0; attempt < 12 && !placed; attempt++) {
      const randX = this.hash(id, 257 + attempt * 7);
      const randZ = this.hash(id, 263 + attempt * 3);
      const candX = -160 + randX * 320;
      // Clamp z so the park (max depth 32 → half 16) stays inside its own
      // chunk (blocks span ±66) and never clips a neighbor chunk's buildings
      const candZ = chunkCenterZ - 40 + randZ * 80;
      if (Math.abs(candX) < 68 || Math.abs(Math.abs(candX) - this.serviceRoadX) < 30) continue; // off avenues + service road
      if (Math.abs(candZ - chunkCenterZ) < 16) continue; // keep off the cross-street
      const w = 26 + seed * 10;
      const d = 22 + this.hash(id, 269 + attempt * 5) * 10;
      let overlaps = false;
      for (const block of chunk.blocks) {
        if (
          Math.abs(candX - block.x) < (w + block.width) * 0.5 + 2 &&
          Math.abs(candZ - block.z) < (d + block.depth) * 0.5 + 2
        ) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        parkX = candX;
        parkZ = candZ;
        parkW = w;
        parkD = d;
        placed = true;
      }
    }
    if (!placed) return; // crowded neighborhood — skip the park

    // Lawn
    const lawn = createBox(parkW, 0.08, parkD, 0x3f8c5d);
    lawn.position.set(parkX, -0.04, parkZ);
    chunk.group.add(lawn);

    // Walking path crossing the park
    const path = createBox(parkW * 0.55, 0.06, 2.6, 0xcbb785);
    path.position.set(parkX, -0.02, parkZ);
    chunk.group.add(path);

    // Pond with a light blue surface + rim
    const pondR = 4 + seed * 3;
    const pond = createBox(pondR * 2, 0.16, pondR * 1.4, 0x3aa8d8);
    pond.position.set(parkX + parkW * 0.22, -0.02, parkZ - parkD * 0.2);
    chunk.group.add(pond);
    const pondRim = createBox(pondR * 2 + 1.4, 0.1, pondR * 1.4 + 1.2, 0x2f744e);
    pondRim.position.set(pond.position.x, -0.05, pond.position.z);
    chunk.group.add(pondRim);

    // Trees around the park
    for (let i = 0; i < 4; i++) {
      const treeX = parkX - parkW * 0.4 + this.hash(id, i * 19 + 271) * parkW * 0.8;
      const treeZ = parkZ - parkD * 0.4 + this.hash(id, i * 23 + 277) * parkD * 0.8;
      if (Math.abs(treeX - path.position.x) < 4) continue; // keep off the path
      const trunk = createBox(0.7, 3, 0.7, 0x4a3a28);
      trunk.position.set(treeX, 1.3, treeZ);
      const crown = createBox(3.4 + this.hash(id, i * 29 + 281) * 2, 3.2 + this.hash(id, i * 31 + 283) * 2, 3.4 + this.hash(id, i * 37 + 287) * 2, 0x2f7a4a);
      crown.position.set(treeX, 3.6, treeZ);
      chunk.group.add(trunk, crown);
    }

    // A couple of benches at the edge
    for (let i = 0; i < 2; i++) {
      const benchX = parkX + (i === 0 ? -parkW * 0.3 : parkW * 0.3);
      const bench = createBox(2.2, 0.5, 0.7, 0x6b4f2f);
      bench.position.set(benchX, 0.2, parkZ + parkD * 0.4);
      chunk.group.add(bench);
    }
  }

  /** Build a moving car and register it with its chunk's traffic. */
  private addTrafficCar(
    chunk: WorldChunk,
    id: number,
    carX: number,
    carZ: number,
    speed: number,
    chunkCenterZ: number,
    laneKey: number,
  ) {
    const forward = speed < 0;
    const carColor = [0x992222, 0x225599, 0x999999, 0x222222, 0x887722, 0x2a6b4f][
      Math.floor(this.hash(id, laneKey * 3 + 5) * 6)
    ];
    // Pass 10: car body + roof are merged into ONE mesh at the car's local
    // origin, with the glow lights as children — the per-frame update then
    // moves a single group instead of four meshes (and saves ~45 draw calls
    // across the three live chunks).
    const carGroup = new THREE.Group();
    carGroup.position.set(carX, 0, carZ);
    const carBody = createBox(2.8, 1.2, 5.5, carColor);
    carBody.position.set(0, 0.6, 0);
    const carRoof = createBox(2.4, 0.8, 3.0, 0x111111);
    carRoof.position.set(0, 1.6, -0.5);
    const mergedBody = mergeBoxMeshes([carBody, carRoof]);
    if (mergedBody) {
      mergedBody.castShadow = true;
      carGroup.add(mergedBody);
    } else {
      carGroup.add(carBody, carRoof);
    }
    const headlight = createGlowBox(2.2, 0.24, 0.18, forward ? 0xfff3b0 : 0xff3344, 0.68);
    headlight.position.set(0, 0.86, forward ? -3.05 : 3.05);
    const taillight = createGlowBox(2.2, 0.2, 0.14, forward ? 0xff3344 : 0xfff3b0, 0.5);
    taillight.position.set(0, 0.9, forward ? 3.05 : -3.05);
    headlight.userData.baseOpacity = 0.68;
    taillight.userData.baseOpacity = 0.5;
    carGroup.add(headlight, taillight);
    chunk.group.add(carGroup);

    const band = this.chunkDepth * 0.5 - 6;
    this.chunkTraffic.get(id)?.push({
      x: carX,
      baseX: carX,
      z: carZ,
      speed,
      baseSpeed: speed,
      minZ: chunkCenterZ - band,
      maxZ: chunkCenterZ + band,
      parts: [carGroup],
      lights: [headlight, taillight],
      dodgeDir: 1,
      dodgeTimer: 0,
      dodgeCooldown: 0,
      honkTimer: 0,
    });
  }

  /** Build a roadside ad board with a canvas-drawn marquee ticker. */
  private addBillboards(
    chunk: WorldChunk,
    id: number,
    chunkCenterZ: number,
    config: DistrictConfig,
  ) {
    const boards: Billboard[] = [];
    for (let i = 0; i < config.billboardCount; i++) {
      const seed = this.hash(id, i * 131 + 61);
      const side = seed < 0.5 ? -1 : 1;
      const x = side * (17 + this.hash(id, i * 137 + 67) * 7); // ≤24 keeps poles off the ±34 avenues
      const z =
        chunkCenterZ - this.chunkDepth * 0.45 + this.hash(id, i * 139 + 71) * this.chunkDepth * 0.9;

      const group = new THREE.Group();
      const pole = createBox(0.45, 5.4, 0.45, 0x2c3642);
      pole.position.set(0, 2.7, 0);
      const signColor =
        config.signColors[Math.floor(seed * config.signColors.length) % config.signColors.length];
      const screenMat = this.buildBillboardTexture(config, seed, signColor);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(8.6, 4.8, 0.32), screenMat);
      screen.position.set(0, 6.4, 0);
      const glow = createGlowBox(9.2, 5.4, 0.4, 0xffffff, 0.55);
      glow.position.set(0, 6.4, 0);
      group.add(pole, screen, glow);
      group.position.set(x, 0.05, z);
      group.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      chunk.group.add(group);
      boards.push({
        tex: screenMat.map as THREE.CanvasTexture,
        scrollSpeed: 0.06 + this.hash(id, i * 143 + 73) * 0.12,
        phase: seed * Math.PI * 2,
        glow,
      });
    }
    this.chunkBillboards.get(id)?.push(...boards);
  }

  /** Draw a stylized ad + scrolling chevron ticker onto a canvas texture. */
  private buildBillboardTexture(config: DistrictConfig, seed: number, signColor: number) {
    const ads = ["HELI-TRONIC", "SKY-FUEL", "ROTOR-AID", "APACHE AIR", "NIGHT HAWK", "WARLOCK"];
    const bgByDistrict: Record<string, string> = {
      downtown: "#0a1c2e",
      midtown: "#221b12",
      industrial: "#241a10",
      residential: "#2b1d14",
      waterfront: "#06242a",
      base: "#1c1626",
      desert: "#2b2110",
      forest: "#0e2116",
      ruins: "#1a1d26",
    };
    const bg = bgByDistrict[config.name] ?? bgByDistrict.downtown;
    const accent = `#${signColor.toString(16).padStart(6, '0')}`;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 256, 128);
      // neon border
      ctx.strokeStyle = accent;
      ctx.lineWidth = 6;
      ctx.strokeRect(5, 5, 246, 118);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(13, 13, 230, 102);
      // ad copy
      const ad = ads[Math.floor(seed * ads.length) % ads.length];
      ctx.font = "bold 34px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = accent;
      ctx.shadowBlur = 12;
      ctx.fillText(ad, 128, 52);
      ctx.shadowBlur = 0;
      // marquee ticker: repeating chevrons tile horizontally (32px period)
      ctx.fillStyle = accent;
      for (let cx = 0; cx <= 256; cx += 32) {
        ctx.beginPath();
        ctx.moveTo(cx + 4, 118);
        ctx.lineTo(cx + 12, 104);
        ctx.lineTo(cx + 20, 104);
        ctx.lineTo(cx + 28, 118);
        ctx.closePath();
        ctx.fill();
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshBasicMaterial({ map: tex });
  }

  /** Free GPU canvas textures for removed/cleared billboards. */
  private disposeBillboardTextures(map: Map<number, Billboard[]>, id?: number) {
    if (id !== undefined) {
      const boards = map.get(id);
      if (boards) for (const board of boards) board.tex.dispose();
      map.delete(id);
      return;
    }
    for (const boards of map.values()) {
      for (const board of boards) board.tex.dispose();
    }
    map.clear();
  }

  private rebuildCaches() {
    this.blocks = [];
    this.rooftopSpots = [];
    this.turrets = [];
    for (const chunk of this.chunks.values()) {
      this.blocks.push(...chunk.blocks);
      this.rooftopSpots.push(...chunk.spots);
    }
    for (const turrets of this.chunkTurrets.values()) {
      this.turrets.push(...turrets);
    }
  }

  /**
   * Phase 1: release a departing chunk's unique GPU resources. disposeObject3D
   * skips shared cached geometries/materials (userData.shared) so live chunks
   * and future generations are unaffected. Called on stream-cull and reset.
   */
  private disposeChunkResources(chunk: WorldChunk) {
    disposeObject3D(chunk.group);
  }

  /** Snap a dimension to a 0.5-unit grid so box geometries are shared/cached. */
  private snap(v: number) {
    return Math.round(v * 2) / 2;
  }

  private hash(a: number, b: number) {
    const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  private addStaticBox(
    world: CANNON.World,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    collisionResponse = true,
  ) {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(x, y, z),
      shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2)),
    });
    body.collisionResponse = collisionResponse;
    if (!collisionResponse) {
      body.collisionFilterGroup = 2;
      body.collisionFilterMask = 0;
    }
    world.addBody(body);
    return body;
  }

  private damageBlock(block: CityBlock, amount: number) {
    if (block.destroyed) return;
    block.hp = Math.max(0, block.hp - amount);
    const damage = 1 - block.hp / block.maxHp;

    for (const mesh of block.meshes) {
      const mat = this.ensureMutableMaterial(mesh);
      if (mat) {
        const baseColor = mat.userData.baseColor as THREE.Color | undefined;
        if (baseColor) {
          // Phase 3: use a cached Color instead of allocating every frame.
          tempDamageTint ??= new THREE.Color(0x211f24);
          mat.color.copy(baseColor).lerp(tempDamageTint, damage * 0.8);
        }
      }
      mesh.scale.x = 1 + damage * 0.04;
      mesh.scale.z = 1 + damage * 0.04;
    }

    if (block.hp > 0) return;
    this.startBlockCollapse(block);
  }

  /**
   * Shared cached materials must never be mutated (other blocks use them), so
   * clone lazily per mesh on first damage. Returns null for non-Lambert meshes
   * (glows are never color-darkened, only scaled/hidden).
   */
  private ensureMutableMaterial(mesh: THREE.Mesh): THREE.MeshLambertMaterial | null {
    const mat = mesh.material;
    if (!(mat instanceof THREE.MeshLambertMaterial)) return null;
    if (mat.userData.shared) {
      let clone = this.damageMats.get(mesh);
      if (!clone) {
        clone = mat.clone();
        clone.userData = { baseColor: (mat.userData.baseColor as THREE.Color).clone() };
        this.damageMats.set(mesh, clone);
        mesh.material = clone;
      }
      return clone;
    }
    return mat;
  }

  /** Kick off the collapse-out sequence: dust burst, physics off, then a 0.5s fall. */
  private startBlockCollapse(block: CityBlock) {
    block.destroyed = true;
    block.collapseProgress = 0;
    block.initialHeights = block.meshes.map((m) => m.position.y);

    if (block.body) {
      block.body.collisionFilterMask = 0;
      block.body.collisionResponse = false;
    }
    if (this.particles) {
      this.particles.spawnExplosion(
        block.x,
        block.height * 0.5,
        block.z,
        40,
        performance.now() / 1000,
        block.width * 1.2,
      );
    }
  }

  /** Collapse animation: everything sinks and tilts, then the block is removed. */
  private animateCollapses(delta: number) {
    for (const block of this.blocks) {
      if (!block.destroyed || block.collapseProgress === undefined) continue;
      block.collapseProgress += delta * 1.9;
      const p = Math.min(1, block.collapseProgress);
      const fall = 8 + block.height * 0.3;
      for (let i = 0; i < block.meshes.length; i++) {
        const m = block.meshes[i];
        // Rooftop prop children ride their group down as a unit (their local y
        // is not world y, so the per-mesh fall below would misplace them).
        const propGroup = m.userData.propGroup as THREE.Group | undefined;
        if (propGroup) {
          if (propGroup.userData.collapseBase === undefined) {
            propGroup.userData.collapseBase = propGroup.position.y;
          }
          propGroup.position.y = (propGroup.userData.collapseBase as number) - p * p * fall;
          continue;
        }
        const baseY = block.initialHeights?.[i] ?? 0;
        m.position.y = baseY - p * p * fall;
        m.rotation.z = p * (0.08 + (i % 3) * 0.06);
      }
      if (p >= 1) this.finishBlockCollapse(block);
    }
  }

  private finishBlockCollapse(block: CityBlock) {
    // Idempotent: a collapsed block stays in this.blocks (height queries need it
    // to keep reporting 0 once the dust clears, and damageNearby skips destroyed
    // ones), but animateCollapses runs every frame — without this guard every
    // finished collapse would re-fire onBuildingDestroyed per frame, re-arming
    // hit-stop permanently (the game crawls at 4% speed) and farming score.
    if (block.collapseFinished) return;
    block.collapseFinished = true;
    for (const mesh of block.meshes) {
      mesh.visible = false;
      // Phase 1: release the building's unique GPU buffers (merged body
      // geometry, damage-darkened material clones) and drop it from the scene
      // graph. The block itself STAYS in this.blocks (height queries report 0
      // for destroyed blocks), but its meshes are dead weight — without this
      // every building destroyed in combat leaks geometry until renderer teardown.
      if (mesh.parent) mesh.parent.remove(mesh);
      disposeObject3D(mesh);
      const propGroup = mesh.userData.propGroup as THREE.Object3D | undefined;
      if (propGroup?.parent) propGroup.parent.remove(propGroup);
    }
    if (this.onBuildingDestroyed) {
      this.onBuildingDestroyed(block.x, block.height * 0.5, block.z);
    }
  }

  private distanceToBlockFootprintSq(x: number, z: number, block: CityBlock) {
    const dx = Math.max(Math.abs(x - block.x) - block.width * 0.5, 0);
    const dz = Math.max(Math.abs(z - block.z) - block.depth * 0.5, 0);
    return dx * dx + dz * dz;
  }

  private segmentIntersectsBlockFootprint(
    from: CANNON.Vec3,
    to: CANNON.Vec3,
    block: CityBlock,
    padding: number,
  ) {
    const minX = block.x - block.width * 0.5 - padding;
    const maxX = block.x + block.width * 0.5 + padding;
    const minZ = block.z - block.depth * 0.5 - padding;
    const maxZ = block.z + block.depth * 0.5 + padding;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 0.0001) {
      if (from.x < minX || from.x > maxX) return null;
    } else {
      const tx1 = (minX - from.x) / dx;
      const tx2 = (maxX - from.x) / dx;
      tMin = Math.max(tMin, Math.min(tx1, tx2));
      tMax = Math.min(tMax, Math.max(tx1, tx2));
    }

    if (Math.abs(dz) < 0.0001) {
      if (from.z < minZ || from.z > maxZ) return null;
    } else {
      const tz1 = (minZ - from.z) / dz;
      const tz2 = (maxZ - from.z) / dz;
      tMin = Math.max(tMin, Math.min(tz1, tz2));
      tMax = Math.min(tMax, Math.max(tz1, tz2));
    }

    if (tMax < tMin) return null;
    return tMin;
  }

  // -------------------------------------------------------------------------
  // Environment Pass 3 — camera occlusion (player visibility)
  //
  // Buildings that sit between the gameplay camera and the player helicopter
  // smoothly ghost out (opacity → 0.2, no depth write) so the action never
  // gets swallowed by the skyline. RENDER-STATE ONLY: collisions, height
  // queries, destruction state and projectile hits are all untouched.
  //
  // Detection is throttled (~8 Hz, instant when the block list changes) and
  // runs a cheap slab segment-vs-AABB test; the ghost factor then eases every
  // frame toward its target for a smooth fade in/out. Shared cached materials
  // are cloned on first ghost (clone-on-write), so fading one building never
  // fades another that shares the same material.
  // -------------------------------------------------------------------------

  /**
   * Drive the occlusion pass. Called every rendered frame with the final
   * camera position and the player position. `detect` toggles the throttled
   * blocker scan; when false (menu / game over) every target drops to 0 so
   * any leftover ghosts ease back to full opacity.
   */
  updateOcclusion(
    camX: number,
    camY: number,
    camZ: number,
    tx: number,
    ty: number,
    tz: number,
    delta: number,
    detect: boolean,
  ) {
    if (detect) {
      this.occlusionTimer += delta;
      const blocksChanged = this.blocks.length !== this.occlusionBlockCount;
      if (this.occlusionTimer >= 0.12 || blocksChanged) {
        this.occlusionTimer = 0;
        this.occlusionBlockCount = this.blocks.length;
        this.detectOccluders(camX, camY, camZ, tx, ty, tz);
      }
    } else {
      for (const block of this.blocks) block.occlusionTarget = 0;
    }
    this.animateOcclusion(delta);
  }

  /** Find the strongest blockers along the camera→player view segment. */
  private detectOccluders(camX: number, camY: number, camZ: number, tx: number, ty: number, tz: number) {
    const dx = tx - camX;
    const dy = ty - camY;
    const dz = tz - camZ;
    const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (segLen < 0.001) return; // camera on top of the player — nothing to ghost
    const midX = (camX + tx) * 0.5;
    const midZ = (camZ + tz) * 0.5;

    this.occlusionScratch.length = 0;
    for (const block of this.blocks) {
      if (block.destroyed) continue;
      // Coarse pre-cull: the view segment is short (≤ ~120u), so anything
      // beyond 100u around its midpoint can never touch it.
      if (Math.abs(block.x - midX) > 100 || Math.abs(block.z - midZ) > 100) continue;
      const tEntry = this.segmentIntersectsBlockVolume(camX, camY, camZ, dx, dy, dz, block);
      if (tEntry === null) continue;
      const strength = occlusionStrength(tEntry);
      if (strength < 0.12) continue;
      this.occlusionScratch.push({ block, strength });
    }
    // Keep only the strongest few blockers so a dense street never ghosts the
    // whole block of buildings at once.
    this.occlusionScratch.sort((a, b) => b.strength - a.strength);
    if (this.occlusionScratch.length > 8) this.occlusionScratch.length = 8;

    for (const block of this.blocks) block.occlusionTarget = 0;
    for (const hit of this.occlusionScratch) hit.block.occlusionTarget = hit.strength;
  }

  /**
   * Full 3D segment-vs-AABB slab test over a building's volume
   * (footprint in XZ, y from 0 to blockTop). Returns the entry t (0..1)
   * where the view line enters the box, or null if it misses entirely.
   */
  private segmentIntersectsBlockVolume(
    camX: number,
    camY: number,
    camZ: number,
    dx: number,
    dy: number,
    dz: number,
    block: CityBlock,
  ): number | null {
    const minX = block.x - block.width * 0.5;
    const maxX = block.x + block.width * 0.5;
    const minY = 0;
    const maxY = block.height + 1;
    const minZ = block.z - block.depth * 0.5;
    const maxZ = block.z + block.depth * 0.5;
    let tMin = 0;
    let tMax = 1;

    if (Math.abs(dx) < 1e-9) {
      if (camX < minX || camX > maxX) return null;
    } else {
      const t1 = (minX - camX) / dx;
      const t2 = (maxX - camX) / dx;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMax < tMin) return null;
    }
    if (Math.abs(dy) < 1e-9) {
      if (camY < minY || camY > maxY) return null;
    } else {
      const t1 = (minY - camY) / dy;
      const t2 = (maxY - camY) / dy;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMax < tMin) return null;
    }
    if (Math.abs(dz) < 1e-9) {
      if (camZ < minZ || camZ > maxZ) return null;
    } else {
      const t1 = (minZ - camZ) / dz;
      const t2 = (maxZ - camZ) / dz;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMax < tMin) return null;
    }
    return tMin;
  }

  /** Ease every block's ghost factor toward its target, applying opacity. */
  private animateOcclusion(delta: number) {
    for (const block of this.blocks) {
      const f = block.occlusionFactor ?? 0;
      const t = block.occlusionTarget ?? 0;
      if (f === 0 && t === 0) continue; // common fast path — untouched block
      if (f === t) continue; // already settled
      const k = t > f ? 1 - Math.exp(-delta / 0.08) : 1 - Math.exp(-delta / 0.16);
      const next = f + (t - f) * k;
      block.occlusionFactor = Math.abs(t - next) < 0.002 ? t : next;
      this.applyOcclusionVisual(block, block.occlusionFactor);
    }
  }

  /** Ghost (or restore) a block's render state. Only touched meshes/materials change. */
  private applyOcclusionVisual(block: CityBlock, factor: number) {
    const ghosted = factor > 0.001;
    const opacity = 1 - factor * 0.8; // fully ghosted → 0.2 (0.15–0.35 band)
    for (const mesh of block.meshes) {
      if (Array.isArray(mesh.material)) continue; // building meshes are single-material
      // A near-transparent ghost must not drop a hard shadow onto the street.
      if (ghosted) {
        if (!mesh.userData.ghostCastShadow) {
          mesh.userData.ghostCastShadow = mesh.castShadow;
          mesh.castShadow = false;
        }
      } else if (mesh.userData.ghostCastShadow !== undefined) {
        mesh.castShadow = mesh.userData.ghostCastShadow as boolean;
        mesh.userData.ghostCastShadow = undefined;
      }
      const mat = mesh.material;
      if (!(mat instanceof THREE.MeshLambertMaterial) && !(mat instanceof THREE.MeshBasicMaterial)) continue;
      if (ghosted) {
        const priv = this.ensureOccludableMaterial(mesh, mat);
        if (priv) this.setGhostState(priv, opacity);
      } else {
        this.restoreMaterial(mat);
      }
    }
  }

  /**
   * Clone-on-ghost: shared cached materials are never mutated (other blocks
   * use them), so swap in a private clone the first time a block is ghosted.
   * Per-mesh glow materials (already private) are returned untouched.
   */
  private ensureOccludableMaterial(
    mesh: THREE.Mesh,
    mat: THREE.MeshLambertMaterial | THREE.MeshBasicMaterial,
  ): THREE.MeshLambertMaterial | THREE.MeshBasicMaterial | null {
    if (!mat.userData.shared) return mat;
    let clone = this.occlusionMats.get(mesh);
    if (!clone) {
      clone = mat.clone();
      const base = mat.userData.baseColor;
      clone.userData = {
        shared: false,
        baseColor: base instanceof THREE.Color ? base.clone() : undefined,
      };
      this.occlusionMats.set(mesh, clone);
      mesh.material = clone;
    }
    return clone;
  }

  /** Apply the ghosted visual: transparent, low opacity, no depth write. */
  private setGhostState(mat: THREE.Material, opacity: number) {
    if (!mat.userData.ghostOrig) {
      mat.userData.ghostOrig = {
        transparent: mat.transparent,
        opacity: mat.opacity,
        depthWrite: mat.depthWrite,
      };
    }
    mat.transparent = true;
    mat.opacity = opacity;
    mat.depthWrite = false;
  }

  /**
   * Restore a material to its exact pre-ghost state (glows keep their blend).
   * Note: a darkened damage tint deliberately survives — ghosting only touches
   * transparency/opacity/depth-write, never the block's damage state.
   */
  private restoreMaterial(mat: THREE.Material) {
    const orig = mat.userData.ghostOrig as
      | { transparent: boolean; opacity: number; depthWrite: boolean }
      | undefined;
    if (!orig) return;
    mat.transparent = orig.transparent;
    mat.opacity = orig.opacity;
    mat.depthWrite = orig.depthWrite;
    mat.userData.ghostOrig = undefined;
  }
}
