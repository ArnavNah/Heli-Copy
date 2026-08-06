import * as THREE from "three";
import * as CANNON from "cannon-es";
import { createBox, createGlowBox, createLowPolyMaterial } from "./materials";
import { Turret } from "./entities";
import type { CityBlock, RooftopSpot, WorldChunk } from "./types";

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

export class CityEnvironment {
  group = new THREE.Group();
  rooftopSpots: RooftopSpot[] = [];
  blocks: CityBlock[] = [];
  chunks: Map<number, WorldChunk> = new Map();
  particles: any = null;
  cellSize = 22;
  chunkDepth = 132;
  halfWidthCells = 9;
  activeBehind = 1;
  activeAhead = 2;
  onBuildingDestroyed: ((x: number, y: number, z: number) => void) | null = null;

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

  constructor(scene: THREE.Scene, world: CANNON.World) {
    this.group.name = "ModularBlockCity";
    scene.add(this.group);

    this.update({ x: 0, y: 20, z: 0 }, world);
  }

  reset(world: CANNON.World) {
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.group);
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
    this.update({ x: 0, y: 20, z: 0 }, world);
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
        for (const body of chunk.bodies) world.removeBody(body);
        this.chunks.delete(id);
        this.chunkTurrets.delete(id);
        this.chunkTraffic.delete(id);
        this.chunkBeacons.delete(id);
        this.disposeBillboardTextures(this.chunkBillboards, id);
        cacheDirty = true;
      }
    }

    if (cacheDirty) this.rebuildCaches();
    this.animateWorld(player.x, player.z, delta);
  }

  /** Animate the living city: dodging traffic, animated ad boards, pulsing beacons. */
  private animateWorld(playerX: number, playerZ: number, delta: number) {
    this.time += delta;
    const t = this.time;
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
          const mat = light.material as THREE.MeshBasicMaterial;
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
        const gmat = board.glow.material as THREE.MeshBasicMaterial;
        gmat.opacity = 0.5 + Math.sin(t * 2.2 + board.phase) * 0.35;
      }
    }

    // Rooftop beacons + runway glows gently pulse
    for (const beacons of this.chunkBeacons.values()) {
      for (const beacon of beacons) {
        const ph = (beacon.userData.phase as number) ?? 0;
        const mat = beacon.material as THREE.MeshBasicMaterial;
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

    const zone = this.zoneForChunk(id);
    const chunkCenterZ = id * this.chunkDepth;
    const groundColors: Record<string, number> = {
      city: 0x74e4ed,
      base: 0x737c8d,
      refinery: 0x565f6d,
      desert: 0xd6b55b,
      forest: 0x3f8c5d,
      ruins: 0x7e7d86,
    };
    const ground = createBox(640, 0.8, this.chunkDepth - 0.4, groundColors[zone]);
    ground.position.set(0, -0.62, chunkCenterZ);
    chunk.group.add(ground);

    this.chunkTurrets.set(id, []);
    this.chunkTraffic.set(id, []);
    this.chunkBeacons.set(id, []);
    this.chunkBillboards.set(id, []);

    const road = createBox(18, 0.12, this.chunkDepth - 0.4, 0x243044);
    road.position.set(this.hash(id, 99) > 0.5 ? -34 : 34, -0.16, chunkCenterZ);
    chunk.group.add(road);
    this.addGroundDressing(chunk, zone, chunkCenterZ, road.position.x, id);
    this.addBillboards(chunk, id, chunkCenterZ, road.position.x, zone);

    for (let gx = -this.halfWidthCells; gx <= this.halfWidthCells; gx++) {
      for (let local = -2; local <= 3; local++) {
        const isFlightLane = Math.abs(gx) <= 1;
        if (isFlightLane && (id === 0 || this.hash(id, gx * 53 + local * 19) < 0.22)) continue;
        const roll = this.hash(id, gx * 13 + local * 37);
        // Dense skyline: most cells build, with the density tapering toward the far edges
        const edgeFactor = 1 - Math.min(1, (Math.abs(gx) - 3) / 6) * 0.35;
        const density = (zone === "city" ? 0.62 : 0.48) * edgeFactor;
        if (roll > density) continue;

        const x = gx * this.cellSize + (this.hash(id, gx + local) - 0.5) * 4;
        const z = chunkCenterZ + local * this.cellSize + (this.hash(id, gx - local) - 0.5) * 5;
        this.addProceduralStructure(chunk, world, zone, x, z, gx, local);
      }
    }

    if (Math.abs(id) % 5 === 2) this.addBridge(chunk, chunkCenterZ);
    if (Math.abs(id) % 7 === 4) this.addSmokeColumn(chunk, chunkCenterZ);

    this.chunks.set(id, chunk);
  }

  private addProceduralStructure(
    chunk: WorldChunk,
    world: CANNON.World,
    zone: string,
    x: number,
    z: number,
    gx: number,
    local: number,
  ) {
    const seed = this.hash(chunk.id, gx * 97 + local * 131);
    const palettes: Record<string, number[]> = {
      city: [0x2742a0, 0x3155b7, 0x3f67c9, 0x24377e, 0x547bdf],
      base: [0x4b5361, 0x687182, 0x323946, 0x73827b],
      refinery: [0x303a47, 0x596675, 0x745c37, 0x222832],
      desert: [0xc3a94e, 0xb78f42, 0x9b7841, 0xd2bf77],
      forest: [0x224c38, 0x315f41, 0x4d6d4b, 0x20362f],
      ruins: [0x4d5366, 0x696a77, 0x3f4455, 0x7a6f69],
    };
    const colors = palettes[zone];
    const color = colors[Math.floor(seed * colors.length)];
    const skyscraper = (zone === "city" || zone === "ruins") && Math.abs(gx) > 1 && seed > 0.48;
    const height = skyscraper ? 26 + seed * 40 : 9 + seed * 14;
    const width = zone === "base" ? 9 + seed * 5 : 6 + this.hash(chunk.id, gx) * 8;
    const depth = zone === "refinery" ? 5 + this.hash(chunk.id, local) * 8 : 6 + this.hash(chunk.id, gx + 4) * 8;

    const building = createBox(width, height, depth, color);
    building.position.set(x, height / 2, z);
    chunk.group.add(building);

    const cap = createBox(width + 1.8, 1, depth + 1.8, color);
    cap.position.set(x, height + 0.5, z);
    chunk.group.add(cap);

    const facadeDetails = this.addBuildingFacadeDetails(
      chunk,
      zone,
      x,
      z,
      height,
      width,
      depth,
      seed,
    );

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
    const block: CityBlock = {
      x,
      z,
      width: width + 1.8,
      depth: depth + 1.8,
      height: height + 1,
      chunkId: chunk.id,
      meshes: [building, cap, ...facadeDetails],
      body,
      hp: maxHp,
      maxHp,
      destroyed: false,
    };
    chunk.blocks.push(block);
    chunk.spots.push({ x, y: height + 1.8, z });

    if (seed > 0.65) this.addRooftopDetail(chunk, x, z, height, width, depth, seed);

    // Ambient rooftop turrets on mid-rise buildings in developed zones (~55% of eligible roofs)
    const turretRoll = this.hash(chunk.id, gx * 61 + local * 73);
    const developed = zone === "city" || zone === "base" || zone === "refinery";
    if (developed && height < 38 && turretRoll > 0.45) {
      const turret = new Turret(chunk.group, x, height + 1.35, z, chunk.id, block);
      this.chunkTurrets.get(chunk.id)?.push(turret);
    }
  }

  private addBuildingFacadeDetails(
    chunk: WorldChunk,
    zone: string,
    x: number,
    z: number,
    height: number,
    width: number,
    depth: number,
    seed: number,
  ) {
    const details: THREE.Mesh[] = [];
    const isLitZone = zone === "city" || zone === "base" || zone === "refinery";
    const windowColor =
      zone === "refinery"
        ? 0xff8f2a
        : zone === "base"
          ? 0xb8f1ff
          : zone === "ruins"
            ? 0x8bd0ff
            : 0x9ff7ff;
    const trimColor = zone === "desert" ? 0xf7d36f : zone === "forest" ? 0x5cc47a : 0x75b8ff;
    const bandCount = isLitZone ? Math.max(1, Math.min(3, Math.floor(height / 10))) : 1;

    for (let i = 0; i < bandCount; i++) {
      const y = 3.4 + i * (height / (bandCount + 0.45));
      const bandHeight = isLitZone ? 0.34 : 0.22;
      const lit = isLitZone && this.hash(chunk.id, Math.floor(seed * 1000) + i * 29) > 0.18;
      const materialColor = lit ? windowColor : trimColor;
      const opacity = lit ? 0.62 : 0.28;

      const front = createGlowBox(width * 0.62, bandHeight, 0.08, materialColor, opacity);
      front.position.set(x, y, z + depth * 0.5 + 0.08);
      chunk.group.add(front);
      details.push(front);

      if (isLitZone && i % 2 === 0) {
        const side = seed > 0.5 ? 1 : -1;
        const sideBand = createGlowBox(0.08, bandHeight, depth * 0.42, materialColor, opacity * 0.4);
        sideBand.position.set(x + side * (width * 0.5 + 0.08), y, z);
        chunk.group.add(sideBand);
        details.push(sideBand);
      }
    }

    if (height > 18 && seed > 0.42) {
      const beacon = createGlowBox(1.2, 0.5, 1.2, seed > 0.7 ? 0xff3344 : 0xffe66d, 0.9);
      beacon.position.set(x, height + 1.22, z + depth * 0.18);
      beacon.userData.phase = seed * Math.PI * 2;
      chunk.group.add(beacon);
      this.chunkBeacons.get(chunk.id)?.push(beacon);
      details.push(beacon);
    }

    return details;
  }

  private addRooftopDetail(
    chunk: WorldChunk,
    x: number,
    z: number,
    height: number,
    width: number,
    depth: number,
    seed: number,
  ) {
    if (seed > 0.86) {
      const helipad = createBox(Math.min(width, 10), 0.22, Math.min(depth, 10), 0x1b2740);
      helipad.position.set(x, height + 1.18, z);
      chunk.group.add(helipad);
      
      const hMarker = createBox(3.5, 0.28, 3.5, 0xe9df9a);
      hMarker.position.set(x, height + 1.22, z);
      chunk.group.add(hMarker);
    } else if (seed > 0.75) {
      const tower = createBox(0.8, 7, 0.8, 0x151b2c);
      tower.position.set(x + width * 0.22, height + 4.2, z - depth * 0.18);
      chunk.group.add(tower);
      const dish = createBox(3.2, 0.35, 1.2, 0xaee9ff);
      dish.position.set(tower.position.x, height + 8, tower.position.z);
      dish.rotation.z = Math.PI / 7;
      chunk.group.add(dish);
    } else if (seed > 0.55) {
      // Multiple AC Units
      for (let i=0; i<3; i++) {
        const ac = createBox(1.5, 1.4, 1.5, 0x222b39);
        ac.position.set(x - width*0.15 + i*2.5, height + 1.7, z + depth*0.15);
        chunk.group.add(ac);
      }
    } else {
      // Water Tower
      const legs = createBox(2, 3, 2, 0x222b39);
      legs.position.set(x, height + 2.5, z);
      const tank = createBox(2.8, 3, 2.8, 0x4a5369);
      tank.position.set(x, height + 5.5, z);
      chunk.group.add(legs, tank);
    }
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
      smoke.material.transparent = true;
      smoke.material.opacity = 0.18;
      smoke.position.set(-70 + i * 10, 5 + i * 5, z - 18 + i * 4);
      chunk.group.add(smoke);
    }
  }

  private addGroundDressing(
    chunk: WorldChunk,
    zone: string,
    chunkCenterZ: number,
    roadX: number,
    id: number,
  ) {
    // No central lane box: removing it stops the play area from looking like the player is flying down the middle of a highway/runway.

    const shoulderColor = zone === "desert" ? 0xb99643 : zone === "forest" ? 0x2f744e : 0x38495d;
    for (const side of [-1, 1]) {
      const shoulder = createBox(4, 0.05, this.chunkDepth - 0.6, shoulderColor);
      shoulder.position.set(roadX + side * 12.5, -0.02, chunkCenterZ);
      chunk.group.add(shoulder);
    }

    for (let i = -3; i <= 3; i++) {
      const stripe = createBox(1.2, 0.09, 7, 0xe9df9a);
      stripe.position.set(roadX, -0.04, chunkCenterZ + i * 18);
      chunk.group.add(stripe);

      const runwayGlow = createGlowBox(0.75, 0.06, 2.5, i % 2 === 0 ? 0x7ff6ff : 0xffe66d, 0.34);
      runwayGlow.position.set(roadX + (i % 2 === 0 ? -8.6 : 8.6), 0.03, chunkCenterZ + i * 18 + 5);
      chunk.group.add(runwayGlow);

      // Moving traffic — two-way lanes of cruising cars
      for (const lane of [4.5, -4.5]) {
        const laneKey = lane > 0 ? 7 : 13;
        if (this.hash(id, i * 43 + laneKey) < 0.16) continue;
        const forward = lane > 0; // right lane drives forward (away from player)
        const speed = (forward ? -1 : 1) * (26 + this.hash(id, i * 29 + laneKey) * 16);
        const startZ = chunkCenterZ - this.chunkDepth * 0.5 + this.hash(id, i * 17 + laneKey) * this.chunkDepth * 0.9;
        const carX = roadX + lane + (this.hash(id, i * 7 + laneKey) - 0.5) * 1.4;
        this.addTrafficCar(chunk, id, carX, startZ, speed, chunkCenterZ, laneKey);
      }
    }

    const detailPalettes: Record<string, number[]> = {
      city: [0x5bbdcc, 0x4ea3bc, 0x6ac8cf, 0x596c86],
      base: [0x5b6574, 0x444d5b, 0x6d786d, 0x303947],
      refinery: [0x454f5d, 0x313946, 0x69573d, 0x202832],
      desert: [0xcaa84e, 0xb98e3f, 0xd0ba65, 0x98713d],
      forest: [0x2f7249, 0x24583f, 0x3f8559, 0x1f4634],
      ruins: [0x676978, 0x555967, 0x77736e, 0x454a57],
    };
    const palette = detailPalettes[zone] ?? detailPalettes.city;

    for (let i = 0; i < 18; i++) {
      const seed = this.hash(id, i * 41 + 7);
      const x = -275 + this.hash(id, i * 59 + 11) * 550;
      const z = chunkCenterZ - this.chunkDepth * 0.48 + this.hash(id, i * 67 + 17) * this.chunkDepth;
      if (Math.abs(x) < 23 || Math.abs(x - roadX) < 24) continue;

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
      const x = -280 + this.hash(id, i * 89 + 37) * 560;
      const z = chunkCenterZ - this.chunkDepth * 0.45 + this.hash(id, i * 97 + 43) * this.chunkDepth * 0.9;
      if (Math.abs(x) < 35 || Math.abs(x - roadX) < 20) continue;

      if (zone === "forest" && seed > 0.25) {
        const trunk = createBox(0.8, 3.2, 0.8, 0x473820);
        trunk.position.set(x, 1.35, z);
        const crown = createBox(4 + seed * 2, 4 + seed * 2.5, 4 + seed * 2, 0x1e5b39);
        crown.position.set(x, 4.0, z);
        chunk.group.add(trunk, crown);
      } else {
        const rock = createBox(2 + seed * 4, 0.6 + seed * 1.3, 2 + seed * 4, zone === "desert" ? 0x8f7646 : 0x3d4652);
        rock.position.set(x, rock.geometry.boundingBox ? 0.2 : 0.25, z);
        rock.rotation.y = seed * Math.PI;
        chunk.group.add(rock);
      }
    }

    for (let i = 0; i < 5; i++) {
      const seed = this.hash(id, i * 109 + 51);
      const side = seed > 0.5 ? 1 : -1;
      const lampX = roadX + side * (15.5 + this.hash(id, i * 113) * 4);
      const lampZ = chunkCenterZ - this.chunkDepth * 0.42 + this.hash(id, i * 127 + 53) * this.chunkDepth * 0.84;
      const pole = createBox(0.28, 5.2, 0.28, 0x1a2333);
      pole.position.set(lampX, 2.45, lampZ);
      const arm = createBox(3.4, 0.18, 0.18, 0x1a2333);
      arm.position.set(lampX - side * 1.5, 5.0, lampZ);
      const lamp = createGlowBox(1.1, 0.38, 1.1, zone === "desert" ? 0xffd487 : 0x9ff7ff, 0.62);
      lamp.position.set(lampX - side * 3.0, 4.88, lampZ);
      chunk.group.add(pole, arm, lamp);
    }

    if (Math.abs(id) % 3 === 1) {
      const crater = createBox(16, 0.05, 12, 0x242831);
      crater.position.set(roadX > 0 ? -112 : 112, -0.02, chunkCenterZ + (this.hash(id, 203) - 0.5) * 52);
      crater.rotation.y = this.hash(id, 211) * Math.PI;
      chunk.group.add(crater);
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
    const parts: THREE.Object3D[] = [];

    const carBody = createBox(2.8, 1.2, 5.5, carColor);
    carBody.position.set(carX, 0.6, carZ);
    const carRoof = createBox(2.4, 0.8, 3.0, 0x111111);
    carRoof.position.set(carX, 1.6, carZ - 0.5);
    const headlight = createGlowBox(2.2, 0.24, 0.18, forward ? 0xfff3b0 : 0xff3344, 0.68);
    headlight.position.set(carX, 0.86, carZ + (forward ? -3.05 : 3.05));
    const taillight = createGlowBox(2.2, 0.2, 0.14, forward ? 0xff3344 : 0xfff3b0, 0.5);
    taillight.position.set(carX, 0.9, carZ + (forward ? 3.05 : -3.05));
    headlight.userData.baseOpacity = 0.68;
    taillight.userData.baseOpacity = 0.5;

    chunk.group.add(carBody, carRoof, headlight, taillight);
    parts.push(carBody, carRoof, headlight, taillight);

    const band = this.chunkDepth * 0.5 - 6;
    this.chunkTraffic.get(id)?.push({
      x: carX,
      baseX: carX,
      z: carZ,
      speed,
      baseSpeed: speed,
      minZ: chunkCenterZ - band,
      maxZ: chunkCenterZ + band,
      parts,
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
    roadX: number,
    zone: string,
  ) {
    const boards: Billboard[] = [];
    for (let i = 0; i < 3; i++) {
      const seed = this.hash(id, i * 131 + 61);
      const side = seed < 0.5 ? -1 : 1;
      const x = roadX + side * (17 + this.hash(id, i * 137 + 67) * 9);
      const z =
        chunkCenterZ - this.chunkDepth * 0.45 + this.hash(id, i * 139 + 71) * this.chunkDepth * 0.9;

      const group = new THREE.Group();
      const pole = createBox(0.45, 5.4, 0.45, 0x2c3642);
      pole.position.set(0, 2.7, 0);
      const screenMat = this.buildBillboardTexture(zone, seed);
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
  private buildBillboardTexture(zone: string, seed: number) {
    const ads = ["HELI-TRONIC", "SKY-FUEL", "ROTOR-AID", "APACHE AIR", "NIGHT HAWK", "WARLOCK"];
    const palettes: Record<string, [string, string]> = {
      city: ["#0a1c2e", "#7fe8ff"],
      base: ["#1c1626", "#ffd97a"],
      refinery: ["#241a10", "#ff9a5c"],
      ruins: ["#1a1d26", "#8fd0ff"],
    };
    const [bg, accent] = palettes[zone] ?? palettes.city;
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

  private zoneForChunk(id: number) {
    const zones = ["city", "city", "ruins", "refinery", "city", "city"];
    return zones[Math.abs(Math.floor(this.hash(id, 17) * zones.length)) % zones.length];
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
    block.hp = Math.max(0, block.hp - amount);
    const damage = 1 - block.hp / block.maxHp;

    for (const mesh of block.meshes) {
      const mat = mesh.material;
      if (mat instanceof THREE.MeshLambertMaterial) {
        const baseColor = mat.userData.baseColor as THREE.Color | undefined;
        if (baseColor) {
          mat.color.copy(baseColor).lerp(new THREE.Color(0x211f24), damage * 0.8);
        }
      }
      mesh.scale.x = 1 + damage * 0.04;
      mesh.scale.z = 1 + damage * 0.04;
    }

    if (block.hp > 0 || block.destroyed) return;
    block.destroyed = true;

    if (this.particles) {
      this.particles.spawnExplosion(
        block.x,
        block.height * 0.5,
        block.z,
        60, // large particle count
        performance.now() / 1000,
        block.width * 1.5, // large size scale
      );
    }
    
    if (this.onBuildingDestroyed) {
      this.onBuildingDestroyed(block.x, block.height * 0.5, block.z);
    }

    if (block.body) {
      block.body.collisionFilterMask = 0;
      block.body.collisionResponse = false;
    }
    for (const mesh of block.meshes) {
      mesh.visible = false;
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
}
