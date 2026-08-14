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
  /** Sidewalk / plaza concrete (light warm gray). */
  concrete: 0x9aa0a3,
  /** Dark concrete pads and plazas. */
  darkConcrete: 0x4f525a,
  /** Warm asphalt — grand avenue (brightened for ground readability). */
  asphalt: 0x49454a,
  /** Darker asphalt — side streets (brightened for ground readability). */
  asphaltDark: 0x3d3a3f,
  /** Industrial metal / sheds. */
  industrialMetal: 0x5e6977,
  /** Generic rooftop tone. */
  rooftop: 0x636a74,
  /** Soft glass accent for windows. */
  glassAccent: 0xbcd6de,
  /** Muted military olive. */
  military: 0x4d5c3a,
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
      // Pass 8: deep slate top + warm haze horizon so the dome melts into the
      // warm fog — distant buildings fade to haze, never to cyan. Brightened
      // from 0x26395e so the scene reads daytime, not night.
      topColor: { value: new THREE.Color(0x3d5c8f) },
      horizonColor: { value: new THREE.Color(0xc6b398) },
      sunColor: { value: new THREE.Color(0xffc36b) },
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
      varying vec3 vWorldPosition;

      void main() {
        vec3 dir = normalize(vWorldPosition);
        float horizon = smoothstep(-0.12, 0.72, dir.y);
        vec3 color = mix(horizonColor, topColor, horizon);
        float sun = pow(max(dot(dir, normalize(vec3(-0.38, 0.58, -0.72))), 0.0), 52.0);
        color += sunColor * sun * 0.55;
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
