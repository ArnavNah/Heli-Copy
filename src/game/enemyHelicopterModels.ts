import * as THREE from "three";
import {
  createBox,
  createGlowBox,
  getBoxGeometry,
  getCylinderGeometry,
  getLowPolyMaterial,
  getPrismGeometry,
} from "./materials";

// ============================================================================
// HELI-STRIKE ENEMY HELICOPTER MODEL SYSTEM
// Procedural Low-Poly Attack Helicopters & Gunships
// ============================================================================

export type EnemyHelicopterFamily = "light" | "medium" | "boss";

export interface EnemyHelicopterModelOptions {
  family: EnemyHelicopterFamily;
  variant?: number; // 0..3 cosmetic variation
  scale?: number;
  isElite?: boolean;
  coreColor?: number;
  accentColor?: number;
}

export interface EnemyDamagePoints {
  engineLeft: THREE.Object3D;
  engineRight: THREE.Object3D;
  hull: THREE.Object3D;
  tail?: THREE.Object3D;
}

export interface EnemyHelicopterModelResult {
  root: THREE.Group;
  visualRoot: THREE.Group; // Banks & pitches with flight velocity
  mainRotorPivot: THREE.Group;
  tailRotorPivot: THREE.Group;
  gunYawPivot: THREE.Group;
  gunPitchPivot: THREE.Group;
  muzzlePoint: THREE.Object3D;
  missilePoints: THREE.Object3D[];
  rocketPoints: THREE.Object3D[];
  targetPoint: THREE.Object3D;
  damagePoints: EnemyDamagePoints;
  coreGlowMesh?: THREE.Mesh;
  rotorBlurDisc?: THREE.Mesh;
  submeshes: THREE.Mesh[];
}

// ----------------------------------------------------------------------------
// SHARED GEOMETRY CACHE
// ----------------------------------------------------------------------------
const rotorBladeGeomCache = new Map<string, THREE.BufferGeometry>();
const tailBladeGeomCache = new Map<string, THREE.BufferGeometry>();
const rocketPodGeomCache = new Map<string, THREE.BufferGeometry>();
const missileGeomCache = new Map<string, THREE.BufferGeometry>();
const skidGeomCache = new Map<string, THREE.BufferGeometry>();

/** Creates a shared tapered low-poly rotor blade geometry. */
function getRotorBladeGeometry(length: number, baseWidth: number, tipWidth: number, thickness: number): THREE.BufferGeometry {
  const key = `${length.toFixed(2)}_${baseWidth.toFixed(2)}_${tipWidth.toFixed(2)}_${thickness.toFixed(2)}`;
  let geo = rotorBladeGeomCache.get(key);
  if (!geo) {
    const hwBase = baseWidth * 0.5;
    const hwTip = tipWidth * 0.5;
    const ht = thickness * 0.5;
    const pos = new Float32Array([
      // Top face
      -hwBase, ht, 0,
       hwBase, ht, 0,
       hwTip, ht, length,

      -hwBase, ht, 0,
       hwTip, ht, length,
      -hwTip, ht, length,

      // Bottom face
       hwBase, -ht, 0,
      -hwBase, -ht, 0,
      -hwTip, -ht, length,

       hwBase, -ht, 0,
      -hwTip, -ht, length,
       hwTip, -ht, length,

      // Leading edge (right)
       hwBase, ht, 0,
       hwBase, -ht, 0,
       hwTip, -ht, length,

       hwBase, ht, 0,
       hwTip, -ht, length,
       hwTip, ht, length,

      // Trailing edge (left)
      -hwBase, -ht, 0,
      -hwBase, ht, 0,
      -hwTip, ht, length,

      -hwBase, -ht, 0,
      -hwTip, ht, length,
      -hwTip, -ht, length,

      // Tip face
      -hwTip, -ht, length,
       hwTip, -ht, length,
       hwTip, ht, length,

      -hwTip, -ht, length,
       hwTip, ht, length,
      -hwTip, ht, length,

      // Base face
       hwBase, -ht, 0,
       hwBase, ht, 0,
      -hwBase, ht, 0,

       hwBase, -ht, 0,
      -hwBase, ht, 0,
      -hwBase, -ht, 0,
    ]);

    geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo.userData.shared = true;
    rotorBladeGeomCache.set(key, geo);
  }
  return geo;
}

/** Creates a shared tail rotor blade geometry. */
function getTailBladeGeometry(length: number, width: number, thickness: number): THREE.BufferGeometry {
  const key = `${length.toFixed(2)}_${width.toFixed(2)}_${thickness.toFixed(2)}`;
  let geo = tailBladeGeomCache.get(key);
  if (!geo) {
    const hw = width * 0.5;
    const ht = thickness * 0.5;
    const pos = new Float32Array([
      // Face +Z
      -hw, 0, ht,   hw, 0, ht,   hw, length, ht,
      -hw, 0, ht,   hw, length, ht,  -hw, length, ht,
      // Face -Z
       hw, 0, -ht,  -hw, 0, -ht,  -hw, length, -ht,
       hw, 0, -ht,  -hw, length, -ht,   hw, length, -ht,
      // Face +X
       hw, 0, ht,   hw, 0, -ht,   hw, length, -ht,
       hw, 0, ht,   hw, length, -ht,   hw, length, ht,
      // Face -X
      -hw, 0, -ht,  -hw, 0, ht,  -hw, length, ht,
      -hw, 0, -ht,  -hw, length, ht,  -hw, length, -ht,
      // Face +Y
      -hw, length, ht,   hw, length, ht,   hw, length, -ht,
      -hw, length, ht,   hw, length, -ht,  -hw, length, -ht,
    ]);
    geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo.userData.shared = true;
    tailBladeGeomCache.set(key, geo);
  }
  return geo;
}

/** Creates a shared rocket pod geometry with dark recessed launch tubes. */
function getRocketPodGeometry(radius: number, length: number): THREE.BufferGeometry {
  const key = `${radius.toFixed(2)}_${length.toFixed(2)}`;
  let geo = rocketPodGeomCache.get(key);
  if (!geo) {
    geo = new THREE.CylinderGeometry(radius, radius * 0.9, length, 8, 1).toNonIndexed();
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    geo.userData.shared = true;
    rocketPodGeomCache.set(key, geo);
  }
  return geo;
}

/** Creates a shared missile geometry. */
function getMissileGeometry(length: number, radius: number): THREE.BufferGeometry {
  const key = `${length.toFixed(2)}_${radius.toFixed(2)}`;
  let geo = missileGeomCache.get(key);
  if (!geo) {
    geo = new THREE.CylinderGeometry(radius * 0.3, radius, length, 6, 1).toNonIndexed();
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    geo.userData.shared = true;
    missileGeomCache.set(key, geo);
  }
  return geo;
}

// ----------------------------------------------------------------------------
// SHARED MATERIALS CACHE
// ----------------------------------------------------------------------------
const SHARED_MATERIALS = {
  // Light helicopter body variations
  lightBodyOlive: getLowPolyMaterial(0x3d4f36),
  lightBodyCharcoal: getLowPolyMaterial(0x283038),
  lightBodyTan: getLowPolyMaterial(0x544738),
  lightBodyCamo: getLowPolyMaterial(0x35402f),

  // Medium gunship body variations
  mediumBodyGunmetal: getLowPolyMaterial(0x3b434d),
  mediumBodyDrab: getLowPolyMaterial(0x424c3a),
  mediumBodySlate: getLowPolyMaterial(0x2d3640),
  mediumBodyRust: getLowPolyMaterial(0x4d3b32),

  // Heavy boss gunship body
  bossBodyArchon: getLowPolyMaterial(0x282033),
  bossBodySecondary: getLowPolyMaterial(0x383046),
  bossArmorPlates: getLowPolyMaterial(0x191420),

  // Universal military materials
  darkChassis: getLowPolyMaterial(0x15181c),
  cockpitGlass: getLowPolyMaterial(0x13222e),
  cockpitArmored: getLowPolyMaterial(0x0e1720),
  bladeComposite: getLowPolyMaterial(0x111315),
  weaponMetal: getLowPolyMaterial(0x22262a),
  skidMetal: getLowPolyMaterial(0x2d3338),
  mechanicalMetal: getLowPolyMaterial(0x4a525a),

  // Hostile accents and lights
  accentCrimson: getLowPolyMaterial(0xd93326),
  accentOrange: getLowPolyMaterial(0xe85a22),
  accentAmber: getLowPolyMaterial(0xf5ba2c),
  accentPurple: getLowPolyMaterial(0x9d3ae8),

  // Emissive glow materials
  glowSensorRed: new THREE.MeshBasicMaterial({ color: 0xff2838, transparent: true, opacity: 0.95 }),
  glowSensorGreen: new THREE.MeshBasicMaterial({ color: 0x33ff66, transparent: true, opacity: 0.95 }),
  glowExhaustFire: new THREE.MeshBasicMaterial({ color: 0xff5522, transparent: true, opacity: 0.9 }),
  glowCoreBoss: new THREE.MeshBasicMaterial({ color: 0xff2266, transparent: true, opacity: 0.98 }),
  glowIntakeWarm: new THREE.MeshBasicMaterial({ color: 0xff8833, transparent: true, opacity: 0.85 }),

  // Translucent rotor blur disc (additive)
  rotorBlurDisc: new THREE.MeshBasicMaterial({
    color: 0x9be8ff,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }),
};

// ============================================================================
// HELICOPTER BUILDERS
// ============================================================================

/**
 * 1. LIGHT ATTACK HELICOPTER (Fast, agile, scout/harasser)
 * Visual model for light aerial combat enemies (formerly Drone / Scout).
 */
export function buildLightAttackHelicopter(options: EnemyHelicopterModelOptions): EnemyHelicopterModelResult {
  const variant = (options.variant ?? 0) % 4;
  const isElite = Boolean(options.isElite);
  const submeshes: THREE.Mesh[] = [];

  const root = new THREE.Group();
  root.name = "CombatDroneRoot";

  const visualRoot = new THREE.Group();
  visualRoot.name = "HelicopterVisual";
  root.add(visualRoot);

  // Material selection based on variant
  const bodyMat =
    variant === 1
      ? SHARED_MATERIALS.lightBodyCharcoal
      : variant === 2
        ? SHARED_MATERIALS.lightBodyTan
        : variant === 3
          ? SHARED_MATERIALS.lightBodyCamo
          : SHARED_MATERIALS.lightBodyOlive;

  const accentMat = isElite ? SHARED_MATERIALS.accentAmber : SHARED_MATERIALS.accentCrimson;

  // 1. Fuselage Base (Narrow, aerodynamic, elongated)
  const fuselageGeo = getBoxGeometry(1.2, 0.95, 3.4);
  const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
  fuselage.name = "CentralBody";
  fuselage.position.set(0, 0, 0);
  visualRoot.add(fuselage);
  submeshes.push(fuselage);

  // 2. Chiseled Aerodynamic Nose & Sensor Dome
  const nosePrismGeo = getPrismGeometry(1.0, 0.7, 1.4);
  const nose = new THREE.Mesh(nosePrismGeo, bodyMat);
  nose.name = "Nose";
  nose.position.set(0, -0.35, 1.7);
  visualRoot.add(nose);
  submeshes.push(nose);

  const sensorGeo = getBoxGeometry(0.32, 0.32, 0.32);
  const sensor = new THREE.Mesh(sensorGeo, SHARED_MATERIALS.glowSensorRed);
  sensor.name = "NavigationLight";
  sensor.position.set(0, -0.28, 2.35);
  visualRoot.add(sensor);
  submeshes.push(sensor);

  // 3. Cockpit Canopy (Faceted in front third)
  const cockpitGeo =
    variant === 1
      ? getBoxGeometry(0.7, 0.65, 1.6) // Stealth faceted
      : getBoxGeometry(0.75, 0.6, 1.5);
  const cockpit = new THREE.Mesh(cockpitGeo, SHARED_MATERIALS.cockpitGlass);
  cockpit.name = "Cockpit";
  cockpit.position.set(0, 0.5, 0.8);
  visualRoot.add(cockpit);
  submeshes.push(cockpit);

  // Canopy Frame Trim
  const canopyFrame = new THREE.Mesh(getBoxGeometry(0.8, 0.12, 1.55), bodyMat);
  canopyFrame.position.set(0, 0.78, 0.8);
  visualRoot.add(canopyFrame);
  submeshes.push(canopyFrame);

  // 4. Twin Compact Engine Housings
  const engineGeo = getBoxGeometry(0.42, 0.42, 1.5);
  const engine01 = new THREE.Mesh(engineGeo, SHARED_MATERIALS.darkChassis);
  engine01.name = "Engine01";
  engine01.position.set(-0.55, 0.35, -0.35);
  visualRoot.add(engine01);
  submeshes.push(engine01);

  const engine02 = new THREE.Mesh(engineGeo, SHARED_MATERIALS.darkChassis);
  engine02.name = "Engine02";
  engine02.position.set(0.55, 0.35, -0.35);
  visualRoot.add(engine02);
  submeshes.push(engine02);

  [-0.55, 0.55].forEach((side) => {
    // Glowing exhaust ports at rear of nacelles
    const exhaust = new THREE.Mesh(getBoxGeometry(0.28, 0.28, 0.12), SHARED_MATERIALS.glowExhaustFire);
    exhaust.position.set(side, 0.35, -1.12);
    visualRoot.add(exhaust);
    submeshes.push(exhaust);
  });

  // 5. Long Slender Tail Boom (communicates helicopter silhouette)
  const boomGeo = getBoxGeometry(0.34, 0.36, 4.4);
  const boom = new THREE.Mesh(boomGeo, bodyMat);
  boom.name = "TailBoom";
  boom.position.set(0, 0.2, -3.7);
  visualRoot.add(boom);
  submeshes.push(boom);

  // Tail Vertical Stabilizer Fin
  const finGeo = getBoxGeometry(0.12, 1.3, 0.85);
  const fin = new THREE.Mesh(finGeo, accentMat);
  fin.name = "TailFin";
  fin.position.set(0, 0.75, -5.6);
  if (variant === 1) fin.rotation.x = -0.25; // Canted stealth fin
  visualRoot.add(fin);
  submeshes.push(fin);

  // Horizontal Tail Stabilizers
  const hStabGeo = getBoxGeometry(1.6, 0.08, 0.5);
  const hStab = new THREE.Mesh(hStabGeo, bodyMat);
  hStab.name = "HorizontalStabilizer";
  hStab.position.set(0, 0.3, -5.2);
  visualRoot.add(hStab);
  submeshes.push(hStab);

  // 6. Main Rotor Assembly
  const mastGeo = getCylinderGeometry(0.12, 0.8, 6);
  const mast = new THREE.Mesh(mastGeo, SHARED_MATERIALS.mechanicalMetal);
  mast.position.set(0, 0.85, 0.1);
  visualRoot.add(mast);
  submeshes.push(mast);

  const mainRotorPivot = new THREE.Group();
  mainRotorPivot.name = "MainRotorPivot";
  mainRotorPivot.position.set(0, 1.25, 0.1);
  visualRoot.add(mainRotorPivot);

  // Central Rotor Hub
  const hub = new THREE.Mesh(getCylinderGeometry(0.35, 0.18, 8), SHARED_MATERIALS.mechanicalMetal);
  mainRotorPivot.add(hub);
  submeshes.push(hub);

  // Rotor Blades (2 to 4 blades depending on variant)
  const bladeCount = variant === 1 ? 2 : variant === 2 ? 3 : 4;
  const bladeGeo = getRotorBladeGeometry(5.2, 0.28, 0.18, 0.04);

  for (let i = 0; i < bladeCount; i++) {
    const bladeArm = new THREE.Group();
    bladeArm.rotation.y = (i * Math.PI * 2) / bladeCount;

    const blade = new THREE.Mesh(bladeGeo, SHARED_MATERIALS.bladeComposite);
    blade.position.set(0, 0, 0.35); // Base starts outside hub
    bladeArm.add(blade);
    submeshes.push(blade);

    // Tip accent stripe
    const tipAccent = new THREE.Mesh(getBoxGeometry(0.2, 0.05, 0.4), accentMat);
    tipAccent.position.set(0, 0, 5.0);
    bladeArm.add(tipAccent);
    submeshes.push(tipAccent);

    mainRotorPivot.add(bladeArm);
  }

  // Rotor Blur Disc (translucent visual cue at high RPM)
  const blurDiscGeo = new THREE.RingGeometry(1.2, 5.6, 32);
  blurDiscGeo.rotateX(-Math.PI / 2);
  const rotorBlurDisc = new THREE.Mesh(blurDiscGeo, SHARED_MATERIALS.rotorBlurDisc);
  rotorBlurDisc.name = "RotorBlurDisc";
  rotorBlurDisc.position.set(0, 0.02, 0);
  mainRotorPivot.add(rotorBlurDisc);

  // 7. Spinning Tail Rotor
  const tailRotorPivot = new THREE.Group();
  tailRotorPivot.name = "TailRotorPivot";
  tailRotorPivot.position.set(0.18, 0.95, -5.7);
  visualRoot.add(tailRotorPivot);

  const tailHub = new THREE.Mesh(getBoxGeometry(0.16, 0.2, 0.2), SHARED_MATERIALS.mechanicalMetal);
  tailRotorPivot.add(tailHub);
  submeshes.push(tailHub);

  const tailBladeGeo = getTailBladeGeometry(1.1, 0.14, 0.03);
  for (let i = 0; i < 2; i++) {
    const tBladeArm = new THREE.Group();
    tBladeArm.rotation.x = (i * Math.PI) / 2;

    const tBlade = new THREE.Mesh(tailBladeGeo, SHARED_MATERIALS.bladeComposite);
    tBlade.position.set(0, 0.1, 0);
    tBladeArm.add(tBlade);
    submeshes.push(tBlade);

    const tBladeOpp = new THREE.Mesh(tailBladeGeo, SHARED_MATERIALS.bladeComposite);
    tBladeOpp.position.set(0, -0.1, 0);
    tBladeOpp.rotation.z = Math.PI;
    tBladeArm.add(tBladeOpp);
    submeshes.push(tBladeOpp);

    tailRotorPivot.add(tBladeArm);
  }

  // 8. Short Swept Weapon Wings & Hardpoints
  const wingGeo = getBoxGeometry(3.6, 0.12, 0.75);
  const weaponWings = new THREE.Mesh(wingGeo, bodyMat);
  weaponWings.name = "WeaponWings";
  weaponWings.position.set(0, -0.05, 0.15);
  if (variant === 1) weaponWings.rotation.y = -0.15; // Forward swept variant
  visualRoot.add(weaponWings);
  submeshes.push(weaponWings);

  const leftWing = new THREE.Object3D();
  leftWing.name = "LeftWing";
  leftWing.position.set(-1.4, -0.05, 0.15);
  visualRoot.add(leftWing);

  const rightWing = new THREE.Object3D();
  rightWing.name = "RightWing";
  rightWing.position.set(1.4, -0.05, 0.15);
  visualRoot.add(rightWing);

  const rocketPoints: THREE.Object3D[] = [];
  const missilePoints: THREE.Object3D[] = [];

  const podGeo = getRocketPodGeometry(0.24, 1.0);
  [-1.4, 1.4].forEach((side) => {
    const pylon = new THREE.Mesh(getBoxGeometry(0.08, 0.22, 0.4), SHARED_MATERIALS.darkChassis);
    pylon.position.set(side, -0.15, 0.15);
    visualRoot.add(pylon);
    submeshes.push(pylon);

    const rocketPod = new THREE.Mesh(podGeo, SHARED_MATERIALS.weaponMetal);
    rocketPod.position.set(side, -0.32, 0.2);
    visualRoot.add(rocketPod);
    submeshes.push(rocketPod);

    // Front tube face plate
    const tubePlate = new THREE.Mesh(getBoxGeometry(0.38, 0.38, 0.05), SHARED_MATERIALS.darkChassis);
    tubePlate.position.set(side, -0.32, 0.72);
    visualRoot.add(tubePlate);
    submeshes.push(tubePlate);

    const rocketPoint = new THREE.Object3D();
    rocketPoint.position.set(side, -0.32, 0.8);
    visualRoot.add(rocketPoint);
    rocketPoints.push(rocketPoint);
  });

  // 9. Independent Chin/Nose Gun Turret
  const gunYawPivot = new THREE.Group();
  gunYawPivot.name = "GunMount";
  gunYawPivot.position.set(0, -0.55, 1.35);
  visualRoot.add(gunYawPivot);

  const gunBase = new THREE.Mesh(getBoxGeometry(0.4, 0.25, 0.4), SHARED_MATERIALS.darkChassis);
  gunYawPivot.add(gunBase);
  submeshes.push(gunBase);

  const gunPitchPivot = new THREE.Group();
  gunPitchPivot.name = "GunPitchPivot";
  gunPitchPivot.position.set(0, -0.1, 0.1);
  gunYawPivot.add(gunPitchPivot);

  const gunBarrelGeo = getCylinderGeometry(0.06, 1.1, 6);
  const gunBarrel = new THREE.Mesh(gunBarrelGeo, SHARED_MATERIALS.weaponMetal);
  gunBarrel.rotation.x = Math.PI / 2;
  gunBarrel.position.set(0, 0, 0.55);
  gunPitchPivot.add(gunBarrel);
  submeshes.push(gunBarrel);

  const muzzleBrake = new THREE.Mesh(getBoxGeometry(0.18, 0.18, 0.25), SHARED_MATERIALS.darkChassis);
  muzzleBrake.position.set(0, 0, 1.1);
  gunPitchPivot.add(muzzleBrake);
  submeshes.push(muzzleBrake);

  const muzzleGlow = new THREE.Mesh(getBoxGeometry(0.14, 0.14, 0.14), SHARED_MATERIALS.glowSensorRed);
  muzzleGlow.position.set(0, 0, 1.18);
  gunPitchPivot.add(muzzleGlow);
  submeshes.push(muzzleGlow);

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.name = "MuzzlePoint";
  muzzlePoint.position.set(0, 0, 1.25);
  gunPitchPivot.add(muzzlePoint);

  // 10. Landing Skids
  [-0.65, 0.65].forEach((side) => {
    // Skid tube
    const skidGeo = getBoxGeometry(0.08, 0.08, 3.2);
    const skid = new THREE.Mesh(skidGeo, SHARED_MATERIALS.skidMetal);
    skid.position.set(side, -0.85, 0.1);
    visualRoot.add(skid);
    submeshes.push(skid);

    // Front curved tip
    const tip = new THREE.Mesh(getBoxGeometry(0.08, 0.24, 0.4), SHARED_MATERIALS.skidMetal);
    tip.position.set(side, -0.75, 1.7);
    tip.rotation.x = -0.4;
    visualRoot.add(tip);
    submeshes.push(tip);

    // Struts connecting fuselage to skid
    [-0.8, 0.9].forEach((zPos) => {
      const strut = new THREE.Mesh(getBoxGeometry(0.06, 0.55, 0.08), SHARED_MATERIALS.skidMetal);
      strut.position.set(side * 0.7, -0.6, zPos);
      strut.rotation.z = side * 0.25;
      visualRoot.add(strut);
      submeshes.push(strut);
    });
  });

  // 11. Target & Damage Attachment Points
  const targetPoint = new THREE.Object3D();
  targetPoint.name = "TargetPoint";
  targetPoint.position.set(0, 0, 0);
  visualRoot.add(targetPoint);

  const engineLeft = new THREE.Object3D();
  engineLeft.name = "EngineDamagePointLeft";
  engineLeft.position.set(-0.55, 0.35, -0.6);
  visualRoot.add(engineLeft);

  const engineRight = new THREE.Object3D();
  engineRight.name = "EngineDamagePointRight";
  engineRight.position.set(0.55, 0.35, -0.6);
  visualRoot.add(engineRight);

  const hull = new THREE.Object3D();
  hull.name = "HullDamagePoint";
  hull.position.set(0, 0.1, 0);
  visualRoot.add(hull);

  const tail = new THREE.Object3D();
  tail.name = "TailDamagePoint";
  tail.position.set(0, 0.4, -4.5);
  visualRoot.add(tail);

  return {
    root,
    visualRoot,
    mainRotorPivot,
    tailRotorPivot,
    gunYawPivot,
    gunPitchPivot,
    muzzlePoint,
    missilePoints,
    rocketPoints,
    targetPoint,
    damagePoints: { engineLeft, engineRight, hull, tail },
    rotorBlurDisc,
    submeshes,
  };
}

/**
 * 2. MEDIUM ATTACK GUNSHIP (Wider, armored, heavy weapons)
 * Visual model for medium aerial combat enemies (formerly Shooter).
 */
export function buildMediumAttackGunship(options: EnemyHelicopterModelOptions): EnemyHelicopterModelResult {
  const variant = (options.variant ?? 0) % 4;
  const isElite = Boolean(options.isElite);
  const submeshes: THREE.Mesh[] = [];

  const root = new THREE.Group();
  root.name = "MediumGunshipRoot";

  const visualRoot = new THREE.Group();
  visualRoot.name = "HelicopterVisual";
  root.add(visualRoot);

  const bodyMat =
    variant === 1
      ? SHARED_MATERIALS.mediumBodySlate
      : variant === 2
        ? SHARED_MATERIALS.mediumBodyDrab
        : variant === 3
          ? SHARED_MATERIALS.mediumBodyRust
          : SHARED_MATERIALS.mediumBodyGunmetal;

  const accentMat = isElite ? SHARED_MATERIALS.accentAmber : SHARED_MATERIALS.accentOrange;

  // 1. Armored Fuselage (Wider, muscular, multi-section)
  const fuselageGeo = getBoxGeometry(1.8, 1.25, 4.4);
  const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
  fuselage.name = "ArmoredFuselage";
  fuselage.position.set(0, 0, 0);
  visualRoot.add(fuselage);
  submeshes.push(fuselage);

  // Lower Armored Belly Plate
  const belly = new THREE.Mesh(getBoxGeometry(1.6, 0.4, 3.8), SHARED_MATERIALS.darkChassis);
  belly.position.set(0, -0.65, 0.1);
  visualRoot.add(belly);
  submeshes.push(belly);

  // 2. Reinforced Nose Section
  const nosePrismGeo = getPrismGeometry(1.5, 0.9, 1.8);
  const nose = new THREE.Mesh(nosePrismGeo, bodyMat);
  nose.name = "ReinforcedNose";
  nose.position.set(0, -0.45, 2.2);
  visualRoot.add(nose);
  submeshes.push(nose);

  const noseArmor = new THREE.Mesh(getBoxGeometry(1.1, 0.4, 0.8), accentMat);
  noseArmor.position.set(0, -0.15, 2.8);
  visualRoot.add(noseArmor);
  submeshes.push(noseArmor);

  // Optical Targeting Radome
  const radome = new THREE.Mesh(getCylinderGeometry(0.25, 0.35, 8), SHARED_MATERIALS.glowSensorRed);
  radome.rotation.x = Math.PI / 2;
  radome.position.set(0, -0.4, 3.1);
  visualRoot.add(radome);
  submeshes.push(radome);

  // 3. Heavy Tandem Armored Cockpit
  const cockpitGeo = getBoxGeometry(1.0, 0.8, 2.2);
  const cockpit = new THREE.Mesh(cockpitGeo, SHARED_MATERIALS.cockpitArmored);
  cockpit.name = "ArmoredCockpit";
  cockpit.position.set(0, 0.7, 1.0);
  visualRoot.add(cockpit);
  submeshes.push(cockpit);

  // Armored Canopy Mullion Bars
  const mullion = new THREE.Mesh(getBoxGeometry(1.08, 0.18, 2.25), SHARED_MATERIALS.darkChassis);
  mullion.position.set(0, 1.05, 1.0);
  visualRoot.add(mullion);
  submeshes.push(mullion);

  // 4. Chunky Turboshaft Engine Pods + Intakes
  const engineGeo = getBoxGeometry(0.65, 0.65, 2.4);
  [-0.95, 0.95].forEach((side) => {
    const engine = new THREE.Mesh(engineGeo, bodyMat);
    engine.position.set(side, 0.45, -0.4);
    visualRoot.add(engine);
    submeshes.push(engine);

    // Warm turbine intake at front
    const intake = new THREE.Mesh(getBoxGeometry(0.55, 0.55, 0.16), SHARED_MATERIALS.glowIntakeWarm);
    intake.position.set(side, 0.45, 0.82);
    visualRoot.add(intake);
    submeshes.push(intake);

    // Heavy exhaust shroud at rear
    const exhaust = new THREE.Mesh(getCylinderGeometry(0.24, 0.4, 6), SHARED_MATERIALS.darkChassis);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(side, 0.45, -1.65);
    visualRoot.add(exhaust);
    submeshes.push(exhaust);
  });

  // 5. Strong Armored Tail Boom & Fins
  const boomGeo = getBoxGeometry(0.55, 0.55, 5.6);
  const boom = new THREE.Mesh(boomGeo, bodyMat);
  boom.name = "ArmoredTailBoom";
  boom.position.set(0, 0.25, -4.8);
  visualRoot.add(boom);
  submeshes.push(boom);

  // Vertical Fin & Dorsal Fairing
  const finGeo = getBoxGeometry(0.16, 1.8, 1.2);
  const fin = new THREE.Mesh(finGeo, accentMat);
  fin.name = "VerticalTailFin";
  fin.position.set(0, 1.05, -7.3);
  visualRoot.add(fin);
  submeshes.push(fin);

  const hStabGeo = getBoxGeometry(2.4, 0.12, 0.7);
  const hStab = new THREE.Mesh(hStabGeo, bodyMat);
  hStab.position.set(0, 0.45, -6.8);
  visualRoot.add(hStab);
  submeshes.push(hStab);

  // 6. Heavy 4-Blade Main Rotor Assembly
  const mastGeo = getCylinderGeometry(0.18, 0.95, 8);
  const mast = new THREE.Mesh(mastGeo, SHARED_MATERIALS.mechanicalMetal);
  mast.position.set(0, 1.05, 0.0);
  visualRoot.add(mast);
  submeshes.push(mast);

  const mainRotorPivot = new THREE.Group();
  mainRotorPivot.name = "MainRotorPivot";
  mainRotorPivot.position.set(0, 1.55, 0.0);
  visualRoot.add(mainRotorPivot);

  const hub = new THREE.Mesh(getCylinderGeometry(0.55, 0.25, 8), SHARED_MATERIALS.mechanicalMetal);
  mainRotorPivot.add(hub);
  submeshes.push(hub);

  const bladeCount = 4;
  const bladeGeo = getRotorBladeGeometry(7.2, 0.38, 0.25, 0.06);
  for (let i = 0; i < bladeCount; i++) {
    const bladeArm = new THREE.Group();
    bladeArm.rotation.y = (i * Math.PI * 2) / bladeCount;

    const blade = new THREE.Mesh(bladeGeo, SHARED_MATERIALS.bladeComposite);
    blade.position.set(0, 0, 0.55);
    bladeArm.add(blade);
    submeshes.push(blade);

    const tipAccent = new THREE.Mesh(getBoxGeometry(0.3, 0.07, 0.5), accentMat);
    tipAccent.position.set(0, 0, 7.0);
    bladeArm.add(tipAccent);
    submeshes.push(tipAccent);

    mainRotorPivot.add(bladeArm);
  }

  const blurDiscGeo = new THREE.RingGeometry(1.6, 7.6, 40);
  blurDiscGeo.rotateX(-Math.PI / 2);
  const rotorBlurDisc = new THREE.Mesh(blurDiscGeo, SHARED_MATERIALS.rotorBlurDisc);
  rotorBlurDisc.name = "RotorBlurDisc";
  rotorBlurDisc.position.set(0, 0.03, 0);
  mainRotorPivot.add(rotorBlurDisc);

  // 7. Spinning Heavy Tail Rotor
  const tailRotorPivot = new THREE.Group();
  tailRotorPivot.name = "TailRotorPivot";
  tailRotorPivot.position.set(0.24, 1.35, -7.4);
  visualRoot.add(tailRotorPivot);

  const tailHub = new THREE.Mesh(getBoxGeometry(0.22, 0.28, 0.28), SHARED_MATERIALS.mechanicalMetal);
  tailRotorPivot.add(tailHub);
  submeshes.push(tailHub);

  const tailBladeGeo = getTailBladeGeometry(1.4, 0.18, 0.04);
  for (let i = 0; i < 4; i++) {
    const tBladeArm = new THREE.Group();
    tBladeArm.rotation.x = (i * Math.PI) / 2;

    const tBlade = new THREE.Mesh(tailBladeGeo, SHARED_MATERIALS.bladeComposite);
    tBlade.position.set(0, 0.12, 0);
    tBladeArm.add(tBlade);
    submeshes.push(tBlade);

    tailRotorPivot.add(tBladeArm);
  }

  // 8. Broad Heavy Weapon Wings with Dual Hardpoints
  const wingGeo = getBoxGeometry(5.4, 0.18, 1.1);
  const weaponWings = new THREE.Mesh(wingGeo, bodyMat);
  weaponWings.name = "HeavyWeaponWings";
  weaponWings.position.set(0, -0.05, 0.2);
  visualRoot.add(weaponWings);
  submeshes.push(weaponWings);

  const rocketPoints: THREE.Object3D[] = [];
  const missilePoints: THREE.Object3D[] = [];

  // Inboard Rocket Pods (7-tube)
  const podGeo = getRocketPodGeometry(0.35, 1.4);
  [-1.6, 1.6].forEach((side) => {
    const pylon = new THREE.Mesh(getBoxGeometry(0.12, 0.3, 0.6), SHARED_MATERIALS.darkChassis);
    pylon.position.set(side, -0.22, 0.2);
    visualRoot.add(pylon);
    submeshes.push(pylon);

    const rocketPod = new THREE.Mesh(podGeo, SHARED_MATERIALS.weaponMetal);
    rocketPod.position.set(side, -0.45, 0.25);
    visualRoot.add(rocketPod);
    submeshes.push(rocketPod);

    const rocketPoint = new THREE.Object3D();
    rocketPoint.position.set(side, -0.45, 1.0);
    visualRoot.add(rocketPoint);
    rocketPoints.push(rocketPoint);
  });

  // Outboard Missile Racks with Mounted Missiles
  const missileGeo = getMissileGeometry(1.2, 0.12);
  [-2.4, 2.4].forEach((side) => {
    const rack = new THREE.Mesh(getBoxGeometry(0.45, 0.1, 0.8), SHARED_MATERIALS.darkChassis);
    rack.position.set(side, -0.2, 0.2);
    visualRoot.add(rack);
    submeshes.push(rack);

    const missile = new THREE.Mesh(missileGeo, SHARED_MATERIALS.darkChassis);
    missile.position.set(side, -0.32, 0.3);
    visualRoot.add(missile);
    submeshes.push(missile);

    const missilePoint = new THREE.Object3D();
    missilePoint.position.set(side, -0.32, 0.95);
    visualRoot.add(missilePoint);
    missilePoints.push(missilePoint);
  });

  // 9. Independent Heavy Nose Autocannon Turret
  const gunYawPivot = new THREE.Group();
  gunYawPivot.name = "GunYawPivot";
  gunYawPivot.position.set(0, -0.75, 1.9);
  visualRoot.add(gunYawPivot);

  const turretHousing = new THREE.Mesh(getBoxGeometry(0.6, 0.35, 0.6), SHARED_MATERIALS.darkChassis);
  gunYawPivot.add(turretHousing);
  submeshes.push(turretHousing);

  const gunPitchPivot = new THREE.Group();
  gunPitchPivot.name = "GunPitchPivot";
  gunPitchPivot.position.set(0, -0.15, 0.15);
  gunYawPivot.add(gunPitchPivot);

  const cannonBarrelGeo = getCylinderGeometry(0.1, 1.8, 8);
  const cannonBarrel = new THREE.Mesh(cannonBarrelGeo, SHARED_MATERIALS.weaponMetal);
  cannonBarrel.rotation.x = Math.PI / 2;
  cannonBarrel.position.set(0, 0, 0.9);
  gunPitchPivot.add(cannonBarrel);
  submeshes.push(cannonBarrel);

  const heavyMuzzle = new THREE.Mesh(getBoxGeometry(0.28, 0.24, 0.35), SHARED_MATERIALS.darkChassis);
  heavyMuzzle.position.set(0, 0, 1.75);
  gunPitchPivot.add(heavyMuzzle);
  submeshes.push(heavyMuzzle);

  const muzzleGlow = new THREE.Mesh(getBoxGeometry(0.2, 0.2, 0.2), SHARED_MATERIALS.glowSensorRed);
  muzzleGlow.position.set(0, 0, 1.85);
  gunPitchPivot.add(muzzleGlow);
  submeshes.push(muzzleGlow);

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.name = "MuzzlePoint";
  muzzlePoint.position.set(0, 0, 1.95);
  gunPitchPivot.add(muzzlePoint);

  // 10. Landing Gear / Reinforced Skids
  [-0.9, 0.9].forEach((side) => {
    const gearLeg = new THREE.Mesh(getBoxGeometry(0.12, 0.6, 0.14), SHARED_MATERIALS.skidMetal);
    gearLeg.position.set(side * 0.95, -0.85, 0.4);
    gearLeg.rotation.z = side * 0.2;
    visualRoot.add(gearLeg);
    submeshes.push(gearLeg);

    const wheel = new THREE.Mesh(getCylinderGeometry(0.22, 0.18, 8), SHARED_MATERIALS.darkChassis);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 1.05, -1.15, 0.4);
    visualRoot.add(wheel);
    submeshes.push(wheel);
  });
  const tailWheel = new THREE.Mesh(getCylinderGeometry(0.15, 0.12, 6), SHARED_MATERIALS.darkChassis);
  tailWheel.rotation.z = Math.PI / 2;
  tailWheel.position.set(0, -0.3, -4.5);
  visualRoot.add(tailWheel);
  submeshes.push(tailWheel);

  // 11. Target & Damage Attachment Points
  const targetPoint = new THREE.Object3D();
  targetPoint.name = "TargetPoint";
  targetPoint.position.set(0, 0, 0);
  visualRoot.add(targetPoint);

  const engineLeft = new THREE.Object3D();
  engineLeft.name = "EngineDamagePointLeft";
  engineLeft.position.set(-0.95, 0.45, -0.6);
  visualRoot.add(engineLeft);

  const engineRight = new THREE.Object3D();
  engineRight.name = "EngineDamagePointRight";
  engineRight.position.set(0.95, 0.45, -0.6);
  visualRoot.add(engineRight);

  const hull = new THREE.Object3D();
  hull.name = "HullDamagePoint";
  hull.position.set(0, 0.2, 0);
  visualRoot.add(hull);

  const tail = new THREE.Object3D();
  tail.name = "TailDamagePoint";
  tail.position.set(0, 0.6, -6.0);
  visualRoot.add(tail);

  return {
    root,
    visualRoot,
    mainRotorPivot,
    tailRotorPivot,
    gunYawPivot,
    gunPitchPivot,
    muzzlePoint,
    missilePoints,
    rocketPoints,
    targetPoint,
    damagePoints: { engineLeft, engineRight, hull, tail },
    rotorBlurDisc,
    submeshes,
  };
}

/**
 * 3. HEAVY GUNSHIP / BOSS ("ARCHON" Heavy Assault Gunship)
 * Unique multi-engine, multi-rotor, heavily armored boss gunship with phased damage support.
 */
export function buildBossHeavyGunship(options: EnemyHelicopterModelOptions): EnemyHelicopterModelResult {
  const submeshes: THREE.Mesh[] = [];

  const root = new THREE.Group();
  root.name = "BossRoot";

  const visualRoot = new THREE.Group();
  visualRoot.name = "HelicopterVisual";
  root.add(visualRoot);

  const bodyMat = SHARED_MATERIALS.bossBodyArchon;
  const secondaryMat = SHARED_MATERIALS.bossBodySecondary;
  const armorMat = SHARED_MATERIALS.bossArmorPlates;
  const accentMat = SHARED_MATERIALS.accentPurple;

  // 1. Massive Layered Fuselage
  const hullGeo = getBoxGeometry(3.6, 2.2, 7.8);
  const hull = new THREE.Mesh(hullGeo, bodyMat);
  hull.name = "HeavyFuselage";
  hull.position.set(0, 0, 0);
  visualRoot.add(hull);
  submeshes.push(hull);

  const topSpine = new THREE.Mesh(getBoxGeometry(2.4, 0.9, 6.2), secondaryMat);
  topSpine.position.set(0, 1.45, -0.3);
  visualRoot.add(topSpine);
  submeshes.push(topSpine);

  const heavyBelly = new THREE.Mesh(getBoxGeometry(3.0, 0.7, 6.0), armorMat);
  heavyBelly.position.set(0, -1.35, 0.2);
  visualRoot.add(heavyBelly);
  submeshes.push(heavyBelly);

  // 2. Reinforced Forward Nose & Command Cockpit
  const nosePrismGeo = getPrismGeometry(2.8, 1.5, 2.6);
  const nose = new THREE.Mesh(nosePrismGeo, bodyMat);
  nose.name = "ReinforcedNose";
  nose.position.set(0, -0.65, 3.9);
  visualRoot.add(nose);
  submeshes.push(nose);

  const commandCockpit = new THREE.Mesh(getBoxGeometry(1.8, 1.1, 2.4), SHARED_MATERIALS.cockpitArmored);
  commandCockpit.name = "Cockpit";
  commandCockpit.position.set(0, 1.05, 2.2);
  visualRoot.add(commandCockpit);
  submeshes.push(commandCockpit);

  const noseSensor = new THREE.Mesh(getBoxGeometry(0.8, 0.45, 0.8), SHARED_MATERIALS.glowSensorRed);
  noseSensor.position.set(0, 0.15, 4.8);
  visualRoot.add(noseSensor);
  submeshes.push(noseSensor);

  // 3. Central Reactor Core Housing (Glowing pulsing boss core)
  const coreHousing = new THREE.Mesh(getBoxGeometry(1.4, 1.4, 0.8), armorMat);
  coreHousing.position.set(0, 0.1, 1.8);
  visualRoot.add(coreHousing);
  submeshes.push(coreHousing);

  const coreGlowMesh = new THREE.Mesh(getBoxGeometry(1.1, 1.1, 0.7), SHARED_MATERIALS.glowCoreBoss);
  coreGlowMesh.name = "CoreGlow";
  coreGlowMesh.position.set(0, 0.1, 1.85);
  visualRoot.add(coreGlowMesh);
  submeshes.push(coreGlowMesh);

  // 4. Massive Twin Engine Nacelles
  const nacelleGeo = getBoxGeometry(1.25, 1.35, 4.8);
  const engine01 = new THREE.Mesh(nacelleGeo, secondaryMat);
  engine01.name = "Engine01";
  engine01.position.set(-2.3, 0.6, -0.6);
  visualRoot.add(engine01);
  submeshes.push(engine01);

  const engine02 = new THREE.Mesh(nacelleGeo, secondaryMat);
  engine02.name = "Engine02";
  engine02.position.set(2.3, 0.6, -0.6);
  visualRoot.add(engine02);
  submeshes.push(engine02);

  [-2.3, 2.3].forEach((side) => {
    // Glowing Turbine Intakes
    const intake = new THREE.Mesh(getBoxGeometry(1.1, 1.1, 0.3), SHARED_MATERIALS.glowIntakeWarm);
    intake.position.set(side, 0.6, 1.85);
    visualRoot.add(intake);
    submeshes.push(intake);

    // Heavy Quad Exhaust Ports
    const exhaust = new THREE.Mesh(getCylinderGeometry(0.42, 0.6, 8), armorMat);
    exhaust.rotation.x = Math.PI / 2;
    exhaust.position.set(side, 0.6, -3.05);
    visualRoot.add(exhaust);
    submeshes.push(exhaust);
  });

  // 5. Twin Heavy Tail Booms & Stabilizers
  [-1.4, 1.4].forEach((side) => {
    const boom = new THREE.Mesh(getBoxGeometry(0.65, 0.75, 6.8), bodyMat);
    boom.position.set(side, 0.45, -6.8);
    visualRoot.add(boom);
    submeshes.push(boom);

    // Twin Canted Vertical Fins
    const fin = new THREE.Mesh(getBoxGeometry(0.2, 2.6, 1.8), accentMat);
    fin.position.set(side, 1.7, -9.8);
    fin.rotation.z = (side < 0 ? -1 : 1) * 0.15;
    visualRoot.add(fin);
    submeshes.push(fin);
  });

  // Linking Horizontal Bridge Stabilizer
  const bridgeStab = new THREE.Mesh(getBoxGeometry(3.6, 0.22, 1.6), bodyMat);
  bridgeStab.position.set(0, 0.65, -9.4);
  visualRoot.add(bridgeStab);
  submeshes.push(bridgeStab);

  // 6. Heavy 5-Blade Main Rotor Assembly
  const mastGeo = getCylinderGeometry(0.35, 1.6, 8);
  const mast = new THREE.Mesh(mastGeo, SHARED_MATERIALS.mechanicalMetal);
  mast.position.set(0, 2.1, -0.6);
  visualRoot.add(mast);
  submeshes.push(mast);

  const mainRotorPivot = new THREE.Group();
  mainRotorPivot.name = "MainRotorPivot";
  mainRotorPivot.position.set(0, 2.8, -0.6);
  visualRoot.add(mainRotorPivot);

  const hubA = new THREE.Mesh(getCylinderGeometry(1.1, 0.35, 10), SHARED_MATERIALS.mechanicalMetal);
  mainRotorPivot.add(hubA);
  submeshes.push(hubA);

  const hubB = new THREE.Mesh(getCylinderGeometry(0.6, 0.5, 8), armorMat);
  hubB.position.set(0, 0.3, 0);
  mainRotorPivot.add(hubB);
  submeshes.push(hubB);

  const bladeCount = 5;
  const bladeGeo = getRotorBladeGeometry(11.2, 0.65, 0.42, 0.09);
  for (let i = 0; i < bladeCount; i++) {
    const bladeArm = new THREE.Group();
    bladeArm.rotation.y = (i * Math.PI * 2) / bladeCount;

    const blade = new THREE.Mesh(bladeGeo, SHARED_MATERIALS.bladeComposite);
    blade.position.set(0, 0, 1.0);
    bladeArm.add(blade);
    submeshes.push(blade);

    const tipAccent = new THREE.Mesh(getBoxGeometry(0.55, 0.12, 0.9), accentMat);
    tipAccent.position.set(0, 0, 11.0);
    bladeArm.add(tipAccent);
    submeshes.push(tipAccent);

    mainRotorPivot.add(bladeArm);
  }

  const blurDiscGeo = new THREE.RingGeometry(2.4, 11.8, 48);
  blurDiscGeo.rotateX(-Math.PI / 2);
  const rotorBlurDisc = new THREE.Mesh(blurDiscGeo, SHARED_MATERIALS.rotorBlurDisc);
  rotorBlurDisc.name = "RotorBlurDisc";
  rotorBlurDisc.position.set(0, 0.04, 0);
  mainRotorPivot.add(rotorBlurDisc);

  // 7. Spinning Dual/Central Tail Rotor
  const tailRotorPivot = new THREE.Group();
  tailRotorPivot.name = "TailRotorPivot";
  tailRotorPivot.position.set(0, 1.8, -9.8);
  visualRoot.add(tailRotorPivot);

  const tailHub = new THREE.Mesh(getBoxGeometry(0.35, 0.4, 0.4), SHARED_MATERIALS.mechanicalMetal);
  tailRotorPivot.add(tailHub);
  submeshes.push(tailHub);

  const tailBladeGeo = getTailBladeGeometry(2.2, 0.28, 0.05);
  for (let i = 0; i < 4; i++) {
    const tBladeArm = new THREE.Group();
    tBladeArm.rotation.x = (i * Math.PI) / 2;

    const tBlade = new THREE.Mesh(tailBladeGeo, SHARED_MATERIALS.bladeComposite);
    tBlade.position.set(0, 0.2, 0);
    tBladeArm.add(tBlade);
    submeshes.push(tBlade);

    tailRotorPivot.add(tBladeArm);
  }

  // 8. Extended Heavy Weapon Wings & Ordnance
  const wingGeo = getBoxGeometry(9.8, 0.35, 1.8);
  const weaponWings = new THREE.Mesh(wingGeo, bodyMat);
  weaponWings.name = "HeavyAssaultWings";
  weaponWings.position.set(0, -0.1, 0.2);
  visualRoot.add(weaponWings);
  submeshes.push(weaponWings);

  const leftWing = new THREE.Object3D();
  leftWing.name = "LeftWing";
  leftWing.position.set(-4.0, -0.1, 0.2);
  visualRoot.add(leftWing);

  const rightWing = new THREE.Object3D();
  rightWing.name = "RightWing";
  rightWing.position.set(4.0, -0.1, 0.2);
  visualRoot.add(rightWing);

  const damageDetails = new THREE.Object3D();
  damageDetails.name = "DamageDetails";
  visualRoot.add(damageDetails);

  const rocketPoints: THREE.Object3D[] = [];
  const missilePoints: THREE.Object3D[] = [];

  // Heavy 19-Tube Rocket Pods
  const podGeo = getRocketPodGeometry(0.65, 2.2);
  const rocketPodLeft = new THREE.Mesh(podGeo, SHARED_MATERIALS.weaponMetal);
  rocketPodLeft.name = "RocketPodLeft";
  rocketPodLeft.position.set(-3.4, -0.75, 0.3);
  visualRoot.add(rocketPodLeft);
  submeshes.push(rocketPodLeft);

  const rocketPodRight = new THREE.Mesh(podGeo, SHARED_MATERIALS.weaponMetal);
  rocketPodRight.name = "RocketPodRight";
  rocketPodRight.position.set(3.4, -0.75, 0.3);
  visualRoot.add(rocketPodRight);
  submeshes.push(rocketPodRight);

  [-3.4, 3.4].forEach((side) => {
    const pylon = new THREE.Mesh(getBoxGeometry(0.24, 0.5, 1.2), armorMat);
    pylon.position.set(side, -0.35, 0.2);
    visualRoot.add(pylon);
    submeshes.push(pylon);

    const rocketPoint = new THREE.Object3D();
    rocketPoint.position.set(side, -0.75, 1.5);
    visualRoot.add(rocketPoint);
    rocketPoints.push(rocketPoint);
  });

  // Wingtip Anti-Armor Missile Launchers
  const missileGeo = getMissileGeometry(2.0, 0.2);
  [-4.6, 4.6].forEach((side) => {
    const rack = new THREE.Mesh(getBoxGeometry(0.8, 0.16, 1.4), armorMat);
    rack.position.set(side, -0.25, 0.2);
    visualRoot.add(rack);
    submeshes.push(rack);

    const missile = new THREE.Mesh(missileGeo, SHARED_MATERIALS.darkChassis);
    missile.position.set(side, -0.45, 0.4);
    visualRoot.add(missile);
    submeshes.push(missile);

    const tipLight = new THREE.Mesh(getBoxGeometry(0.2, 0.2, 0.2), SHARED_MATERIALS.glowSensorRed);
    tipLight.position.set(side * 1.05, 0, 0.2);
    visualRoot.add(tipLight);
    submeshes.push(tipLight);

    const missilePoint = new THREE.Object3D();
    missilePoint.position.set(side, -0.45, 1.5);
    visualRoot.add(missilePoint);
    missilePoints.push(missilePoint);
  });

  // 9. Independent Heavy Chin Cannon Turret
  const gunYawPivot = new THREE.Group();
  gunYawPivot.name = "CannonMount";
  gunYawPivot.position.set(0, -1.45, 3.4);
  visualRoot.add(gunYawPivot);

  const cannonMount = new THREE.Mesh(getBoxGeometry(1.2, 0.65, 1.2), armorMat);
  gunYawPivot.add(cannonMount);
  submeshes.push(cannonMount);

  const gunPitchPivot = new THREE.Group();
  gunPitchPivot.name = "GunPitchPivot";
  gunPitchPivot.position.set(0, -0.2, 0.3);
  gunYawPivot.add(gunPitchPivot);

  // Twin Heavy Cannon Barrels
  [-0.24, 0.24].forEach((bSide) => {
    const barrel = new THREE.Mesh(getCylinderGeometry(0.12, 2.6, 8), SHARED_MATERIALS.weaponMetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(bSide, 0, 1.3);
    gunPitchPivot.add(barrel);
    submeshes.push(barrel);
  });

  const heavyMuzzle = new THREE.Mesh(getBoxGeometry(0.75, 0.38, 0.5), SHARED_MATERIALS.darkChassis);
  heavyMuzzle.position.set(0, 0, 2.5);
  gunPitchPivot.add(heavyMuzzle);
  submeshes.push(heavyMuzzle);

  const muzzleGlow = new THREE.Mesh(getBoxGeometry(0.65, 0.28, 0.24), SHARED_MATERIALS.glowSensorRed);
  muzzleGlow.position.set(0, 0, 2.7);
  gunPitchPivot.add(muzzleGlow);
  submeshes.push(muzzleGlow);

  const muzzlePoint = new THREE.Object3D();
  muzzlePoint.name = "MuzzlePoint";
  muzzlePoint.position.set(0, 0, 2.85);
  gunPitchPivot.add(muzzlePoint);

  // 10. Target & Damage Attachment Points (Phased Boss Visual Support)
  const targetPoint = new THREE.Object3D();
  targetPoint.name = "TargetPoint";
  targetPoint.position.set(0, 0, 0);
  visualRoot.add(targetPoint);

  const engineLeft = new THREE.Object3D();
  engineLeft.name = "EngineDamagePointLeft";
  engineLeft.position.set(-2.3, 0.8, -0.6);
  visualRoot.add(engineLeft);

  const engineRight = new THREE.Object3D();
  engineRight.name = "EngineDamagePointRight";
  engineRight.position.set(2.3, 0.8, -0.6);
  visualRoot.add(engineRight);

  const hullPoint = new THREE.Object3D();
  hullPoint.name = "HullDamagePoint";
  hullPoint.position.set(0, 1.2, 0);
  visualRoot.add(hullPoint);

  const tailPoint = new THREE.Object3D();
  tailPoint.name = "TailDamagePoint";
  tailPoint.position.set(0, 1.0, -8.5);
  visualRoot.add(tailPoint);

  return {
    root,
    visualRoot,
    mainRotorPivot,
    tailRotorPivot,
    gunYawPivot,
    gunPitchPivot,
    muzzlePoint,
    missilePoints,
    rocketPoints,
    targetPoint,
    damagePoints: { engineLeft, engineRight, hull: hullPoint, tail: tailPoint },
    coreGlowMesh,
    rotorBlurDisc,
    submeshes,
  };
}

// ============================================================================
// MODEL FACTORY ENTRY POINT
// ============================================================================
export class EnemyHelicopterModelFactory {
  static create(options: EnemyHelicopterModelOptions): EnemyHelicopterModelResult {
    switch (options.family) {
      case "light":
        return buildLightAttackHelicopter(options);
      case "medium":
        return buildMediumAttackGunship(options);
      case "boss":
        return buildBossHeavyGunship(options);
      default:
        return buildLightAttackHelicopter(options);
    }
  }
}
