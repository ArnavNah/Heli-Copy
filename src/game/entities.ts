import * as THREE from "three";
import * as CANNON from "cannon-es";
import { createBox, createGlowBox, createGlowMaterial, createLowPolyMaterial, disposeObject3D } from "./materials";
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
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
      // Phase 1: release this entity's unique GPU buffers (rotor blur discs,
      // shield bubbles, hull materials). Shared cached resources are skipped.
      disposeObject3D(this.mesh);
    }
    if (this.body && this.world) this.world.removeBody(this.body);
  }
}

const tempColor = new THREE.Color();
const tempVec3_1 = new CANNON.Vec3();
const tempVec3_2 = new CANNON.Vec3();

/**
 * Phase 2 — named, tunable arcade movement values. The helicopter is
 * velocity-controlled (not a position-target chase), so these are the single
 * source of truth for every movement constant. Units: units/second and
 * units/second². Braking is deliberately stronger than acceleration so the
 * ship settles into a hover instead of gliding across the city.
 */
export const MOVEMENT_CONFIG = {
  /** Normal cruise speed cap (u/s). */
  maxSpeed: 68,
  /**
   * Horizontal move response (/s) — exponential approach toward the desired
   * velocity: 1 - exp(-response·dt). ~11/s reaches 90% of cruise in ~0.21s:
   * immediate first response (the velocity jumps a large fraction per frame)
   * with a short physical ramp so the ship reads as weighted, not rail-guided.
   */
  moveResponse: 11,
  /** Horizontal braking response (/s) — stronger than accel: a brief moment
   *  of momentum on release, then a decisive settle (no long glide). */
  brakeResponse: 13,
  /** Vertical climb/descend speed cap (u/s). */
  maxVerticalSpeed: 36,
  /** Vertical move response (/s) — heavier than horizontal (90% in ~0.27s). */
  verticalResponse: 8.5,
  /** Vertical settle response (/s) — faster when easing into auto-hover. */
  verticalSettleResponse: 11,
  /** Double-tap dash speed (u/s). */
  dashSpeed: 150,
  /** Afterburner max-speed multiplier (never multiplies velocity per frame). */
  afterburnerMultiplier: 1.55,
  /** Speed-boost power-up multiplier. */
  speedBoostMultiplier: 1.24,
  /** Minimum altitude above terrain/buildings (u). */
  hoverClearance: 7.5,
  /** Soft max altitude (u) — control eases out near the cap. */
  maxAltitude: 58,
  /** World half-width the player can fly across (x clamp). */
  worldBoundX: 210,
  /** Abnormal-speed safety clamp (u/s) — see Step 19. */
  safetyMaxSpeed: 260,
} as const;

/**
 * Phase 2 — per-frame movement command from the engine. Inputs are
 * world-space and already normalized: x = strafe (A/D), z = forward (W/S,
 * -z is forward), y = vertical -1..1 (Space/Alt), afterburner = speed
 * multiplier (1 when inactive).
 */
export interface MovementCommand {
  x: number;
  z: number;
  y: number;
  afterburner: number;
}

export class Helicopter extends Entity {
  model: HelicopterModel = HelicopterModel.APACHE;
  targetPosition: THREE.Vector3;
  lastTargetPosition: THREE.Vector3;
  mainRotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  shieldMesh: THREE.Mesh | null = null;
  /** Rotating chin gun turret — tracks auto-aim targets while the body flies on. */
  /** Yaw pivot (horizontal) — child of the helicopter mesh, parent to pitch pivot. */
  gunYawPivot: THREE.Group = new THREE.Group();
  /** Pitch pivot (vertical) — child of yaw pivot, holds the gun mesh. */
  gunPitchPivot: THREE.Group = new THREE.Group();
  gunAimMode: boolean = false;
  /** World-space target the gun should track (set externally). */
  gunAimTarget: THREE.Vector3 = new THREE.Vector3();

  // Phase 3 game-feel: MG recoil kicks the barrel/muzzle back along its axis
  // and springs back — visual only, pivots (and therefore auto-aim math) are
  // untouched. firePitchImpulse adds a tiny clamped nose kick for heavy
  // weapons, applied to the visual mesh only and absorbed by the bank
  // controller (spring return).
  private gunRecoil = 0;
  private firePitchImpulse = 0;
  private gunBarrelMesh: THREE.Mesh | null = null;
  private gunMuzzleMesh: THREE.Mesh | null = null;
  private static readonly GUN_RECOIL_MAX = 0.28;
  private static readonly GUN_RECOIL_RESPONSE = 22; // /s — fast spring back
  private static readonly FIRE_PITCH_MAX = 0.09;
  private static readonly FIRE_PITCH_RESPONSE = 10; // /s

  // Gun turret config
  static readonly GUN_YAW_MIN: number = -2.09; // -120°
  static readonly GUN_YAW_MAX: number = 2.09;  // +120°
  static readonly GUN_PITCH_MIN: number = -0.79; // -45°
  static readonly GUN_PITCH_MAX: number = 0.44;  // +25°
  static readonly GUN_TRACKING_SPEED: number = 14; // rad/s

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

    // Shared rotating chin gun turret (all models): yaw pivot → pitch pivot → gun mesh
    // This ensures auto-aim rotates ONLY the gun, never the helicopter body.
    this.gunYawPivot.position.set(0, -0.95, 3.0);
    baseGroup.add(this.gunYawPivot);

    this.gunPitchPivot.position.set(0, 0, 0);
    this.gunYawPivot.add(this.gunPitchPivot);

    const gunMountBase = createBox(0.6, 0.4, 0.6, 0x161a18);
    gunMountBase.material = bladeMat;
    const gunBarrel = createBox(0.14, 0.14, 2.0, 0x22262a);
    gunBarrel.material = bladeMat;
    gunBarrel.position.set(0, 0, 1.0);
    const gunMuzzle = createGlowBox(0.3, 0.3, 0.26, 0xff4444, 0.85);
    gunMuzzle.position.set(0, 0, 2.05);
    this.gunPitchPivot.add(gunMountBase, gunBarrel, gunMuzzle);
    this.gunBarrelMesh = gunBarrel;
    this.gunMuzzleMesh = gunMuzzle;

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

    // Signature details: wingtip nav lights + tail beacon (Apache)
    const navRed = createGlowBox(0.22, 0.22, 0.22, 0xff2244, 0.9);
    navRed.position.set(-3.9, -0.1, 0.2);
    const navGreen = createGlowBox(0.22, 0.22, 0.22, 0x22ff66, 0.9);
    navGreen.position.set(3.9, -0.1, 0.2);
    const tailBeacon = createGlowBox(0.18, 0.18, 0.18, 0xff3344, 0.9);
    tailBeacon.position.set(0, 0.6, -8.4);
    const antenna = createBox(0.06, 0.7, 0.06, 0x5a6360);
    antenna.material = metalMat;
    antenna.position.set(0.7, 1.1, 0.6);
    baseGroup.add(navRed, navGreen, tailBeacon, antenna);
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

    // Signature details: wingtip nav lights + twin tail beacons (Nighthawk)
    const navRed = createGlowBox(0.2, 0.2, 0.2, 0xff2244, 0.9);
    navRed.position.set(-3.9, -0.15, 0.1);
    const navGreen = createGlowBox(0.2, 0.2, 0.2, 0x22ff66, 0.9);
    navGreen.position.set(3.9, -0.15, 0.1);
    const beaconL = createGlowBox(0.16, 0.16, 0.16, 0xff3344, 0.9);
    beaconL.position.set(-1.1, 1.2, -6.2);
    const beaconR = beaconL.clone();
    beaconR.position.x = 1.1;
    const antenna = createBox(0.06, 0.6, 0.06, 0x5a6360);
    antenna.material = metalMat;
    antenna.position.set(0, 1.0, 0.8);
    baseGroup.add(navRed, navGreen, beaconL, beaconR, antenna);
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

    // Signature details: intake glows + wingtip nav lights + roof beacon (Warlock)
    const intakeL = createGlowBox(0.5, 0.4, 0.2, 0xff8833, 0.8);
    intakeL.position.set(-1.7, 0.9, -2.2);
    const intakeR = intakeL.clone();
    intakeR.position.x = 1.7;
    const navRed = createGlowBox(0.24, 0.24, 0.24, 0xff2244, 0.9);
    navRed.position.set(-4.9, -0.2, 0.3);
    const navGreen = createGlowBox(0.24, 0.24, 0.24, 0x22ff66, 0.9);
    navGreen.position.set(4.9, -0.2, 0.3);
    const roofBeacon = createGlowBox(0.2, 0.2, 0.2, 0xffaa33, 0.9);
    roofBeacon.position.set(0, 1.6, 0.6);
    const antenna = createBox(0.07, 0.8, 0.07, 0x5a6360);
    antenna.material = metalMat;
    antenna.position.set(-0.8, 1.3, 0.7);
    baseGroup.add(intakeL, intakeR, navRed, navGreen, roofBeacon, antenna);
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

  /**
   * Phase 2 — vertical control, fully separate from horizontal movement.
   * Manual climb/descend input is velocity-based (own accel/brake/cap), then
   * two guards layer on top:
   *   • terrain safety floor — never descend below hoverFloor + clearance;
   *   • soft altitude cap near maxAltitude (control eases out, no hard snap).
   */
  private applyVerticalControl(
    time: number,
    delta: number,
    inputY: number,
    engineEff: number,
    rotorEff: number,
  ) {
    const cfg = MOVEMENT_CONFIG;
    this.smoothedHoverFloor +=
      (this.hoverFloor - this.smoothedHoverFloor) *
      Math.min(1, delta * (this.hoverFloor > this.smoothedHoverFloor ? 6.0 : 3.5));
    const floorY = this.smoothedHoverFloor + cfg.hoverClearance;

    // Manual climb/descend (Space/Alt)
    let desiredVy = inputY * cfg.maxVerticalSpeed * engineEff;

    // Safety floor: never descend below terrain/buildings + clearance.
    if (this.body.position.y < floorY && desiredVy < 0) desiredVy = 0;
    if (this.body.position.y < floorY - 0.5) {
      desiredVy = Math.max(desiredVy, (floorY - this.body.position.y) * 2.5);
    }
    // Soft altitude cap near maxAltitude (ease out, never hard-snap).
    if (this.body.position.y > cfg.maxAltitude - 4 && desiredVy > 0) {
      desiredVy *= Math.max(0, (cfg.maxAltitude - this.body.position.y) / 4);
    }

    // Step toward desired vertical velocity (faster response when settling or
    // reversing climb/descend — weighted but responsive altitude control).
    const vResp =
      (desiredVy * this.body.velocity.y < 0 ||
        Math.abs(desiredVy) < Math.abs(this.body.velocity.y)
        ? cfg.verticalSettleResponse
        : cfg.verticalResponse) * rotorEff;
    this.body.velocity.y +=
      (desiredVy - this.body.velocity.y) * (1 - Math.exp(-vResp * delta));
    // Snap tiny residual vertical velocity to zero so the ship never creeps.
    if (desiredVy === 0 && Math.abs(this.body.velocity.y) < 0.05) {
      this.body.velocity.y = 0;
    }
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
    if (active) this.gunAimTarget.set(x, y, z);
  }

  /** Phase 3: MG recoil — kick the barrel/muzzle back, spring returns fast.
   *  Visual only; pivots (auto-aim yaw/pitch math) are never touched. */
  triggerRecoil(amount: number) {
    this.gunRecoil = Math.min(Helicopter.GUN_RECOIL_MAX, Math.max(this.gunRecoil, amount));
  }

  /** Phase 3: tiny clamped nose kick for heavy weapons (missiles/rockets). */
  triggerFirePitch(amount: number) {
    this.firePitchImpulse = Math.min(Helicopter.FIRE_PITCH_MAX, Math.max(this.firePitchImpulse, amount));
  }

  /** Advance the visual recoil/fire-pitch spring back to rest. */
  private updateFireFeedback(delta: number) {
    if (this.gunRecoil > 0.0005) {
      this.gunRecoil *= Math.exp(-Helicopter.GUN_RECOIL_RESPONSE * delta);
      if (this.gunRecoil < 0.0005) this.gunRecoil = 0;
    }
    if (this.gunBarrelMesh && this.gunMuzzleMesh) {
      this.gunBarrelMesh.position.z = 1.0 - this.gunRecoil * 0.55;
      this.gunMuzzleMesh.position.z = 2.05 - this.gunRecoil;
    }
    if (this.firePitchImpulse > 0.0005) {
      this.firePitchImpulse *= Math.exp(-Helicopter.FIRE_PITCH_RESPONSE * delta);
      if (this.firePitchImpulse < 0.0005) this.firePitchImpulse = 0;
    }
  }

  /** Get the current muzzle world position (fire origin for gun projectiles).
   *  Walks the pivot hierarchy: mesh → gunYawPivot → gunPitchPivot → muzzle. */
  getMuzzlePosition(target: THREE.Vector3): THREE.Vector3 {
    // Reads the muzzle mesh's live local z so recoil offsets the fire origin
    // correctly. +Z is the barrel axis in gunPitchPivot local space.
    const muzzleZ = this.gunMuzzleMesh ? this.gunMuzzleMesh.position.z : 2.05;
    target.set(0, 0, muzzleZ);
    target.applyQuaternion(this.gunPitchPivot.quaternion);
    target.add(this.gunPitchPivot.position);
    target.applyQuaternion(this.gunYawPivot.quaternion);
    target.add(this.gunYawPivot.position);
    this.mesh.localToWorld(target);
    return target;
  }

  /** Get the muzzle world forward direction (fire direction for gun projectiles).
   *  Composes the full world rotation: mesh (body heading/bank) → yaw → pitch. */
  getMuzzleDirection(target: THREE.Vector3): THREE.Vector3 {
    target.set(0, 0, 1);
    const q = this.mesh.quaternion.clone();
    q.multiply(this.gunYawPivot.quaternion);
    q.multiply(this.gunPitchPivot.quaternion);
    target.applyQuaternion(q);
    return target;
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
    this.gunYawPivot.rotation.y = 0;
    this.gunPitchPivot.rotation.x = 0;
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
    move?: MovementCommand,
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
      if (this.dashTimer <= 0) {
        // Dash finished: snap the pose back to identity (2π ≡ 0) so the tilt
        // controller resumes from a clean baseline instead of unwinding a full turn.
        this.mesh.rotation.x = 0;
        this.mesh.rotation.z = 0;
      } else if (this.dashRollDirection !== 0) {
        // Sideways dodge: a sharp bank out and back (no disorienting full spin)
        const rollAngle = Math.sin(progress * Math.PI) * 0.95 * -this.dashRollDirection;
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

      // Dash keeps altitude control active (climb/descend still works mid-dash)
      this.applyVerticalControl(time, delta, move?.y ?? 0, 1, 1);

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

    // ---- Phase 2: velocity-based arcade movement -------------------------
    // Input (world-space, normalized 0..1) → desired velocity → accelerate the
    // actual body velocity toward it. No position-target chasing: the body's
    // velocity IS the gameplay transform, so movement is predictable, capped,
    // and easy to correct. Diagonal input is normalized upstream, so W+D moves
    // at the same max speed as W alone.
    const cfg = MOVEMENT_CONFIG;
    const moveX = move?.x ?? 0;
    const moveZ = move?.z ?? 0;
    const moveY = move?.y ?? 0;
    const speedMult =
      (move?.afterburner ?? 1) *
      (speedBoostActive ? cfg.speedBoostMultiplier : 1) *
      engineEff;
    const maxSpeed = cfg.maxSpeed * speedMult;

    const desiredVx = moveX * maxSpeed;
    const desiredVz = moveZ * maxSpeed;

    const vx = this.body.velocity.x;
    const vz = this.body.velocity.z;

    // Step 6: braking response is stronger than acceleration (no gliding across
    // the city). Per-axis: slowing toward the desired velocity — OR reversing
    // direction (opposite signs = strong counter-acceleration, Step 6) — uses
    // the braking response. Exponential approach gives immediate first response
    // with a short physical ramp to cruise (~0.21s), so the ship has weight.
    const respX =
      desiredVx * vx < 0 || Math.abs(desiredVx) < Math.abs(vx)
        ? cfg.brakeResponse
        : cfg.moveResponse;
    const respZ =
      desiredVz * vz < 0 || Math.abs(desiredVz) < Math.abs(vz)
        ? cfg.brakeResponse
        : cfg.moveResponse;
    this.body.velocity.x += (desiredVx - vx) * (1 - Math.exp(-respX * rotorEff * delta));
    this.body.velocity.z += (desiredVz - vz) * (1 - Math.exp(-respZ * rotorEff * delta));
    // Snap tiny residual velocities to zero so the ship settles into a hover
    // instead of creeping on floating-point leftovers.
    if (desiredVx === 0 && Math.abs(this.body.velocity.x) < 0.05) this.body.velocity.x = 0;
    if (desiredVz === 0 && Math.abs(this.body.velocity.z) < 0.05) this.body.velocity.z = 0;

    // Ambient wind nudge (cosmetic — never overrides player control)
    if (windForce) {
      this.body.velocity.x += windForce.x * 0.004 * delta;
      this.body.velocity.z += windForce.z * 0.004 * delta;
    }

    // Step 8/9: vertical is separate from horizontal — climb/descend with its
    // own accel/brake/cap, plus a terrain-safety floor and altitude cap.
    this.applyVerticalControl(time, delta, moveY, engineEff, rotorEff);

    const newVx = this.body.velocity.x;
    const newVz = this.body.velocity.z;
    const newVy = this.body.velocity.y;
    const speed = Math.sqrt(newVx * newVx + newVz * newVz);

    // Step 19 movement safety: abnormal speed ⇒ corrupted body — clamp and log
    // instead of letting it fly off the map and corrupt the whole sim.
    const totalSpeed = Math.sqrt(speed * speed + newVy * newVy);
    if (totalSpeed > cfg.safetyMaxSpeed) {
      if (import.meta.env.DEV) {
        console.warn(
          "[Heli-Strike] abnormal player speed — clamping",
          totalSpeed.toFixed(1),
        );
      }
      const s = cfg.safetyMaxSpeed / Math.max(totalSpeed, 0.001);
      this.body.velocity.x *= s;
      this.body.velocity.y *= s;
      this.body.velocity.z *= s;
    }

    const isIdle = !hasInput && speed < 3.0; // Player resting?
    const inputAgility = Math.min(speed / 80.0, 1.0);

    // Body heading is movement-only. The nose NEVER turns toward the aim
    // point, the mouse, or enemies — the chin gun turret does all aiming
    // (see the gun update below), so the aircraft flies on course while the
    // weapon tracks independently. When hovering (speed <= 4) the body holds
    // its last heading instead of drifting toward anything.
    let targetAngle = this.mesh.rotation.y;
    if (speed > 4) {
      targetAngle = Math.atan2(newVx, newVz);
    }

    let currentAngle = this.mesh.rotation.y;
    let diff = targetAngle - currentAngle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;

    // Turn the nose toward travel at a deliberately slower rate so the ship
    // shows cross-controlled banking: strafing left drifts the hull sideways
    // with a visible bank while the nose swings in behind the motion (Phase 2
    // physics — helicopter-like weight instead of an instantly-aligned nose).
    const turnTurnSpeed = (0.07 + inputAgility * 0.06) * rotorEff;
    this.mesh.rotation.y += diff * Math.min(1, turnTurnSpeed * delta * 60);

    // Rotating chin gun turret (separate yaw/pitch pivots) — tracks the auto-aim
    // target, or eases to neutral. ONLY the gun moves; the helicopter body stays
    // on its flight course. Yaw rotates gunYawPivot (horizontal), pitch rotates
    // gunPitchPivot (vertical, child of yaw). Limits prevent the gun from
    // pointing through the cockpit.
    const H = Helicopter;
    const trackingSpeed = H.GUN_TRACKING_SPEED * delta;

    if (this.gunAimMode) {
      // Yaw: world-space target direction converted to mesh-local yaw
      const gDx = this.gunAimTarget.x - this.body.position.x;
      const gDz = this.gunAimTarget.z - this.body.position.z;
      let yawTarget = Math.atan2(gDx, gDz) - this.mesh.rotation.y;
      // Clamp to yaw limits
      yawTarget = Math.max(H.GUN_YAW_MIN, Math.min(H.GUN_YAW_MAX, yawTarget));
      // Shortest-path angle wrapping
      let yawDiff = yawTarget - this.gunYawPivot.rotation.y;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      this.gunYawPivot.rotation.y += Math.min(Math.abs(yawDiff), trackingSpeed) * Math.sign(yawDiff);

      // Pitch: vertical angle to target, calculated in world space (yaw pivot
      // has already rotated to face the target direction).
      const gDy = this.gunAimTarget.y - this.body.position.y;
      const gHoriz = Math.max(0.001, Math.sqrt(gDx * gDx + gDz * gDz));
      let pitchTarget = THREE.MathUtils.clamp(-Math.atan2(gDy, gHoriz), H.GUN_PITCH_MIN, H.GUN_PITCH_MAX);
      let pitchDiff = pitchTarget - this.gunPitchPivot.rotation.x;
      this.gunPitchPivot.rotation.x += Math.min(Math.abs(pitchDiff), trackingSpeed * 0.8) * Math.sign(pitchDiff);
    } else {
      // No target — ease back to neutral forward position
      const yawReturnSpeed = trackingSpeed * 0.6;
      this.gunYawPivot.rotation.y += Math.min(Math.abs(this.gunYawPivot.rotation.y), yawReturnSpeed) * -Math.sign(this.gunYawPivot.rotation.y);
      this.gunPitchPivot.rotation.x += Math.min(Math.abs(this.gunPitchPivot.rotation.x), yawReturnSpeed * 0.8) * -Math.sign(this.gunPitchPivot.rotation.x);
    }

    // Phase 3: visual recoil + heavy-weapon nose kick — barrel/muzzle only and
    // a tiny clamped mesh pitch, both springing back to rest.
    this.updateFireFeedback(delta);

    this.mesh.position.copy(this.body.position as any);

    const cy = Math.cos(this.mesh.rotation.y);
    const sy = Math.sin(this.mesh.rotation.y);
    // Transform velocity to local space (Z forward, X right)
    const localVx = newVx * cy - newVz * sy;
    const localVz = newVx * sy + newVz * cy;

    // Auto-Stabilization: Suppress tilt if idling to gently correct rotation
    const tiltMultiplier = isIdle ? 0.22 : 1.25;

    // Phase 2: lean-in from acceleration (difference between desired and actual velocity)
    // — replaces the old force-based term (fx/fz no longer exist).
    const accelX = desiredVx - newVx;
    const accelZ = desiredVz - newVz;
    const localAx = accelX * cy - accelZ * sy;
    const localAz = accelX * sy + accelZ * cy;

    // Phase 2 physics banking: velocity-driven bank + acceleration lean-in,
    // with explicit arcade limits — roll ±17°, pitch ±9° (never 45°+ rails).
    // The acceleration term (localAx/localAz = desired−actual) makes the ship
    // visibly lean INTO a direction change, then settle as velocity catches up.
    // One authoritative calculation; critically-damped exp smoothing: quick
    // lean-in, slightly slower return to neutral (no oscillation, no jitter).
    const ROLL_LIMIT = 0.30; // ~17°
    const PITCH_LIMIT = 0.16; // ~9°
    const BANK_IN_RESPONSE = 7.5;
    const BANK_OUT_RESPONSE = 4.5;
    const targetTiltX =
      THREE.MathUtils.clamp(
        (localVz * 0.0028 +
          THREE.MathUtils.clamp(localAz * 0.0022, -0.14, 0.14)) *
          tiltMultiplier,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
    const targetTiltZ =
      -THREE.MathUtils.clamp(
        (localVx * 0.0055 +
          THREE.MathUtils.clamp(localAx * 0.0022, -0.16, 0.16)) *
          tiltMultiplier,
        -ROLL_LIMIT,
        ROLL_LIMIT,
      );
    const bankRespX =
      Math.abs(targetTiltX) >= Math.abs(this.mesh.rotation.x)
        ? BANK_IN_RESPONSE
        : BANK_OUT_RESPONSE;
    const bankRespZ =
      Math.abs(targetTiltZ) >= Math.abs(this.mesh.rotation.z)
        ? BANK_IN_RESPONSE
        : BANK_OUT_RESPONSE;
    this.mesh.rotation.x +=
      (targetTiltX - this.mesh.rotation.x) * (1 - Math.exp(-bankRespX * delta));
    this.mesh.rotation.z +=
      (targetTiltZ - this.mesh.rotation.z) * (1 - Math.exp(-bankRespZ * delta));
    // Phase 3: heavy-weapon nose kick — the bank controller absorbs this tiny
    // clamped pitch next frame, giving a clean spring return.
    this.mesh.rotation.x += this.firePitchImpulse;

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

    this.animateRotors(speed, 80, delta);
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
  /** Smoothed movement velocity — eases toward the desired vector each frame so
   *  enemies don't snap direction (same polish as the player's PD controller). */
  smoothVelX: number = 0;
  smoothVelZ: number = 0;
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
      // "Archon" heavy gunship — layered hull, twin nacelles, broad wings, glow core
      this.ring = new THREE.Group();
      this.ring.position.y = 0.2;
      const r = radius;

      // Layered main hull (chunky silhouette)
      const hull = createBox(r * 1.25, r * 0.55, r * 1.9, coreHex);
      this.ring.add(hull);
      const hullTop = createBox(r * 0.9, r * 0.35, r * 1.5, coreHex);
      hullTop.position.set(0, r * 0.42, -r * 0.1);
      this.ring.add(hullTop);
      const belly = createBox(r * 1.05, r * 0.3, r * 1.5, 0x1a1020);
      belly.position.set(0, -r * 0.45, r * 0.1);
      this.ring.add(belly);

      // Cockpit + nose sensor + glowing core
      const glass = createBox(r * 0.55, r * 0.38, r * 0.65, 0x172f3d);
      glass.position.set(0, r * 0.25, r * 1.1);
      this.ring.add(glass);
      const noseSensor = createGlowBox(r * 0.3, r * 0.18, r * 0.3, 0xff3366, 0.9);
      noseSensor.position.set(0, r * 0.05, r * 1.45);
      this.ring.add(noseSensor);
      const core = createGlowBox(r * 0.5, r * 0.5, r * 0.24, 0xff2266, 0.95);
      core.position.set(0, 0, r * 0.85);
      this.ring.add(core);

      // Twin engine nacelles with glowing intakes
      [-1, 1].forEach((s) => {
        const nacelle = createBox(r * 0.45, r * 0.5, r * 1.1, accentHex);
        nacelle.position.set(s * r * 1.0, r * 0.15, r * 0.35);
        this.ring.add(nacelle);
        const intake = createGlowBox(r * 0.5, r * 0.4, r * 0.18, 0xff8833, 0.85);
        intake.position.set(s * r * 1.0, r * 0.15, r * 0.92);
        this.ring.add(intake);
      });

      // Broad wing + missile pylons + wingtip lights
      const wing = createBox(r * 3.0, r * 0.18, r * 0.8, coreHex);
      wing.position.set(0, 0, r * 0.2);
      this.ring.add(wing);
      [-1, 1].forEach((s) => {
        const pylon = createBox(r * 0.14, r * 0.3, r * 0.5, 0x222222);
        pylon.position.set(s * r * 1.35, -r * 0.25, r * 0.2);
        this.ring.add(pylon);
        const missile = createBox(r * 0.12, r * 0.12, r * 0.7, 0x444444);
        missile.position.set(s * r * 1.35, -r * 0.42, r * 0.2);
        this.ring.add(missile);
        const tipLight = createGlowBox(r * 0.16, r * 0.16, r * 0.16, s < 0 ? 0x33ff66 : 0xff4433, 0.9);
        tipLight.position.set(s * r * 1.55, 0, r * 0.2);
        this.ring.add(tipLight);
      });

      // Twin tail booms + fins + stabilizer
      [-1, 1].forEach((s) => {
        const boom = createBox(r * 0.22, r * 0.28, r * 1.9, coreHex);
        boom.position.set(s * r * 0.55, r * 0.1, -r * 1.55);
        this.ring.add(boom);
        const fin = createBox(r * 0.12, r * 0.85, r * 0.4, accentHex);
        fin.position.set(s * r * 0.55, r * 0.5, -r * 2.3);
        this.ring.add(fin);
      });
      const stab = createBox(r * 1.4, r * 0.1, r * 0.7, coreHex);
      stab.position.set(0, r * 0.15, -r * 2.2);
      this.ring.add(stab);

      // Dorsal spine
      const spine = createBox(r * 0.12, r * 0.5, r * 0.9, accentHex);
      spine.position.set(0, r * 0.75, -r * 0.3);
      this.ring.add(spine);

      // Main rotor on a raised mast
      const mast = createBox(r * 0.14, r * 0.5, r * 0.14, 0x333333);
      mast.position.set(0, r * 0.6, -r * 0.2);
      this.ring.add(mast);
      const rotorGroup = new THREE.Group();
      rotorGroup.position.set(0, r * 0.9, -r * 0.2);
      for (let i = 0; i < 4; i++) {
        const blade = createBox(r * 0.12, r * 0.03, r * 1.6, 0x111111);
        blade.rotation.y = (i * Math.PI) / 2;
        blade.position.z = r * 0.75;
        rotorGroup.add(blade);
      }
      this.ring.add(rotorGroup);
      this.enemyRotor = rotorGroup;

      // Tail rotor
      const tailRotorGroup = new THREE.Group();
      tailRotorGroup.position.set(0, r * 0.45, -r * 2.35);
      for (let i = 0; i < 2; i++) {
        const blade = createBox(r * 0.03, r * 0.08, r * 0.5, 0x111111);
        blade.rotation.x = (i * Math.PI) / 2;
        tailRotorGroup.add(blade);
      }
      this.ring.add(tailRotorGroup);
      this.enemyTailRotor = tailRotorGroup;

      baseGroup.add(this.ring);

    } else if (type === EnemyType.TANK) {
      // "Flakpanzer" — sloped hull, tracked chassis, quad AA turret + radar
      this.ring = new THREE.Group();

      // Tracked chassis with road wheels
      [-1.5, 1.5].forEach((tx) => {
        const track = createBox(1.1, 0.8, 3.9, 0x111111);
        track.position.set(tx, -0.25, 0);
        this.ring.add(track);
        for (let i = 0; i < 5; i++) {
          const wheel = createBox(0.5, 0.5, 0.22, 0x2a2a2a);
          wheel.position.set(tx, -0.25, -1.5 + i * 0.75);
          this.ring.add(wheel);
        }
      });
      const belly = createBox(2.1, 0.25, 3.2, 0x111111);
      belly.position.set(0, -0.1, 0);
      this.ring.add(belly);

      // Sloped hull + glacis plate + side skirts
      const hull = createBox(2.3, 0.9, 3.4, coreHex);
      hull.position.set(0, 0.35, 0);
      this.ring.add(hull);
      const glacis = createBox(2.1, 0.7, 0.9, coreHex);
      glacis.position.set(0, 0.75, 1.5);
      glacis.rotation.x = -0.5;
      this.ring.add(glacis);
      [-1.35, 1.35].forEach((sx) => {
        const skirt = createBox(0.12, 0.6, 3.6, 0x1a1a1a);
        skirt.position.set(sx, 0.1, 0);
        this.ring.add(skirt);
      });

      // Turret with quad AA barrels + glowing muzzle
      const turret = createBox(1.9, 0.7, 2.1, accentHex);
      turret.position.set(0, 1.15, -0.3);
      this.ring.add(turret);
      const turretTop = createBox(1.3, 0.3, 1.5, accentHex);
      turretTop.position.set(0, 1.55, -0.3);
      this.ring.add(turretTop);
      for (let i = 0; i < 4; i++) {
        const barrel = createBox(0.12, 0.12, 2.4, 0x333333);
        barrel.position.set(-0.45 + i * 0.3, 1.2, 1.6);
        this.ring.add(barrel);
      }
      const muzzle = createGlowBox(0.6, 0.24, 0.2, 0xffaa33, 0.85);
      muzzle.position.set(-0.15, 1.2, 2.95);
      this.ring.add(muzzle);

      // Radar dish + blinking beacon behind the turret
      const radarPole = createBox(0.12, 0.7, 0.12, 0x333333);
      radarPole.position.set(0.7, 1.6, -0.9);
      this.ring.add(radarPole);
      const radarDish = createBox(0.5, 0.08, 0.7, 0x99ccdd);
      radarDish.position.set(0.7, 1.9, -0.9);
      radarDish.rotation.x = 0.5;
      this.ring.add(radarDish);
      const radarBlink = createGlowBox(0.16, 0.16, 0.16, 0x44ddff, 0.9);
      radarBlink.position.set(0.7, 2.05, -1.0);
      this.ring.add(radarBlink);

      // Antenna with warning light
      const antenna = createBox(0.06, 0.9, 0.06, 0x333333);
      antenna.position.set(-0.6, 1.9, -0.2);
      this.ring.add(antenna);
      const antennaTip = createGlowBox(0.14, 0.14, 0.14, 0xff3344, 0.9);
      antennaTip.position.set(-0.6, 2.35, -0.2);
      this.ring.add(antennaTip);

      baseGroup.add(this.ring);

    } else if (type === EnemyType.DRONE) {
      // Recon quadcopter — camera dome, sensor pod, rotor arms, nav light
      this.ring = new THREE.Group();

      const core = createBox(1.3, 0.55, 1.3, coreHex);
      this.ring.add(core);
      const coreTop = createBox(0.9, 0.3, 0.9, coreHex);
      coreTop.position.set(0, 0.4, 0);
      this.ring.add(coreTop);
      const cameraDome = createGlowBox(0.4, 0.22, 0.4, 0x44ddff, 0.7);
      cameraDome.position.set(0, 0.62, 0.1);
      this.ring.add(cameraDome);
      const sensor = createBox(0.55, 0.35, 0.7, accentHex);
      sensor.position.set(0, -0.4, 0.45);
      this.ring.add(sensor);
      const sensorEye = createGlowBox(0.2, 0.12, 0.16, 0xff3344, 0.9);
      sensorEye.position.set(0, -0.4, 0.82);
      this.ring.add(sensorEye);
      // Landing struts
      [-0.5, 0.5].forEach((s) => {
        const strut = createBox(0.08, 0.35, 0.08, 0x222222);
        strut.position.set(s * 0.6, -0.6, -0.2);
        this.ring.add(strut);
      });
      // Blinking nav light
      const navLight = createGlowBox(0.2, 0.2, 0.2, 0xffaa33, 0.9);
      navLight.position.set(0, -0.3, -0.7);
      this.ring.add(navLight);

      this.enemyRotor = new THREE.Group();
      const armOffsets = [
        [-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]
      ];
      armOffsets.forEach(([px, pz]) => {
        const arm = createBox(1.6, 0.14, 0.14, 0x333333);
        arm.position.set(px / 2, 0.05, pz / 2);
        arm.rotation.y = Math.atan2(pz, px);
        this.ring.add(arm);
        const motor = createBox(0.42, 0.6, 0.42, accentHex);
        motor.position.set(px, 0.12, pz);
        this.ring.add(motor);
        const bladeGroup = new THREE.Group();
        bladeGroup.position.set(px, 0.5, pz);
        const blade = createBox(1.5, 0.05, 0.2, 0x111111);
        bladeGroup.add(blade);
        this.enemyRotor!.add(bladeGroup);
      });
      this.ring.add(this.enemyRotor);
      baseGroup.add(this.ring);

    } else {
      // BASIC interceptor (sleek) vs SHOOTER gunship (heavy) — distinct silhouettes
      const isShooter = type === EnemyType.SHOOTER;
      this.ring = new THREE.Group();
      const r = radius;

      // Shared fuselage + nose
      const fuselage = createBox(r * 0.75, r * 0.6, r * 2.4, coreHex);
      this.ring.add(fuselage);
      const nose = createBox(r * 0.45, r * 0.45, r * 0.9, coreHex);
      nose.position.set(0, -r * 0.05, r * 1.5);
      this.ring.add(nose);
      const noseCone = createBox(r * 0.22, r * 0.22, r * 0.5, accentHex);
      noseCone.position.set(0, -r * 0.05, r * 2.1);
      this.ring.add(noseCone);
      const cockpit = createBox(r * 0.5, r * 0.4, r * 0.7, 0x172f3d);
      cockpit.position.set(0, r * 0.35, r * 0.5);
      this.ring.add(cockpit);

      if (isShooter) {
        // Gunship: twin engine pods, chin cannon, wing hardpoints
        [-1, 1].forEach((s) => {
          const enginePod = createBox(r * 0.4, r * 0.45, r * 1.0, accentHex);
          enginePod.position.set(s * r * 0.85, 0, -r * 0.4);
          this.ring.add(enginePod);
          const intake = createGlowBox(r * 0.3, r * 0.3, r * 0.16, 0xff8833, 0.85);
          intake.position.set(s * r * 0.85, 0, -r * 0.95);
          this.ring.add(intake);
        });
        const wing = createBox(r * 2.6, r * 0.14, r * 0.7, coreHex);
        wing.position.set(0, 0, -r * 0.3);
        this.ring.add(wing);
        [-1, 1].forEach((s) => {
          const missile = createBox(r * 0.14, r * 0.14, r * 0.7, 0x444444);
          missile.position.set(s * r * 1.15, -r * 0.2, -r * 0.3);
          this.ring.add(missile);
        });
        const cannon = createBox(r * 0.14, r * 0.14, r * 1.2, 0x333333);
        cannon.position.set(0, -r * 0.35, r * 1.4);
        this.ring.add(cannon);
        const cannonMuzzle = createGlowBox(r * 0.22, r * 0.22, r * 0.2, 0xff3344, 0.9);
        cannonMuzzle.position.set(0, -r * 0.35, r * 2.05);
        this.ring.add(cannonMuzzle);
        [-1, 1].forEach((s) => {
          const fin = createBox(r * 0.08, r * 0.6, r * 0.4, accentHex);
          fin.position.set(s * r * 0.45, r * 0.4, -r * 1.2);
          this.ring.add(fin);
        });
      } else {
        // Interceptor: swept delta wing, twin fins, wingtip lights
        const wing = createBox(r * 2.9, r * 0.12, r * 0.9, coreHex);
        wing.position.set(0, -r * 0.05, -r * 0.2);
        wing.rotation.z = 0.05;
        this.ring.add(wing);
        [-1, 1].forEach((s) => {
          const tip = createGlowBox(r * 0.16, r * 0.16, r * 0.16, s < 0 ? 0x33ff66 : 0xff4433, 0.9);
          tip.position.set(s * r * 1.55, -r * 0.05, -r * 0.2);
          this.ring.add(tip);
        });
        const tailFin = createBox(r * 0.1, r * 0.55, r * 0.35, accentHex);
        tailFin.position.set(0, r * 0.35, -r * 1.25);
        this.ring.add(tailFin);
        const stab = createBox(r * 0.9, r * 0.08, r * 0.5, coreHex);
        stab.position.set(0, -r * 0.1, -r * 1.15);
        this.ring.add(stab);
      }

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

  /** First-order smoothing toward a desired velocity, then write it to the body. */
  private applySmoothMovement(desiredX: number, desiredZ: number, delta: number, rate: number) {
    const k = Math.min(1, delta * rate);
    this.smoothVelX += (desiredX - this.smoothVelX) * k;
    this.smoothVelZ += (desiredZ - this.smoothVelZ) * k;
    this.body.velocity.set(this.smoothVelX, 0, this.smoothVelZ);
  }

  /** How responsively this enemy type tracks its desired velocity. */
  private smoothRate(): number {
    if (this.type === EnemyType.TANK) return 5;
    if (this.type === EnemyType.BOSS) return 6;
    return 8;
  }

  updateDirection(
    targetPos: CANNON.Vec3,
    time: number,
    enemyProjectilePool: ProjectilePool,
    playerBullets: Projectile[],
    allEnemies: Enemy[],
    city: CityEnvironment,
    fireRateMult: number = 1.0,
    delta: number = 0.016,
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

    // Steering-based building avoidance: curve around block faces BEFORE touching
    // them (the overlap push below stays as a safety net).
    let avoidForceX = 0;
    let avoidForceZ = 0;
    const avoidRange = this.radius * 2 + 3;
    for (const block of city.blocks) {
      if (block.destroyed) continue;
      // Flying above the roof? No need to steer around it (mirrors the 3D overlap check).
      if (this.body.position.y - this.radius * 0.75 > block.height) continue;
      const bx = this.body.position.x;
      const bz = this.body.position.z;
      if (
        Math.abs(bx - block.x) > block.width / 2 + avoidRange ||
        Math.abs(bz - block.z) > block.depth / 2 + avoidRange
      ) {
        continue;
      }
      const closestX = THREE.MathUtils.clamp(bx, block.x - block.width / 2, block.x + block.width / 2);
      const closestZ = THREE.MathUtils.clamp(bz, block.z - block.depth / 2, block.z + block.depth / 2);
      const dxA = bx - closestX;
      const dzA = bz - closestZ;
      const dA = Math.sqrt(dxA * dxA + dzA * dzA);
      if (dA < avoidRange && dA > 0.001) {
        const strength = (1 - dA / avoidRange) * (this.radius * 6);
        avoidForceX += (dxA / dA) * strength;
        avoidForceZ += (dzA / dA) * strength;
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
          // Push along X axis and bias the smoothed velocity away so the enemy
          // doesn't instantly re-stick against the wall.
          const pushDir = this.body.position.x < block.x ? -1 : 1;
          this.body.position.x += pushDir * overlapX;
          this.smoothVelX = pushDir * Math.min(Math.max(Math.abs(this.smoothVelX), 6), 36);
          this.body.velocity.x = this.smoothVelX;
        } else {
          // Push along Z axis and bias the smoothed velocity away
          const pushDir = this.body.position.z < block.z ? -1 : 1;
          this.body.position.z += pushDir * overlapZ;
          this.smoothVelZ = pushDir * Math.min(Math.max(Math.abs(this.smoothVelZ), 6), 36);
          this.body.velocity.z = this.smoothVelZ;
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
      fired = this.updateBoss(targetPos, time, dist, dirX, dirZ, enemyProjectilePool, repelForceX, repelForceZ, fireRateMult, delta, avoidForceX, avoidForceZ);
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
      // Urgent dive, but still eased so the dive arcs instead of teleporting direction
      this.applySmoothMovement(
        dirX * kamikazeSpeed + repelForceX + avoidForceX,
        dirZ * kamikazeSpeed + repelForceZ + avoidForceZ,
        delta,
        14,
      );
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
      // Gentler weave, routed through the smoother so it reads as an organic bob
      const swoopX = Math.cos(time * 2 + this.personalityOffset) * 12;
      const swoopZ = Math.sin(time * 2 + this.personalityOffset) * 12;
      this.applySmoothMovement(
        dirX * speed + swoopX + repelForceX + avoidForceX,
        dirZ * speed + swoopZ + repelForceZ + avoidForceZ,
        delta,
        8,
      );

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

    let desiredX: number;
    let desiredZ: number;
    if (this.pattern === AttackPattern.CIRCLE) {
      // Circle-strafing runs: orbit the player, always strafing
      desiredX = tangentX * speed * 1.25 + dirX * 0.12 * speed + repelForceX + avoidForceX;
      desiredZ = tangentZ * speed * 1.25 + dirZ * 0.12 * speed + repelForceZ + avoidForceZ;
    } else if (this.pattern === AttackPattern.ARTILLERY) {
      // Artillery: hold range, only fire lobbed shells
      if (dist < 95) {
        desiredX = (-dirX + tangentX * 0.6) * speed * 0.8 + repelForceX + avoidForceX;
        desiredZ = (-dirZ + tangentZ * 0.6) * speed * 0.8 + repelForceZ + avoidForceZ;
      } else {
        desiredX = (tangentX + dirX * 0.15) * speed * 0.5 + repelForceX + avoidForceX;
        desiredZ = (tangentZ + dirZ * 0.15) * speed * 0.5 + repelForceZ + avoidForceZ;
      }
    } else if (dist > 45) {
      // Approach directly
      desiredX = dirX * speed + repelForceX + avoidForceX;
      desiredZ = dirZ * speed + repelForceZ + avoidForceZ;
    } else if (dist < 20 || isEvading) {
      // Evade / back away and strafe
      desiredX = (-dirX + tangentX * 1.5) * speed * 0.7 + repelForceX + avoidForceX;
      desiredZ = (-dirZ + tangentZ * 1.5) * speed * 0.7 + repelForceZ + avoidForceZ;
    } else {
      // Orbit (strafe)
      desiredX = (tangentX + dirX * 0.2) * speed * 0.6 + repelForceX + avoidForceX;
      desiredZ = (tangentZ + dirZ * 0.2) * speed * 0.6 + repelForceZ + avoidForceZ;
    }
    this.applySmoothMovement(desiredX, desiredZ, delta, this.smoothRate());

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
    delta: number = 0.016,
    avoidForceX: number = 0,
    avoidForceZ: number = 0,
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
    let desiredX: number;
    let desiredZ: number;
    if (dist > 40) {
      desiredX = dirX * speed * 0.9 + repelForceX + avoidForceX;
      desiredZ = dirZ * speed * 0.9 + repelForceZ + avoidForceZ;
    } else {
      desiredX = (tangentX + dirX * 0.15) * speed + repelForceX + avoidForceX;
      desiredZ = (tangentZ + dirZ * 0.15) * speed + repelForceZ + avoidForceZ;
    }
    this.applySmoothMovement(desiredX, desiredZ, delta, 6);

    let fired = false;

    // Telegraph attack (phase 1/2): beam warns the player, then fires
    if (this.phase <= 2 && this.telegraphActive) {
      this.smoothVelX = 0;
      this.smoothVelZ = 0;
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
  value: number = 1; // XP amount for XP_GEM pickups
  /** Spinning ground ring so the pickup reads clearly from the air. */
  groundRing: THREE.Mesh | null = null;

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
      [PowerUpType.XP_GEM]: 0x56e6ff,
    };

    const color = colors[type];

    // Classic arcade pickup indicator: a flat ring on the ground that spins
    // around the pickup so it's visible from the air.
    const isBomb = type === PowerUpType.BOMB;
    const groundRingGeo = new THREE.RingGeometry(isBomb ? 2.9 : 2.0, isBomb ? 3.7 : 2.5, 28);
    groundRingGeo.rotateX(-Math.PI / 2);
    const groundRingMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isBomb ? 0.9 : 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.groundRing = new THREE.Mesh(groundRingGeo, groundRingMat);
    // Ring hovers just below the pickup so it stays visible on rooftops and in the air
    this.groundRing.position.set(x, Math.max(0.12, y - 1.2), z);
    scene.add(this.groundRing);

    // Bombs also get a tall light pillar so the payoff pickup is unmissable
    if (isBomb) {
      const beamGeo = new THREE.CylinderGeometry(0.9, 2.4, 46, 10, 1, true);
      beamGeo.translate(0, 23, 0);
      const beamMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(x, Math.max(1, y - 1), z);
      scene.add(beam);
      this.groundRing.userData.beam = beam;
    }

    if (type === PowerUpType.XP_GEM) {
      // VS-style XP gem: small spinning cyan crystal with a bright core
      const gemGeom = new THREE.OctahedronGeometry(0.7, 0);
      const gemMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
      });
      const gem = new THREE.Mesh(gemGeom, gemMat);
      gem.scale.set(1, 1.5, 1);
      this.mesh.add(gem);

      const inner = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.3, 0),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
        }),
      );
      inner.scale.set(1, 1.5, 1);
      this.mesh.add(inner);

      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 10, 8),
        createGlowMaterial(color, 0.3),
      );
      this.mesh.add(halo);

      this.mesh.position.copy(this.position);
      scene.add(this.mesh);
      return;
    }

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
    this.mesh.position.x = this.position.x;
    this.mesh.position.z = this.position.z;
    this.mesh.position.y = this.position.y + Math.sin(time * 3) * 0.5;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.mesh.scale.setScalar(pulse);

    // Spin + pulse the ground indicator ring, keeping it under the pickup
    if (this.groundRing) {
      this.groundRing.rotation.y += delta * 3.2;
      this.groundRing.position.x = this.position.x;
      this.groundRing.position.z = this.position.z;
      this.groundRing.position.y = Math.max(0.12, this.position.y - 1.2);
      const pulse = 1 + Math.sin(time * 5) * 0.12;
      this.groundRing.scale.set(pulse, pulse, 1);
      const beam = this.groundRing.userData.beam as THREE.Mesh | undefined;
      if (beam) {
        beam.position.x = this.position.x;
        beam.position.z = this.position.z;
      }
    }

    // Check lifetime
    if (time - this.spawnTime > this.lifetime) {
      this.active = false;
    }
  }

  destroy(scene: THREE.Scene) {
    this.active = false;
    scene.remove(this.mesh);
    // Phase 1: release the pickup's unique buffers (core/halo/rings). Shared
    // cached geometries/materials are skipped by disposeObject3D.
    disposeObject3D(this.mesh);
    if (this.groundRing) {
      const beam = this.groundRing.userData.beam as THREE.Mesh | undefined;
      if (beam) {
        scene.remove(beam);
        beam.geometry.dispose();
        (beam.material as THREE.Material).dispose();
      }
      scene.remove(this.groundRing);
      this.groundRing.geometry.dispose();
      (this.groundRing.material as THREE.Material).dispose();
      this.groundRing = null;
    }
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
        const hitRadius = o.radius + 4.5;
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
  /** Countdown for the collapse-out animation after destruction. */
  deathTimer: number = 0;
  /** Light military prop ring around ground objectives (city group child). */
  propGroup: THREE.Object3D | null = null;

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
    this.beacon.visible = true; // tall light pillar so objectives read from the air
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
    this.labelSprite.visible = true;
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

  update(time: number, delta: number = 1 / 60) {
    if (!this.active) {
      // Collapse-out: shrink + fade over ~0.35s, THEN the depot is gone
      if (this.deathTimer > 0) {
        this.deathTimer -= delta;
        const k = Math.max(0, this.deathTimer / 0.35);
        this.mesh.scale.setScalar(Math.max(0.01, k));
        this.mesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
            child.material.opacity = Math.max(0, k * 0.7);
          }
        });
        if (this.deathTimer <= 0) {
          this.deathTimer = 0;
          this.destroy();
        }
      }
      return;
    }
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
      // Defer removal: play the collapse-out animation in update() before the
      // depot truly disappears.
      this.active = false;
      this.deathTimer = 0.35;
      return true;
    }
    return false;
  }

  destroy() {
    if (!this.mesh.parent) return; // idempotent: already destroyed (cull/reset can double-call)
    this.active = false;
    this.mesh.parent.remove(this.mesh);
    // Phase 1: release the objective's unique buffers (marker ring, beacon
    // beam, label sprite). Shared cached resources are skipped.
    disposeObject3D(this.mesh);
    // Detach the objective's prop ring (Pass 5) — shared materials/geometries
    // stay cached, so removal is just a scene-graph detach.
    if (this.propGroup?.parent) this.propGroup.parent.remove(this.propGroup);
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
