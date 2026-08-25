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
import { createBox, createCylinder, createPrism, createGlowBox, getLowPolyMaterial, getBoxGeometry, getCylinderGeometry } from "./materials";

/** Reusable low-poly military & coastal palette. */
export const PROP_COLORS = {
  steel: 0x5a6370,
  darkSteel: 0x222832,
  concrete: 0xc8bfaf,
  concreteDark: 0x6e737c,
  rust: 0x9a442e,
  blue: 0x346fa6,
  green: 0x489635,
  sand: 0xe5be82,
  red: 0xc7382c,
  yellow: 0xf5ba2c,
  black: 0x1a1e24,
  olive: 0x4d5f36,
  oliveDark: 0x3c4a2a,
  tan: 0xb59e75,
  orange: 0xde5932,
  white: 0xf4f6fa,
  palmTrunk: 0x6c492b,
  palmFrond: 0x429e30,
  palmFrondLight: 0x56c242,
  wood: 0x825b36,
  woodDark: 0x523820,
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

function prism(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
) {
  const m = createPrism(w, h, d, color);
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
export function buildCrate(variant: number, color: number = PROP_COLORS.tan): THREE.Group {
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
// Coastal, Tropical & Warzone Props (Matching Reference Style)
// ---------------------------------------------------------------------------

/** Stylized low-poly palm tree: segmented curved trunk + starburst fan fronds + coconuts. */
export function buildPalmTree(variant = 0): THREE.Group {
  const g = new THREE.Group();
  const lean = ((variant % 5) - 2) * 0.12;
  const leanZ = (((variant * 3) % 5) - 2) * 0.08;
  const hScale = 0.85 + (variant % 4) * 0.12;

  // Segmented trunk: 5 stacked tapered box segments with gentle curvature
  let currY = 0;
  let currX = 0;
  let currZ = 0;
  let tWidth = 0.75;
  const segments = 5;
  const segH = 1.35 * hScale;

  for (let s = 0; s < segments; s++) {
    const nextX = currX + lean * (s * 0.35 + 0.2);
    const nextZ = currZ + leanZ * (s * 0.35 + 0.2);
    const midX = (currX + nextX) / 2;
    const midZ = (currZ + nextZ) / 2;
    const midY = currY + segH / 2;
    
    // Trunk core segment
    const b = box(tWidth, segH, tWidth, PROP_COLORS.palmTrunk, midX, midY, midZ, g);
    b.rotation.z = -lean * 0.4;
    b.rotation.x = leanZ * 0.4;

    // Segment ring ridge (chunky low-poly tree bark collar)
    const ring = box(tWidth + 0.14, 0.22, tWidth + 0.14, PROP_COLORS.woodDark, midX, currY + segH - 0.1, midZ, g);
    ring.rotation.z = -lean * 0.4;
    ring.rotation.x = leanZ * 0.4;

    currX = nextX;
    currZ = nextZ;
    currY += segH;
    tWidth *= 0.88;
  }

  // Crown head
  const crownY = currY + 0.2;
  const crownX = currX;
  const crownZ = currZ;

  // Coconuts under the canopy
  for (let c = 0; c < 4; c++) {
    const cAng = (c / 4) * Math.PI * 2 + 0.3;
    box(0.38, 0.45, 0.38, PROP_COLORS.woodDark, crownX + Math.cos(cAng) * 0.45, crownY - 0.2, crownZ + Math.sin(cAng) * 0.45, g);
  }

  // Starburst palm fronds: 8 arching fan leaves pointing outward and drooping
  const frondCount = 8;
  for (let f = 0; f < frondCount; f++) {
    const ang = (f / frondCount) * Math.PI * 2 + (variant * 0.4);
    const frondColor = f % 2 === 0 ? PROP_COLORS.palmFrond : PROP_COLORS.palmFrondLight;
    const dirX = Math.cos(ang);
    const dirZ = Math.sin(ang);

    // Inner arching stem segment
    const inner = box(0.95, 0.14, 1.8, frondColor, crownX + dirX * 1.0, crownY + 0.25, crownZ + dirZ * 1.0, g);
    inner.rotation.y = -ang + Math.PI / 2;
    inner.rotation.x = 0.32; // arch upwards

    // Outer drooping leaf tip
    const outer = box(1.15, 0.12, 2.2, frondColor, crownX + dirX * 2.3, crownY - 0.25, crownZ + dirZ * 2.3, g);
    outer.rotation.y = -ang + Math.PI / 2;
    outer.rotation.x = -0.42; // droop downwards

    // Leaf tip point
    const tip = box(0.65, 0.1, 1.2, frondColor, crownX + dirX * 3.4, crownY - 0.9, crownZ + dirZ * 3.4, g);
    tip.rotation.y = -ang + Math.PI / 2;
    tip.rotation.x = -0.7; // sharp tip droop
  }

  return g;
}

/** Low-poly roadside & median shrub / flower bush. */
export function buildShrub(variant = 0, color: number = PROP_COLORS.green): THREE.Group {
  const g = new THREE.Group();
  const s = 0.85 + (variant % 3) * 0.25;
  box(1.8 * s, 1.2 * s, 1.8 * s, color, 0, (0.6 * s), 0, g);
  box(1.3 * s, 0.9 * s, 1.3 * s, PROP_COLORS.palmFrondLight, 0.3 * s, (1.1 * s), -0.2 * s, g);
  box(1.0 * s, 0.8 * s, 1.0 * s, color, -0.4 * s, (0.9 * s), 0.3 * s, g);
  // Optional small blossom accents
  if (variant % 2 === 1) {
    box(0.25, 0.25, 0.25, 0xffd940, 0.2, 1.4 * s, 0.3, g);
    box(0.22, 0.22, 0.22, 0xff5566, -0.3, 1.3 * s, -0.2, g);
  }
  return g;
}

/** Low-poly painted road arrow marking (straight, turn, or combo). */
export function buildRoadArrow(type: 'straight' | 'turn' | 'combo' = 'straight', color: number = PROP_COLORS.white): THREE.Group {
  const g = new THREE.Group();
  const y = 0.02; // flush on road surface

  if (type === 'straight' || type === 'combo') {
    // Shaft (Z-axis)
    box(0.55, 0.04, 3.2, color, 0, y, 0.6, g);
    // Arrowhead wedge
    const head = prism(1.8, 0.04, 1.6, color, 0, y, -1.6, g);
    head.rotation.y = Math.PI; // point forward (-Z)
  }

  if (type === 'turn' || type === 'combo') {
    // Curved/angled turn arm pointing right (+X)
    const armX = type === 'combo' ? 0.8 : 0.4;
    box(2.0, 0.04, 0.55, color, armX, y, 0.8, g);
    const turnHead = prism(1.6, 0.04, 1.4, color, armX + 1.2, y, 0.8, g);
    turnHead.rotation.y = -Math.PI / 2; // point right (+X)
  }

  if (type === 'turn') {
    // Base shaft
    box(0.55, 0.04, 2.0, color, 0, y, 1.8, g);
  }

  return g;
}

/** Low-poly orange traffic cone with white reflective collar (matching reference). */
export function buildTrafficCone(): THREE.Group {
  const g = new THREE.Group();
  // Square rubber base
  box(0.9, 0.1, 0.9, PROP_COLORS.orange, 0, 0.05, 0, g);
  // Bottom orange cone
  cyl(0.36, 0.5, PROP_COLORS.orange, 0, 0.35, 0, g, 8);
  // White reflective middle band
  cyl(0.27, 0.3, PROP_COLORS.white, 0, 0.7, 0, g, 8);
  // Top orange cone
  cyl(0.18, 0.4, PROP_COLORS.orange, 0, 1.0, 0, g, 8);
  // Cone tip cap
  box(0.14, 0.12, 0.14, PROP_COLORS.orange, 0, 1.24, 0, g);
  return g;
}

/** Striped construction barricade (A-frame legs + diagonal orange/white stripes). */
export function buildStripedBarricade(): THREE.Group {
  const g = new THREE.Group();
  // Two dark steel A-frame end stands
  for (const sx of [-1.3, 1.3]) {
    box(0.16, 1.6, 0.16, PROP_COLORS.darkSteel, sx, 0.8, -0.4, g);
    box(0.16, 1.6, 0.16, PROP_COLORS.darkSteel, sx, 0.8, 0.4, g);
    box(0.16, 0.16, 1.0, PROP_COLORS.darkSteel, sx, 0.3, 0, g);
  }
  // Main horizontal board
  box(3.2, 0.55, 0.12, PROP_COLORS.white, 0, 1.2, 0, g);
  // Alternating orange diagonal/vertical hazard stripes
  for (let s = -3; s <= 3; s++) {
    if (Math.abs(s) % 2 === 1) {
      box(0.42, 0.57, 0.14, PROP_COLORS.orange, s * 0.46, 1.2, 0, g);
    }
  }
  // Bottom stabilizer bar
  box(3.2, 0.32, 0.12, PROP_COLORS.white, 0, 0.55, 0, g);
  return g;
}

/** Stack of 3-4 oil barrels (fuel red, military olive, dark steel). */
export function buildOilDrumStack(): THREE.Group {
  const g = new THREE.Group();
  // Bottom 3 barrels
  cyl(0.55, 1.3, PROP_COLORS.red, -0.6, 0.65, -0.4, g, 8);
  cyl(0.55, 1.3, PROP_COLORS.olive, 0.6, 0.65, -0.4, g, 8);
  cyl(0.55, 1.3, PROP_COLORS.darkSteel, 0, 0.65, 0.6, g, 8);
  // Top barrel resting in cradle
  cyl(0.55, 1.3, PROP_COLORS.red, 0, 1.9, 0, g, 8);
  return g;
}

/** Fortified sandbag revetment / wall. */
export function buildSandbagWall(length = 6): THREE.Group {
  const g = new THREE.Group();
  const bags = Math.max(2, Math.floor(length / 1.1));
  for (let row = 0; row < 3; row++) {
    const y = 0.2 + row * 0.32;
    const offset = (row % 2) * 0.5;
    for (let i = 0; i < bags; i++) {
      const x = -length / 2 + 0.6 + i * 1.1 + offset;
      if (Math.abs(x) > length / 2) continue;
      const b = box(1.0, 0.28, 0.6, row % 2 === 0 ? PROP_COLORS.sand : PROP_COLORS.tan, x, y, 0, g);
      b.rotation.y = ((i + row) % 3 - 1) * 0.06;
    }
  }
  return g;
}

/** Fortified U-shaped sandbag military bunker / checkpoint. */
export function buildSandbagBunker(): THREE.Group {
  const g = new THREE.Group();
  const front = buildSandbagWall(5.4);
  front.position.set(0, 0, -2.2);
  g.add(front);

  const left = buildSandbagWall(4.2);
  left.position.set(-2.6, 0, 0);
  left.rotation.y = Math.PI / 2;
  g.add(left);

  const right = buildSandbagWall(4.2);
  right.position.set(2.6, 0, 0);
  right.rotation.y = Math.PI / 2;
  g.add(right);

  // Machine gun tripod support / ammo box inside
  box(0.8, 0.5, 0.6, PROP_COLORS.olive, 0, 0.25, 0, g);
  box(0.3, 0.8, 0.3, PROP_COLORS.darkSteel, 0, 0.8, -1.2, g);
  return g;
}

/** Military Radar Truck: heavy 6x6 chassis + shelter + rotating rectangular radar dish (matching reference image 2). */
export function buildRadarTruck(): THREE.Group {
  const g = new THREE.Group();
  // 6x6 Green truck chassis
  box(3.2, 1.4, 7.8, PROP_COLORS.olive, 0, 1.2, 0, g);
  // Cab with front windshield
  box(3.0, 1.3, 2.6, PROP_COLORS.olive, 0, 2.1, -2.4, g);
  box(2.8, 0.7, 0.2, PROP_COLORS.black, 0, 2.3, -3.72, g); // windshield
  box(0.2, 0.6, 1.6, PROP_COLORS.black, -1.52, 2.3, -2.4, g); // left window
  box(0.2, 0.6, 1.6, PROP_COLORS.black, 1.52, 2.3, -2.4, g); // right window
  // Headlights & front grille
  box(2.6, 0.5, 0.2, PROP_COLORS.darkSteel, 0, 0.9, -3.92, g);
  box(0.4, 0.3, 0.15, PROP_COLORS.yellow, -1.1, 0.9, -4.0, g);
  box(0.4, 0.3, 0.15, PROP_COLORS.yellow, 1.1, 0.9, -4.0, g);

  // 6 Heavy all-terrain wheels
  for (const wx of [-1.65, 1.65]) {
    for (const wz of [-2.4, 0.8, 2.6]) {
      const wheel = cyl(0.65, 0.5, PROP_COLORS.black, wx, 0.65, wz, g, 8);
      wheel.rotation.z = Math.PI / 2;
    }
  }

  // Communications shelter body on rear bed
  box(3.1, 1.8, 4.6, PROP_COLORS.oliveDark, 0, 2.6, 1.4, g);

  // Rotating Radar Array structure
  const radarTurntable = new THREE.Group();
  radarTurntable.name = "RadarDishGroup";
  radarTurntable.position.set(0, 3.7, 1.4);

  // Turntable base & mast
  cyl(0.8, 0.5, PROP_COLORS.darkSteel, 0, 0.25, 0, radarTurntable, 8);
  box(0.4, 1.2, 0.4, PROP_COLORS.steel, 0, 0.9, 0, radarTurntable);

  // Tilted rectangular radar antenna dish
  const dish = box(4.4, 1.8, 0.35, PROP_COLORS.olive, 0, 1.8, 0, radarTurntable);
  dish.rotation.x = -0.22; // slight upward elevation angle
  // Radar reflector grid bands
  for (let i = -1; i <= 1; i++) {
    box(4.2, 0.14, 0.38, PROP_COLORS.steel, 0, 1.8 + i * 0.6, 0, radarTurntable);
  }
  // Feed horn antenna boom
  const boom = cyl(0.12, 1.2, PROP_COLORS.darkSteel, 0, 1.8, -0.6, radarTurntable, 6);
  boom.rotation.x = Math.PI / 2;

  g.add(radarTurntable);
  return g;
}

/** MLRS Missile Launcher Truck: 6x6 chassis + elevated tilted 12-tube rocket pod (matching reference image 2). */
export function buildMissileLauncherTruck(): THREE.Group {
  const g = new THREE.Group();
  // 6x6 Green truck chassis
  box(3.2, 1.4, 7.8, PROP_COLORS.olive, 0, 1.2, 0, g);
  // Armored cab
  box(3.0, 1.3, 2.6, PROP_COLORS.olive, 0, 2.1, -2.4, g);
  box(2.8, 0.6, 0.2, PROP_COLORS.black, 0, 2.3, -3.72, g);
  // 6 wheels
  for (const wx of [-1.65, 1.65]) {
    for (const wz of [-2.4, 0.8, 2.6]) {
      const wheel = cyl(0.65, 0.5, PROP_COLORS.black, wx, 0.65, wz, g, 8);
      wheel.rotation.z = Math.PI / 2;
    }
  }

  // Tilted 12-tube MLRS rocket launcher pod
  const podGroup = new THREE.Group();
  podGroup.position.set(0, 2.2, 1.2);
  podGroup.rotation.x = -0.48; // ~28 degree launch elevation

  // Hydraulic lifter arm & turntable
  cyl(0.7, 0.6, PROP_COLORS.darkSteel, 0, 0, 0, podGroup, 8);
  box(0.5, 1.6, 0.5, PROP_COLORS.steel, 0, 0.8, -0.4, podGroup);

  // Main launcher box
  box(2.8, 1.6, 4.4, PROP_COLORS.oliveDark, 0, 1.6, 0.4, podGroup);
  // 12 rocket launch tube muzzles (3 rows x 4 cols)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const tx = -1.05 + c * 0.7;
      const ty = 1.05 + r * 0.55;
      cyl(0.22, 0.4, PROP_COLORS.black, tx, ty, -1.82, podGroup, 6);
      cyl(0.14, 0.2, PROP_COLORS.yellow, tx, ty, -1.84, podGroup, 6); // yellow rocket tip
    }
  }

  g.add(podGroup);
  return g;
}

/** Orange Fuel Tanker Truck: white cab + massive horizontal cylindrical orange fuel tank (matching reference image 1). */
export function buildFuelTankerTruck(): THREE.Group {
  const g = new THREE.Group();
  // White modern cab
  box(3.0, 2.0, 3.2, PROP_COLORS.white, 0, 1.6, -3.2, g);
  box(2.8, 0.8, 0.2, PROP_COLORS.black, 0, 2.1, -4.82, g); // windshield
  box(0.2, 0.7, 1.6, PROP_COLORS.black, -1.52, 2.1, -3.2, g); // side window
  box(0.2, 0.7, 1.6, PROP_COLORS.black, 1.52, 2.1, -3.2, g);
  // Chrome grille & bumper
  box(2.6, 0.6, 0.3, PROP_COLORS.steel, 0, 0.9, -4.85, g);
  box(0.4, 0.3, 0.15, PROP_COLORS.yellow, -1.1, 0.9, -4.95, g);
  box(0.4, 0.3, 0.15, PROP_COLORS.yellow, 1.1, 0.9, -4.95, g);

  // Chassis frame
  box(2.6, 0.6, 9.4, PROP_COLORS.darkSteel, 0, 0.9, 0.2, g);

  // 8 Wheels (2 front, 2 mid, 4 tandem rear)
  for (const wx of [-1.6, 1.6]) {
    for (const wz of [-3.2, 0.8, 2.6, 4.0]) {
      const wheel = cyl(0.65, 0.45, PROP_COLORS.black, wx, 0.65, wz, g, 8);
      wheel.rotation.z = Math.PI / 2;
    }
  }

  // Large horizontal cylindrical Orange Fuel Tank
  const tank = cyl(1.45, 6.6, PROP_COLORS.orange, 0, 2.4, 1.6, g, 10);
  tank.rotation.x = Math.PI / 2;
  // Tank end caps
  box(2.7, 2.7, 0.4, PROP_COLORS.orange, 0, 2.4, -1.7, g);
  box(2.7, 2.7, 0.4, PROP_COLORS.orange, 0, 2.4, 4.9, g);
  // White hazard diamond / company stripe along tank
  box(3.0, 0.6, 6.2, PROP_COLORS.white, 0, 2.4, 1.6, g);
  box(0.5, 0.5, 6.25, PROP_COLORS.red, 0, 2.4, 1.6, g);
  // Top catwalk & access ladder
  box(1.0, 0.15, 5.8, PROP_COLORS.steel, 0, 3.9, 1.6, g);
  box(0.4, 2.2, 0.12, PROP_COLORS.steel, 1.45, 2.4, 4.6, g);

  return g;
}

/** Chunky low-poly pickup truck (matching reference image 1 orange pickup). */
export function buildPickupTruck(color: number = PROP_COLORS.orange): THREE.Group {
  const g = new THREE.Group();
  // Cab & front hood
  box(2.6, 1.1, 2.2, color, 0, 1.05, -1.4, g); // front hood
  box(2.6, 1.4, 2.2, color, 0, 1.8, 0.1, g); // cabin
  box(2.4, 0.65, 0.15, PROP_COLORS.black, 0, 1.95, -1.02, g); // windshield
  box(0.15, 0.55, 1.4, PROP_COLORS.black, -1.32, 1.95, 0.1, g);
  box(0.15, 0.55, 1.4, PROP_COLORS.black, 1.32, 1.95, 0.1, g);

  // Open cargo bed
  box(2.6, 0.9, 2.6, color, 0, 0.95, 2.0, g);
  box(2.2, 0.7, 2.4, PROP_COLORS.darkSteel, 0, 1.15, 2.0, g); // bed interior

  // Front grille & headlights
  box(2.2, 0.5, 0.2, PROP_COLORS.darkSteel, 0, 0.85, -2.52, g);
  box(0.35, 0.25, 0.15, PROP_COLORS.yellow, -0.9, 0.85, -2.58, g);
  box(0.35, 0.25, 0.15, PROP_COLORS.yellow, 0.9, 0.85, -2.58, g);

  // 4 Wheels
  for (const wx of [-1.4, 1.4]) {
    for (const wz of [-1.3, 2.0]) {
      const wheel = cyl(0.55, 0.4, PROP_COLORS.black, wx, 0.55, wz, g, 8);
      wheel.rotation.z = Math.PI / 2;
    }
  }

  return g;
}

/** Low-poly delivery van / utility truck. */
export function buildUtilityVan(color: number = PROP_COLORS.white): THREE.Group {
  const g = new THREE.Group();
  // Van boxy body
  box(2.6, 2.0, 5.6, color, 0, 1.5, 0, g);
  // Front windshield slope & windows
  box(2.4, 0.7, 0.2, PROP_COLORS.black, 0, 1.8, -2.82, g);
  box(0.2, 0.6, 1.4, PROP_COLORS.black, -1.32, 1.8, -1.8, g);
  box(0.2, 0.6, 1.4, PROP_COLORS.black, 1.32, 1.8, -1.8, g);
  // Headlights & rear taillights
  box(0.35, 0.25, 0.15, PROP_COLORS.yellow, -0.9, 0.9, -2.85, g);
  box(0.35, 0.25, 0.15, PROP_COLORS.yellow, 0.9, 0.9, -2.85, g);
  box(0.35, 0.35, 0.15, PROP_COLORS.red, -0.9, 1.2, 2.85, g);
  box(0.35, 0.35, 0.15, PROP_COLORS.red, 0.9, 1.2, 2.85, g);

  // 4 Wheels
  for (const wx of [-1.4, 1.4]) {
    for (const wz of [-1.6, 1.6]) {
      const wheel = cyl(0.55, 0.4, PROP_COLORS.black, wx, 0.55, wz, g, 8);
      wheel.rotation.z = Math.PI / 2;
    }
  }

  return g;
}

/** Low-poly sedan / taxi / police car. */
export function buildSedan(color: number = PROP_COLORS.yellow): THREE.Group {
  const g = new THREE.Group();
  // Lower body
  box(2.5, 0.8, 5.2, color, 0, 0.7, 0, g);
  // Upper greenhouse cabin
  box(2.1, 0.75, 2.8, color, 0, 1.45, -0.2, g);
  box(1.9, 0.55, 0.2, PROP_COLORS.black, 0, 1.45, -1.62, g); // windshield
  box(1.9, 0.55, 0.2, PROP_COLORS.black, 0, 1.45, 1.22, g); // rear window
  box(0.2, 0.5, 2.2, PROP_COLORS.black, -1.07, 1.45, -0.2, g); // side windows
  box(0.2, 0.5, 2.2, PROP_COLORS.black, 1.07, 1.45, -0.2, g);
  // Headlights
  box(0.35, 0.22, 0.15, PROP_COLORS.yellow, -0.85, 0.7, -2.62, g);
  box(0.35, 0.22, 0.15, PROP_COLORS.yellow, 0.85, 0.7, -2.62, g);

  // 4 Wheels
  for (const wx of [-1.35, 1.35]) {
    for (const wz of [-1.4, 1.4]) {
      const wheel = cyl(0.5, 0.35, PROP_COLORS.black, wx, 0.5, wz, g, 8);
      wheel.rotation.z = Math.PI / 2;
    }
  }

  return g;
}

/** Industrial Blue Steel Truss Bridge (matching reference image 2). */
export function buildSteelTrussBridge(span = 28, width = 12): THREE.Group {
  const g = new THREE.Group();
  const trussHeight = 4.8;
  const hw = width / 2;
  const hs = span / 2;

  // Roadway asphalt deck
  box(width, 0.4, span, PROP_COLORS.darkSteel, 0, 0.2, 0, g);
  // Road lane white lines on bridge
  box(0.4, 0.05, span, PROP_COLORS.white, 0, 0.42, 0, g);

  // Left & Right Steel Truss Girders
  for (const side of [-1, 1]) {
    const gx = side * (hw - 0.4);
    // Bottom chord beam
    box(0.6, 0.6, span, PROP_COLORS.blue, gx, 0.4, 0, g);
    // Top chord beam
    box(0.6, 0.6, span * 0.82, PROP_COLORS.blue, gx, trussHeight + 0.4, 0, g);
    // Slanted end diagonal posts
    const endPost1 = box(0.6, trussHeight * 1.2, 0.6, PROP_COLORS.blue, gx, trussHeight / 2 + 0.4, -hs + 1.5, g);
    endPost1.rotation.x = 0.55;
    const endPost2 = box(0.6, trussHeight * 1.2, 0.6, PROP_COLORS.blue, gx, trussHeight / 2 + 0.4, hs - 1.5, g);
    endPost2.rotation.x = -0.55;

    // Vertical & Diagonal X-bracing truss bays
    const bays = 4;
    const bayLen = span / bays;
    for (let b = 0; b <= bays; b++) {
      const bz = -hs + b * bayLen;
      // Vertical post
      if (Math.abs(bz) < hs - 1) {
        box(0.5, trussHeight, 0.5, PROP_COLORS.blue, gx, trussHeight / 2 + 0.4, bz, g);
      }
      // Diagonal X brace
      if (b < bays) {
        const diag1 = box(0.4, trussHeight * 1.25, 0.4, PROP_COLORS.blue, gx, trussHeight / 2 + 0.4, bz + bayLen / 2, g);
        diag1.rotation.x = 0.62;
        const diag2 = box(0.4, trussHeight * 1.25, 0.4, PROP_COLORS.blue, gx, trussHeight / 2 + 0.4, bz + bayLen / 2, g);
        diag2.rotation.x = -0.62;
      }
    }
  }

  // Top overhead cross struts
  for (let z = -hs + 4; z <= hs - 4; z += 6) {
    box(width, 0.4, 0.4, PROP_COLORS.blue, 0, trussHeight + 0.4, z, g);
  }

  // Bridge concrete abutment piers at each end
  for (const endZ of [-hs - 1.2, hs + 1.2]) {
    box(width + 2, 4.5, 2.4, PROP_COLORS.concrete, 0, -1.8, endZ, g);
  }

  return g;
}

/** Rustic Wooden Pier / Dock extending into coastal water (matching reference image 2). */
export function buildWoodenDock(length = 18, width = 6): THREE.Group {
  const g = new THREE.Group();
  const deckY = 0.35;

  // Deck plank surface
  box(width, 0.2, length, PROP_COLORS.wood, 0, deckY, 0, g);

  // Planks grooving & timber side beams
  for (const side of [-1, 1]) {
    box(0.35, 0.35, length, PROP_COLORS.woodDark, side * (width / 2 - 0.15), deckY - 0.1, 0, g);
  }

  // Vertical timber pilings in water
  const piles = Math.max(3, Math.floor(length / 4));
  for (let p = 0; p <= piles; p++) {
    const pz = -length / 2 + 1 + p * ((length - 2) / piles);
    for (const px of [-width / 2 + 0.3, width / 2 - 0.3]) {
      // Pilings reach down into water
      cyl(0.24, 3.5, PROP_COLORS.woodDark, px, deckY - 1.4, pz, g, 6);
      // Piling head extends above deck as mooring post
      cyl(0.22, 0.6, PROP_COLORS.woodDark, px, deckY + 0.4, pz, g, 6);
    }
  }

  return g;
}

/** Procedural Gas / Service Station (matching reference image 1 "VOLT FUEL" / "SKYWAY"). */
export function buildGasStation(name = "VOLT FUEL"): THREE.Group {
  const g = new THREE.Group();

  // Concrete forecourt apron slab
  box(28, 0.16, 22, PROP_COLORS.concrete, 0, 0.08, 0, g);

  // Large overhead Canopy
  const canopyGroup = new THREE.Group();
  canopyGroup.position.set(0, 0, -2);

  // 4 Concrete-wrapped steel support columns
  for (const cx of [-6.5, 6.5]) {
    for (const cz of [-4.5, 4.5]) {
      box(0.9, 4.8, 0.9, PROP_COLORS.concrete, cx, 2.4, cz, canopyGroup);
      box(0.5, 5.0, 0.5, PROP_COLORS.darkSteel, cx, 2.5, cz, canopyGroup);
    }
  }

  // Canopy roof structure (orange fascia + yellow accent + white underside)
  box(18, 1.2, 13, PROP_COLORS.orange, 0, 5.4, 0, canopyGroup);
  box(18.2, 0.25, 13.2, PROP_COLORS.yellow, 0, 5.8, 0, canopyGroup); // yellow accent stripe
  box(17.6, 0.2, 12.6, PROP_COLORS.white, 0, 4.75, 0, canopyGroup); // underside soffit

  // Brand Name Fascia Box (front facing -Z)
  const brandSign = createGlowBox(8.0, 0.8, 0.2, 0xffaa22, 0.85);
  brandSign.position.set(0, 5.4, -6.6);
  canopyGroup.add(brandSign);

  // Two Fuel Pump Islands
  for (const px of [-4.5, 4.5]) {
    // Concrete island curb
    box(2.2, 0.35, 6.4, PROP_COLORS.concreteDark, px, 0.18, 0, canopyGroup);
    // Yellow protective steel bollards at island ends
    cyl(0.2, 1.1, PROP_COLORS.yellow, px, 0.55, -2.8, canopyGroup, 8);
    cyl(0.2, 1.1, PROP_COLORS.yellow, px, 0.55, 2.8, canopyGroup, 8);

    // Twin Fuel Pumps (Red & Yellow)
    for (const pz of [-1.2, 1.2]) {
      // Pump body
      box(1.2, 2.2, 1.0, PROP_COLORS.red, px, 1.25, pz, canopyGroup);
      // Meter display screen
      box(0.8, 0.5, 1.05, PROP_COLORS.black, px, 1.6, pz, canopyGroup);
      box(0.7, 0.4, 1.08, 0x88ff88, px, 1.6, pz, canopyGroup);
      // Fuel nozzle & hose
      cyl(0.08, 1.4, PROP_COLORS.black, px + 0.65, 1.1, pz, canopyGroup, 6);
      cyl(0.08, 1.4, PROP_COLORS.black, px - 0.65, 1.1, pz, canopyGroup, 6);
    }
  }
  g.add(canopyGroup);

  // Roadside Price Totem Sign
  const totem = new THREE.Group();
  totem.position.set(11, 0, -9);
  cyl(0.4, 6.8, PROP_COLORS.darkSteel, 0, 3.4, 0, totem, 8);
  // Main orange price cabinet
  box(2.8, 3.8, 0.8, PROP_COLORS.orange, 0, 5.2, 0, totem);
  box(2.4, 0.8, 0.85, PROP_COLORS.yellow, 0, 6.4, 0, totem); // logo header
  box(2.2, 0.6, 0.86, PROP_COLORS.black, 0, 5.2, 0, totem); // LED price screen
  const priceDigits = createGlowBox(1.8, 0.4, 0.1, 0xffee44, 0.85);
  priceDigits.position.set(0, 5.2, 0.45);
  totem.add(priceDigits);
  g.add(totem);

  // Convenience Store Building behind the canopy
  const shop = new THREE.Group();
  shop.position.set(0, 0, 8);
  // Main building body
  box(16, 4.4, 9, PROP_COLORS.concrete, 0, 2.2, 0, shop);
  // Roof parapet trim
  box(16.4, 0.4, 9.4, PROP_COLORS.orange, 0, 4.5, 0, shop);
  // Glass storefront windows & entrance door
  box(12, 2.4, 0.2, 0x1a2632, 0, 1.6, -4.52, shop);
  box(4, 0.3, 1.2, PROP_COLORS.orange, 0, 2.8, -4.9, shop); // entrance awning
  // Roof HVAC condenser
  box(2.4, 1.4, 2.0, PROP_COLORS.concreteDark, -4, 5.1, 1, shop);
  g.add(shop);

  // Commercial dumpster & garbage cans
  const dumpster = buildDumpster();
  dumpster.position.set(10.5, 0, 7.5);
  dumpster.rotation.y = -0.4;
  g.add(dumpster);

  return g;
}

/** Canal Channel Segment: concrete retaining walls, walkways, railings, and water plane (matching reference image 1). */
export function buildCanalSegment(width = 24, length = 40, depth = 3.5): THREE.Group {
  const g = new THREE.Group();
  const hw = width / 2;
  const hl = length / 2;

  // Left & Right Concrete Retaining Walls
  for (const side of [-1, 1]) {
    const wx = side * hw;
    // Main vertical retaining wall
    box(1.2, depth + 1.2, length, PROP_COLORS.concreteDark, wx, -depth / 2 + 0.4, 0, g);
    // Top coping curb slab
    box(1.8, 0.35, length, PROP_COLORS.concrete, wx, 0.1, 0, g);
    // Outer pedestrian walkway along canal
    box(3.2, 0.18, length, PROP_COLORS.concrete, wx + side * 2.2, 0.02, 0, g);

    // Metal safety railing along the canal edge
    const posts = Math.max(3, Math.floor(length / 5));
    for (let p = 0; p <= posts; p++) {
      const pz = -hl + 1 + p * ((length - 2) / posts);
      // Railing vertical post
      box(0.12, 1.1, 0.12, PROP_COLORS.darkSteel, wx + side * 0.4, 0.65, pz, g);
    }
    // Horizontal top railing bar
    box(0.14, 0.12, length, PROP_COLORS.darkSteel, wx + side * 0.4, 1.15, 0, g);
    box(0.14, 0.12, length, PROP_COLORS.darkSteel, wx + side * 0.4, 0.65, 0, g);
  }

  // Turquoise Water Plane with Foam Lines
  const water = createBox(width - 0.4, 0.25, length, 0x2898cf);
  water.position.set(0, -depth + 1.6, 0);
  g.add(water);

  // Shoreline foam borders
  for (const side of [-1, 1]) {
    const foam = createBox(1.2, 0.08, length, 0xe6faff);
    foam.position.set(side * (hw - 1.2), -depth + 1.74, 0);
    g.add(foam);
  }

  // Floating wooden crates & buoys in the water
  const crate1 = buildCrate(0, PROP_COLORS.wood);
  crate1.position.set(-3.2, -depth + 1.8, -hl * 0.35);
  crate1.rotation.y = 0.4;
  g.add(crate1);

  const buoy1 = cyl(0.45, 0.7, PROP_COLORS.red, 4.5, -depth + 1.8, hl * 0.28, g, 8);
  cyl(0.3, 0.3, PROP_COLORS.white, 4.5, -depth + 2.2, hl * 0.28, g, 8);

  return g;
}

/** Wrecked / Burned Civilian Car (environmental battlefield storytelling). */
export function buildWreckedCar(): THREE.Group {
  const g = new THREE.Group();
  // Charred darkened lower body
  box(2.5, 0.75, 5.0, PROP_COLORS.black, 0, 0.5, 0, g);
  // Crumpled cabin roof (tilted)
  const roof = box(2.1, 0.65, 2.6, PROP_COLORS.darkSteel, 0.1, 1.15, -0.1, g);
  roof.rotation.z = 0.12;
  roof.rotation.x = -0.08;

  // Bent hood
  const hood = box(2.3, 0.2, 1.6, PROP_COLORS.darkSteel, 0, 0.9, -1.8, g);
  hood.rotation.x = 0.25;

  // Missing/deflated wheels (only 3 wheels remaining, chassis tilted)
  for (const wx of [-1.3, 1.3]) {
    const wheel = cyl(0.45, 0.35, PROP_COLORS.black, wx, 0.45, -1.3, g, 8);
    wheel.rotation.z = Math.PI / 2;
  }
  const rearWheel = cyl(0.45, 0.35, PROP_COLORS.black, -1.3, 0.45, 1.4, g, 8);
  rearWheel.rotation.z = Math.PI / 2;

  g.rotation.z = 0.08; // tilted onto deflated corner
  return g;
}

/** Circular explosion blast crater decal with shattered asphalt fragments. */
export function buildCraterDecal(radius = 3.5): THREE.Group {
  const g = new THREE.Group();
  // Flat dark scorch ring
  cyl(radius, 0.04, 0x181a1f, 0, 0.02, 0, g, 12);
  cyl(radius * 0.55, 0.06, 0x0f1114, 0, 0.03, 0, g, 8);

  // Scattered loose asphalt rubble chunks around rim
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.3;
    const dist = radius * (0.65 + (i % 3) * 0.18);
    const chunk = box(0.4 + (i % 2) * 0.3, 0.15, 0.4 + (i % 3) * 0.2, PROP_COLORS.concreteDark, Math.cos(ang) * dist, 0.08, Math.sin(ang) * dist, g);
    chunk.rotation.y = ang;
  }
  return g;
}

/** Stack of 3 black rubber vehicle tires. */
export function buildTireStack(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const tire = cyl(0.65, 0.38, 0x14161a, (i % 2 - 0.5) * 0.08, 0.19 + i * 0.38, (i % 3 - 1) * 0.06, g, 8);
    cyl(0.32, 0.4, PROP_COLORS.darkSteel, tire.position.x, tire.position.y, tire.position.z, g, 8);
  }
  return g;
}

/** Coiled steel razor wire barrier on stakes. */
export function buildRazorWire(length = 6): THREE.Group {
  const g = new THREE.Group();
  const stakes = Math.max(2, Math.floor(length / 2.2));
  for (let i = 0; i <= stakes; i++) {
    const x = -length / 2 + i * (length / stakes);
    // Dark steel picket stake
    box(0.12, 1.4, 0.12, PROP_COLORS.darkSteel, x, 0.7, 0, g);
    // Coil center
    cyl(0.45, 0.12, PROP_COLORS.steel, x, 0.55, 0, g, 8);
    cyl(0.45, 0.12, PROP_COLORS.steel, x, 1.05, 0, g, 8);
  }
  return g;
}

/** Red low-poly fire hydrant with yellow nozzle caps. */
export function buildFireHydrant(): THREE.Group {
  const g = new THREE.Group();
  cyl(0.24, 0.9, PROP_COLORS.red, 0, 0.45, 0, g, 8);
  cyl(0.3, 0.18, PROP_COLORS.red, 0, 0.85, 0, g, 8);
  box(0.16, 0.14, 0.75, PROP_COLORS.yellow, 0, 0.55, 0, g); // side nozzle caps
  return g;
}

/** Curved-neck streetlamp with downward warm light head. */
export function buildStreetLamp(): THREE.Group {
  const g = new THREE.Group();
  // Base & mast
  cyl(0.25, 0.6, PROP_COLORS.darkSteel, 0, 0.3, 0, g, 8);
  box(0.18, 5.6, 0.18, PROP_COLORS.darkSteel, 0, 2.8, 0, g);
  // Curved overhead arm extending toward roadway (+Z)
  box(0.16, 0.16, 1.8, PROP_COLORS.darkSteel, 0, 5.6, 0.9, g);
  // Downward lamp head
  const lampHead = createGlowBox(0.45, 0.22, 0.8, 0xfff0b8, 0.85);
  lampHead.position.set(0, 5.4, 1.6);
  g.add(lampHead);
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
