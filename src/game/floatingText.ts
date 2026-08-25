import * as THREE from 'three';

export type CombatTextType =
  | 'NORMAL'
  | 'CRITICAL'
  | 'SHIELD'
  | 'HEAVY'
  | 'XP'
  | 'SALVAGE'
  | 'CREDITS'
  | 'KILL_POP'
  | 'GROUP_KILL';

export type CombatTextLane = 'CENTER' | 'UPPER' | 'SIDE';

export interface FloatingText {
  id: number;
  active: boolean;
  type: CombatTextType;
  lane: CombatTextLane;
  priority: number; // 1 (Low: MG damage) to 4 (Highest: Boss/Elite kill)
  text: string;
  subText: string;
  value: number;
  hitCount: number;
  worldPos: THREE.Vector3;
  velocity: THREE.Vector3;
  age: number;
  maxAge: number;
  scale: number;
  punchScale: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number;
  targetEntityId: number | null;
  lastAggregatedTime: number;
  // Projected screen coordinates for collision avoidance
  screenX: number;
  screenY: number;
  screenDisplacementY: number;
  visible: boolean;
}

const TYPE_CONFIGS: Record<CombatTextType, {
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number;
  punchScale: number;
  duration: number;
  upwardSpeed: number;
  priority: number;
  lane: CombatTextLane;
}> = {
  NORMAL: {
    color: '#f0f2f5',
    strokeColor: '#05070a',
    strokeWidth: 3.5,
    fontSize: 18,
    punchScale: 1.25,
    duration: 0.55,
    upwardSpeed: 4.2,
    priority: 1,
    lane: 'CENTER',
  },
  CRITICAL: {
    color: '#ffd000',
    strokeColor: '#2b1200',
    strokeWidth: 4.0,
    fontSize: 22,
    punchScale: 1.45,
    duration: 0.70,
    upwardSpeed: 5.2,
    priority: 3,
    lane: 'CENTER',
  },
  SHIELD: {
    color: '#50ebff',
    strokeColor: '#001a33',
    strokeWidth: 3.5,
    fontSize: 18,
    punchScale: 1.25,
    duration: 0.55,
    upwardSpeed: 4.2,
    priority: 1,
    lane: 'CENTER',
  },
  HEAVY: {
    color: '#ff4d4d',
    strokeColor: '#200000',
    strokeWidth: 4.5,
    fontSize: 26,
    punchScale: 1.60,
    duration: 0.80,
    upwardSpeed: 5.8,
    priority: 3,
    lane: 'CENTER',
  },
  XP: {
    color: '#50ebff',
    strokeColor: '#001830',
    strokeWidth: 3.5,
    fontSize: 18,
    punchScale: 1.30,
    duration: 0.65,
    upwardSpeed: 4.8,
    priority: 2,
    lane: 'SIDE',
  },
  SALVAGE: {
    color: '#ffaa00',
    strokeColor: '#2b1500',
    strokeWidth: 3.5,
    fontSize: 19,
    punchScale: 1.35,
    duration: 0.75,
    upwardSpeed: 4.8,
    priority: 2,
    lane: 'SIDE',
  },
  CREDITS: {
    color: '#55f2a2',
    strokeColor: '#002611',
    strokeWidth: 4.0,
    fontSize: 20,
    punchScale: 1.40,
    duration: 0.80,
    upwardSpeed: 5.2,
    priority: 2,
    lane: 'SIDE',
  },
  KILL_POP: {
    color: '#ffd000',
    strokeColor: '#1a0d00',
    strokeWidth: 4.0,
    fontSize: 22,
    punchScale: 1.50,
    duration: 0.85,
    upwardSpeed: 5.5,
    priority: 4,
    lane: 'UPPER',
  },
  GROUP_KILL: {
    color: '#ffd000',
    strokeColor: '#1a0d00',
    strokeWidth: 4.5,
    fontSize: 22,
    punchScale: 1.55,
    duration: 1.05,
    upwardSpeed: 4.5,
    priority: 4,
    lane: 'UPPER',
  },
};

export class FloatingCombatTextManager {
  public static readonly MAX_ITEMS = 60;
  public static readonly BASE_AGGREGATION_WINDOW = 0.14; // 140ms standard window
  public static readonly REWARD_AGGREGATION_WINDOW = 0.24; // 240ms for XP/Salvage gem pickups
  public static readonly MAX_RENDER_DISTANCE = 340;
  public static readonly FULL_DETAIL_DISTANCE = 130;
  public static readonly FADE_DISTANCE = 230;

  private pool: FloatingText[] = [];
  private nextIndex = 0;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private readonly scratchProj = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      this.pool.push({
        id: i,
        active: false,
        type: 'NORMAL',
        lane: 'CENTER',
        priority: 1,
        text: '',
        subText: '',
        value: 0,
        hitCount: 0,
        worldPos: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        age: 0,
        maxAge: 0.6,
        scale: 1.0,
        punchScale: 1.25,
        color: '#ffffff',
        strokeColor: '#000000',
        strokeWidth: 3.5,
        fontSize: 18,
        targetEntityId: null,
        lastAggregatedTime: 0,
        screenX: 0,
        screenY: 0,
        screenDisplacementY: 0,
        visible: false,
      });
    }
  }

  /** Attach or initialize the 2D overlay canvas attached over the 3D canvas container */
  public attachCanvas(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /**
   * Spawn or aggregate a damage number at a target world position.
   * Uses damage aggregation per target enemy (~120-160ms window) to prevent
   * bullet-by-bullet spam during rapid machine gun and shotgun fire.
   */
  public spawnDamage(
    targetEntityId: number | null,
    pos: { x: number; y: number; z: number },
    amount: number,
    type: CombatTextType = 'NORMAL',
    time: number = 0,
    aggregationWindow: number = FloatingCombatTextManager.BASE_AGGREGATION_WINDOW,
  ) {
    if (amount <= 0.01) return;

    // Adapt aggregation window slightly under high density
    const activeCount = this.getActiveCount();
    const effectiveWindow = activeCount > 25 ? aggregationWindow * 1.3 : aggregationWindow;

    // 1. Check for rapid-fire aggregation on the same target entity
    if (targetEntityId !== null) {
      for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
        const item = this.pool[i];
        if (
          item.active &&
          item.targetEntityId === targetEntityId &&
          (item.lane === 'CENTER' || item.type === type) &&
          time - item.lastAggregatedTime <= effectiveWindow
        ) {
          item.value += amount;
          item.hitCount++;
          item.text = Math.round(item.value).toString();
          item.age = Math.min(item.age, 0.08); // Refresh lifetime so aggregated sum stays visible
          item.scale = Math.min(2.1, item.scale + 0.12); // Re-punch scale on subsequent hits

          // Upgrade type if damage becomes heavy
          if (type === 'HEAVY' || item.value >= 70) {
            item.type = 'HEAVY';
            item.color = TYPE_CONFIGS.HEAVY.color;
            item.fontSize = Math.max(item.fontSize, TYPE_CONFIGS.HEAVY.fontSize);
          } else if (type === 'CRITICAL' && item.type === 'NORMAL') {
            item.type = 'CRITICAL';
            item.color = TYPE_CONFIGS.CRITICAL.color;
          }

          item.lastAggregatedTime = time;

          // Deterministic minor offset (avoids random jitter while preventing perfect overlap)
          const detOffsetX = (((targetEntityId * 31 + item.hitCount * 7) % 15) - 7) * 0.06;
          item.worldPos.x = pos.x + detOffsetX;
          item.worldPos.z = pos.z;
          return;
        }
      }
    }

    // 2. Allocate a fresh number from pool
    const config = TYPE_CONFIGS[type] || TYPE_CONFIGS.NORMAL;
    const item = this.allocate(config.priority);

    item.active = true;
    item.type = type;
    item.lane = config.lane;
    item.priority = config.priority;
    item.value = amount;
    item.hitCount = 1;
    item.text = Math.round(amount).toString();
    item.subText = '';
    item.age = 0;
    item.maxAge = config.duration;
    item.scale = config.punchScale;
    item.punchScale = config.punchScale;
    item.color = config.color;
    item.strokeColor = config.strokeColor;
    item.strokeWidth = config.strokeWidth;
    item.fontSize = config.fontSize;
    item.targetEntityId = targetEntityId;
    item.lastAggregatedTime = time;
    item.screenDisplacementY = 0;

    // Vampire-Survivors style juicy fountain physics:
    // Numbers pop outwards in an arc with gravity deceleration
    const entitySeed = targetEntityId ?? Math.floor(pos.x * 13 + pos.z * 7);
    const angle = ((entitySeed * 37 + (item.id * 53)) % 360) * (Math.PI / 180);
    const spreadSpeed = 1.2 + Math.random() * 1.6;
    const initialUpward = config.upwardSpeed + Math.random() * 1.2;

    item.worldPos.set(pos.x, pos.y + 1.8, pos.z);
    item.velocity.set(Math.cos(angle) * spreadSpeed, initialUpward, Math.sin(angle) * spreadSpeed);
  }

  /**
   * Spawn reward text (XP / Salvage / Credits).
   * Aggregates rapid consecutive pickups (e.g. gem vacuums / multiple salvage boxes)
   * into a single clean counter.
   */
  public spawnReward(
    pos: { x: number; y: number; z: number },
    text: string,
    type: 'XP' | 'SALVAGE' | 'CREDITS' | 'KILL_POP',
    customColor?: string,
    numericValue?: number,
    time: number = performance.now() / 1000,
  ) {
    const config = TYPE_CONFIGS[type] || TYPE_CONFIGS.KILL_POP;
    const parsedVal = numericValue ?? this.extractNumericValue(text);

    // 1. Check for rapid pickup aggregation for XP / Salvage
    if (parsedVal !== null && (type === 'XP' || type === 'SALVAGE' || type === 'CREDITS')) {
      for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
        const item = this.pool[i];
        if (
          item.active &&
          item.type === type &&
          time - item.lastAggregatedTime <= FloatingCombatTextManager.REWARD_AGGREGATION_WINDOW &&
          item.worldPos.distanceToSquared(pos as THREE.Vector3) < 400
        ) {
          item.value += parsedVal;
          item.text = type === 'CREDITS' ? `+${Math.round(item.value)} CR` : `+${Math.round(item.value)} ${type}`;
          item.age = Math.min(item.age, 0.08); // Refresh lifetime
          item.scale = Math.min(1.85, item.scale + 0.15); // Punch scale
          item.lastAggregatedTime = time;
          item.worldPos.set(pos.x, pos.y + 2.5, pos.z);
          return;
        }
      }
    }

    // 2. Allocate fresh reward popup
    const item = this.allocate(config.priority);

    item.active = true;
    item.type = type;
    item.lane = config.lane;
    item.priority = config.priority;
    item.value = parsedVal ?? 0;
    item.hitCount = 1;
    item.text = text;
    item.subText = '';
    item.age = 0;
    item.maxAge = config.duration;
    item.scale = config.punchScale;
    item.punchScale = config.punchScale;
    item.color = customColor || config.color;
    item.strokeColor = config.strokeColor;
    item.strokeWidth = config.strokeWidth;
    item.fontSize = config.fontSize;
    item.targetEntityId = null;
    item.lastAggregatedTime = time;
    item.screenDisplacementY = 0;

    const laneOffsetY = type === 'KILL_POP' ? 3.4 : 2.5;
    item.worldPos.set(pos.x, pos.y + laneOffsetY, pos.z);
    item.velocity.set(0, config.upwardSpeed, 0);
  }

  /**
   * Spawn a grouped, high-visibility kill popup for special units
   * (e.g. "MISSILE CARRIER DESTROYED \n +6 XP  +12 SALVAGE").
   */
  public spawnGroupedKill(
    targetEntityId: number | null,
    pos: { x: number; y: number; z: number },
    title: string,
    subText: string = '',
    customColor: string = '#ffd000',
    time: number = performance.now() / 1000,
  ) {
    const config = TYPE_CONFIGS.GROUP_KILL;
    const item = this.allocate(config.priority);

    item.active = true;
    item.type = 'GROUP_KILL';
    item.lane = 'UPPER';
    item.priority = config.priority;
    item.value = 0;
    item.hitCount = 1;
    item.text = title;
    item.subText = subText;
    item.age = 0;
    item.maxAge = config.duration;
    item.scale = config.punchScale;
    item.punchScale = config.punchScale;
    item.color = customColor || config.color;
    item.strokeColor = config.strokeColor;
    item.strokeWidth = config.strokeWidth;
    item.fontSize = config.fontSize;
    item.targetEntityId = targetEntityId;
    item.lastAggregatedTime = time;
    item.screenDisplacementY = 0;

    item.worldPos.set(pos.x, pos.y + 3.6, pos.z);
    item.velocity.set(0, config.upwardSpeed, 0);
  }

  /** Update active floating numbers in world space with arcade physics */
  public update(delta: number) {
    const dt = Math.min(delta, 1.0);

    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      const item = this.pool[i];
      if (!item.active) continue;

      item.age += dt;
      if (item.age >= item.maxAge) {
        item.active = false;
        continue;
      }

      // Vampire Survivors physics: drift outward and float up with smooth gravity curve
      item.worldPos.x += item.velocity.x * dt;
      item.worldPos.y += item.velocity.y * dt;
      item.worldPos.z += item.velocity.z * dt;

      item.velocity.y = Math.max(0.8, item.velocity.y - 3.8 * dt);
      item.velocity.x *= (1 - 1.2 * dt);
      item.velocity.z *= (1 - 1.2 * dt);
    }
  }

  /** Render all active floating numbers onto the 2D overlay canvas with screen-space collision avoidance */
  public render(
    camera: THREE.Camera,
    width: number,
    height: number,
    dpr: number = 1,
    hitMarkerTimer: number = 0,
    hitMarkerPos: THREE.Vector3 | null = null,
  ) {
    if (!this.ctx || !this.canvas || width <= 0 || height <= 0) return;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width * dpr, height * dpr);

    // 1. Project all active items and calculate screen bounds
    const camPos = camera.position;
    const activeIndices: number[] = [];

    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      const item = this.pool[i];
      if (!item.active) {
        item.visible = false;
        continue;
      }

      const dist = camPos.distanceTo(item.worldPos);
      if (dist > FloatingCombatTextManager.MAX_RENDER_DISTANCE) {
        item.visible = false;
        continue;
      }

      // Distance LOD: skip tiny normal damage when very far away
      if (dist > FloatingCombatTextManager.FADE_DISTANCE && item.priority === 1 && item.value < 35) {
        item.visible = false;
        continue;
      }

      // Project world coords to NDC [-1, 1]
      this.scratchProj.copy(item.worldPos).project(camera);

      // In Three.js, valid visible NDC z is between -1 (near) and 1 (far).
      // Cull if behind camera near plane or beyond far plane
      if (this.scratchProj.z < -1 || this.scratchProj.z > 1) {
        item.visible = false;
        continue;
      }

      const sx = (this.scratchProj.x * 0.5 + 0.5) * width;
      const sy = (-this.scratchProj.y * 0.5 + 0.5) * height;

      // Viewport margin culling
      if (sx < -60 || sx > width + 60 || sy < -60 || sy > height + 60) {
        item.visible = false;
        continue;
      }

      item.screenX = sx;
      item.screenY = sy;
      item.screenDisplacementY = 0;
      item.visible = true;
      activeIndices.push(i);
    }

    if (activeIndices.length === 0) return;

    // 2. Screen-space lightweight collision avoidance between nearby labels
    const count = activeIndices.length;
    for (let i = 0; i < count; i++) {
      const idxA = activeIndices[i];
      const itemA = this.pool[idxA];
      if (!itemA.visible) continue;

      for (let j = i + 1; j < count; j++) {
        const idxB = activeIndices[j];
        const itemB = this.pool[idxB];
        if (!itemB.visible) continue;

        const dx = Math.abs(itemA.screenX - itemB.screenX);
        const effectiveSyA = itemA.screenY + itemA.screenDisplacementY;
        const effectiveSyB = itemB.screenY + itemB.screenDisplacementY;
        const dy = Math.abs(effectiveSyA - effectiveSyB);

        // If bounding boxes overlap significantly
        if (dx < 36 && dy < 20) {
          // Push lower-priority or newer entry upward (negative Y on screen)
          if (itemA.priority < itemB.priority || (itemA.priority === itemB.priority && itemA.age < itemB.age)) {
            itemA.screenDisplacementY = Math.max(-28, itemA.screenDisplacementY - 18);
          } else {
            itemB.screenDisplacementY = Math.max(-28, itemB.screenDisplacementY - 18);
          }
        }
      }
    }

    // 3. Render pass onto Canvas2D
    ctx.save();
    ctx.scale(dpr, dpr);

    for (let i = 0; i < count; i++) {
      const item = this.pool[activeIndices[i]];
      if (!item.visible) continue;

      const dist = camPos.distanceTo(item.worldPos);
      const progress = item.age / item.maxAge;

      // Scale punch: sharp punch at spawn, quickly settles to 1.0
      const punchDecay = Math.max(0, 1 - progress * 4.5);
      const currentPunch = 1.0 + (item.punchScale - 1.0) * punchDecay;

      // Distance scaling: crisp readable size
      const distScale = THREE.MathUtils.clamp(1.0 - (dist - 60) / 480, 0.72, 1.15);
      const totalScale = currentPunch * distScale;

      // Alpha: Solid for first 65%, then fades out cleanly
      const alpha = progress < 0.65 ? 1.0 : (1.0 - progress) / 0.35;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.translate(item.screenX, item.screenY + item.screenDisplacementY);
      ctx.scale(totalScale, totalScale);

      // Main Text
      ctx.font = `800 ${item.fontSize}px 'Barlow Condensed', 'Oxanium', sans-serif`;
      ctx.strokeStyle = item.strokeColor;
      ctx.lineWidth = item.strokeWidth;
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 2;
      ctx.strokeText(item.text, 0, 0);

      ctx.fillStyle = item.color;
      ctx.fillText(item.text, 0, 0);

      // Sub-text for grouped kill feedback (e.g. "+6 XP  +12 SALVAGE")
      if (item.subText) {
        const subFontSize = Math.max(12, item.fontSize * 0.65);
        ctx.font = `700 ${subFontSize}px 'Oxanium', 'Barlow Condensed', monospace`;
        ctx.strokeStyle = '#05080c';
        ctx.lineWidth = 3.0;
        ctx.strokeText(item.subText, 0, item.fontSize * 0.85);

        ctx.fillStyle = '#80f0ff';
        ctx.fillText(item.subText, 0, item.fontSize * 0.85);
      }

      ctx.restore();
    }

    // 4. Tactical Hitmarker Crosshair Feedback (4-tick diagonal pip at hit location)
    if (hitMarkerTimer && hitMarkerTimer > 0 && hitMarkerPos) {
      this.scratchProj.copy(hitMarkerPos).project(camera);
      if (this.scratchProj.z >= -1 && this.scratchProj.z <= 1) {
        const hx = (this.scratchProj.x * 0.5 + 0.5) * width;
        const hy = (-this.scratchProj.y * 0.5 + 0.5) * height;
        const hAlpha = Math.min(1.0, hitMarkerTimer / 0.08);

        ctx.save();
        ctx.translate(hx, hy);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.2;
        ctx.globalAlpha = hAlpha;

        const gap = 3.5;
        const len = 6.5;
        ctx.beginPath();
        ctx.moveTo(-gap, -gap);
        ctx.lineTo(-gap - len, -gap - len);
        ctx.moveTo(gap, -gap);
        ctx.lineTo(gap + len, -gap - len);
        ctx.moveTo(-gap, gap);
        ctx.lineTo(-gap - len, gap + len);
        ctx.moveTo(gap, gap);
        ctx.lineTo(gap + len, gap + len);
        ctx.stroke();

        ctx.restore();
      }
    }

    ctx.restore();
  }

  /** Reset all active numbers */
  public clear() {
    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      this.pool[i].active = false;
    }
  }

  /** Get count of active floating numbers */
  public getActiveCount(): number {
    let count = 0;
    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      if (this.pool[i].active) count++;
    }
    return count;
  }

  /** Get pool entry by index for testing/inspection */
  public getPoolItem(index: number): Readonly<FloatingText> {
    return this.pool[index];
  }

  /** Allocate an item from pool, with priority replacement if pool is exhausted */
  private allocate(requestedPriority: number = 1): FloatingText {
    // 1. Try to find an inactive slot
    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      const idx = (this.nextIndex + i) % FloatingCombatTextManager.MAX_ITEMS;
      if (!this.pool[idx].active) {
        this.nextIndex = (idx + 1) % FloatingCombatTextManager.MAX_ITEMS;
        return this.pool[idx];
      }
    }

    // 2. Pool full: find the oldest item with the lowest priority to recycle
    let lowestPriority = requestedPriority + 1;
    let oldestAge = -1;
    let victimIndex = this.nextIndex;

    for (let i = 0; i < FloatingCombatTextManager.MAX_ITEMS; i++) {
      const item = this.pool[i];
      if (item.priority < lowestPriority || (item.priority === lowestPriority && item.age > oldestAge)) {
        lowestPriority = item.priority;
        oldestAge = item.age;
        victimIndex = i;
      }
    }

    this.nextIndex = (victimIndex + 1) % FloatingCombatTextManager.MAX_ITEMS;
    return this.pool[victimIndex];
  }

  private extractNumericValue(text: string): number | null {
    const match = text.match(/\+?(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
}
