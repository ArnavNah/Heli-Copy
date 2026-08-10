// ---------------------------------------------------------------------------
// Modular low-poly prop library (Environment Pass 5).
//
// Every prop is built from SHARED cached geometries and materials (see
// materials.ts) — no per-prop GPU buffers, no unique materials, no per-frame
// logic. Props are static scenery; city.ts's clone-on-write for damage and
// camera-occlusion still works because everything funnels through the same
// shared cache.
//
// Art rules: strong silhouettes, chunky proportions, low-poly, no tiny detail.
// A handful of reusable colors per category keeps the palette small so
// gameplay effects stay dominant.
// ---------------------------------------------------------------------------
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createBox, createCylinder, createGlowBox, getLowPolyMaterial } from "./materials";

/** Limited reusable palette — all shared materials, never per-prop. */
export const PROP_COLORS = {
  steel: 0x4a5560,
  darkSteel: 0x1d2530,
  concrete: 0x6e7078,
  concreteDark: 0x50545c,
  rust: 0x8a4a35,
  blue: 0x3a6b9f,
  green: 0x4f7a4f,
  sand: 0xcbb785,
  red: 0xb33a2e,
  yellow: 0xd9b23a,
  black: 0x20242c,
  olive: 0x4d5c3a,
  oliveDark: 0x39452b,
  tan: 0x8a7a5c,
} as const;

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
) {
  const m = createBox(w, h, d, color);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function cyl(
  r: number,
  h: number,
  color: number,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
  segments = 8,
) {
  const m = createCylinder(r, h, color, segments);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// Rooftop props
// ---------------------------------------------------------------------------

export type RooftopPropKind =
  | "helipad"
  | "antenna"
  | "acUnit"
  | "mast"
  | "waterTank"
  | "smokeStack"
  | "vent"
  | "maintenanceHut";

/**
 * Build one rooftop prop, relative to the roof surface (y = 0 = roof).
 * `variant` (0..1) picks between sub-looks of the same kind; `accent` is the
 * district accent color. Beacons are tagged `userData.isBeacon` so the city
 * can register them for the pulsing-warning-light pass.
 */
export function buildRooftopProp(
  kind: RooftopPropKind,
  variant: number,
  w: number,
  d: number,
  accent: number,
): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case "acUnit":
      acUnit(g, variant);
      break;
    case "vent":
      vent(g, variant);
      break;
    case "antenna":
      antennaCluster(g, variant);
      break;
    case "mast":
      commTower(g, variant);
      break;
    case "waterTank":
      waterTank(g, variant, accent);
      break;
    case "maintenanceHut":
      maintenanceHut(g, variant, accent);
      break;
    case "helipad":
      helipad(g, w, d);
      break;
    case "smokeStack":
      smokeStack(g, variant, accent);
      break;
  }
  return g;
}

function acUnit(g: THREE.Group, v: number) {
  // Chunk of A/C boxes + fan grilles; variant adds a second unit / duct stub.
  box(1.7, 1.1, 1.7, PROP_COLORS.darkSteel, 0, 0.65, 0, g);
  box(1.7, 0.22, 0.5, PROP_COLORS.steel, 0, 1.15, 0.85, g);
  if (v > 0.45) {
    box(1.7, 1.1, 1.7, PROP_COLORS.darkSteel, 0, 0.65, -1.9, g);
    box(1.7, 0.22, 0.5, PROP_COLORS.steel, 0, 1.15, -1.05, g);
  }
  if (v > 0.8) {
    box(0.55, 1.7, 0.55, PROP_COLORS.steel, 1.0, 1.35, -0.6, g);
  }
}

function vent(g: THREE.Group, v: number) {
  box(1.4, 0.7, 1.4, PROP_COLORS.concreteDark, 0, 0.45, 0, g);
  cyl(0.32, 1.4 + v * 0.9, PROP_COLORS.darkSteel, 0, 1.5 + v * 0.45, 0, g, 6);
  box(0.8, 0.14, 0.8, PROP_COLORS.steel, 0, 2.3 + v * 0.45, 0, g);
}

function antennaCluster(g: THREE.Group, v: number) {
  // 2-3 masts of varying height with crossbars — strong skyline silhouette.
  const masts = v > 0.6 ? 3 : 2;
  for (let i = 0; i < masts; i++) {
    const h = 3 + ((v * 7 + i * 3) % 5);
    const x = (i - (masts - 1) / 2) * 1.3;
    box(0.22, h, 0.22, PROP_COLORS.darkSteel, x, h / 2 + 0.5, 0, g);
    box(1.4, 0.14, 0.14, PROP_COLORS.steel, x, h * 0.6 + 0.5, 0, g);
  }
}

function commTower(g: THREE.Group, v: number) {
  // Tapered lattice tower (stacked shrinking boxes) + blinking beacon.
  let width = 1.5;
  let y = 0;
  const steps = 3 + Math.floor(v * 2);
  for (let i = 0; i < steps; i++) {
    box(width, 2.2, width, PROP_COLORS.darkSteel, 0, y + 1.1, 0, g);
    width *= 0.78;
    y += 2.1;
  }
  const beacon = createGlowBox(0.8, 0.35, 0.8, 0xff3344, 0.9);
  beacon.position.set(0, y + 1.2, 0);
  beacon.userData.isBeacon = true;
  g.add(beacon);
  if (v > 0.5) {
    const dish = box(1.6, 0.28, 1.0, PROP_COLORS.steel, 0.7, y - 0.4, 0, g);
    dish.rotation.z = 0.5;
  }
}

function waterTank(g: THREE.Group, v: number, accent: number) {
  if (v > 0.7) {
    // twin tanks
    for (const sx of [-1.6, 1.6]) {
      box(1.0, 2.6, 1.0, PROP_COLORS.darkSteel, sx, 1.3, 0, g);
      cyl(0.85, 2.4, PROP_COLORS.steel, sx, 2.8, 0, g, 8);
    }
    return;
  }
  box(2.0, 3.0, 2.0, PROP_COLORS.darkSteel, 0, 1.6, 0, g);
  cyl(1.25, 2.8, PROP_COLORS.steel, 0, 3.6, 0, g, 8);
  cyl(1.3, 0.45, accent, 0, 3.0, 0, g, 8); // district accent band
}

function maintenanceHut(g: THREE.Group, v: number, accent: number) {
  box(3.0, 2.2, 2.4, PROP_COLORS.concrete, 0, 1.1, 0, g);
  box(3.4, 0.5, 2.8, PROP_COLORS.darkSteel, 0, 2.4, 0, g);
  box(1.1, 1.5, 0.15, accent, 0, 0.75, 1.25, g); // accent door
  if (v > 0.5) {
    cyl(0.22, 1.6, PROP_COLORS.darkSteel, 1.1, 3.1, -0.7, g, 6);
  }
}

function helipad(g: THREE.Group, w: number, d: number) {
  const pw = Math.min(w, 9);
  const pd = Math.min(d, 9);
  box(pw, 0.22, pd, 0x1b2740, 0, 0.05, 0, g);
  // Oversized H marking (two crossing bars) — readable from the air.
  box(2.6, 0.26, 0.9, 0xe9df9a, 0, 0.16, 0, g);
  box(0.9, 0.26, 2.6, 0xe9df9a, 0, 0.16, 0, g);
  // Corner warning dots
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(0.7, 0.18, 0.7, PROP_COLORS.steel, sx * (pw / 2 - 0.8), 0.12, sz * (pd / 2 - 0.8), g);
    }
  }
}

function smokeStack(g: THREE.Group, v: number, accent: number) {
  box(2.6, 1.6, 2.6, PROP_COLORS.concreteDark, 0, 0.8, 0, g);
  cyl(0.7, 5 + v * 3, PROP_COLORS.darkSteel, 0, 4.1 + v * 1.5, 0, g, 8);
  cyl(0.85, 0.5, accent, 0, 6.8 + v * 1.5, 0, g, 8);
}

// ---------------------------------------------------------------------------
// Street props
// ---------------------------------------------------------------------------

/** Street lamp with an inward arm + glowing head (arm points toward -x). */
export function buildLightPole(desert: boolean): THREE.Group {
  const g = new THREE.Group();
  box(0.28, 5.2, 0.28, PROP_COLORS.darkSteel, 0, 2.45, 0, g);
  box(3.4, 0.18, 0.18, PROP_COLORS.darkSteel, -1.5, 5.0, 0, g);
  const lamp = createGlowBox(1.1, 0.38, 1.1, desert ? 0xffd487 : 0x9ff7ff, 0.62);
  lamp.position.set(-3.0, 4.88, 0);
  g.add(lamp);
  return g;
}

/** Traffic light: pole + three chunky signal heads (faces +z). */
export function buildTrafficLight(): THREE.Group {
  const g = new THREE.Group();
  box(0.3, 5.0, 0.3, PROP_COLORS.darkSteel, 0, 2.5, 0, g);
  box(0.55, 1.7, 0.7, PROP_COLORS.black, 0, 5.6, 0.55, g);
  box(0.32, 0.32, 0.15, 0xff3344, 0, 6.15, 0.9, g);
  box(0.32, 0.32, 0.15, 0xffd23b, 0, 5.6, 0.9, g);
  box(0.32, 0.32, 0.15, 0x35e66d, 0, 5.05, 0.9, g);
  return g;
}

/** Small roadside direction/zone sign on a pole. */
export function buildRoadSign(green: boolean): THREE.Group {
  const g = new THREE.Group();
  box(0.22, 2.6, 0.22, PROP_COLORS.darkSteel, 0, 1.3, 0, g);
  box(1.9, 1.3, 0.14, green ? 0x2f7a4a : 0x33517a, 0, 2.9, 0, g);
  return g;
}

/** Chunky dumpster with lid + handles. */
export function buildDumpster(): THREE.Group {
  const g = new THREE.Group();
  box(2.2, 1.3, 1.3, PROP_COLORS.oliveDark, 0, 0.75, 0, g);
  box(2.4, 0.22, 1.5, PROP_COLORS.olive, 0, 1.5, 0, g);
  box(0.3, 0.5, 1.6, PROP_COLORS.steel, -1.0, 1.1, 0, g);
  return g;
}

/** Low utility box with an accent access panel. */
export function buildUtilityBox(accent: number): THREE.Group {
  const g = new THREE.Group();
  box(1.4, 1.5, 1.0, PROP_COLORS.concreteDark, 0, 0.75, 0, g);
  box(0.5, 0.6, 0.15, accent, 0.35, 0.95, 0.55, g);
  return g;
}

// ---------------------------------------------------------------------------
// Industrial props
// ---------------------------------------------------------------------------

/** Vertical storage tank: base pad + barrel + accent band + roof stub. */
export function buildStorageTank(variant: number, accent: number): THREE.Group {
  const g = new THREE.Group();
  const r = 1.6 + (variant % 2) * 0.6;
  const h = 3.2 + (variant % 3) * 1.2;
  cyl(r, 0.5, PROP_COLORS.concreteDark, 0, 0.25, 0, g, 8);
  cyl(r, h, PROP_COLORS.steel, 0, 0.5 + h / 2, 0, g, 8);
  cyl(r * 0.96, 0.5, accent, 0, 0.5 + h - 0.2, 0, g, 8);
  cyl(r * 0.4, 0.9, PROP_COLORS.darkSteel, 0, 0.5 + h + 0.5, 0, g, 8);
  return g;
}

/** Twin horizontal pipes on supports. */
export function buildPipeRun(): THREE.Group {
  const g = new THREE.Group();
  const len = 6;
  const m1 = createCylinder(0.32, len, PROP_COLORS.rust, 6);
  m1.rotation.z = Math.PI / 2;
  m1.position.set(0, 2.2, 0);
  g.add(m1);
  const m2 = createCylinder(0.32, len, PROP_COLORS.rust, 6);
  m2.rotation.z = Math.PI / 2;
  m2.position.set(0, 1.4, 0.9);
  g.add(m2);
  box(0.3, 1.4, 0.3, PROP_COLORS.darkSteel, 1.8, 0.7, 0, g);
  box(0.3, 1.4, 0.3, PROP_COLORS.darkSteel, -1.8, 0.7, 0, g);
  return g;
}

/** Generator skid: engine block + control box + exhaust stack. */
export function buildGenerator(): THREE.Group {
  const g = new THREE.Group();
  box(1.9, 1.4, 1.1, PROP_COLORS.oliveDark, 0, 0.7, 0, g);
  box(0.8, 1.0, 0.8, PROP_COLORS.black, 0.75, 0.9, 0, g);
  cyl(0.18, 1.8, PROP_COLORS.darkSteel, -0.6, 2.1, 0.2, g, 6);
  return g;
}

/** Stacked crate with a lid frame. */
export function buildCrate(variant: number, color = PROP_COLORS.tan): THREE.Group {
  const g = new THREE.Group();
  const s = 1.1 + (variant % 2) * 0.35;
  box(s, s, s, color, 0, s / 2, 0, g);
  box(s + 0.14, 0.22, s + 0.14, PROP_COLORS.darkSteel, 0, s + 0.11, 0, g);
  return g;
}

/** Shipping container box with ribbed top + corner posts. */
export function buildContainer(color: number): THREE.Group {
  const g = new THREE.Group();
  const w = 5.0;
  const h = 2.4;
  const d = 2.4;
  box(w, h, d, color, 0, h / 2, 0, g);
  box(w + 0.2, 0.3, d + 0.2, PROP_COLORS.darkSteel, 0, h + 0.15, 0, g);
  box(0.3, h, 0.3, PROP_COLORS.darkSteel, -w / 2, h / 2, 0, g);
  return g;
}

/** Loading bay: platform + posts + canopy. */
export function buildLoadingBay(): THREE.Group {
  const g = new THREE.Group();
  box(4.4, 0.6, 3.4, PROP_COLORS.concrete, 0, 0.3, 0, g);
  box(0.3, 2.6, 0.3, PROP_COLORS.darkSteel, -1.9, 1.6, 1.6, g);
  box(0.3, 2.6, 0.3, PROP_COLORS.darkSteel, 1.9, 1.6, 1.6, g);
  box(4.6, 0.4, 0.5, PROP_COLORS.darkSteel, 0, 3.0, 1.6, g);
  return g;
}

// ---------------------------------------------------------------------------
// Military props
// ---------------------------------------------------------------------------

/** Tall antenna array: three masts with dishes/crossbars. */
export function buildAntennaArray(variant: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const h = 5 + ((variant * 5 + i * 2) % 4);
    const x = (i - 1) * 1.4;
    box(0.24, h, 0.24, PROP_COLORS.darkSteel, x, h / 2, 0, g);
    box(1.7, 0.16, 0.16, PROP_COLORS.steel, x, h * 0.65, 0, g);
    box(1.1, 0.6, 0.4, PROP_COLORS.steel, x, h * 0.35, 0, g);
  }
  return g;
}

/** Floodlight: pole + glowing head. */
export function buildFloodlight(): THREE.Group {
  const g = new THREE.Group();
  box(0.3, 4.2, 0.3, PROP_COLORS.darkSteel, 0, 2.1, 0, g);
  const head = createGlowBox(1.3, 0.9, 0.6, 0xfff3c4, 0.9);
  head.position.set(0, 4.3, 0.35);
  head.rotation.x = -0.35;
  g.add(head);
  return g;
}

/** Low military equipment crate. */
export function buildEquipmentCrate(): THREE.Group {
  const g = new THREE.Group();
  box(2.0, 1.0, 1.4, PROP_COLORS.olive, 0, 0.5, 0, g);
  box(2.2, 0.18, 1.6, PROP_COLORS.oliveDark, 0, 1.05, 0, g);
  return g;
}

/** Low striped perimeter marker post. */
export function buildPerimeterMarker(): THREE.Group {
  const g = new THREE.Group();
  box(0.35, 1.2, 0.35, PROP_COLORS.concreteDark, 0, 0.6, 0, g);
  box(0.42, 0.3, 0.42, PROP_COLORS.yellow, 0, 0.95, 0, g);
  return g;
}

/** Barricade: chunky concrete + legs + hazard bar. */
export function buildBarricade(): THREE.Group {
  const g = new THREE.Group();
  box(1.8, 1.1, 0.5, PROP_COLORS.concrete, 0, 0.55, 0, g);
  box(0.4, 1.3, 0.5, PROP_COLORS.darkSteel, -0.6, 0.75, 0, g);
  box(0.4, 1.3, 0.5, PROP_COLORS.darkSteel, 0.6, 0.75, 0, g);
  box(1.84, 0.22, 0.56, PROP_COLORS.red, 0, 1.1, 0, g);
  return g;
}

// ---------------------------------------------------------------------------
// Instancing (for repeated street / military items)
// ---------------------------------------------------------------------------

/** Shared geometry for low-poly bollards — instanced by the city. */
export const bollardGeometry = (() => {
  const g = new THREE.CylinderGeometry(0.26, 0.32, 1.0, 8);
  g.userData.shared = true;
  return g;
})();

/** Shared geometry for concrete barriers — instanced by the city. */
export const barrierGeometry = (() => {
  const base = new THREE.BoxGeometry(2.6, 0.7, 0.55);
  const top = new THREE.BoxGeometry(2.6, 0.45, 0.35).translate(0, 0.55, 0);
  const g = mergeGeometries([base, top], false) as THREE.BufferGeometry;
  g.userData.shared = true;
  return g;
})();

/**
 * Instance `geometry` at the given transforms in one draw call. The transforms
 * array is consumed (cleared) so callers can reuse a scratch list per chunk.
 */
export function addInstancedProps(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  transforms: Array<{ x: number; y: number; z: number; ry?: number }>,
) {
  if (transforms.length === 0) return;
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < transforms.length; i++) {
    dummy.position.set(transforms[i].x, transforms[i].y, transforms[i].z);
    dummy.rotation.set(0, transforms[i].ry ?? 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  parent.add(mesh);
  transforms.length = 0; // consumed — scratch lists can be reused per chunk
}
