import * as THREE from "three";
import { FOG_CLEAR_COLOR, FOG_STORM_COLOR, FOG_NEAR, FOG_FAR, SKY_CLEAR_COLOR, SKY_STORM_COLOR } from "./types";

const ParticleVert = `
  attribute vec3 velocity;
  attribute float startTime;
  attribute float pType;
  uniform float uTime;
  varying float vLife;
  varying float vType;

  void main() {
      float lifeTime = max(0.0, uTime - startTime);
      float duration = pType == 1.0 ? 2.2 : (pType == 2.0 ? 0.4 : (pType == 3.0 ? 1.6 : 1.0)); // Smoke longest, sparks fastest, debris in between
      vLife = max(0.0, 1.0 - (lifeTime / duration)); 
      vType = pType;
      
      vec3 currentPos = position + velocity * lifeTime;
      // Gravity affects sparks (type 2), explosions (type 0) and debris (type 3); smoke (type 1) rises
      float gravMult = pType == 1.0 ? -2.0 : (pType == 3.0 ? 16.0 : 9.8);
      currentPos.y -= gravMult * lifeTime * lifeTime;

      vec4 mvPosition = modelViewMatrix * vec4(currentPos, 1.0);
      
      // Sizes based on type
      float sizeMult = pType == 1.0 ? 38.0 : (pType == 2.0 ? 6.5 : (pType == 3.0 ? 7.0 : 24.0));
      gl_PointSize = (sizeMult * vLife) * (100.0 / length(mvPosition.xyz));
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const ParticleFrag = `
  varying float vLife;
  varying float vType;
  void main() {
      if (vLife <= 0.0) discard;
      vec2 coord = gl_PointCoord - vec2(0.5);
      float dist = length(coord);
      if(dist > 0.5) discard;
      float softDisc = smoothstep(0.5, 0.08, dist);
      
      vec3 color;
      float alpha = vLife * 0.8 * softDisc;

      if (vType == 1.0) {
          // Smoke (starts grey, fades to dark)
          color = mix(vec3(0.04, 0.045, 0.055), vec3(0.36, 0.38, 0.42), vLife);
          alpha = vLife * 0.42 * softDisc;
      } else if (vType == 2.0) {
          // Sparks (white to orange)
          vec3 sparkStart = vec3(1.0, 1.0, 0.8);
          vec3 sparkEnd = vec3(1.0, 0.3, 0.0);
          color = mix(sparkEnd, sparkStart, vLife);
          alpha = vLife * softDisc;
      } else if (vType == 3.0) {
          // Debris chunks (dark, fall fast, catch fire at the start)
          vec3 debrisStart = vec3(0.05, 0.05, 0.06);
          vec3 debrisEnd = vec3(0.34, 0.3, 0.28);
          color = mix(debrisEnd, debrisStart, vLife);
          color += vec3(1.0, 0.45, 0.05) * pow(1.0 - dist * 2.0, 2.0) * max(0.0, vLife - 0.75);
          alpha = vLife * 0.95 * softDisc;
      } else {
          // Default Explosion
          vec3 startColor = vec3(1.0, 0.96, 0.72); // White-Hot
          vec3 midColor = vec3(1.0, 0.36, 0.04);   // Orange
          vec3 endColor = vec3(0.16, 0.17, 0.2);   // Smoke
          color = mix(endColor, midColor, smoothstep(0.0, 0.5, vLife));
          color = mix(color, startColor, smoothstep(0.5, 1.0, vLife));
          color += vec3(1.0, 0.12, 0.02) * pow(1.0 - dist * 2.0, 3.0) * vLife;
      }
      
      gl_FragColor = vec4(color, alpha);
  }
`;

const RainVert = `
  attribute vec3 velocity;
  attribute float startTime;
  uniform float uTime;
  uniform vec3 uPlayerPos;
  varying float vLife;

  void main() {
      float lifeTime = mod(uTime - startTime, 2.0); // 2 sec loop
      vLife = step(0.0, lifeTime);
      
      // Infinite rain box around player
      vec3 pos = position + velocity * lifeTime;
      vec3 boxSize = vec3(100.0, 60.0, 100.0);
      pos = mod(pos - uPlayerPos + boxSize * 0.5, boxSize) - boxSize * 0.5 + uPlayerPos;

      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      gl_PointSize = 2.8 * (100.0 / length(mvPosition.xyz));
      gl_Position = projectionMatrix * mvPosition;
  }
`;

const RainFrag = `
  varying float vLife;
  void main() {
      vec2 coord = abs(gl_PointCoord - vec2(0.5));
      float streak = smoothstep(0.5, 0.02, coord.x) * smoothstep(0.5, 0.0, coord.y);
      gl_FragColor = vec4(0.58, 0.78, 1.0, 0.48 * streak);
  }
`;

// --- SYSTEMS ---

export class RainSystem {
  mesh: THREE.Points;
  uniforms: { uTime: { value: number }; uPlayerPos: { value: THREE.Vector3 } };

  constructor(count = 2000) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const startTimes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = Math.random() * 60;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 100;

      velocities[i * 3] = -2.0; // slight wind slant
      velocities[i * 3 + 1] = -40.0;
      velocities[i * 3 + 2] = 0.0;

      startTimes[i] = Math.random() * 2.0;
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("velocity", new THREE.BufferAttribute(velocities, 3));
    geometry.setAttribute(
      "startTime",
      new THREE.BufferAttribute(startTimes, 1),
    );

    this.uniforms = {
      uTime: { value: 0.0 },
      uPlayerPos: { value: new THREE.Vector3() },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: RainVert,
      fragmentShader: RainFrag,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(geometry, material);
    this.mesh.frustumCulled = false;
  }

  update(time: number, playerPos: THREE.Vector3) {
    this.uniforms.uTime.value = time;
    this.uniforms.uPlayerPos.value.copy(playerPos);
  }
}

export class WeatherSystem {
  stormIntensity: number = 0; // 0 to 1
  targetIntensity: number = 0;
  windForce: THREE.Vector3 = new THREE.Vector3();
  fogColor: number = 0x06111a;
  lastLightningTime: number = 0;
  isLightning: boolean = false;
  private clearColor = new THREE.Color(SKY_CLEAR_COLOR);
  private stormColor = new THREE.Color(SKY_STORM_COLOR);
  private clearFog = new THREE.Color(FOG_CLEAR_COLOR);
  private stormFog = new THREE.Color(FOG_STORM_COLOR);
  private tempColor = new THREE.Color();
  // Pass 8: the sky dome's warm haze horizon cools with the storm so distant
  // buildings fade into a matching haze instead of warm-on-cool at the horizon.
  private domeClear = new THREE.Color(0xc6b398);
  private domeStorm = new THREE.Color(0x3a4252);
  private tempDome = new THREE.Color();

  update(time: number, delta: number, scene: THREE.Scene) {
    // Transition intensity
    this.stormIntensity +=
      (this.targetIntensity - this.stormIntensity) * delta * 0.1;

    // Fog management (low-poly pass): the scene uses a linear fog band with a
    // completely clear near-field; storms pull the far plane in and darken the
    // color, capped low enough that skyscraper silhouettes and enemy glows
    // keep their separation.
    const fog = scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.density = 0.004 + this.stormIntensity * 0.0046;
    } else if (fog instanceof THREE.Fog) {
      fog.near = FOG_NEAR;
      fog.far = Math.max(FOG_FAR - this.stormIntensity * 90, FOG_NEAR + 60);
    }
    fog.color.copy(this.tempColor.copy(this.clearFog).lerp(this.stormFog, this.stormIntensity));
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(this.tempColor.copy(this.clearColor).lerp(this.stormColor, this.stormIntensity * 0.82));
    }

    // Pass 8: cool the sky dome horizon with the storm (see fields above).
    const dome = scene.getObjectByName('ArcadeSkyDome');
    const domeMat = dome ? ((dome as THREE.Mesh).material as THREE.ShaderMaterial) : null;
    if (domeMat && domeMat.uniforms?.horizonColor) {
      domeMat.uniforms.horizonColor.value.copy(
        this.tempDome.copy(this.domeClear).lerp(this.domeStorm, this.stormIntensity),
      );
    }

    // Wind Turbulance
    const windScale = this.stormIntensity * 150;
    this.windForce.set(
      Math.sin(time * 0.5) * windScale + Math.sin(time * 2.1) * windScale * 0.5,
      0,
      Math.cos(time * 0.4) * windScale + Math.cos(time * 1.8) * windScale * 0.5,
    );

    // Lightning logic
    this.isLightning = false;
    if (this.stormIntensity > 0.4) {
      const chance = delta * (0.05 + this.stormIntensity * 0.2);
      if (Math.random() < chance && time - this.lastLightningTime > 2.0) {
        this.isLightning = true;
        this.lastLightningTime = time;
      }
    }
  }
}

export class GPUParticleSystem {
  mesh: THREE.Points;
  maxParticles: number;
  positionAttr: THREE.BufferAttribute;
  velocityAttr: THREE.BufferAttribute;
  startTimeAttr: THREE.BufferAttribute;
  pTypeAttr: THREE.BufferAttribute;
  currentIndex: number = 0;
  uniforms: { uTime: { value: number } };

  constructor(maxParticles = 5000) {
    this.maxParticles = maxParticles;
    const geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(maxParticles * 3);
    const velocities = new Float32Array(maxParticles * 3);
    const startTimes = new Float32Array(maxParticles);
    const pTypes = new Float32Array(maxParticles);

    for (let i = 0; i < maxParticles; i++) {
      startTimes[i] = -9999.0;
      pTypes[i] = 0.0;
    }

    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.velocityAttr = new THREE.BufferAttribute(velocities, 3);
    this.startTimeAttr = new THREE.BufferAttribute(startTimes, 1);
    this.pTypeAttr = new THREE.BufferAttribute(pTypes, 1);

    geometry.setAttribute("position", this.positionAttr);
    geometry.setAttribute("velocity", this.velocityAttr);
    geometry.setAttribute("startTime", this.startTimeAttr);
    geometry.setAttribute("pType", this.pTypeAttr);

    this.uniforms = { uTime: { value: 0.0 } };

    const material = new THREE.ShaderMaterial({
      vertexShader: ParticleVert,
      fragmentShader: ParticleFrag,
      uniforms: this.uniforms,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(geometry, material);
    this.mesh.matrixAutoUpdate = false;
  }

  spawnExplosion(
    x: number,
    y: number,
    z: number,
    count = 50,
    now = 0,
    speedMult = 20,
  ) {
    for (let i = 0; i < count; i++) {
      const idx = this.currentIndex;
      this.positionAttr.setXYZ(idx, x, y, z);

      const vX = (Math.random() - 0.5) * speedMult;
      const vY = (Math.random() - 0.5) * speedMult + speedMult * 0.5;
      const vZ = (Math.random() - 0.5) * speedMult;

      this.velocityAttr.setXYZ(idx, vX, vY, vZ);
      this.startTimeAttr.setX(idx, now - Math.random() * 0.1); // slight jitter
      this.pTypeAttr.setX(idx, 0.0); // Explosion type

      this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    }

    this.updateAttrs();
  }

  spawnSmoke(x: number, y: number, z: number, now: number) {
    const idx = this.currentIndex;
    this.positionAttr.setXYZ(idx, x, y, z);
    this.velocityAttr.setXYZ(
      idx,
      (Math.random() - 0.5) * 3,
      Math.random() * 4 + 2,
      (Math.random() - 0.5) * 3,
    );
    this.startTimeAttr.setX(idx, now - Math.random() * 0.2);
    this.pTypeAttr.setX(idx, 1.0); // Smoke type
    this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    this.updateAttrs();
  }

  /** Rotor-downwash dust — smoke-type puffs kicked outward from the ground
   *  so low hovers visibly stir the terrain. Outward velocity + the smoke
   *  buoyancy term make them roll up and away like real wash. */
  spawnDust(x: number, y: number, z: number, now: number) {
    const idx = this.currentIndex;
    const ang = Math.random() * Math.PI * 2;
    const out = 6 + Math.random() * 7;
    this.positionAttr.setXYZ(idx, x, y, z);
    this.velocityAttr.setXYZ(
      idx,
      Math.cos(ang) * out,
      1.2 + Math.random() * 2.2,
      Math.sin(ang) * out,
    );
    this.startTimeAttr.setX(idx, now - Math.random() * 0.15);
    this.pTypeAttr.setX(idx, 1.0); // Smoke type
    this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    this.updateAttrs();
  }

  spawnSparks(x: number, y: number, z: number, now: number, count = 3, speed = 15) {
    for (let i = 0; i < count; i++) {
      const idx = this.currentIndex;
      this.positionAttr.setXYZ(idx, x, y, z);
      this.velocityAttr.setXYZ(
        idx,
        (Math.random() - 0.5) * speed,
        Math.random() * speed + 5,
        (Math.random() - 0.5) * speed,
      );
      this.startTimeAttr.setX(idx, now);
      this.pTypeAttr.setX(idx, 2.0); // Spark type
      this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    }
    this.updateAttrs();
  }

  /** Debris chunks — dark heavy fragments that fly out with strong gravity and
   *  fade over ~1.6s. Reuses the type-3 shader branch. Cheap: N attribute
   *  writes per call, no allocations. */
  spawnDebris(x: number, y: number, z: number, now: number, count = 10, speed = 24) {
    for (let i = 0; i < count; i++) {
      const idx = this.currentIndex;
      this.positionAttr.setXYZ(idx, x, y, z);
      this.velocityAttr.setXYZ(
        idx,
        (Math.random() - 0.5) * speed,
        Math.random() * speed * 0.8 + 4,
        (Math.random() - 0.5) * speed,
      );
      this.startTimeAttr.setX(idx, now - Math.random() * 0.08);
      this.pTypeAttr.setX(idx, 3.0); // Debris type
      this.currentIndex = (this.currentIndex + 1) % this.maxParticles;
    }
    this.updateAttrs();
  }

  updateAttrs() {
    this.positionAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.startTimeAttr.needsUpdate = true;
    this.pTypeAttr.needsUpdate = true;
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
  }
}

export class VolumetricExplosions {
  // Shared color constants (were allocated per frame in update()).
  private static readonly COLOR_WHITE = new THREE.Color(0xffffff);
  private static readonly COLOR_YELLOW = new THREE.Color(0xffaa00);
  private static readonly COLOR_ORANGE = new THREE.Color(0xff3300);
  private static readonly COLOR_GRAY = new THREE.Color(0x222222);
  private static readonly COLOR_TEMP = new THREE.Color();

  mesh: THREE.InstancedMesh;
  maxParticles: number;
  dummy = new THREE.Object3D();
  
  scales: Float32Array;
  lifetimes: Float32Array;
  maxLifetimes: Float32Array;
  activeFlags: Uint8Array;
  
  constructor(scene: THREE.Scene, maxParticles = 400) {
    this.maxParticles = maxParticles;
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    
    this.mesh = new THREE.InstancedMesh(geometry, material, maxParticles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxParticles * 3), 3);
    
    this.scales = new Float32Array(maxParticles);
    this.lifetimes = new Float32Array(maxParticles);
    this.maxLifetimes = new Float32Array(maxParticles);
    this.activeFlags = new Uint8Array(maxParticles);
    
    for(let i=0; i<maxParticles; i++) {
      this.dummy.position.set(0,-9999,0);
      this.dummy.scale.set(0,0,0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      this.activeFlags[i] = 0;
    }
    
    scene.add(this.mesh);
  }
  
  spawn(x: number, y: number, z: number, count: number, size: number) {
    let spawned = 0;
    for(let i=0; i<this.maxParticles && spawned < count; i++) {
      if (this.activeFlags[i] === 0) {
        this.activeFlags[i] = 1;
        this.lifetimes[i] = 0;
        this.maxLifetimes[i] = 0.5 + Math.random() * 0.7;
        this.scales[i] = size * (0.5 + Math.random() * 1.5);
        
        this.dummy.position.set(
          x + (Math.random() - 0.5) * size * 1.5,
          y + (Math.random() - 0.5) * size * 1.5,
          z + (Math.random() - 0.5) * size * 1.5
        );
        this.dummy.scale.set(0.1, 0.1, 0.1);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        
        spawned++;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  
  update(delta: number) {
    let needsUpdate = false;
    // Hoisted out of the per-frame path — these used to allocate every frame.
    const colorWhite = VolumetricExplosions.COLOR_WHITE;
    const colorYellow = VolumetricExplosions.COLOR_YELLOW;
    const colorOrange = VolumetricExplosions.COLOR_ORANGE;
    const colorGray = VolumetricExplosions.COLOR_GRAY;
    const tempColor = VolumetricExplosions.COLOR_TEMP;
    
    for(let i=0; i<this.maxParticles; i++) {
      if (this.activeFlags[i] === 1) {
        needsUpdate = true;
        this.lifetimes[i] += delta;
        const lifeRatio = this.lifetimes[i] / this.maxLifetimes[i];
        
        if (lifeRatio >= 1.0) {
          this.activeFlags[i] = 0;
          this.dummy.scale.set(0,0,0);
          this.dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this.dummy.matrix);
        } else {
          const scaleCurve = lifeRatio < 0.2 ? lifeRatio * 5.0 : 1.0 - (lifeRatio - 0.2) * 0.5;
          const s = this.scales[i] * scaleCurve;
          
          this.mesh.getMatrixAt(i, this.dummy.matrix);
          this.dummy.matrix.decompose(this.dummy.position, this.dummy.quaternion, this.dummy.scale);
          this.dummy.position.y += delta * 4.0;
          this.dummy.scale.set(s,s,s);
          this.dummy.updateMatrix();
          this.mesh.setMatrixAt(i, this.dummy.matrix);
          
          if (lifeRatio < 0.1) tempColor.copy(colorWhite);
          else if (lifeRatio < 0.3) tempColor.lerpColors(colorWhite, colorYellow, (lifeRatio-0.1)/0.2);
          else if (lifeRatio < 0.5) tempColor.lerpColors(colorYellow, colorOrange, (lifeRatio-0.3)/0.2);
          else tempColor.lerpColors(colorOrange, colorGray, (lifeRatio-0.5)/0.5);
          
          this.mesh.setColorAt(i, tempColor);
        }
      }
    }
    
    if (needsUpdate) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

/**
 * Expanding dust shockwave rings — flat additive rings that scale outward and
 * fade in under a second. Pooled; one mesh per live ring (max 8 concurrent),
 * spawned by building collapses, bombs and the Devastation super.
 */
export class ShockwaveRings {
  private static readonly MAX_RINGS = 8;
  private rings: {
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    active: boolean;
    bornAt: number;
    maxRadius: number;
    duration: number;
  }[] = [];

  constructor(private scene: THREE.Scene) {
    const geometry = new THREE.RingGeometry(0.82, 1, 40);
    geometry.rotateX(-Math.PI / 2); // lie flat on the ground plane
    for (let i = 0; i < ShockwaveRings.MAX_RINGS; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xd8c9a2,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.rings.push({ mesh, material, active: false, bornAt: 0, maxRadius: 30, duration: 0.8 });
    }
  }

  /** Fire a ring. `now` in wall-clock seconds (matches the particle system). */
  spawn(x: number, y: number, z: number, now: number, maxRadius = 30, color = 0xd8c9a2, duration = 0.8) {
    const slot = this.rings.find((r) => !r.active);
    if (!slot) return; // pool exhausted — rings are pure garnish, drop silently
    slot.active = true;
    slot.bornAt = now;
    slot.maxRadius = maxRadius;
    slot.duration = duration;
    slot.material.color.setHex(color);
    slot.mesh.position.set(x, Math.max(0.35, y), z);
    slot.mesh.visible = true;
  }

  update(now: number) {
    for (const ring of this.rings) {
      if (!ring.active) continue;
      const p = (now - ring.bornAt) / ring.duration;
      if (p >= 1) {
        ring.active = false;
        ring.mesh.visible = false;
        continue;
      }
      // Ease-out expansion: fast start, gentle settle — reads as a pressure wave.
      const eased = 1 - (1 - p) * (1 - p);
      const radius = Math.max(0.01, ring.maxRadius * eased);
      ring.mesh.scale.set(radius, 1, radius);
      ring.material.opacity = 0.55 * (1 - p);
    }
  }

  dispose() {
    for (const ring of this.rings) {
      this.scene.remove(ring.mesh);
      ring.material.dispose();
    }
    // Geometry is shared across rings — dispose once via the first mesh.
    if (this.rings.length > 0) this.rings[0].mesh.geometry.dispose();
    this.rings = [];
  }
}
