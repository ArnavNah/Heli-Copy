import * as THREE from "three";
import * as CANNON from "cannon-es";

/**
 * Rigid-body debris — real cannon-es dynamics for destruction chunks.
 *
 * A fixed pool of small dynamic box bodies tumbles under gravity through the
 * world's existing `world.step` and bounces off a dedicated static ground
 * plane. Rendering is a single InstancedMesh (one draw call for ALL chunks).
 *
 * Perf contract:
 * - Hard-capped pool: cost is bounded no matter how much explodes.
 * - Inactive slots are parked below ground and put to sleep (skipped by the
 *   solver), and the instance buffer is only re-uploaded while debris lives.
 * - Collision-filtered onto their own groups so debris can never perturb
 *   gameplay bodies (helicopter, buildings, objectives).
 */

const MAX_DEBRIS = 28;
/** Collision groups: debris only sees its ground plane and vice versa. */
const DEBRIS_GROUP = 4;
const DEBRIS_GROUND_GROUP = 8;
/** Seconds a chunk lives before it is recycled. */
const DEBRIS_LIFETIME = 2.6;
/** Gravity magnitude used for nothing here (world supplies it) — kept for docs. */

interface DebrisSlot {
  body: CANNON.Body;
  /** Wall-clock seconds when the chunk was spawned. */
  bornAt: number;
  active: boolean;
  /** Uniform-ish render scale captured at spawn. */
  scale: number;
}

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh;
  private slots: DebrisSlot[] = [];
  private ground: CANNON.Body;
  private world: CANNON.World | null = null;
  private dummy = new THREE.Object3D();
  private scratchColor = new THREE.Color();

  constructor(private scene: THREE.Scene) {
    const geometry = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_DEBRIS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_DEBRIS * 3),
      3,
    );
    this.mesh.frustumCulled = false; // chunks fly anywhere; culling pops them

    // Park every instance far below the world until spawned.
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.dummy.position.set(0, -9999, 0);
      this.dummy.scale.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);

    // Static ground plane — debris bounces on this instead of falling forever.
    this.ground = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Plane(),
      collisionFilterGroup: DEBRIS_GROUND_GROUP,
      collisionFilterMask: DEBRIS_GROUP,
    });
    this.ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);

    for (let i = 0; i < MAX_DEBRIS; i++) {
      const body = new CANNON.Body({
        mass: 0.6,
        shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
        collisionFilterGroup: DEBRIS_GROUP,
        collisionFilterMask: DEBRIS_GROUND_GROUP,
        angularDamping: 0.25,
        linearDamping: 0.08,
        allowSleep: true,
        sleepSpeedLimit: 0.6,
        sleepTimeLimit: 0.4,
      });
      body.position.set(0, -9999, 0);
      body.sleep();
      this.slots.push({ body, bornAt: 0, active: false, scale: 1 });
    }
  }

  /** Wire the pool into the physics world (called once by the engine). */
  attachWorld(world: CANNON.World) {
    if (this.world === world) return;
    this.world = world;
    world.addBody(this.ground);
    for (const slot of this.slots) world.addBody(slot.body);
  }

  /**
   * Burst debris chunks from a point. `color` tints the whole burst (e.g. the
   * building's palette color); per-chunk jitter keeps it from reading flat.
   */
  spawn(
    x: number,
    y: number,
    z: number,
    now: number,
    count = 6,
    speed = 22,
    color = 0x6a625a,
    size = 1,
  ): number {
    let spawned = 0;
    for (const slot of this.slots) {
      if (spawned >= count) break;
      if (slot.active) continue;
      slot.active = true;
      slot.bornAt = now;
      slot.scale = size * (0.4 + Math.random() * 0.8);

      const body = slot.body;
      body.wakeUp();
      body.position.set(
        x + (Math.random() - 0.5) * 2.5,
        y + (Math.random() - 0.5) * 2.5,
        z + (Math.random() - 0.5) * 2.5,
      );
      body.velocity.set(
        (Math.random() - 0.5) * speed,
        Math.random() * speed * 0.75 + 4,
        (Math.random() - 0.5) * speed,
      );
      body.angularVelocity.set(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 12,
      );
      body.quaternion.setFromEuler(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );

      // Tint: base color with per-chunk brightness jitter.
      const jitter = 0.75 + Math.random() * 0.5;
      this.scratchColor.setHex(color).multiplyScalar(jitter);
      this.mesh.setColorAt(this.slots.indexOf(slot), this.scratchColor);
      spawned++;
    }
    if (spawned > 0 && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
    return spawned;
  }

  /** Sync live physics bodies into the instanced mesh; recycle dead chunks. */
  update(now: number) {
    let anyActive = false;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;
      const body = slot.body;
      if (now - slot.bornAt > DEBRIS_LIFETIME || body.position.y < -4) {
        this.recycle(slot, i);
        continue;
      }
      anyActive = true;
      this.dummy.position.set(body.position.x, body.position.y, body.position.z);
      this.dummy.quaternion.set(
        body.quaternion.x,
        body.quaternion.y,
        body.quaternion.z,
        body.quaternion.w,
      );
      // Shrink out over the last 25% of life so chunks don't pop.
      const life = 1 - (now - slot.bornAt) / DEBRIS_LIFETIME;
      const s = slot.scale * (life > 0.25 ? 1 : Math.max(0.01, life / 0.25));
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (anyActive) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private recycle(slot: DebrisSlot, index: number) {
    slot.active = false;
    slot.body.velocity.set(0, 0, 0);
    slot.body.angularVelocity.set(0, 0, 0);
    slot.body.position.set(0, -9999, 0);
    slot.body.sleep();
    this.dummy.position.set(0, -9999, 0);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(index, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Number of live chunks (perf overlay / tests). */
  get activeCount(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.active) n++;
    return n;
  }

  /** Recycle every active chunk — used on game reset so old debris doesn't
   *  persist into the new run. */
  reset() {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i].active) this.recycle(this.slots[i], i);
    }
  }

  dispose() {
    if (this.world) {
      for (const slot of this.slots) this.world.removeBody(slot.body);
      this.world.removeBody(this.ground);
      this.world = null;
    }
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
