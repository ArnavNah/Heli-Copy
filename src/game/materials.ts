import * as THREE from "three";

// --- SHADERS ---

const LowPolyVert = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalMatrix * normal;
      vViewPosition = -mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const LowPolyFrag = `
  uniform vec3 baseColor;
  uniform float uDamage; // 0.0 to 1.0 range for visuals
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
      vec3 normal = normalize(vNormal);
      vec3 viewDir = normalize(vViewPosition);

      // Lights
      vec3 keyLightDir = normalize(vec3(0.5, 1.0, 0.5));
      vec3 fillLightDir = normalize(vec3(-0.5, 0.2, -0.5));
      
      float keyDiff = max(dot(normal, keyLightDir), 0.0);
      float fillDiff = max(dot(normal, fillLightDir), 0.0) * 0.3;
      float ambient = 0.3;

      // Stylized Rim Light
      float rim = 1.0 - max(dot(viewDir, normal), 0.0);
      rim = smoothstep(0.65, 1.0, rim);

      vec3 lighting = vec3(keyDiff + fillDiff + ambient);
      
      // Darken color based on damage
      vec3 damagedColor = mix(baseColor, vec3(0.05, 0.05, 0.08), uDamage * 0.85);
      vec3 color = damagedColor * lighting + vec3(0.8, 0.9, 1.0) * rim * (0.5 * (1.0 - uDamage * 0.5));
      
      gl_FragColor = vec4(color, 1.0);
  }
`;

export function createLowPolyMaterial(colorHex: number) {
  const material = new THREE.MeshLambertMaterial({
    color: colorHex,
    flatShading: true,
    emissive: colorHex,
    emissiveIntensity: 0.025,
  });
  material.userData.baseColor = new THREE.Color(colorHex);
  return material;
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

export function createGlowBox(
  width: number,
  height: number,
  depth: number,
  colorHex: number,
  opacity = 0.72,
) {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, createGlowMaterial(colorHex, opacity));
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
      topColor: { value: new THREE.Color(0x1f4f97) },
      horizonColor: { value: new THREE.Color(0x78cfe0) },
      sunColor: { value: new THREE.Color(0xffc66d) },
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
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed();
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, createLowPolyMaterial(colorHex));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
