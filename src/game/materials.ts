import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Low-poly pass: a shared 3-stop toon gradient map. NearestFilter keeps the
// bands hard (lit face / midtone / shadow face), which is what makes flat-shaded
// boxes read as low-poly art instead of Lambert's smooth per-vertex gradients.
// IMPORTANT: three's toon shader samples it with coord = dotNL*0.5+0.5, so the
// BRIGHT texel must be at the RIGHT end (faces toward the sun = coord 1). An
// inverted array silently turned sunlit faces dark — the whole city read as a
// night scene.
const TOON_GRADIENT = (() => {
  const gradient = new THREE.DataTexture(new Uint8Array([130, 195, 255]), 3, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
})();

export function createLowPolyMaterial(colorHex: number) {
  // Note: r184 MeshToonMaterial has no flatShading flag (it extends Material
  // directly), so the faceted low-poly look comes from baking per-face normals
  // into the geometry (toNonIndexed + computeVertexNormals) instead.
  const material = new THREE.MeshToonMaterial({
    color: colorHex,
    gradientMap: TOON_GRADIENT,
    emissive: colorHex,
    emissiveIntensity: 0.025,
  });
  material.userData.baseColor = new THREE.Color(colorHex);
  return material;
}

// --- ENVIRONMENT PALETTE ---------------------------------------------------
// Stylized coastal & military warzone palette matching the reference diorama look:
// warm grey asphalt, crisp painted road markings, lush grass medians, golden sand,
// sparkling turquoise water, terracotta & warm tan facades, military olive & camo.
export const ENV_PALETTE = {
  /** Sidewalk / plaza concrete — warm sunlit concrete. */
  concrete: 0xc8bfaf,
  /** Dark concrete pads and curbs. */
  darkConcrete: 0x727782,
  /** Main avenue asphalt — warm mid-tone road grey. */
  asphalt: 0x5e636b,
  /** Side streets and secondary roads. */
  asphaltDark: 0x4a4e56,
  /** Road lane dividers, arrows, crosswalks — crisp off-white. */
  roadWhite: 0xf5f7fa,
  /** Road center lines, hazard stripes, arrows — warm amber yellow. */
  roadYellow: 0xf5ba2c,
  /** Road medians & planter lawns — lush tropical green grass. */
  grass: 0x4e9138,
  /** Darker foliage / shrub green. */
  grassDark: 0x3b7529,
  /** Coastal beach & desert ground — warm golden sand. */
  sand: 0xe5be82,
  /** Wet shoreline / compacted sand. */
  sandDark: 0xd4a86a,
  /** Coastal ocean & waterways — sparkling tropical turquoise. */
  water: 0x22a0dc,
  /** Deep water channels. */
  waterDeep: 0x167db8,
  /** Shoreline foam and surf edge. */
  waterFoam: 0xe6faff,
  /** Palm tree trunk — warm textured segmented bark. */
  palmTrunk: 0x6c492b,
  /** Palm fan fronds — vibrant emerald green. */
  palmFrond: 0x429e30,
  /** Palm fan fronds highlight — bright lime. */
  palmFrondLight: 0x56c242,
  /** Modern apartment concrete facade — warm tan. */
  facadeTan: 0xc7bcab,
  /** Light cream concrete facade. */
  facadeBeige: 0xd8cfc0,
  /** Warm sand concrete facade. */
  facadeWarm: 0xb8ac98,
  /** Bold horizontal accent paneling — terracotta / warm orange (matching reference). */
  accentOrange: 0xde5932,
  /** Signal / hazard red. */
  accentRed: 0xc7382c,
  /** Taxi / hazard yellow. */
  accentYellow: 0xebb828,
  /** Industrial metal / bridge steel — vibrant cobalt / steel blue. */
  industrialBlue: 0x346fa6,
  /** Weathered industrial metal. */
  industrialMetal: 0x5c6570,
  /** Generic rooftop tone — sun-baked grey-tan. */
  rooftop: 0x787d85,
  /** Soft glass accent for windows (cool contrast on warm facades). */
  glassAccent: 0x7faec2,
  /** Deep tinted window pane glass. */
  windowDark: 0x202a35,
  /** Muted military olive drab. */
  military: 0x4d5f36,
  /** Military camo shadow green. */
  militaryDark: 0x3c4a2a,
  /** Natural rock / cliff stone. */
  rock: 0x8a7f72,
} as const;

// --- SHARED POOLS -----------------------------------------------------------
// The city instantiates thousands of boxes per chunk. Sharing geometries and
// Lambert materials by (size, color) key cuts GPU allocations and GC pressure
// dramatically. Damage-darkening clones a shared material lazily per mesh, so
// shared instances are never mutated in place (see city.ts ensureMutableMaterial).

const boxGeometryCache = new Map<string, THREE.BufferGeometry>();
const lambertMaterialCache = new Map<number, THREE.MeshToonMaterial>();

/** Return a shared non-indexed box geometry for a snapped size. */
export function getBoxGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const key = `${width}|${height}|${depth}`;
  let geometry = boxGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
    geometry.computeVertexNormals();
    geometry.userData.shared = true;
    boxGeometryCache.set(key, geometry);
  }
  return geometry;
}

/** Return a shared toon material for a color (marked `shared` for clone-on-write). */
export function getLowPolyMaterial(colorHex: number): THREE.MeshToonMaterial {
  let material = lambertMaterialCache.get(colorHex);
  if (!material) {
    material = createLowPolyMaterial(colorHex);
    material.userData.shared = true;
    lambertMaterialCache.set(colorHex, material);
  }
  return material;
}

/** Low-poly box with a shared cached geometry and material. */
export function createBox(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
) {
  const mesh = new THREE.Mesh(getBoxGeometry(width, height, depth), getLowPolyMaterial(colorHex));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Merge a set of same-material boxes into one mesh (positions baked into the
 * geometry). Used to collapse a building's body + cap + setback tiers into a
 * single draw call. Returns null if nothing could be merged.
 */
export function mergeBoxMeshes(meshes: THREE.Mesh[]): THREE.Mesh | null {
  if (meshes.length === 0) return null;
  const geos: THREE.BufferGeometry[] = [];
  let material: THREE.Material | null = null;
  for (const m of meshes) {
    if (!(m.geometry instanceof THREE.BufferGeometry)) continue;
    let g = m.geometry.clone();
    if (g.index) g = g.toNonIndexed();
    g.translate(m.position.x, m.position.y, m.position.z);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const count = g.getAttribute('position').count;
    if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    for (const name in g.attributes) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') {
        g.deleteAttribute(name);
      }
    }
    geos.push(g);
    const single = Array.isArray(m.material) ? m.material[0] : m.material;
    if (single) material = single;
  }
  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged || !material) return null;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Recursively dispose an object's GPU resources (geometries + materials).
 *
 * Shared cached resources (marked `userData.shared = true` — box/cylinder
 * caches, Lambert/glow material caches, instanced bollard/barrier geometry)
 * are deliberately SKIPPED so disposing one chunk or entity can never break
 * another that still references the same buffer. Everything else (merged
 * building/road geometries, per-enemy rotor blur discs, power-up rings, …)
 * is unique and safe to dispose. `dispose()` is idempotent in three.js, so
 * the same material shared by several children may be disposed twice safely.
 */
export function disposeObject3D(root: THREE.Object3D) {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry;
    if (geometry instanceof THREE.BufferGeometry && !geometry.userData.shared) {
      geometry.dispose();
    }
    const material = (child as THREE.Mesh | THREE.Sprite).material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    if (material) {
      const list = Array.isArray(material) ? material : [material];
      for (const m of list) {
        if (m && !m.userData.shared) m.dispose();
      }
    }
  });
}

export function createGlowMaterial(colorHex: number, opacity = 0.72) {
  return new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// --- Vertex-color collapse --------------------------------------------------
// Static prop/building clusters are folded into ONE opaque mesh (toon shading,
// per-vertex colors) and optionally ONE additive glow mesh. Damage darkening
// still works: the shared toon material multiplies vertex colors by its own
// color, and the clone-on-write path keys off userData.baseColor (white here).
let vertexToonMaterial: THREE.MeshToonMaterial | null = null;

/** Shared toon material for vertex-color-collapsed static meshes. */
export function getVertexToonMaterial(): THREE.MeshToonMaterial {
  if (!vertexToonMaterial) {
    vertexToonMaterial = new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: TOON_GRADIENT,
      emissive: 0xffffff,
      emissiveIntensity: 0.02,
    });
    vertexToonMaterial.userData.shared = true;
    vertexToonMaterial.userData.baseColor = new THREE.Color(0xffffff);
  }
  return vertexToonMaterial;
}

let vertexGlowMaterial: THREE.MeshBasicMaterial | null = null;

/** Shared additive material for vertex-color-collapsed glow meshes. */
export function getVertexGlowMaterial(): THREE.MeshBasicMaterial {
  if (!vertexGlowMaterial) {
    vertexGlowMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    vertexGlowMaterial.userData.shared = true;
  }
  return vertexGlowMaterial;
}

const _collapseRel = new THREE.Matrix4();
const _collapseInv = new THREE.Matrix4();
const _collapseColor = new THREE.Color();

/**
 * Fold every static mesh under `root` into at most two meshes: one opaque
 * vertex-color mesh and one additive glow mesh. Original meshes are removed
 * from the graph; meshes flagged `userData.keepSeparate` (or under an
 * ancestor that is) or `userData.isBeacon` (pulsing lights, animated screens)
 * are left untouched. Returns the merged meshes (already parented to
 * `root`). `root` may be detached from the scene.
 *
 * `bakeGlow` (used for destructible buildings) folds additive glow parts
 * into the opaque mesh as bright vertex colors instead of a second draw
 * call — one mesh per building instead of two.
 */
export function collapseStaticMeshes(root: THREE.Object3D, bakeGlow = false): THREE.Mesh[] {
  const opaqueGeos: THREE.BufferGeometry[] = [];
  const glowGeos: THREE.BufferGeometry[] = [];
  const opaqueVictims: THREE.Mesh[] = [];
  const glowVictims: THREE.Mesh[] = [];

  root.updateMatrixWorld(true);
  _collapseInv.copy(root.matrixWorld).invert();

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || mesh instanceof THREE.InstancedMesh || child === root) return;
    if (mesh.userData.isBeacon) return;
    // keepSeparate works on the mesh OR any ancestor — whole subtrees (cars,
    // billboards, explosive props, destructible buildings) opt out as a unit.
    for (let a: THREE.Object3D | null = mesh; a && a !== root; a = a.parent) {
      if (a.userData.keepSeparate) return;
    }
    const material = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshBasicMaterial | THREE.MeshToonMaterial | THREE.MeshLambertMaterial | undefined;
    if (!material || !(mesh.geometry instanceof THREE.BufferGeometry)) return;
    const isGlow =
      material instanceof THREE.MeshBasicMaterial &&
      material.blending === THREE.AdditiveBlending;

    _collapseRel.multiplyMatrices(_collapseInv, mesh.matrixWorld);
    let geo = mesh.geometry.clone();
    if (geo.index) geo = geo.toNonIndexed();
    geo.applyMatrix4(_collapseRel);
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();

    _collapseColor.copy(material.color ?? _collapseColor.set(0xffffff));
    if (isGlow) {
      const opacity = material.opacity ?? 1;
      if (bakeGlow) {
        // Brighten instead of fade: over a dark facade a lit band reads as
        // emissive even without additive blending (1 mesh per building).
        _collapseColor.multiplyScalar(0.45 + opacity * 1.35);
      } else {
        _collapseColor.multiplyScalar(opacity);
      }
    }
    const count = geo.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = _collapseColor.r;
      colors[i * 3 + 1] = _collapseColor.g;
      colors[i * 3 + 2] = _collapseColor.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    if (!geo.getAttribute("uv")) {
      geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    for (const name in geo.attributes) {
      if (name !== "position" && name !== "normal" && name !== "uv" && name !== "color") {
        geo.deleteAttribute(name);
      }
    }

    if (isGlow && !bakeGlow) {
      glowGeos.push(geo);
      glowVictims.push(mesh);
    } else {
      opaqueGeos.push(geo);
      opaqueVictims.push(mesh);
    }
  });

  const merged: THREE.Mesh[] = [];
  const addMerged = (geos: THREE.BufferGeometry[], victims: THREE.Mesh[], material: THREE.Material) => {
    if (geos.length === 0) return;
    const combined = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!combined) {
      console.warn("collapseStaticMeshes: mergeGeometries failed, preserving original meshes");
      return;
    }
    for (const mesh of victims) mesh.parent?.remove(mesh);
    const mesh = new THREE.Mesh(combined, material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    root.add(mesh);
    merged.push(mesh);
  };
  addMerged(opaqueGeos, opaqueVictims, getVertexToonMaterial());
  addMerged(glowGeos, glowVictims, getVertexGlowMaterial());
  return merged;
}

// Pass 10: glow boxes used to mint a brand-new MeshBasicMaterial per mesh,
// which ballooned the scene to 800+ unique materials. Cached by (color, opacity)
// and marked `shared` so the existing clone-on-write systems (occlusion ghost,
// per-instance beacon/car-light pulsing) never mutate a cached material in place.
const glowMaterialCache = new Map<string, THREE.MeshBasicMaterial>();

export function getGlowMaterial(colorHex: number, opacity = 0.72): THREE.MeshBasicMaterial {
  // Round the opacity so float chains like opacity * 0.3 never split the cache.
  const op = Math.round(opacity * 100) / 100;
  const key = `${colorHex.toString(16)}|${op.toFixed(2)}`;
  let mat = glowMaterialCache.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: op,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    mat.userData.shared = true;
    mat.userData.baseOpacity = op;
    glowMaterialCache.set(key, mat);
  }
  return mat;
}

/** Low-poly box with an additive-blended glow material. */
export function createGlowBox(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
  opacity = 0.72,
) {
  const mesh = new THREE.Mesh(getBoxGeometry(width, height, depth), getGlowMaterial(colorHex, opacity));
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

// --- Sky Dome ---------------------------------------------------------------
// Coastal atmosphere: sunny clear cyan zenith fading to warm horizon.
export function createSkyDome(radius = 700): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 24, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x6caee2) },
      bottomColor: { value: new THREE.Color(0xdaf0fc) },
      sunColor: { value: new THREE.Color(0xfff4cf) },
      sunDirection: { value: new THREE.Vector3(-0.45, 0.72, 0.52).normalize() },
      sunGlowSize: { value: 0.045 },
      cloudColor: { value: new THREE.Color(0xffffff) },
      time: { value: 0 },
      offset: { value: 18 },
      exponent: { value: 0.65 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform vec3 sunColor;
      uniform vec3 sunDirection;
      uniform float sunGlowSize;
      uniform vec3 cloudColor;
      uniform float time;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;

      // Cheap procedural 2D hash for sky banding / cirrus streaks
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
      }

      void main() {
        vec3 dir = normalize(vWorldPosition);
        float h = normalize(vWorldPosition + offset).y;
        float f = max(pow(max(h, 0.0), exponent), 0.0);
        vec3 sky = mix(bottomColor, topColor, f);

        // Sun disc + radial haze
        float sunDot = max(dot(dir, sunDirection), 0.0);
        float sunGlow = pow(sunDot, 64.0) * 0.9;
        float sunCore = step(0.9992, sunDot) * 1.5;
        sky += sunColor * (sunGlow + sunCore);

        // Subtle high-altitude cirrus cloud streaks
        if (dir.y > 0.05) {
          vec2 cloudUv = dir.xz / (dir.y + 0.2) * 1.8 + vec2(time * 0.003, time * 0.001);
          float n = noise(cloudUv * 3.0) * 0.6 + noise(cloudUv * 6.0) * 0.4;
          float cloudMask = smoothstep(0.55, 0.78, n) * smoothstep(0.05, 0.35, dir.y) * 0.32;
          sky = mix(sky, cloudColor, cloudMask);
        }

        gl_FragColor = vec4(sky, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

// --- Prism / Wedge Geometry Cache -------------------------------------------
const prismGeometryCache = new Map<string, THREE.BufferGeometry>();

/** Return a shared low-poly triangular prism (e.g. for gables, road arrows, ramps). */
export function getPrismGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const key = `${width.toFixed(2)}|${height.toFixed(2)}|${depth.toFixed(2)}`;
  let geo = prismGeometryCache.get(key);
  if (!geo) {
    const hw = width / 2;
    const hd = depth / 2;
    const positions = new Float32Array([
      // Bottom face
      -hw, 0, -hd,   hw, 0, -hd,   hw, 0,  hd,
      -hw, 0, -hd,   hw, 0,  hd,  -hw, 0,  hd,
      // Front tri (at +hd)
      -hw, 0,  hd,   hw, 0,  hd,    0, height, hd,
      // Back tri (at -hd)
       hw, 0, -hd,  -hw, 0, -hd,    0, height, -hd,
      // Right slope
       hw, 0, -hd,   0, height, -hd,  0, height,  hd,
       hw, 0, -hd,   0, height,  hd,  hw, 0,  hd,
      // Left slope
      -hw, 0,  hd,   0, height,  hd,  0, height, -hd,
      -hw, 0,  hd,   0, height, -hd, -hw, 0, -hd,
    ]);
    geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
    geo.userData.shared = true;
    prismGeometryCache.set(key, geo);
  }
  return geo;
}

export function createPrism(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
) {
  const mesh = new THREE.Mesh(getPrismGeometry(width, height, depth), getLowPolyMaterial(colorHex));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Fake blob shadows ------------------------------------------------------
// shadowMap is disabled for perf, so entities get a radial-gradient decal on
// the street instead. One shared CanvasTexture; each mesh owns its material
// so per-instance opacity (altitude fade) never mutates shared state.
let blobShadowTexture: THREE.CanvasTexture | null = null;

function getBlobShadowTexture(): THREE.CanvasTexture {
  if (blobShadowTexture) return blobShadowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0, 0, 0, 0.55)");
  g.addColorStop(0.65, "rgba(0, 0, 0, 0.28)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  blobShadowTexture = new THREE.CanvasTexture(canvas);
  return blobShadowTexture;
}

/** Flat radial-gradient decal laid on the street under a flying entity. */
export function createBlobShadow(radius: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(radius * 2, radius * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: getBlobShadowTexture(),
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  return mesh;
}

const cylinderGeometryCache = new Map<string, THREE.BufferGeometry>();

/** Return a shared low-poly cylinder geometry (8-sided chunky silhouette). */
export function getCylinderGeometry(radius: number, height: number, radialSegments = 8): THREE.BufferGeometry {
  const key = `${radius.toFixed(2)}|${height.toFixed(2)}|${radialSegments}`;
  let geometry = cylinderGeometryCache.get(key);
  if (!geometry) {
    // Non-indexed + per-face normals = hard facets on every cylinder (same
    // trick as getBoxGeometry), so toon banding reads crisp on tanks/silos.
    geometry = new THREE.CylinderGeometry(radius, radius, height, radialSegments, 1)
      .toNonIndexed();
    geometry.computeVertexNormals();
    geometry.userData.shared = true;
    cylinderGeometryCache.set(key, geometry);
  }
  return geometry;
}

/** Low-poly vertical cylinder with a shared cached geometry/material. */
export function createCylinder(radius: number, height: number, colorHex: number, radialSegments = 8) {
  const mesh = new THREE.Mesh(getCylinderGeometry(radius, height, radialSegments), getLowPolyMaterial(colorHex));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
