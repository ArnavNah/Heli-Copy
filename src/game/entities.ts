import * as THREE from "three";
import * as CANNON from "cannon-es";
import { createBox, createGlowBox, createGlowMaterial, createLowPolyMaterial } from "./materials";
import {
  AttackPattern,
  EnemyLock,
  EnemyModifier,
  EnemyType,
  HelicopterModel,
  ObjectiveType,
  PowerUpType,
} from "./types";
import { BOSS_TELEGRAPH_DURATION, bossPhaseForRatio, bossVolleyConfig, objectiveConfig } from "./logic";
import type { CityBlock } from "./types";
import type { CityEnvironment } from "./city";
import type { GPUParticleSystem } from "./particles";

export class Entity {
  mesh!: THREE.Object3D;
  body!: CANNON.Body;
  active: boolean = true;
  world!: CANNON.World;
  scene!: THREE.Scene;

  constructor(scene: THREE.Scene, world: CANNON.World) {
    this.scene = scene;
    this.world = world;
  }

  update(time: number = 0) {
    if (this.active && this.mesh && this.body) {
      this.mesh.position.copy(this.body.position as any);
      // We don't copy quaternion directly because we manually bank/tilt the mesh for stylized physics
    }
  }

  destroy() {
    this.active = false;
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this.body && this.world) this.world.removeBody(this.body);
  }
}

const tempColor = new THREE.Color();
const tempVec3_1 = new CANNON.Vec3();
const tempVec3_2 = new CANNON.Vec3();

export class Helicopter extends Entity {
  model: HelicopterModel = HelicopterModel.APACHE;
  targetPosition: THREE.Vector3;
  lastTargetPosition: THREE.Vector3;
  mainRotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  shieldMesh: THREE.Mesh | null = null;
  /** Rotating chin gun turret — tracks auto-aim targets while the body flies on. */
  gunMount: THREE.Group = new THREE.Group();
  gunAimMode: boolean = false;
  gunAimPoint: THREE.Vector3 = new THREE.Vector3();

  // Subsystems
  rotorHealth: number = 100;
  engineHealth: number = 100;
  hoverFloor: number = 0;
  smoothedHoverFloor: number = 0;
  aimPosition: THREE.Vector3 = new THREE.Vector3(0, 26, -30);

  // Dash variables
  dashTimer: number = 0;
  dashDuration: number = 0.28;
  dashRollDirection: number = 0;
  dashPitchDirection: number = 0;

  triggerDash(dx: number, dz: number) {
    this.dashTimer = this.dashDuration;
    this.dashRollDirection = dx;
    this.dashPitchDirection = -dz; // Negative Z is forward
  }

  constructor(scene: THREE.Scene, world: CANNON.World, model: HelicopterModel = HelicopterModel.APACHE) {
    super(scene, world);
    this.model = model;
    this.targetPosition = new THREE.Vector3(0, 26, 0);
    this.lastTargetPosition = new THREE.Vector3(0, 26, 0);

    const baseGroup = new THREE.Group();

    // Model-tinted shared materials (Nighthawk is dark slate, Warlock olive,
    // Apache keeps the original green — so each model keeps its own identity)
    const bodyMat = createLowPolyMaterial(
      model === HelicopterModel.NIGHTHAWK
        ? 0x242c30
        : model === HelicopterModel.WARLOCK
          ? 0x3a4436
          : 0x2d3a2e,
    );
    const darkBodyMat = createLowPolyMaterial(
      model === HelicopterModel.NIGHTHAWK
        ? 0x101820
        : model === HelicopterModel.WARLOCK
          ? 0x242c2a
          : 0x1a211a,
    );
    const glassMat = createLowPolyMaterial(
      model === HelicopterModel.NIGHTHAWK ? 0x101820 : 0x1c2b33,
    );
    const metalMat = createLowPolyMaterial(0x5a6360);
    const bladeMat = createLowPolyMaterial(0x161a18);
    const ordnanceMat = createLowPolyMaterial(0x212b25);
    const accentMat = createLowPolyMaterial(0xb33127);

    if (model === HelicopterModel.NIGHTHAWK) {
      this.buildNighthawk(baseGroup, bodyMat, darkBodyMat, glassMat, metalMat, bladeMat, accentMat);
    } else if (model === HelicopterModel.WARLOCK) {
      this.buildWarlock(baseGroup, bodyMat, darkBodyMat, glassMat, metalMat, bladeMat, accentMat);
    } else {
      this.buildApache(baseGroup, bodyMat, darkBodyMat, glassMat, metalMat, bladeMat, ordnanceMat, accentMat);
    }

    // Shared rotating chin gun turret (all models) — replaces the static Apache chin gun
    const gunMountBase = createBox(0.6, 0.4, 0.6, 0x161a18);
    gunMountBase.material = bladeMat;
    const gunBarrel = createBox(0.14, 0.14, 2.0, 0x22262a);
    gunBarrel.material = bladeMat;
    gunBarrel.position.set(0, 0, 1.0);
    const gunMuzzle = createGlowBox(0.3, 0.3, 0.26, 0xff4444, 0.85);
    gunMuzzle.position.set(0, 0, 2.05);
    this.gunMount.add(gunMountBase, gunBarrel, gunMuzzle);
    this.gunMount.position.set(0, -0.95, 3.0);
    baseGroup.add(this.gunMount);

    // Mast & Rotor (shared)
    const mast = createBox(0.6, 1.5, 0.6, 0x5a6360);
    mast.material = metalMat;
    mast.position.set(0, 1.4, -0.2);
    baseGroup.add(mast);

    this.mainRotor = new THREE.Group();
    this.mainRotor.position.set(0, 2.1, -0.2);
    
    // Rotor hub
    const hub = createBox(1.2, 0.2, 1.2, 0x5a6360);
    hub.material = metalMat;
    this.mainRotor.add(hub);

    for (let i = 0; i < 4; i++) {
      const blade = createBox(0.35, 0.05, 11.0, 0x161a18);
      blade.material = bladeMat;
      blade.position.set(0, 0, 5.5); // Pivot at hub
      
      const bladePivot = new THREE.Group();
      bladePivot.rotation.y = (Math.PI / 2) * i;
      bladePivot.add(blade);
      this.mainRotor.add(bladePivot);
    }

    // Rotor Blur Disc (Transparent)
    const blurGeo = new THREE.RingGeometry(3.2, 11.5, 56);
    blurGeo.rotateX(-Math.PI / 2);
    const blurMat = new THREE.MeshBasicMaterial({
      color: 0xd8f6ff,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const blurDisc = new THREE.Mesh(blurGeo, blurMat);
    blurDisc.name = "rotorBlur";
    blurDisc.visible = false;
    this.mainRotor.add(blurDisc);
    baseGroup.add(this.mainRotor);

    this.tailRotor = new THREE.Group();
    this.tailRotor.position.set(0.3, 1.8, -8.5);
    
    const tailHub = createBox(0.2, 0.4, 0.4, 0x5a6360);
    tailHub.material = metalMat;
    this.tailRotor.add(tailHub);

    for (let i = 0; i < 4; i++) {
      const blade = createBox(0.05, 1.8, 0.15, 0x161a18);
      blade.material = bladeMat;
      blade.position.set(0, 0.9, 0); // Pivot at hub
      
      const bladePivot = new THREE.Group();
      bladePivot.rotation.x = (Math.PI / 2) * i;
      bladePivot.add(blade);
      this.tailRotor.add(bladePivot);
    }
    
    const tailBlurGeo = new THREE.RingGeometry(0.45, 1.9, 28);
    tailBlurGeo.rotateY(Math.PI / 2);
    const tailBlurDisc = new THREE.Mesh(tailBlurGeo, blurMat);
    tailBlurDisc.name = "tailBlur";
    tailBlurDisc.visible = false;
    this.tailRotor.add(tailBlurDisc);
    baseGroup.add(this.tailRotor);
    // Shield Bubble Mesh
    const shieldGeo = new THREE.SphereGeometry(3.6, 16, 16);
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.28,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
    this.shieldMesh.visible = false;
    baseGroup.add(this.shieldMesh);

    this.mesh = baseGroup;
    this.mesh.rotation.order = "YXZ";
    scene.add(this.mesh);

    this.body = new CANNON.Body({
      mass: 5,
      type: CANNON.Body.DYNAMIC,
      position: new CANNON.Vec3(0, 26, 0),
      linearDamping: 0.18, // Low: the PD controller owns velocity, damping was fighting it
      angularDamping: 0.9,
    });

    // Core hitbox
    const shape = new CANNON.Box(new CANNON.Vec3(1.25, 1.05, 2.35));
    this.body.addShape(shape);
    this.body.fixedRotation = true;
    this.body.updateMassProperties();
    world.addBody(this.body);
  }

  /** Default Apache attack helicopter (original design). */
  private buildApache(
    baseGroup: THREE.Group,
    bodyMat: THREE.MeshLambertMaterial,
    darkBodyMat: THREE.MeshLambertMaterial,
    glassMat: THREE.MeshLambertMaterial,
    metalMat: THREE.MeshLambertMaterial,
    bladeMat: THREE.MeshLambertMaterial,
    ordnanceMat: THREE.MeshLambertMaterial,
    accentMat: THREE.MeshLambertMaterial,
  ) {
    // Main Fuselage
    const fuselage = createBox(2.2, 1.6, 5.8, 0x2d3a2e);
    fuselage.material = bodyMat;
    fuselage.position.set(0, 0, -0.5);
    baseGroup.add(fuselage);

    // Nose & Sensor Pod
    const nose = createBox(1.5, 1.2, 2.2, 0x2d3a2e);
    nose.material = bodyMat;
    nose.position.set(0, -0.2, 3.5);
    baseGroup.add(nose);
    
    const sensorPod = createBox(0.8, 0.7, 1.0, 0x1a211a);
    sensorPod.material = darkBodyMat;
    sensorPod.position.set(0, -0.9, 4.0);
    baseGroup.add(sensorPod);

    // (Static chin gun replaced by the shared rotating gun turret)

    // Tandem Cockpit
    const rearCanopy = createBox(1.2, 0.8, 1.5, 0x1c2b33);
    rearCanopy.material = glassMat;
    rearCanopy.position.set(0, 0.9, 1.2);
    rearCanopy.rotation.x = -0.05;
    baseGroup.add(rearCanopy);

    const frontCanopy = createBox(1.1, 0.6, 1.4, 0x1c2b33);
    frontCanopy.material = glassMat;
    frontCanopy.position.set(0, 0.6, 2.6);
    frontCanopy.rotation.x = -0.15;
    baseGroup.add(frontCanopy);

    // Engine Intakes (Sides)
    const engineLeft = createBox(1.0, 0.9, 2.8, 0x1a211a);
    engineLeft.material = darkBodyMat;
    engineLeft.position.set(-1.4, 0.4, -0.8);
    const engineRight = engineLeft.clone();
    engineRight.position.x = 1.4;
    baseGroup.add(engineLeft, engineRight);

    // Tail Boom
    const tailBoom = createBox(0.7, 0.9, 6.2, 0x2d3a2e);
    tailBoom.material = bodyMat;
    tailBoom.position.set(0, 0.1, -6.0);
    baseGroup.add(tailBoom);

    const tailFin = createBox(0.3, 2.4, 1.4, 0x1a211a);
    tailFin.material = darkBodyMat;
    tailFin.position.set(0, 1.1, -8.4);
    tailFin.rotation.x = 0.15;
    baseGroup.add(tailFin);

    const tailStabilizer = createBox(3.0, 0.15, 0.8, 0x2d3a2e);
    tailStabilizer.material = bodyMat;
    tailStabilizer.position.set(0, 0.2, -7.8);
    baseGroup.add(tailStabilizer);

    // Stub Wings
    const stubWingLeft = createBox(3.8, 0.25, 1.4, 0x2d3a2e);
    stubWingLeft.material = bodyMat;
    stubWingLeft.position.set(-2.5, -0.1, 0.2);
    stubWingLeft.rotation.z = -0.05;
    const stubWingRight = stubWingLeft.clone();
    stubWingRight.position.x = 2.5;
    stubWingRight.rotation.z = 0.05;
    baseGroup.add(stubWingLeft, stubWingRight);

    // Pylons and Missiles
    const pylonOffsets = [-3.8, -2.6, 2.6, 3.8];
    pylonOffsets.forEach((px) => {
      const pylon = createBox(0.2, 0.5, 0.8, 0x212b25);
      pylon.material = ordnanceMat;
      pylon.position.set(px, -0.4, 0.2);
      baseGroup.add(pylon);

      // Rocket pod
      const pod = createBox(0.6, 0.6, 1.4, 0x1a211a);
      pod.material = darkBodyMat;
      pod.position.set(px, -0.8, 0.2);
      baseGroup.add(pod);

      const tip = createBox(0.2, 0.2, 0.3, 0xb33127);
      tip.material = accentMat;
      tip.position.set(px, -0.8, 0.95);
      baseGroup.add(tip);
    });

    // Landing Gear (Wheels)
    const gearStrutL = createBox(0.2, 1.2, 0.2, 0x5a6360);
    gearStrutL.material = metalMat;
    gearStrutL.position.set(-1.2, -1.2, 1.5);
    const gearStrutR = gearStrutL.clone();
    gearStrutR.position.x = 1.2;
    const gearStrutRear = createBox(0.2, 1.0, 0.2, 0x5a6360);
    gearStrutRear.material = metalMat;
    gearStrutRear.position.set(0, -0.8, -4.5);
    baseGroup.add(gearStrutL, gearStrutR, gearStrutRear);

    const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 8).toNonIndexed();
    wheelGeo.computeVertexNormals();
    const wheelMat = createLowPolyMaterial(0x111111);
    const wheelL = new THREE.Mesh(wheelGeo, wheelMat);
    wheelL.rotation.z = Math.PI / 2;
    wheelL.position.set(-1.3, -1.8, 1.5);
    const wheelR = wheelL.clone();
    wheelR.position.x = 1.3;
    const wheelRear = wheelL.clone();
    wheelRear.position.set(0, -1.3, -4.5);
    baseGroup.add(wheelL, wheelR, wheelRear);
  }

  /** NIGHTHAWK — angular stealth gunship with twin tails and a dark fuselage. */
  private buildNighthawk(
    baseGroup: THREE.Group,
    bodyMat: THREE.MeshLambertMaterial,
    darkBodyMat: THREE.MeshLambertMaterial,
    glassMat: THREE.MeshLambertMaterial,
    metalMat: THREE.MeshLambertMaterial,
    bladeMat: THREE.MeshLambertMaterial,
    accentMat: THREE.MeshLambertMaterial,
  ) {
    const hull = createBox(2.0, 1.3, 6.4, 0x242c30);
    hull.material = bodyMat;
    baseGroup.add(hull);

    // Angular faceted nose
    const noseLow = createBox(1.4, 0.7, 1.6, 0x242c30);
    noseLow.material = bodyMat;
    noseLow.position.set(0, -0.35, 3.9);
    const noseTop = createBox(1.0, 0.5, 1.2, 0x1a211a);
    noseTop.material = darkBodyMat;
    noseTop.position.set(0, 0.45, 4.0);
    baseGroup.add(noseLow, noseTop);

    // Stealth canopy (dark angular glass)
    const canopy = createBox(1.0, 0.6, 2.2, 0x101820);
    canopy.material = glassMat;
    canopy.position.set(0, 0.75, 1.6);
    canopy.rotation.x = -0.1;
    baseGroup.add(canopy);

    // Twin tail booms with vertical stabilizers
    const boomL = createBox(0.5, 0.6, 4.6, 0x242c30);
    boomL.material = bodyMat;
    boomL.position.set(-1.1, 0.3, -4.6);
    const boomR = boomL.clone();
    boomR.position.x = 1.1;
    baseGroup.add(boomL, boomR);

    const finL = createBox(0.25, 1.9, 1.1, 0x1a211a);
    finL.material = darkBodyMat;
    finL.position.set(-1.1, 1.1, -6.2);
    finL.rotation.x = 0.12;
    const finR = finL.clone();
    finR.position.x = 1.1;
    baseGroup.add(finL, finR);

    // Wide delta wings
    const wingL = createBox(3.6, 0.22, 1.6, 0x242c30);
    wingL.material = bodyMat;
    wingL.position.set(-2.4, -0.15, 0.1);
    wingL.rotation.z = 0.06;
    const wingR = wingL.clone();
    wingR.position.x = 2.4;
    wingR.rotation.z = -0.06;
    baseGroup.add(wingL, wingR);

    // Wingtip missiles (stub pylons)
    [-3.3, 3.3].forEach((px) => {
      const rail = createBox(0.16, 0.34, 1.9, 0x111111);
      rail.material = bladeMat;
      rail.position.set(px, -0.45, 0.1);
      const tip = createBox(0.22, 0.22, 0.3, 0xff3344);
      tip.material = accentMat;
      tip.position.set(px, -0.45, 1.05);
      baseGroup.add(rail, tip);
    });

    // Stealth fins under the nose
    const chinFin = createBox(0.3, 0.8, 1.4, 0x1a211a);
    chinFin.material = darkBodyMat;
    chinFin.position.set(0, -0.95, 2.4);
    baseGroup.add(chinFin);
  }

  /** WARLOCK — heavy gunship: bulky hull, wide wings, dual rotor mast, heavy ordnance. */
  private buildWarlock(
    baseGroup: THREE.Group,
    bodyMat: THREE.MeshLambertMaterial,
    darkBodyMat: THREE.MeshLambertMaterial,
    glassMat: THREE.MeshLambertMaterial,
    metalMat: THREE.MeshLambertMaterial,
    bladeMat: THREE.MeshLambertMaterial,
    accentMat: THREE.MeshLambertMaterial,
  ) {
    const hull = createBox(2.5, 1.9, 6.6, 0x3a4436);
    hull.material = bodyMat;
    baseGroup.add(hull);

    // Armored nose
    const nose = createBox(1.8, 1.5, 2.2, 0x3a4436);
    nose.material = bodyMat;
    nose.position.set(0, -0.1, 4.2);
    baseGroup.add(nose);

    // Flat armored canopy
    const canopy = createBox(1.5, 0.7, 1.9, 0x1c2b33);
    canopy.material = glassMat;
    canopy.position.set(0, 0.9, 3.4);
    canopy.rotation.x = -0.12;
    baseGroup.add(canopy);

    // Chunky engine nacelles
    const nacelleL = createBox(1.2, 1.2, 3.2, 0x1a211a);
    nacelleL.material = darkBodyMat;
    nacelleL.position.set(-1.7, 0.4, -0.6);
    const nacelleR = nacelleL.clone();
    nacelleR.position.x = 1.7;
    baseGroup.add(nacelleL, nacelleR);

    // Broad wing spar with hardpoints
    const wingL = createBox(4.6, 0.3, 1.6, 0x3a4436);
    wingL.material = bodyMat;
    wingL.position.set(-2.8, -0.3, 0.3);
    wingL.rotation.z = 0.03;
    const wingR = wingL.clone();
    wingR.position.x = 2.8;
    wingR.rotation.z = -0.03;
    baseGroup.add(wingL, wingR);

    // Heavy rocket pods under each wing
    [-2.9, -1.7, 1.7, 2.9].forEach((px) => {
      const pod = createBox(0.7, 0.7, 2.0, 0x2a3030);
      pod.material = darkBodyMat;
      pod.position.set(px, -0.85, 0.3);
      const muzzle = createBox(0.8, 0.8, 0.3, 0xb33127);
      muzzle.material = accentMat;
      muzzle.position.set(px, -0.85, 1.35);
      baseGroup.add(pod, muzzle);
    });

    // Twin tail boom
    const tailBoom = createBox(0.8, 1.0, 6.6, 0x3a4436);
    tailBoom.material = bodyMat;
    tailBoom.position.set(0, 0.2, -6.2);
    baseGroup.add(tailBoom);

    const tailFin = createBox(0.35, 2.6, 1.5, 0x1a211a);
    tailFin.material = darkBodyMat;
    tailFin.position.set(0, 1.3, -9.0);
    tailFin.rotation.x = 0.14;
    baseGroup.add(tailFin);

    const stabilizerL = createBox(2.6, 0.2, 1.0, 0x3a4436);
    stabilizerL.material = bodyMat;
    stabilizerL.position.set(-1.6, 0.3, -8.4);
    const stabilizerR = stabilizerL.clone();
    stabilizerR.position.x = 1.6;
    baseGroup.add(stabilizerL, stabilizerR);

    // Heavy landing skids
    const skidL = createBox(0.3, 0.3, 2.6, 0x5a6360);
    skidL.material = metalMat;
    skidL.position.set(-1.6, -1.1, 0.6);
    const skidR = skidL.clone();
    skidR.position.x = 1.6;
    const skidRear = createBox(0.3, 0.3, 2.2, 0x5a6360);
    skidRear.material = metalMat;
    skidRear.position.set(0, -1.0, -4.6);
    baseGroup.add(skidL, skidR, skidRear);
  }

  setTarget(x: number, y: number, z: number) {
    this.targetPosition.set(x, y, z);
  }

  setAim(x: number, z: number) {
    this.aimPosition.set(x, 26, z);
  }

  setHoverFloor(height: number) {
    this.hoverFloor = height;
  }

  takeDamage(amount: number) {
    // Randomly distribute damage to subsystems based on a threshold
    const criticalThreshold = 0.4; // 40% chance of subsystem damage per hit
    if (Math.random() < criticalThreshold) {
      if (Math.random() > 0.5) {
        this.engineHealth = Math.max(0, this.engineHealth - amount * 0.5);
      } else {
        this.rotorHealth = Math.max(0, this.rotorHealth - amount * 0.5);
      }
    }
  }

  /** Kick off a visible out-of-control wobble after slamming into terrain. */
  triggerCrashTilt(strength: number) {
    this.crashTiltTimer = 0.65;
    this.crashTiltStrength = Math.min(1, Math.max(0.2, strength));
  }

  /** Point the chin gun turret at a world position (auto-aim). Pass active=false to return to neutral. */
  setGunAim(x: number, y: number, z: number, active: boolean) {
    this.gunAimMode = active;
    if (active) this.gunAimPoint.set(x, y, z);
  }

  repair(percent: number) {
    this.engineHealth = Math.min(100, this.engineHealth + percent);
    this.rotorHealth = Math.min(100, this.rotorHealth + percent);
  }

  reset() {
    this.active = true;
    this.rotorHealth = 100;
    this.engineHealth = 100;
    this.hoverFloor = 0;
    this.smoothedHoverFloor = 0;
    this.crashTiltTimer = 0;
    this.crashTiltStrength = 1;
    this.gunAimMode = false;
    this.targetPosition.set(0, 26, 0);
    this.lastTargetPosition.set(0, 26, 0);
    this.aimPosition.set(0, 26, -30);
    this.body.position.set(0, 26, 0);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.force.set(0, 0, 0);
    this.body.torque.set(0, 0, 0);
    this.mesh.position.set(0, 26, 0);
    this.mesh.rotation.set(0, 0, 0);
  }

  update(
    time: number = 0,
    delta: number = 0.016,
    windForce?: CANNON.Vec3,
    particles?: GPUParticleSystem,
    shieldActive: boolean = false,
    speedBoostActive: boolean = false,
    hasInput: boolean = false,
    autoScrollSpeed: number = 28,
  ) {
    if (!this.active) return;

    // Toggle and animate shield bubble
    if (this.shieldMesh) {
      this.shieldMesh.visible = shieldActive;
      if (shieldActive) {
        this.shieldMesh.rotation.y = time * 2;
        this.shieldMesh.rotation.x = time * 0.5;
        const scale = 1.0 + Math.sin(time * 6) * 0.05;
        this.shieldMesh.scale.set(scale, scale, scale);
      }
    }

    // Speed Boost visual trails from wingtips
    if (particles && speedBoostActive && Math.random() < 0.3) {
      const leftTip = new THREE.Vector3(-1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
      const rightTip = new THREE.Vector3(1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
      particles.spawnSmoke(leftTip.x, leftTip.y, leftTip.z, time);
      particles.spawnSmoke(rightTip.x, rightTip.y, rightTip.z, time);
      if (Math.random() < 0.4) {
        particles.spawnSparks(leftTip.x, leftTip.y, leftTip.z, time);
        particles.spawnSparks(rightTip.x, rightTip.y, rightTip.z, time);
      }
    }

    if (this.dashTimer > 0) {
      this.dashTimer -= delta;

      // Visual rotation during dash
      const progress = 1.0 - (this.dashTimer / this.dashDuration);
      if (this.dashRollDirection !== 0) {
        // Sideways barrel roll!
        const rollAngle = progress * Math.PI * 2 * -this.dashRollDirection;
        this.mesh.rotation.z = rollAngle;
        this.mesh.rotation.x = Math.sin(progress * Math.PI) * -0.22; // slight dip forward
      } else if (this.dashPitchDirection !== 0) {
        // Forward/backward stunt flip!
        const pitchAngle = progress * Math.PI * 2 * this.dashPitchDirection;
        this.mesh.rotation.x = pitchAngle;
        this.mesh.rotation.z = 0;
      }

      this.mesh.position.copy(this.body.position as any);

      // Spawn spiraling particles during barrel roll or flip
      if (particles && Math.random() < 0.45) {
        const leftTip = new THREE.Vector3(-1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
        const rightTip = new THREE.Vector3(1.9, 0.4, 0.2).applyMatrix4(this.mesh.matrixWorld);
        particles.spawnSmoke(leftTip.x, leftTip.y, leftTip.z, time);
        particles.spawnSmoke(rightTip.x, rightTip.y, rightTip.z, time);
        if (Math.random() < 0.2) {
          particles.spawnSparks(leftTip.x, leftTip.y, leftTip.z, time);
          particles.spawnSparks(rightTip.x, rightTip.y, rightTip.z, time);
        }
      }

      // Still apply gravity compensation and vertical target tracking so we don't fall/rise wildly
      this.smoothedHoverFloor +=
        (this.hoverFloor - this.smoothedHoverFloor) *
        Math.min(1, delta * (this.hoverFloor > this.smoothedHoverFloor ? 6.5 : 2.5));
      const hoverBob = Math.sin(time * 1.7) * 0.14;
      const targetY = Math.max(this.targetPosition.y, this.smoothedHoverFloor + 7.5) + hoverBob;
      const ey = targetY - this.body.position.y;
      const gravityComp = 9.82 * this.body.mass;
      const fy = ey * 112 - this.body.velocity.y * 38 + gravityComp;

      tempVec3_2.set(0, fy, 0);
      this.body.applyForce(tempVec3_2, this.body.position);

      this.animateRotors(80, 60, delta);
      return;
    }

    // Subsystem Penalties
    const engineEff = 0.5 + (this.engineHealth / 100) * 0.5; // Up to 50% thrust loss
    const rotorEff = 0.4 + (this.rotorHealth / 100) * 0.6; // Up to 60% agility loss

    // Hull Damage Visuals
    const hullDamage =
      1.0 - (this.rotorHealth * 0.3 + this.engineHealth * 0.7) / 100;
    this.mesh.traverse((child) => {
      if (
        child instanceof THREE.Mesh &&
        child.material instanceof THREE.MeshLambertMaterial
      ) {
        const baseColor = child.material.userData.baseColor as
          | THREE.Color
          | undefined;
        if (baseColor) {
          tempColor.setHex(0x4d171a);
          child.material.color
            .copy(baseColor)
            .lerp(tempColor, hullDamage * 0.75);
        }
      }
    });

    // Subsystem Damage Visuals (Smoke & Sparks)
    if (particles) {
      if (this.engineHealth < 60 && Math.random() < 0.15) {
        particles.spawnSmoke(
          this.mesh.position.x,
          this.mesh.position.y - 0.5,
          this.mesh.position.z,
          time,
        );
      }
      if (this.rotorHealth < 50 && Math.random() < 0.1) {
        particles.spawnSparks(
          this.mesh.position.x,
          this.mesh.position.y + 1.2,
          this.mesh.position.z,
          time,
        );
      }
    }

    // Calculate player input agility (reticle speed) - exclude auto scroll
    const dxInput = this.targetPosition.x - this.lastTargetPosition.x;
    const dzInput = (this.targetPosition.z - this.lastTargetPosition.z) + (autoScrollSpeed * delta);
    const inputSpeed =
      Math.sqrt(dxInput * dxInput + dzInput * dzInput) / Math.max(delta, 0.001);
    this.lastTargetPosition.copy(this.targetPosition);

    // Responsiveness Scale (0.0 to 1.0)
    const inputAgility = Math.min(inputSpeed / 80.0, 1.0);

    const ex = this.targetPosition.x - this.body.position.x;
    const ez = this.targetPosition.z - this.body.position.z;
    const distToTarget = Math.sqrt(ex * ex + ez * ez);

    const maxCruiseSpeed = (55 + inputAgility * 20) * engineEff;
    // Tighter target tracking: higher position gain so the chase feels connected
    let desiredVx = THREE.MathUtils.clamp(ex * 7.5, -maxCruiseSpeed, maxCruiseSpeed);
    let desiredVz = THREE.MathUtils.clamp(ez * 7.5, -maxCruiseSpeed, maxCruiseSpeed);
    const desiredSpeed = Math.sqrt(desiredVx * desiredVx + desiredVz * desiredVz);
    if (desiredSpeed > maxCruiseSpeed) {
      desiredVx = (desiredVx / desiredSpeed) * maxCruiseSpeed;
      desiredVz = (desiredVz / desiredSpeed) * maxCruiseSpeed;
    }

    // Smoother flight: moderate accelResponsiveness (10 to 15) — crisp but not twitchy
    const accelResponsiveness = (10 + inputAgility * 5) * rotorEff * engineEff;
    let fx = (desiredVx - this.body.velocity.x) * this.body.mass * accelResponsiveness;
    let fz = (desiredVz - this.body.velocity.z) * this.body.mass * accelResponsiveness;

    // Apply Environmental Wind
    if (windForce) {
      fx += windForce.x * 0.35;
      fz += windForce.z * 0.35;
    }

    // Organic hover drifting (relative speed excludes autoScrollSpeed)
    const relativeSpeed = Math.sqrt(
      this.body.velocity.x ** 2 + (this.body.velocity.z + autoScrollSpeed) ** 2,
    );
    const isIdle = !hasInput && distToTarget < 5.0; // Is the player resting?

    // Idle breath: a slow, gentle hover sway (single soft frequencies) instead of
    // the old jittery Lissajous drift that read as constant shaking.
    const idleFactor = Math.max(0, 1.0 - relativeSpeed / 8.0);
    fx += Math.sin(time * 0.7 + 1.3) * idleFactor * 3.2;
    fz += Math.cos(time * 0.65) * idleFactor * 3.2;

    // Allow force to be applied without clipping
    const maxForce = (2500 + inputAgility * 500) * engineEff;
    const forceMag = Math.sqrt(fx * fx + fz * fz);
    if (forceMag > maxForce) {
      fx = (fx / forceMag) * maxForce;
      fz = (fz / forceMag) * maxForce;
    }

    tempVec3_1.set(fx, 0, fz);
    this.body.applyForce(tempVec3_1, this.body.position);

    this.smoothedHoverFloor +=
      (this.hoverFloor - this.smoothedHoverFloor) *
      Math.min(1, delta * (this.hoverFloor > this.smoothedHoverFloor ? 6.5 : 2.5));

    const hoverBob = Math.sin(time * 1.35) * 0.08; // gentle breathing altitude
    const targetY = Math.max(this.targetPosition.y, this.smoothedHoverFloor + 7.5) + hoverBob;
    const ey = targetY - this.body.position.y;

    const gravityComp = 9.82 * this.body.mass;
    const fy = ey * 112 - this.body.velocity.y * 38 + gravityComp;

    tempVec3_2.set(0, fy, 0);
    this.body.applyForce(tempVec3_2, this.body.position);

    // Heading targeting — when the gun turret tracks a target (auto-aim), the
    // body flies on course and the chin gun does the aiming; otherwise the nose
    // swings toward the aim point like a classic twin-stick shooter.
    let targetAngle = this.mesh.rotation.y;
    const aimDx = this.aimPosition.x - this.body.position.x;
    const aimDz = this.aimPosition.z - this.body.position.z;
    if (!this.gunAimMode && Math.sqrt(aimDx * aimDx + aimDz * aimDz) > 2) {
      targetAngle = Math.atan2(aimDx, aimDz);
    } else if (!isIdle) {
      targetAngle = Math.atan2(ex, ez);
    }

    let currentAngle = this.mesh.rotation.y;
    let diff = targetAngle - currentAngle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    // Turn faster when input is aggressive
    const turnTurnSpeed = (0.22 + inputAgility * 0.15) * rotorEff;
    this.mesh.rotation.y += diff * turnTurnSpeed;

    // Rotating chin gun turret — tracks the auto-aim target, or eases to neutral
    const gunYawTarget = this.gunAimMode
      ? Math.atan2(
          this.gunAimPoint.x - this.body.position.x,
          this.gunAimPoint.z - this.body.position.z,
        ) - this.mesh.rotation.y
      : 0;
    let gunDiff = gunYawTarget - this.gunMount.rotation.y;
    while (gunDiff < -Math.PI) gunDiff += Math.PI * 2;
    while (gunDiff > Math.PI) gunDiff -= Math.PI * 2;
    this.gunMount.rotation.y += gunDiff * Math.min(1, delta * 12);

    const gDx = this.gunAimPoint.x - this.body.position.x;
    const gDz = this.gunAimPoint.z - this.body.position.z;
    const gDy = this.gunAimPoint.y - this.body.position.y;
    const gHoriz = Math.max(0.001, Math.sqrt(gDx * gDx + gDz * gDz));
    const gunPitchTarget = this.gunAimMode
      ? THREE.MathUtils.clamp(-Math.atan2(gDy, gHoriz), -0.7, 0.7)
      : 0;
    this.gunMount.rotation.x += (gunPitchTarget - this.gunMount.rotation.x) * Math.min(1, delta * 10);

    this.mesh.position.copy(this.body.position as any);

    const cy = Math.cos(this.mesh.rotation.y);
    const sy = Math.sin(this.mesh.rotation.y);
    // Transform velocity to local space (Z forward, X right)
    const localVx = this.body.velocity.x * cy - this.body.velocity.z * sy;
    const localVz = this.body.velocity.x * sy + this.body.velocity.z * cy;

    // Auto-Stabilization: Suppress tilt if idling to gently correct rotation
    const tiltMultiplier = isIdle ? 0.22 : 1.25;

    // Transform applied forces to local space to tilt/roll based on thrust/acceleration
    const localFx = fx * cy - fz * sy;
    const localFz = fx * sy + fz * cy;

    // Visual Tilting: Pitch DOWN when accelerating forward (positive localVz/negative localFz)
    // and pitch UP (flare) when braking. Roll INTO turns based on lateral forces.
    const tiltCap = 0.52;
    // Increased force coefficients to match the smoothed, smaller force values
    const targetTiltX =
      THREE.MathUtils.clamp(localFz * 0.0025 + localVz * 0.0035, -tiltCap, tiltCap) * tiltMultiplier;
    const targetTiltZ =
      -THREE.MathUtils.clamp(localFx * 0.0025 + localVx * 0.0035, -tiltCap, tiltCap) * tiltMultiplier;

    const tiltSmoothing =
      (isIdle ? 0.055 : 0.16 + inputAgility * 0.08) * rotorEff;
    this.mesh.rotation.x +=
      (targetTiltX - this.mesh.rotation.x) * tiltSmoothing;
    this.mesh.rotation.z +=
      (targetTiltZ - this.mesh.rotation.z) * tiltSmoothing;

    // Crash wobble — the ship rocks out of control after slamming into a building
    if (this.crashTiltTimer > 0) {
      this.crashTiltTimer -= delta;
      const k = (this.crashTiltTimer / 0.65) * this.crashTiltStrength;
      this.mesh.rotation.x += Math.sin(time * 26) * 0.34 * k;
      this.mesh.rotation.z += Math.cos(time * 21) * 0.28 * k;
      if (particles && Math.random() < 0.5) {
        particles.spawnSmoke(
          this.mesh.position.x + (Math.random() - 0.5),
          this.mesh.position.y - 0.6,
          this.mesh.position.z + (Math.random() - 0.5),
          time,
        );
      }
    }

    // Spool up rotors based on load + Damage Jitter
    const rotorJitter = this.rotorHealth < 30 ? Math.sin(time * 60) * 0.05 : 0;
    this.mainRotor.position.y = 2.1 + rotorJitter; // Adjusted for Apache mast height

    this.animateRotors(inputSpeed, 60, delta);
  }
  rotorSpeed: number = 0;
  crashTiltTimer: number = 0;
  crashTiltStrength: number = 1;

  animateRotors(forceMag: number, maxForce: number, delta: number) {
    const rotorEff = this.rotorHealth / 100;
    
    // Store angular speed in radians per second so animation is independent of frame rate.
    const load = THREE.MathUtils.clamp(forceMag / Math.max(maxForce, 1), 0, 1);
    const targetSpeed = (42 + load * 24) * rotorEff;
    const spool = 1 - Math.exp(-delta * 8.0);
    this.rotorSpeed = THREE.MathUtils.lerp(this.rotorSpeed, targetSpeed, spool);

    // Limit visual speed to prevent severe strobe/wagon-wheel effect at 60fps
    // 25 rad/s = ~23 degrees per frame, which is safely under the 45 degree Nyquist limit for a 4-blade rotor.
    const visualSpeed = Math.min(this.rotorSpeed, 25);
    this.mainRotor.rotation.y -= visualSpeed * delta;
    this.tailRotor.rotation.x -= visualSpeed * 1.35 * delta;

    // Toggle Blur meshes based on speed
    const isFast = this.rotorSpeed > 28;
    const blurDisc = this.mainRotor.getObjectByName("rotorBlur");
    const tailBlurDisc = this.tailRotor.getObjectByName("tailBlur");
    
    if (blurDisc) blurDisc.visible = isFast;
    if (tailBlurDisc) tailBlurDisc.visible = isFast;

    // Do not hide blades, let them spin inside the blur disc for a better visual effect
    this.mainRotor.children.forEach(c => {
      if (c.name !== "rotorBlur" && c.type === "Group") c.visible = true;
    });
    this.tailRotor.children.forEach(c => {
      if (c.name !== "tailBlur" && c.type === "Group") c.visible = true;
    });
  }
}


export class Enemy extends Entity {
  ring: THREE.Object3D;
  hp: number;
  maxHp: number;
  type: EnemyType;
  modifier: EnemyModifier = EnemyModifier.NONE;
  pattern: AttackPattern = AttackPattern.CHASE;
  isElite: boolean = false;
  lastShotTime: number = 0;
  basePoints: number = 50;
  radius: number = 2.2;

  // Shield (SHIELDED modifier)
  shieldHp: number = 0;
  shieldMaxHp: number = 0;
  shieldMesh: THREE.Mesh | null = null;

  // Regeneration (REGENERATING modifier)
  lastDamageTime: number = -999;
  regenPerSecond: number = 0;

  // Attack pattern state
  patternTimer: number = 0;
  patternCooldown: number = 0;

  // Boss phases & telegraphs
  phase: 1 | 2 | 3 = 1;
  phaseTimer: number = 0;
  telegraphTimer: number = 0;
  telegraphActive: boolean = false;
  telegraphStartTime: number = 0;
  telegraphMesh: THREE.Mesh | null = null;

  // Procedural wave scaling (set by the engine at spawn)
  waveDamageMult: number = 1;
  waveFireRateMult: number = 1;

  personalityOffset: number;
  evadeTimer: number = 0;
  lastDecisionTime: number = 0;
  flankDir: number = 1;
  enemyRotor: THREE.Group | null = null;
  enemyTailRotor: THREE.Group | null = null;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    x: number,
    z: number,
    type: EnemyType = EnemyType.BASIC,
    y: number = 18,
    options: { modifier?: EnemyModifier; pattern?: AttackPattern; isElite?: boolean } = {},
  ) {
    super(scene, world);
    this.type = type;
    this.modifier = options.modifier ?? EnemyModifier.NONE;
    this.pattern = options.pattern ?? AttackPattern.CHASE;
    this.isElite = Boolean(options.isElite);
    this.personalityOffset = Math.random() * Math.PI * 2;
    this.flankDir = Math.random() > 0.5 ? 1 : -1;

    const baseGroup = new THREE.Group();

    let radius = 2.2;
    let coreHex = 0xffd92e;
    let accentHex = 0xff3b22;

    if (type === EnemyType.TANK) {
      radius = 3.0;
      coreHex = 0xffb51f;
      accentHex = 0xff2a1d;
      this.maxHp = 100;
      this.basePoints = 200;
    } else if (type === EnemyType.SHOOTER) {
      radius = 2.0;
      coreHex = 0xffe85b;
      accentHex = 0xff3b22;
      this.maxHp = 30;
      this.basePoints = 100;
    } else if (type === EnemyType.DRONE) {
      radius = 1.8;
      coreHex = 0x44ddff;
      accentHex = 0x2299cc;
      this.maxHp = 15;
      this.basePoints = 150;
    } else if (type === EnemyType.BOSS) {
      radius = 4.1;
      coreHex = 0xd84cff;
      accentHex = 0x6b1fc2;
      this.maxHp = 220;
      this.basePoints = 500;
    } else {
      this.maxHp = 20; // Basic
    }

    // Elite miniboss scaling (minibosses every 5th wave)
    if (this.isElite && type !== EnemyType.BOSS) {
      this.maxHp = Math.round(this.maxHp * 3.2);
      this.basePoints = Math.round(this.basePoints * 2.5);
      radius *= 1.45;
      coreHex = 0xffdd55;
      accentHex = 0xff7722;
    }

    this.hp = this.maxHp;
    this.radius = radius;

    // Bosses start in phase 3 (full HP ratio > 0.66) so spawn never trips a phase change
    if (type === EnemyType.BOSS) this.phase = 3;

    // Shielded modifier grants an energy shield that absorbs the first hits
    if ((this.modifier & EnemyModifier.SHIELDED) !== 0) {
      const shieldScale =
        type === EnemyType.BOSS || this.isElite ? 2.2 : type === EnemyType.TANK ? 1.6 : 1.0;
      this.shieldMaxHp = Math.round(this.maxHp * shieldScale);
      this.shieldHp = this.shieldMaxHp;
      this.basePoints += type === EnemyType.TANK ? 75 : 50;
    }

    // Regenerating modifier heals slowly when untouched
    if ((this.modifier & EnemyModifier.REGENERATING) !== 0) {
      this.regenPerSecond = Math.max(2, this.maxHp * 0.05);
    }

    if (type === EnemyType.BOSS) {
      // Big Boss Helicopter
      this.ring = new THREE.Group();
      this.ring.position.y = 0.2;

      const hull = createBox(radius * 1.1, radius * 0.75, radius * 1.9, coreHex);
      this.ring.add(hull);

      const tailBoom = createBox(radius * 0.3, radius * 0.3, radius * 1.8, coreHex);
      tailBoom.position.set(0, 0, -radius * 1.4);
      this.ring.add(tailBoom);

      const tailFin = createBox(radius * 0.12, radius * 0.75, radius * 0.35, accentHex);
      tailFin.position.set(0, radius * 0.35, -radius * 2.1);
      this.ring.add(tailFin);

      const glass = createBox(radius * 0.6, radius * 0.4, radius * 0.7, 0x172f3d);
      glass.position.set(0, radius * 0.2, radius * 0.95);
      this.ring.add(glass);

      // Main rotor
      const rotorGroup = new THREE.Group();
      rotorGroup.position.set(0, radius * 0.65, 0);
      for (let i = 0; i < 4; i++) {
        const blade = createBox(radius * 0.12, radius * 0.03, radius * 1.5, 0x111111);
        blade.rotation.y = (i * Math.PI) / 2;
        blade.position.z = radius * 0.7;
        rotorGroup.add(blade);
      }
      this.ring.add(rotorGroup);
      this.enemyRotor = rotorGroup;

      // Tail rotor
      const tailRotorGroup = new THREE.Group();
      tailRotorGroup.position.set(radius * 0.2, radius * 0.35, -radius * 2.1);
      for (let i = 0; i < 2; i++) {
        const blade = createBox(radius * 0.03, radius * 0.08, radius * 0.45, 0x111111);
        blade.rotation.x = (i * Math.PI) / 2;
        tailRotorGroup.add(blade);
      }
      this.ring.add(tailRotorGroup);
      this.enemyTailRotor = tailRotorGroup;

      baseGroup.add(this.ring);

    } else if (type === EnemyType.TANK) {
      // Flakpanzer (Anti-Air Tank)
      this.ring = new THREE.Group();
      
      const tracksL = createBox(1.2, 0.6, 3.8, 0x111111);
      tracksL.position.set(-1.4, -0.2, 0);
      const tracksR = createBox(1.2, 0.6, 3.8, 0x111111);
      tracksR.position.set(1.4, -0.2, 0);
      
      const hull = createBox(2.2, 0.9, 3.4, coreHex);
      hull.position.set(0, 0.3, 0);
      
      const turret = createBox(1.8, 0.8, 2.0, accentHex);
      turret.position.set(0, 1.1, -0.2);
      
      const barrelL = createBox(0.2, 0.2, 2.2, 0x333333);
      barrelL.position.set(-0.5, 1.2, 1.6);
      const barrelR = barrelL.clone();
      barrelR.position.x = 0.5;
      
      this.ring.add(tracksL, tracksR, hull, turret, barrelL, barrelR);
      baseGroup.add(this.ring);

    } else if (type === EnemyType.DRONE) {
      // Quadcopter
      this.ring = new THREE.Group();
      
      const core = createBox(1.2, 0.5, 1.2, coreHex);
      this.ring.add(core);
      
      const sensor = createBox(0.6, 0.4, 0.6, accentHex);
      sensor.position.set(0, -0.3, 0.4);
      this.ring.add(sensor);
      
      this.enemyRotor = new THREE.Group();
      const armOffsets = [
        [-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]
      ];
      
      armOffsets.forEach(([px, pz]) => {
        const arm = createBox(1.6, 0.15, 0.15, 0x333333);
        arm.position.set(px/2, 0, pz/2);
        arm.rotation.y = Math.atan2(pz, px);
        this.ring.add(arm);
        
        const motor = createBox(0.4, 0.6, 0.4, accentHex);
        motor.position.set(px, 0.1, pz);
        this.ring.add(motor);
        
        const bladeGroup = new THREE.Group();
        bladeGroup.position.set(px, 0.45, pz);
        const blade = createBox(1.5, 0.05, 0.2, 0x111111);
        bladeGroup.add(blade);
        this.enemyRotor!.add(bladeGroup);
      });
      this.ring.add(this.enemyRotor);
      baseGroup.add(this.ring);

    } else {
      // Heavy Gunship (SHOOTER & BASIC)
      this.ring = new THREE.Group();
      
      const fuselage = createBox(radius * 0.9, radius * 0.7, radius * 2.2, coreHex);
      this.ring.add(fuselage);
      
      const wing = createBox(radius * 2.8, radius * 0.15, radius * 0.6, coreHex);
      wing.position.set(0, 0, -radius * 0.2);
      this.ring.add(wing);
      
      const engineL = createBox(radius * 0.4, radius * 0.4, radius * 0.8, accentHex);
      engineL.position.set(-radius * 0.9, 0, -radius * 0.2);
      const engineR = engineL.clone();
      engineR.position.x = radius * 0.9;
      this.ring.add(engineL, engineR);
      
      const cockpit = createBox(radius * 0.5, radius * 0.4, radius * 0.8, 0x172f3d);
      cockpit.position.set(0, radius * 0.4, radius * 0.6);
      this.ring.add(cockpit);
      
      baseGroup.add(this.ring);
    }

    this.mesh = baseGroup;
    scene.add(this.mesh);

    // Shield bubble visual (SHIELDED modifier)
    if ((this.modifier & EnemyModifier.SHIELDED) !== 0) {
      const shieldGeo = new THREE.SphereGeometry(radius * 1.35, 14, 12);
      const shieldMat = new THREE.MeshBasicMaterial({
        color: 0x55eeff,
        transparent: true,
        opacity: 0.22,
        wireframe: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
      this.mesh.add(this.shieldMesh);
    }

    // Telegraph beam visual (boss phase 3 telegraphed attacks)
    if (type === EnemyType.BOSS) {
      const beamGeo = new THREE.BoxGeometry(0.5, 0.5, 30);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xff2244,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.telegraphMesh = new THREE.Mesh(beamGeo, beamMat);
      this.telegraphMesh.position.z = -15;
      this.telegraphMesh.visible = false;
      this.mesh.add(this.telegraphMesh);
    }

    this.body = new CANNON.Body({
      mass: type === EnemyType.TANK ? 100 : 0,
      type: CANNON.Body.KINEMATIC,
      position: new CANNON.Vec3(x, y, z),
    });

    const shape = new CANNON.Box(
      new CANNON.Vec3(radius, radius * 0.75, radius),
    );
    this.body.addShape(shape);
    world.addBody(this.body);
  }

  /**
   * Apply damage. Returns 'destroyed' | 'shield-broken' | 'hit'.
   * Shield absorbs damage first; when the shield breaks the overkill
   * carries into hull HP.
   */
  takeDamage(amt: number, now: number): "destroyed" | "shield-broken" | "hit" {
    this.lastDamageTime = now;
    if (this.shieldHp > 0) {
      if (amt >= this.shieldHp) {
        const overkill = amt - this.shieldHp;
        this.shieldHp = 0;
        if (this.shieldMesh) this.shieldMesh.visible = false;
        if (overkill > 0) {
          this.hp -= overkill;
        }
        if (this.hp <= 0) {
          this.active = false;
          return "destroyed";
        }
        return "shield-broken";
      }
      this.shieldHp -= amt;
      return "hit";
    }
    this.hp -= amt;
    if (this.hp <= 0) {
      this.active = false;
      return "destroyed";
    }
    return "hit";
  }

  updateDirection(
    targetPos: CANNON.Vec3,
    time: number,
    enemyProjectilePool: ProjectilePool,
    playerBullets: Projectile[],
    allEnemies: Enemy[],
    city: CityEnvironment,
    fireRateMult: number = 1.0,
  ) {
    if (!this.active) return false;

    // Boids horizontal repulsion force to prevent enemies from stacking
    let repelForceX = 0;
    let repelForceZ = 0;
    for (const other of allEnemies) {
      if (other === this || !other.active) continue;
      const dxOther = this.body.position.x - other.body.position.x;
      const dzOther = this.body.position.z - other.body.position.z;
      const distOther = Math.sqrt(dxOther * dxOther + dzOther * dzOther);
      const minDist = (this.radius + other.radius) * 1.35;
      if (distOther < minDist && distOther > 0.001) {
        const force = (1.0 - distOther / minDist) * 16.0;
        repelForceX += (dxOther / distOther) * force;
        repelForceZ += (dzOther / distOther) * force;
      }
    }

    // AABB Building Collision Resolution
    for (const block of city.blocks) {
      if (block.destroyed) continue;

      const dxBlock = this.body.position.x - block.x;
      const dzBlock = this.body.position.z - block.z;
      const rangeX = block.width / 2 + this.radius + 5;
      const rangeZ = block.depth / 2 + this.radius + 5;

      if (Math.abs(dxBlock) > rangeX || Math.abs(dzBlock) > rangeZ) {
        continue;
      }

      const enemyMinX = this.body.position.x - this.radius;
      const enemyMaxX = this.body.position.x + this.radius;
      const enemyMinY = this.body.position.y - this.radius * 0.75;
      const enemyMaxY = this.body.position.y + this.radius * 0.75;
      const enemyMinZ = this.body.position.z - this.radius;
      const enemyMaxZ = this.body.position.z + this.radius;

      const blockMinX = block.x - block.width / 2;
      const blockMaxX = block.x + block.width / 2;
      const blockMinY = 0;
      const blockMaxY = block.height;
      const blockMinZ = block.z - block.depth / 2;
      const blockMaxZ = block.z + block.depth / 2;

      const overlapX = Math.min(enemyMaxX, blockMaxX) - Math.max(enemyMinX, blockMinX);
      const overlapY = Math.min(enemyMaxY, blockMaxY) - Math.max(enemyMinY, blockMinY);
      const overlapZ = Math.min(enemyMaxZ, blockMaxZ) - Math.max(enemyMinZ, blockMinZ);

      if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
        // We have an intersection! Find the minimum penetration axis
        if (overlapY < overlapX && overlapY < overlapZ) {
          // Push upwards onto the roof
          this.body.position.y += overlapY;
          this.body.velocity.y = Math.max(0, this.body.velocity.y);
        } else if (overlapX < overlapZ) {
          // Push along X axis
          if (this.body.position.x < block.x) {
            this.body.position.x -= overlapX;
          } else {
            this.body.position.x += overlapX;
          }
          this.body.velocity.x = 0;
        } else {
          // Push along Z axis
          if (this.body.position.z < block.z) {
            this.body.position.z -= overlapZ;
          } else {
            this.body.position.z += overlapZ;
          }
          this.body.velocity.z = 0;
        }
      }
    }

    const dx = targetPos.x - this.body.position.x;
    const dz = targetPos.z - this.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz) + 0.001;

    const dirX = dx / dist;
    const dirZ = dz / dist;

    // --- Regeneration (REGENERATING modifier) ---
    if (this.regenPerSecond > 0 && this.hp > 0 && time - this.lastDamageTime > 3.0) {
      this.hp = Math.min(this.maxHp, this.hp + this.regenPerSecond * 0.05); // regen at 20fps rate
    }

    let fired = false;

    // =====================================================================
    // BOSS — phased behavior with telegraphed attacks
    // =====================================================================
    if (this.type === EnemyType.BOSS) {
      fired = this.updateBoss(targetPos, time, dist, dirX, dirZ, enemyProjectilePool, repelForceX, repelForceZ, fireRateMult);
      this.mesh.position.copy(this.body.position as any);
      if (this.telegraphMesh) {
        this.telegraphMesh.visible = this.telegraphTimer > 0;
        if (this.telegraphTimer > 0) {
          const pulse = 0.35 + Math.sin(time * 24) * 0.2;
          (this.telegraphMesh.material as THREE.MeshBasicMaterial).opacity = pulse;
          this.telegraphMesh.rotation.y = Math.atan2(dirX, dirZ);
        }
      }
      if (this.enemyRotor) this.enemyRotor.rotation.y = time * 24.0;
      if (this.enemyTailRotor) this.enemyTailRotor.rotation.x = time * 28.0;
      return fired;
    }

    // =====================================================================
    // KAMIKAZE — dive straight at the player (mostly drones)
    // =====================================================================
    if (this.pattern === AttackPattern.KAMIKAZE) {
      const kamikazeSpeed =
        this.type === EnemyType.TANK ? 42 : this.type === EnemyType.DRONE ? 68 : 55;
      this.body.velocity.set(dirX * kamikazeSpeed + repelForceX, 0, dirZ * kamikazeSpeed + repelForceZ);
      // No ranged fire — dies by ramming
      this.mesh.position.copy(this.body.position as any);
      this.mesh.rotation.y = Math.atan2(dirX, dirZ);
      this.ring.rotation.y = Math.atan2(dirX, dirZ);
      this.ring.rotation.x = Math.sin(time * 3 + this.personalityOffset) * 0.1;
      return false;
    }

    // =====================================================================
    // DRONE — chase with swooping movement
    // =====================================================================
    if (this.type === EnemyType.DRONE) {
      const speed = 35;
      const swoopX = Math.cos(time * 2 + this.personalityOffset) * 15;
      const swoopZ = Math.sin(time * 2 + this.personalityOffset) * 15;
      this.body.velocity.set(dirX * speed + swoopX + repelForceX, 0, dirZ * speed + swoopZ + repelForceZ);

      // Drones fire rapidly at close range
      if (dist < 60 && time - this.lastShotTime > 0.8 * fireRateMult) {
        this.lastShotTime = time;
        enemyProjectilePool.spawn(
          this.body.position.x,
          this.body.position.y + 0.35,
          this.body.position.z,
          dirX,
          dirZ,
          time,
          160,
          5,
          0,
          0xffd92e,
          null,
          0,
          0,
          0,
          this.waveDamageMult,
        );
        fired = true;
      }

      this.mesh.position.copy(this.body.position as any);
      this.mesh.rotation.y = Math.atan2(dirX, dirZ);
      this.ring.rotation.y = Math.atan2(dirX, dirZ);
      this.ring.rotation.x = Math.sin(time * 5) * 0.1;

      // Bob up and down
      this.mesh.position.y += Math.sin(time * 3 + this.personalityOffset) * 0.5;

      return fired;
    }

    let speed = 0;
    if (this.type === EnemyType.TANK) speed = 15;
    else if (this.type === EnemyType.SHOOTER) speed = 20;
    else if (this.type === EnemyType.BASIC) speed = 18;

    // AI Evasive and Flanking logic
    if (time - this.lastDecisionTime > 2.0 + Math.random() * 2.0) {
      this.lastDecisionTime = time;
      if (Math.random() > 0.5) this.flankDir *= -1;
      
      if (Math.random() > 0.7) {
        this.evadeTimer = time + 0.5 + Math.random() * 1.0;
      }
    }

    const isEvading = time < this.evadeTimer;
    const tangentX = -dirZ * this.flankDir;
    const tangentZ = dirX * this.flankDir;

    if (this.pattern === AttackPattern.CIRCLE) {
      // Circle-strafing runs: orbit the player, always strafing
      this.body.velocity.set(tangentX * speed * 1.25 + dirX * 0.12 * speed + repelForceX, 0, tangentZ * speed * 1.25 + dirZ * 0.12 * speed + repelForceZ);
    } else if (this.pattern === AttackPattern.ARTILLERY) {
      // Artillery: hold range, only fire lobbed shells
      if (dist < 95) {
        this.body.velocity.set((-dirX + tangentX * 0.6) * speed * 0.8 + repelForceX, 0, (-dirZ + tangentZ * 0.6) * speed * 0.8 + repelForceZ);
      } else {
        this.body.velocity.set((tangentX + dirX * 0.15) * speed * 0.5 + repelForceX, 0, (tangentZ + dirZ * 0.15) * speed * 0.5 + repelForceZ);
      }
    } else if (dist > 45) {
      // Approach directly
      this.body.velocity.set(dirX * speed + repelForceX, 0, dirZ * speed + repelForceZ);
    } else if (dist < 20 || isEvading) {
      // Evade / back away and strafe
      this.body.velocity.set((-dirX + tangentX * 1.5) * speed * 0.7 + repelForceX, 0, (-dirZ + tangentZ * 1.5) * speed * 0.7 + repelForceZ);
    } else {
      // Orbit (strafe)
      this.body.velocity.set((tangentX + dirX * 0.2) * speed * 0.6 + repelForceX, 0, (tangentZ + dirZ * 0.2) * speed * 0.6 + repelForceZ);
    }

    // Firing Logic
    const fireRange =
      this.type === EnemyType.TANK ? 95 : 75;
    const fireRate =
      this.type === EnemyType.SHOOTER
        ? 1.5
        : this.type === EnemyType.TANK
          ? 3.5
          : 2.4;
    if (dist < fireRange && time - this.lastShotTime > fireRate * fireRateMult) {
      this.lastShotTime = time + Math.random() * 0.35;
      const projectileSpeed = this.type === EnemyType.TANK ? 95 : 130;
      if (this.pattern === AttackPattern.ARTILLERY) {
        // Arcing artillery shell: high lob that reaches player altitude,
        // then lands with a visible splash.
        enemyProjectilePool.spawn(
          this.body.position.x,
          this.body.position.y + 4.0,
          this.body.position.z,
          dirX,
          dirZ,
          time,
          150,
          16,
          0,
          0xffaa44,
          null,
          0,
          46, // vy: high arc
          95, // gravity
          this.waveDamageMult,
        );
      } else {
        enemyProjectilePool.spawn(
          this.body.position.x,
          this.body.position.y + 0.35,
          this.body.position.z,
          dirX,
          dirZ,
          time,
          projectileSpeed,
          5,
          0,
          0xffd92e,
          null,
          0,
          0,
          0,
          this.waveDamageMult,
        );
      }
      fired = true;
    }

    this.mesh.position.copy(this.body.position as any);
    this.mesh.rotation.y = Math.atan2(dirX, dirZ);
    this.ring.rotation.y = Math.atan2(dirX, dirZ);
    this.ring.rotation.x = Math.sin(time * 3 + this.personalityOffset) * 0.04;

    if (this.enemyRotor) {
      this.enemyRotor.rotation.y = time * 24.0;
    }
    if (this.enemyTailRotor) {
      this.enemyTailRotor.rotation.x = time * 28.0;
    }

    return fired;
  }

  /**
   * Phased boss behavior:
   *  - Phase 3 (100%-66%): 5-round spread
   *  - Phase 2 (66%-33%): 7-round spread, faster
   *  - Phase 1 (<33%): telegraph a 9-round beam volley
   */
  private updateBoss(
    targetPos: CANNON.Vec3,
    time: number,
    dist: number,
    dirX: number,
    dirZ: number,
    enemyProjectilePool: ProjectilePool,
    repelForceX: number,
    repelForceZ: number,
    fireRateMult: number = 1.0,
  ): boolean {
    const ratio = this.hp / this.maxHp;
    const newPhase = bossPhaseForRatio(ratio);
    if (newPhase !== this.phase) {
      this.phase = newPhase;
      this.phaseTimer = time + 0.6; // brief pivot pause on phase change
    }

    const speed = 10;
    const tangentX = -dirZ * this.flankDir;
    const tangentZ = dirX * this.flankDir;
    if (dist > 40) {
      this.body.velocity.set(dirX * speed * 0.9 + repelForceX, 0, dirZ * speed * 0.9 + repelForceZ);
    } else {
      this.body.velocity.set((tangentX + dirX * 0.15) * speed + repelForceX, 0, (tangentZ + dirZ * 0.15) * speed + repelForceZ);
    }

    let fired = false;

    // Telegraph attack (phase 1/2): beam warns the player, then fires
    if (this.phase <= 2 && this.telegraphActive) {
      this.body.velocity.set(0, 0, 0);
      if (time - this.telegraphStartTime >= BOSS_TELEGRAPH_DURATION) {
        this.telegraphActive = false;
        this.lastShotTime = time; // cooldown AFTER the telegraph volley
        // Fire the beam volley along the telegraph line
        const cfg = bossVolleyConfig(this.phase);
        for (let i = 0; i < cfg.shots; i++) {
          const angle = (i - (cfg.shots - 1) / 2) * cfg.spread;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          enemyProjectilePool.spawn(
            this.body.position.x,
            this.body.position.y + 0.35,
            this.body.position.z,
            dirX * cos - dirZ * sin,
            dirX * sin + dirZ * cos,
            time,
            cfg.speed,
            8,
            0,
            0xff3366,
            null,
            0,
            0,
            0,
            this.waveDamageMult,
          );
        }
        fired = true;
      }
    } else if (time - this.lastShotTime > (this.phase === 3 ? 2.2 : this.phase === 2 ? 1.7 : 1.2) * fireRateMult) {
      // Start telegraph before firing in phase 1/2 (only when no telegraph is queued)
      if (this.phase <= 2 && time - this.lastShotTime > (this.phase === 2 ? 2.4 : 1.8)) {
        this.telegraphActive = true;
        this.telegraphStartTime = time;
        return false;
      }

      this.lastShotTime = time + Math.random() * 0.3;
      // Regular volleys stay WEAKER than the telegraphed one (the tell is a
      // bigger attack). Phase 1 telegraphs 9 shots; its regular volley is 5.
      const cfg = bossVolleyConfig(this.phase);
      const regularShots = Math.min(cfg.shots, 5);
      for (let i = 0; i < regularShots; i++) {
        const angle = (i - (regularShots - 1) / 2) * cfg.spread;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        enemyProjectilePool.spawn(
          this.body.position.x,
          this.body.position.y + 0.35,
          this.body.position.z,
          dirX * cos - dirZ * sin,
          dirX * sin + dirZ * cos,
          time,
          cfg.speed,
          5,
          0,
          0xffd92e,
          null,
          0,
          0,
          0,
          this.waveDamageMult,
        );
      }
      // Phase 2/1 also throws a radial ring burst
      if (this.phase <= 2) {
        const ringCount = 10;
        for (let i = 0; i < ringCount; i++) {
          const angle = (i / ringCount) * Math.PI * 2;
          enemyProjectilePool.spawn(
            this.body.position.x,
            this.body.position.y + 0.35,
            this.body.position.z,
            Math.sin(angle),
            Math.cos(angle),
            time,
            90,
            5,
            0,
            0xffd92e,
            null,
            0,
            0,
            0,
            this.waveDamageMult,
          );
        }
      }
      fired = true;
    }

    return fired;
  }
}

export class Projectile {
  active = false;
  mesh: THREE.Mesh;
  pos: CANNON.Vec3 = new CANNON.Vec3();
  prevPos: CANNON.Vec3 = new CANNON.Vec3();
  vel: CANNON.Vec3 = new CANNON.Vec3();
  spawnTime = 0;
  damage = 10;
  blastRadius = 0;
  target: EnemyLock | null = null;
  homingStrength = 0;
  lifetime = 1.35;
  vy = 0;
  gravity = 0;
  /** Wave-scaled damage multiplier carried on the shot (set by the engine/spawner). */
  waveDamageMult: number = 1;

  constructor(scene: THREE.Scene, colorHex: number) {
    let geom = new THREE.CylinderGeometry(0.035, 0.32, 8.8, 6).toNonIndexed();
    geom.rotateX(Math.PI / 2); // Align with Z axis
    geom.computeVertexNormals();

    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.95,
    });
    this.mesh = new THREE.Mesh(geom, mat);

    const glowGeom = new THREE.CylinderGeometry(0.2, 0.82, 11.6, 6).toNonIndexed();
    glowGeom.rotateX(Math.PI / 2);
    glowGeom.computeVertexNormals();

    const glowMat = new THREE.MeshBasicMaterial({
      color: colorHex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(glowGeom, glowMat);
    this.mesh.add(glow);

    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    now: number,
    speed: number,
    damage: number = 10,
    blastRadius: number = 0,
    color?: number,
    target: EnemyLock | null = null,
    homingStrength: number = 0,
    vy: number = 0,
    gravity: number = 0,
    waveDamageMult: number = 1,
  ) {
    this.active = true;
    this.mesh.visible = true;
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);

    this.vel.set(dx * speed, vy, dz * speed);
    this.spawnTime = now;
    this.damage = damage;
    this.waveDamageMult = waveDamageMult;
    this.blastRadius = blastRadius;
    this.target = target;
    this.homingStrength = homingStrength;
    this.vy = vy;
    this.gravity = gravity;
    this.lifetime = Math.max(1.1, Math.min(2.2, 390 / Math.max(speed, 1)));

    if (color !== undefined) {
      this.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.color.setHex(color);
        }
      });
    }

    const angle = Math.atan2(dx, dz);
    this.mesh.rotation.y = angle;
  }

  update(now: number, delta: number, particles?: GPUParticleSystem) {
    this.prevPos.copy(this.pos);

    if (this.homingStrength > 0 && this.target?.active) {
      const dx = this.target.body.position.x - this.pos.x;
      const dz = this.target.body.position.z - this.pos.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      const speed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
      if (len > 0.001 && speed > 0.001) {
        const turn = Math.min(1, this.homingStrength * delta);
        const nextX = THREE.MathUtils.lerp(this.vel.x / speed, dx / len, turn);
        const nextZ = THREE.MathUtils.lerp(this.vel.z / speed, dz / len, turn);
        const nextLen = Math.sqrt(nextX * nextX + nextZ * nextZ) || 1;
        this.vel.x = (nextX / nextLen) * speed;
        this.vel.z = (nextZ / nextLen) * speed;
        this.vel.y +=
          (this.target.body.position.y + 0.4 - this.pos.y) *
          this.homingStrength *
          0.2 *
          delta;
        this.vel.y = THREE.MathUtils.clamp(this.vel.y, -60, 60);
      }
    }

    if (this.gravity > 0) {
      this.vel.y -= this.gravity * delta;
      this.pos.y += this.vel.y * delta;
      if (this.pos.y < 1.2) {
        // Shell lands: splash burst on impact
        if (particles) {
          particles.spawnExplosion(this.pos.x, 1.4, this.pos.z, 22, now, 8);
        }
        this.deactivate();
        return;
      }
      this.pos.x += this.vel.x * delta;
      this.pos.z += this.vel.z * delta;
    } else {
      this.pos.x += this.vel.x * delta;
      this.pos.y += this.vel.y * delta;
      this.pos.z += this.vel.z * delta;
    }

    if (particles && this.active && this.blastRadius > 0) {
      // Missile / Rocket Trails (Smoke and Engine Flame)
      if (Math.random() < 0.6) {
        particles.spawnSmoke(this.pos.x, this.pos.y, this.pos.z, now);
      }
      if (Math.random() < 0.25) {
        particles.spawnSparks(this.pos.x, this.pos.y, this.pos.z, now);
        particles.spawnSparks(this.pos.x, this.pos.y, this.pos.z, now); // Double sparks for engine flame
      }
    }

    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.y = Math.atan2(this.vel.x, this.vel.z);
    this.mesh.updateMatrix();

    // Dynamic fade-out over lifetime
    const age = now - this.spawnTime;
    const lifeRatio = age / this.lifetime;
    this.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
        const baseOpacity = child === this.mesh ? 0.95 : 0.3;
        child.material.opacity = baseOpacity * Math.max(0, 1.0 - lifeRatio);
      }
    });

    if (now - this.spawnTime > this.lifetime) {
      this.deactivate();
    }
  }

  deactivate() {
    this.active = false;
    this.mesh.visible = false;
  }
}

function distancePointToProjectileSegmentSq(
  point: CANNON.Vec3,
  from: CANNON.Vec3,
  to: CANNON.Vec3,
) {
  const sx = to.x - from.x;
  const sz = to.z - from.z;
  const lenSq = sx * sx + sz * sz;
  if (lenSq < 0.0001) {
    const dx = point.x - to.x;
    const dz = point.z - to.z;
    return dx * dx + dz * dz;
  }

  const t = THREE.MathUtils.clamp(
    ((point.x - from.x) * sx + (point.z - from.z) * sz) /
      lenSq,
    0,
    1,
  );
  const closestX = from.x + sx * t;
  const closestZ = from.z + sz * t;
  const dx = point.x - closestX;
  const dz = point.z - closestZ;
  return dx * dx + dz * dz;
}

// --- POWERUP CLASS ---

export class PowerUp {
  mesh: THREE.Group;
  type: PowerUpType;
  active: boolean = true;
  position: THREE.Vector3;
  spawnTime: number = 0;
  lifetime: number = 22; // 22 seconds lifetime

  constructor(
    scene: THREE.Scene,
    x: number,
    y: number,
    z: number,
    type: PowerUpType,
  ) {
    this.type = type;
    this.position = new THREE.Vector3(x, y, z);
    this.mesh = new THREE.Group();

    // Create powerup visual based on type
    const colors: Record<PowerUpType, number> = {
      [PowerUpType.HEALTH]: 0x22ff44,
      [PowerUpType.DAMAGE_BOOST]: 0xff4422,
      [PowerUpType.SHIELD]: 0x4488ff,
      [PowerUpType.AMMO]: 0xffdd22,
      [PowerUpType.SPEED_BOOST]: 0xff88ff,
      [PowerUpType.BOMB]: 0xff6600,
      [PowerUpType.FUEL]: 0x37ffb8,
    };

    const color = colors[type];

    // Floating diamond shape
    const geom = new THREE.OctahedronGeometry(1.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(geom, mat);
    this.mesh.add(core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(2.0, 12, 8),
      createGlowMaterial(color, 0.18),
    );
    this.mesh.add(halo);

    // Outer glow ring
    const ringGeom = new THREE.TorusGeometry(2.2, 0.15, 8, 16);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    this.mesh.add(ring);

    const verticalRing = new THREE.Mesh(ringGeom, ringMat.clone());
    verticalRing.rotation.y = Math.PI / 2;
    this.mesh.add(verticalRing);

    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
  }

  update(time: number, delta: number) {
    if (!this.active) return;

    // Rotate and bob
    this.mesh.rotation.y += delta * 2;
    this.mesh.rotation.x += delta * 0.5;
    this.mesh.rotation.z += delta * 0.35;
    this.mesh.position.y = this.position.y + Math.sin(time * 3) * 0.5;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.mesh.scale.setScalar(pulse);

    // Check lifetime
    if (time - this.spawnTime > this.lifetime) {
      this.active = false;
    }
  }

  destroy(scene: THREE.Scene) {
    this.active = false;
    scene.remove(this.mesh);
  }

  checkCollection(playerPos: THREE.Vector3): boolean {
    if (!this.active) return false;
    // For arcade shooter feel, ignore the height (Y) difference and use a generous radius
    const dx = this.mesh.position.x - playerPos.x;
    const dz = this.mesh.position.z - playerPos.z;
    const distSq = dx * dx + dz * dz;
    return distSq < 196; // Radius of 14 for easier collection
  }
}

export class ProjectilePool {
  pool: Projectile[] = [];

  constructor(scene: THREE.Scene, count: number, colorHex: number = 0x55ff55) {
    for (let i = 0; i < count; i++) {
      const p = new Projectile(scene, colorHex);
      this.pool.push(p);
    }
  }

  spawn(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    now: number,
    speed: number = 250,
    damage: number = 10,
    blastRadius: number = 0,
    color?: number,
    target: EnemyLock | null = null,
    homingStrength: number = 0,
    vy: number = 0,
    gravity: number = 0,
    waveDamageMult: number = 1,
  ): Projectile | null {
    const p = this.pool.find((b) => !b.active);
    if (p) {
      p.spawn(x, y, z, dx, dz, now, speed, damage, blastRadius, color, target, homingStrength, vy, gravity, waveDamageMult);
      return p;
    }
    return null;
  }

  deactivateAll() {
    for (const p of this.pool) {
      p.deactivate();
    }
  }

  updatePositions(now: number, delta: number, particles?: GPUParticleSystem) {
    for (const p of this.pool) {
      if (p.active) p.update(now, delta, particles);
    }
  }

  /**
   * Check projectile hits against static objectives (SAM sites, radar towers, depots).
   */
  checkObjectiveHits(
    objectives: Objective[],
    onHit: (p: Projectile, o: Objective) => void,
  ) {
    for (const p of this.pool) {
      if (!p.active) continue;
      for (const o of objectives) {
        if (!o.active || o.hp <= 0) continue;
        const distSq = distancePointToProjectileSegmentSq(
          o.position,
          p.prevPos,
          p.pos,
        );
        const hitRadius = o.radius + 2.2;
        if (distSq < hitRadius * hitRadius) {
          onHit(p, o);
          p.deactivate();
          break;
        }
      }
    }
  }

  /**
   * Check projectile hits against rooftop turrets (destroyable, block-mounted).
   */
  checkTurretHits(turrets: Turret[], onHit: (p: Projectile, t: Turret) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      for (const t of turrets) {
        if (t.isGone() || t.hp <= 0) continue;
        const distSq = distancePointToProjectileSegmentSq(
          t.position,
          p.prevPos,
          p.pos,
        );
        const hitRadius = 3.2;
        if (distSq < hitRadius * hitRadius) {
          onHit(p, t);
          p.deactivate();
          break;
        }
      }
    }
  }

  checkEnemyHits(enemies: Enemy[], onHit: (p: Projectile, e: Enemy) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      for (const e of enemies) {
        if (!e.active) continue;
        const hitRadius =
          e.type === EnemyType.BOSS
            ? 7.2
            : e.type === EnemyType.TANK
              ? 6.2
              : e.type === EnemyType.DRONE
                ? 4.7
                : 5.1;
        const distSq = distancePointToProjectileSegmentSq(
          e.body.position,
          p.prevPos,
          p.pos,
        );
        if (distSq < hitRadius * hitRadius) {
          onHit(p, e);
          p.deactivate();
          break;
        }
      }
    }
  }

  checkPlayerHits(playerPos: CANNON.Vec3, onHit: (p: Projectile) => void) {
    for (const p of this.pool) {
      if (!p.active) continue;
      const distSq = distancePointToProjectileSegmentSq(playerPos, p.prevPos, p.pos);
      if (distSq < 16) {
        onHit(p);
        p.deactivate();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OBJECTIVES — destroyable battlefield targets
// ---------------------------------------------------------------------------

export class Objective {
  type: ObjectiveType;
  active: boolean = true;
  hp: number;
  maxHp: number;
  radius: number = 4;
  basePoints: number;
  position: CANNON.Vec3;
  mesh: THREE.Group;
  body: CANNON.Body;
  scene: THREE.Scene;
  world: CANNON.World;
  spawnTime: number = 0;
  bobSeed: number;
  beacon: THREE.Mesh | null = null;
  labelSprite: THREE.Sprite | null = null;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    x: number,
    y: number,
    z: number,
    type: ObjectiveType,
  ) {
    this.scene = scene;
    this.world = world;
    this.type = type;
    this.position = new CANNON.Vec3(x, y, z);
    this.bobSeed = Math.random() * Math.PI * 2;

    const cfg = objectiveConfig(type);
    this.maxHp = cfg.hp;
    this.basePoints = cfg.points;
    this.radius = cfg.radius;
    this.hp = this.maxHp;

    this.mesh = new THREE.Group();

    if (type === ObjectiveType.SAM_SITE) {
      // Missile launcher rack
      const baseMat = createLowPolyMaterial(0x3a4a3a);
      const rackMat = createLowPolyMaterial(0x2a3030);
      const tipMat = createLowPolyMaterial(0xff5533);
      const base = createBox(3.4, 0.9, 3.4, 0x3a4a3a);
      base.material = baseMat;
      this.mesh.add(base);
      for (let i = 0; i < 4; i++) {
        const tube = createBox(0.9, 2.6, 0.9, 0x2a3030);
        tube.material = rackMat;
        tube.position.set((i % 2 === 0 ? -1.1 : 1.1), 2.0, (i < 2 ? -1 : 1));
        this.mesh.add(tube);
        const tip = createBox(0.5, 0.5, 0.5, 0xff5533);
        tip.material = tipMat;
        tip.position.set((i % 2 === 0 ? -1.1 : 1.1), 3.4, (i < 2 ? -1 : 1));
        this.mesh.add(tip);
      }
    } else if (type === ObjectiveType.RADAR_TOWER) {
      // Radar tower with rotating dish
      const towerMat = createLowPolyMaterial(0x445055);
      const dishMat = createLowPolyMaterial(0x88ffaa);
      const tower = createBox(0.9, 7.5, 0.9, 0x445055);
      tower.material = towerMat;
      tower.position.y = 4;
      this.mesh.add(tower);
      const dish = createBox(3.4, 0.7, 2.2, 0x88ffaa);
      dish.material = dishMat;
      dish.position.y = 8.4;
      this.mesh.add(dish);
    } else {
      // AMMO_DEPOT: stacked crates
      const crateMat = createLowPolyMaterial(0xc9a35a);
      const lidMat = createLowPolyMaterial(0x7a5c2e);
      for (let i = 0; i < 6; i++) {
        const size = 1.6 + (i % 3) * 0.3;
        const crate = createBox(size, size, size, 0xc9a35a);
        crate.material = crateMat;
        crate.position.set(
          (i % 2 === 0 ? -1.4 : 1.4),
          size / 2 + Math.floor(i / 2) * 1.7,
          (i % 3 === 0 ? -1 : i % 3 === 1 ? 1 : 0),
        );
        this.mesh.add(crate);
        const lid = createBox(size * 0.7, 0.25, size * 0.7, 0x7a5c2e);
        lid.material = lidMat;
        lid.position.set(crate.position.x, crate.position.y + size / 2 + 0.15, crate.position.z);
        this.mesh.add(lid);
      }
    }

    // Glow marker ring on the ground so players can spot objectives
    const markerMat = createGlowMaterial(type === ObjectiveType.AMMO_DEPOT ? 0xffaa33 : 0xff3366, 0.35);
    const marker = new THREE.Mesh(new THREE.RingGeometry(3.4, 4.0, 24), markerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.15;
    this.mesh.add(marker);

    // Vertical beacon beam + floating label so objectives read from the air
    const beaconColor = type === ObjectiveType.AMMO_DEPOT ? 0xffaa33 : 0xff3366;
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 1.4, 55, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: beaconColor,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.beacon.position.y = 28;
    this.beacon.visible = false; // shown via setMarkerVisible
    this.mesh.add(this.beacon);

    // Canvas label sprite (billboarded, always faces camera)
    const label = this.type === ObjectiveType.SAM_SITE ? 'SAM' : this.type === ObjectiveType.RADAR_TOWER ? 'RADAR' : 'DEPOT';
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(6, 16, 30, 0.85)';
      ctx.roundRect ? ctx.roundRect(8, 8, 240, 112, 18) : ctx.fillRect(8, 8, 240, 112);
      ctx.fill();
      ctx.strokeStyle = '#' + beaconColor.toString(16).padStart(6, '0');
      ctx.lineWidth = 6;
      ctx.strokeRect(8, 8, 240, 112);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 64px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 128, 64);
    }
    const labelTex = new THREE.CanvasTexture(canvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const labelMat = new THREE.SpriteMaterial({
      map: labelTex,
      transparent: true,
      depthTest: false,
    });
    this.labelSprite = new THREE.Sprite(labelMat);
    this.labelSprite.position.y = 34;
    this.labelSprite.scale.set(22, 11, 1);
    this.labelSprite.visible = false;
    this.mesh.add(this.labelSprite);

    this.mesh.position.set(x, y, z);
    scene.add(this.mesh);

    this.body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      position: new CANNON.Vec3(x, y, z),
    });
    const shape = new CANNON.Box(new CANNON.Vec3(this.radius, this.radius * 0.8, this.radius));
    this.body.addShape(shape);
    world.addBody(this.body);
  }

  update(time: number) {
    if (!this.active) return;
    this.mesh.position.y = this.position.y + Math.sin(time * 1.8 + this.bobSeed) * 0.35;
    this.mesh.rotation.y += 0.004;
    // Damage flash
    if (this.hp < this.maxHp * 0.5) {
      this.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = 0.55 + Math.sin(time * 10) * 0.35;
        }
      });
    }
    // Beacon beam pulses toward the sky so players can spot objectives
    if (this.beacon) {
      const pulse = 0.5 + Math.sin(time * 4 + this.bobSeed) * 0.3;
      (this.beacon.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, pulse);
    }
  }

  /** Distance from a world position to the objective, in units. */
  distanceTo(px: number, pz: number): number {
    const dx = px - this.position.x;
    const dz = pz - this.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  takeDamage(amt: number): boolean {
    if (!this.active) return false;
    this.hp -= amt;
    if (this.hp <= 0) {
      this.destroy();
      return true;
    }
    return false;
  }

  destroy() {
    this.active = false;
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    this.world.removeBody(this.body);
    if (this.labelSprite?.material instanceof THREE.SpriteMaterial) {
      this.labelSprite.material.map?.dispose();
      this.labelSprite.material.dispose();
    }
    if (this.beacon) {
      this.beacon.geometry.dispose();
      if (Array.isArray(this.beacon.material)) {
        this.beacon.material.forEach((m) => m.dispose());
      } else {
        this.beacon.material.dispose();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TURRET — destroyable rooftop gun emplacement that tracks and shoots the player
// ---------------------------------------------------------------------------
export class Turret {
  active: boolean = true;
  hp: number;
  maxHp: number = 26;
  position: CANNON.Vec3;
  mesh: THREE.Group;
  head: THREE.Group;
  yaw: number = 0;
  block: CityBlock | null;
  chunkId: number;
  // +Infinity = never fired; the engine sets it on first encounter so turrets
  // spawned mid-run don't fire on their very first frame
  lastShotTime: number = Number.POSITIVE_INFINITY;
  fireInterval: number;
  range: number = 200;
  basePoints: number = 75;
  seed: number;

  constructor(
    chunkGroup: THREE.Group,
    x: number,
    y: number,
    z: number,
    chunkId: number,
    block: CityBlock | null,
  ) {
    this.position = new CANNON.Vec3(x, y, z);
    this.block = block;
    this.chunkId = chunkId;
    this.hp = this.maxHp;
    this.seed = Math.random();
    this.fireInterval = 1.0 + Math.random() * 0.9;

    this.mesh = new THREE.Group();
    this.mesh.position.set(x, y, z);

    const baseMat = createLowPolyMaterial(0x2b3540);
    const metalMat = createLowPolyMaterial(0x4a5560);
    const darkMat = createLowPolyMaterial(0x1d2530);
    const eyeMat = createLowPolyMaterial(0xff3344);

    // Base plate bolted to the roof
    const base = createBox(2.4, 0.5, 2.4, 0x2b3540);
    base.material = baseMat;
    base.position.y = 0.25;
    this.mesh.add(base);

    // Rotating head: body + barrel + glowing eye
    this.head = new THREE.Group();
    this.head.position.y = 0.7;
    this.mesh.add(this.head);

    const body = createBox(1.5, 0.9, 1.5, 0x4a5560);
    body.material = metalMat;
    body.position.y = 0.55;
    this.head.add(body);

    const barrel = createBox(0.34, 0.34, 2.6, 0x1d2530);
    barrel.material = darkMat;
    barrel.position.set(0, 0.72, 1.7);
    this.head.add(barrel);

    const eye = createBox(0.55, 0.45, 0.45, 0xff3344);
    eye.material = eyeMat;
    eye.position.set(0, 0.85, 0.85);
    this.head.add(eye);

    // Muzzle flash glow tip
    const tip = createGlowBox(0.4, 0.4, 0.4, 0xffaa44, 0.9);
    tip.position.set(0, 0.72, 3.0);
    this.head.add(tip);

    chunkGroup.add(this.mesh);
  }

  /** Host building destroyed → the turret is dead too. */
  isGone(): boolean {
    return !this.active || (this.block !== null && this.block.destroyed);
  }

  /** Rotate the head to track the player (yaw only). */
  aimAt(px: number, pz: number, time: number) {
    const dx = px - this.position.x;
    const dz = pz - this.position.z;
    if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) return;
    const targetYaw = Math.atan2(dx, dz);
    let diff = targetYaw - this.yaw;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    // Smooth-yaw tracking (≈0.4 of the remaining angle per frame)
    this.yaw += diff * 0.4;
    this.head.rotation.y = this.yaw;
    // Barrel bob while tracking
    this.head.rotation.x = Math.sin(time * 2.2 + this.seed * 6.28) * 0.06;
  }

  getMuzzle() {
    return {
      x: this.position.x + Math.sin(this.yaw) * 3.0,
      y: this.position.y + 1.4,
      z: this.position.z + Math.cos(this.yaw) * 3.0,
    };
  }

  takeDamage(amt: number): boolean {
    this.hp -= amt;
    if (this.hp <= 0) {
      this.active = false;
      this.mesh.visible = false;
      return true;
    }
    return false;
  }
}
