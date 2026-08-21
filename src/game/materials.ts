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

// --- ENVIRONMENT PALETTE (Pass 8) ------------------------------------------
// A small reusable set of material families for the urban layer. City code
// should pull from here instead of scattering one-off hexes — the environment
// stays subdued so gameplay (tracers, explosions, pickups, enemy glows) keeps
// the saturated color budget.
export const ENV_PALETTE = {
  /** Sidewalk / plaza concrete — sun-bleached sand. */
  concrete: 0xc9ba8d,
  /** Dark concrete pads and plazas — packed dirt. */
  darkConcrete: 0xa29468,
  /** Dirt service roads — grand avenue. */
  asphalt: 0xb3a070,
  /** Darker dirt roads — side streets. */
  asphaltDark: 0x9c8a62,
  /** Industrial metal / sheds — weathered olive-drab. */
  industrialMetal: 0x84795b,
  /** Generic rooftop tone — sun-baked tan. */
  rooftop: 0x8f7d58,
  /** Soft glass accent for windows (cool contrast on warm facades). */
  glassAccent: 0xa8d0da,
  /** Muted military olive. */
  military: 0x5f6b3c,
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
    geos.push(m.geometry.clone().translate(m.position.x, m.position.y, m.position.z));
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
  const victims: THREE.Mesh[] = [];

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
    const geo = mesh.geometry.clone().applyMatrix4(_collapseRel);
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
    (isGlow && !bakeGlow ? glowGeos : opaqueGeos).push(geo);
    victims.push(mesh);
  });

  if (victims.length === 0) return [];
  for (const mesh of victims) mesh.parent?.remove(mesh);

  const merged: THREE.Mesh[] = [];
  const addMerged = (geos: THREE.BufferGeometry[], material: THREE.Material) => {
    if (geos.length === 0) return;
    const combined = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!combined) return;
    const mesh = new THREE.Mesh(combined, material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    root.add(mesh);
    merged.push(mesh);
  };
  addMerged(opaqueGeos, getVertexToonMaterial());
  addMerged(glowGeos, getVertexGlowMaterial());
  return merged;
}

// Pass 10: glow boxes used to mint a brand-new MeshBasicMaterial per mesh,
// which ballooned the scene to 800+ unique materials. Cached by (color, opacity)
// and marked `shared` so the existing clone-on-write systems (occlusion ghost,
// per-instance beacon/car-light pulsing) never mutate a cached material in place.
const glowMaterialCache = new Map<string, THREE.MeshBasicMaterial>();

export function getGlowMaterial(colorHex: number, opacity = 0.72): THREE.MeshBasicMaterial {
  // Round the opacity so float chains like opacity * 0.3 never split the cache.
  const key = `${colorHex}|${Math.round(opacity * 1000) / 1000}`;
  let material = glowMaterialCache.get(key);
  if (!material) {
    material = createGlowMaterial(colorHex, opacity);
    material.userData.shared = true;
    glowMaterialCache.set(key, material);
  }
  return material;
}

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

export function createSkyDome() {
  const geometry = new THREE.SphereGeometry(340, 32, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      // Desert dome: pale dry blue zenith fading to a dust haze horizon so the
      // scene reads as a bright desert day.
      topColor: { value: new THREE.Color(0x6fa3c4) },
      horizonColor: { value: new THREE.Color(0xe6d3a2) },
      sunColor: { value: new THREE.Color(0xffd98f) },
      // Warm glow pooled around the horizon line — the arcade sunrise feel.
      glowColor: { value: new THREE.Color(0xffc986) },
      // Seconds (scaled) — drives a slow halo breathe so the sky subtly moves.
      uTime: { value: 0 },
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
      uniform vec3 horizonColor;
      uniform vec3 sunColor;
      uniform vec3 glowColor;
      uniform float uTime;
      varying vec3 vWorldPosition;

      void main() {
        vec3 dir = normalize(vWorldPosition);

        // Zenith -> horizon gradient (bright dust-blue sky to warm sandy haze).
        float horizon = smoothstep(-0.12, 0.72, dir.y);
        vec3 color = mix(horizonColor, topColor, horizon);

        // Warm band hugging the horizon line (above AND below it), so distant
        // city silhouettes sit in a soft amber atmospheric pool.
        float warmBand = pow(max(0.0, 1.0 - abs(dir.y) * 1.25), 9.0);
        color += (horizonColor * 0.28 + glowColor * 0.5) * warmBand * 0.55;

        // Sun direction (kept aligned with the engine's sun disc + key light).
        vec3 sunDir = normalize(vec3(-0.38, 0.58, -0.72));
        float sunDot = max(dot(dir, sunDir), 0.0);
        // Layered halo: a tight bright core plus a wide, soft scattering pool.
        float sunCore = pow(sunDot, 52.0);
        float sunHalo = pow(sunDot, 9.0) * (0.85 + 0.15 * sin(uTime * 1.4));
        color += sunColor * (sunCore * 0.55 + sunHalo * 0.16);

        // A cool steel-blue band near the zenith top keeps the sky from reading
        // as a single flat wash (subtle, never dusk).
        float zenith = pow(max(0.0, dir.y), 3.0);
        color += topColor * zenith * 0.06;

        // Faint animated cirrus streaks high up — thin, banded, slowly drifting.
        // Opacity is low so it reads as atmosphere, not painted clouds.
        if (dir.y > 0.15) {
          float drift = uTime * 0.02;
          float streak = 0.5 + 0.5 * sin(
            dir.y * 46.0 + (dir.x + dir.z) * 24.0 + drift
          );
          streak *= streak;
          float h = smoothstep(0.15, 0.6, dir.y) * (1.0 - smoothstep(0.6, 1.0, dir.y));
          color += vec3(1.0, 0.98, 0.94) * streak * h * 0.045;
        }

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = "ArcadeSkyDome";
  dome.frustumCulled = false;
  return dome;
}

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
