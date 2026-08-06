import * as THREE from "three";
import { FOG_CLEAR_COLOR, FOG_STORM_COLOR, SKY_CLEAR_COLOR, SKY_STORM_COLOR } from "./types";

const ParticleVert = `
  attribute vec3 velocity;
  attribute float startTime;
  attribute float pType;
  uniform float uTime;
  varying float vLife;
  varying float vType;

  void main() {
      float lifeTime = max(0.0, uTime - startTime);
      float duration = pType == 1.0 ? 2.0 : (pType == 2.0 ? 0.4 : 1.0); // Smoke lives longer, sparks die fast
      vLife = max(0.0, 1.0 - (lifeTime / duration)); 
      vType = pType;
      
      vec3 currentPos = position + velocity * lifeTime;
      // Gravity affects sparks (type 2) and explosions (type 0), but smoke (type 1) rises
      float gravMult = pType == 1.0 ? -2.0 : 9.8; 
      currentPos.y -= gravMult * lifeTime * lifeTime;

      vec4 mvPosition = modelViewMatrix * vec4(currentPos, 1.0);
      
      // Sizes based on type
      float sizeMult = pType == 1.0 ? 38.0 : (pType == 2.0 ? 6.5 : 24.0);
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
  uniforms: any;

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

  update(time: number, delta: number, scene: THREE.Scene) {
    // Transition intensity
    this.stormIntensity +=
      (this.targetIntensity - this.stormIntensity) * delta * 0.1;

    // Fog management
    // Cap maximum fog density at 0.011 so skyscraper silhouettes stay visible during heavy storms
    const fogDensity = 0.0058 + this.stormIntensity * 0.0052;
    const fog = scene.fog as THREE.FogExp2;
    fog.density = fogDensity;
    fog.color.copy(this.tempColor.copy(this.clearFog).lerp(this.stormFog, this.stormIntensity));
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(this.tempColor.copy(this.clearColor).lerp(this.stormColor, this.stormIntensity * 0.82));
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
  uniforms: any;

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

  spawnSparks(x: number, y: number, z: number, now: number) {
    for (let i = 0; i < 3; i++) {
      const idx = this.currentIndex;
      this.positionAttr.setXYZ(idx, x, y, z);
      this.velocityAttr.setXYZ(
        idx,
        (Math.random() - 0.5) * 15,
        Math.random() * 15 + 5,
        (Math.random() - 0.5) * 15,
      );
      this.startTimeAttr.setX(idx, now);
      this.pTypeAttr.setX(idx, 2.0); // Spark type
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
    const colorWhite = new THREE.Color(0xffffff);
    const colorYellow = new THREE.Color(0xffaa00);
    const colorOrange = new THREE.Color(0xff3300);
    const colorGray = new THREE.Color(0x222222);
    const tempColor = new THREE.Color();
    
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
