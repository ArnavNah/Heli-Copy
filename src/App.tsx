import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  EnemyVariant,
  GameEngine,
  HANGAR_UPGRADE_INFO,
  HelicopterModel,
  buyHangarUpgrade,
  readDeliveryCredits,
  readHangarUpgrades,
} from './game';
import type {
  DeliveryHudSnapshot,
  GameSettings,
  HangarUpgradeId,
  HangarUpgrades,
  MinimapSnapshot,
  UpgradeId,
  UpgradeOption,
} from './game';
import { readMastery } from './game/logic';
import { formatDuration } from './game/logic';

type GameMode = 'menu' | 'playing' | 'paused' | 'gameover';

type RunStats = {
  time: number;
  kills: number;
  maxCombo: number;
  accuracy: number;
  wave: number;
  status?: 'DESTROYED' | 'EXTRACTED';
  threatLevel?: number;
  deliveries?: number;
  samSitesDestroyed?: number;
  lostUnsecured?: number;
  securedThreatBonus?: number;
};

type PerfStats = {
  fps: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  quality: string;
  enemies: number;
  powerups: number;
  objectives: number;
};

type StickPayload = { x: number; y: number; active: boolean };

const DEFAULT_SETTINGS: GameSettings = {
  invertedY: false,
  gamepadSensitivity: 1.5,
  quality: 'low',
  volume: 0.8,
  touchMode: false,
  difficulty: 'normal',
  autoAim: false,
};

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function readHighScore() {
  const stored = Number(window.localStorage.getItem('helistrike:highScore') ?? 0);
  return Number.isFinite(stored) ? stored : 0;
}

function readSettings(): GameSettings {
  try {
    const raw = window.localStorage.getItem('helistrike:settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GameSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function detectTouch() {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
  );
}



function HeartIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <path d="M8 5h6v4h4V5h6v4h4v8h-4v4h-4v4h-4v4h-4v-4H8v-4H4v-4H0V9h4V5h4Z" fill="#ef233c" />
      <path d="M8 7h5v3H8v3H5v-3h3V7Z" fill="#ff7b86" opacity="0.75" />
    </svg>
  );
}

function GasIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <path d="M7 4h14v24H5V8h2V4Z" fill="#2bd66f" />
      <path d="M10 8h8v5h-8V8Z" fill="#caffdb" />
      <path d="M21 8h4l3 4v10h-4v-8l-3-2V8Z" fill="#1a9f52" />
      <path d="M8 22h10v3H8v-3Z" fill="#13783b" opacity="0.5" />
    </svg>
  );
}

function CoinIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <circle cx="16" cy="16" r="12" fill="#ffd43b" />
      <circle cx="16" cy="16" r="8" fill="#f6b800" />
      <rect x="14" y="8" width="4" height="16" fill="#fff3a3" opacity="0.8" />
    </svg>
  );
}

function BulletIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8">
      <path d="M18 3h5v5h3v16h-3v5H9v-5H6V12h12V3Z" fill="#ffe66d" />
      <path d="M9 17h14v4H9v-4Z" fill="#ff4b35" />
      <path d="M18 7h3v5h-3V7Z" fill="#fff6ad" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8 drop-shadow-[0_2px_0_rgba(0,0,0,0.45)]">
      <circle cx="16" cy="16" r="12" fill="none" stroke="#ff3344" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="5" fill="#ff3344" />
      <rect x="15" y="2" width="2" height="6" fill="#ff3344" />
      <rect x="15" y="24" width="2" height="6" fill="#ff3344" />
      <rect x="2" y="15" width="6" height="2" fill="#ff3344" />
      <rect x="24" y="15" width="6" height="2" fill="#ff3344" />
    </svg>
  );
}

function KeyCap({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[4px] border border-white/30 bg-white/14 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white shadow-[0_2px_0_rgba(0,0,0,0.25)]">
      {children}
    </span>
  );
}

const CONTROL_HINTS: { keys: string; label: string }[] = [
  { keys: 'W A S D', label: 'Move' },
  { keys: 'SPACE / ALT', label: 'Climb / Descend' },
  { keys: 'SHIFT', label: 'Afterburner' },
  { keys: 'HOLD FIRE', label: 'Shoot' },
  { keys: 'C', label: 'Deploy Flares' },
];

/** Contextual onboarding: a short fading hint sequence after each run starts.
 *  Replaces the old always-on control bar — hints never persist during combat. */
function ControlHints({ runId }: { runId: number }) {
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(false);

  // runId effect: starts the sequence at hint 0, then advances to hint 1.
  useEffect(() => {
    setIdx(0);
    setVisible(false);
    let timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      setVisible(true);
      timeout = setTimeout(() => {
        setVisible(false);
        timeout = setTimeout(() => setIdx(1), 450);
      }, 2400);
    }, 350);
    return () => clearTimeout(timeout);
  }, [runId]);

  // idx effect: show the hint, hide it, then advance to the next (or stay
  // hidden on the last hint). Re-mounts its timers on every idx change.
  useEffect(() => {
    if (idx === 0) return;
    setVisible(true);
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(
      setTimeout(() => {
        setVisible(false);
        if (idx < CONTROL_HINTS.length - 1) {
          timers.push(setTimeout(() => setIdx(idx + 1), 450));
        }
      }, 2400),
    );
    return () => timers.forEach(clearTimeout);
  }, [idx]);

  const hint = CONTROL_HINTS[idx];
  return (
    <div
      className={`pointer-events-none absolute bottom-6 left-1/2 z-30 -translate-x-1/2 transition-opacity duration-500 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="hud-panel flex items-center gap-3 px-4 py-2">
        <KeyCap>{hint.keys}</KeyCap>
        <span className="text-xs font-black uppercase tracking-[0.2em] text-white/90" style={{ textShadow: '0 2px 0 rgba(0,0,0,0.55)' }}>
          {hint.label}
        </span>
      </div>
    </div>
  );
}

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-4 w-24 overflow-hidden rounded-[4px] border-2 border-black/45 bg-black/35 shadow-[0_2px_0_rgba(0,0,0,0.35)] sm:w-48">
      <div className={`h-full ${color} transition-[width] duration-300`} style={{ width: `${clampPercent(value)}%` }} />
    </div>
  );
}

// --- Tactical minimap ------------------------------------------------------
// A north-up radar fed by the engine's ~12 Hz `helistrike:minimap` snapshot.
// The snapshot lives in a ref and is drawn imperatively on a canvas — no React
// re-renders, no entity objects in the UI layer.
function drawMinimap(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  snap: MinimapSnapshot | null,
) {
  const W = canvas.width;
  const H = canvas.height;
  const R = Math.min(W, H) / 2 - 20;
  const cx = W / 2;
  const cy = H / 2;
  const t = performance.now() / 1000;

  ctx.clearRect(0, 0, W, H);

  // Panel
  ctx.beginPath();
  ctx.moveTo(6 + 20, 6);
  ctx.arcTo(W - 6, 6, W - 6, H - 6, 20);
  ctx.arcTo(W - 6, H - 6, 6, H - 6, 20);
  ctx.arcTo(6, H - 6, 6, 6, 20);
  ctx.arcTo(6, 6, W - 6, 6, 20);
  ctx.closePath();
  ctx.fillStyle = 'rgba(6, 13, 28, 0.74)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 190, 255, 0.3)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Grid rings + cross
  ctx.strokeStyle = 'rgba(120, 190, 255, 0.11)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();

  if (!snap) {
    ctx.fillStyle = 'rgba(160, 210, 255, 0.5)';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO SIGNAL', cx, cy);
    return;
  }

  const range = Math.max(1, snap.range);
  // North-up: world +X right, world -Z (forward) up.
  const toX = (x: number) => cx + ((x - snap.player.x) / range) * R;
  const toY = (z: number) => cy + ((z - snap.player.z) / range) * R;
  const edgeX = (dx: number, dz: number) => {
    const len = Math.hypot(dx, dz) || 1;
    return { x: cx + (dx / len) * (R - 14), y: cy + (dz / len) * (R - 14) };
  };

  // Route line: player → destination while carrying (clamped to the radar edge)
  if (snap.delivery?.carrying) {
    const d = snap.delivery.destination;
    const dx = d.x - snap.player.x;
    const dz = d.z - snap.player.z;
    const outside = Math.hypot(dx, dz) > range;
    const end = outside ? edgeX(dx, dz) : { x: toX(d.x), y: toY(d.z) };
    ctx.strokeStyle = 'rgba(85, 242, 194, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Delivery markers
  if (snap.delivery) {
    const origin = snap.delivery.origin;
    const dest = snap.delivery.destination;
    // Destination: bright green diamond, clamped to the edge when out of range
    const ddx = dest.x - snap.player.x;
    const ddz = dest.z - snap.player.z;
    const destOutside = Math.hypot(ddx, ddz) > range;
    const dp = destOutside ? edgeX(ddx, ddz) : { x: toX(dest.x), y: toY(dest.z) };
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dp.x, dp.y - 9);
    ctx.lineTo(dp.x + 7, dp.y);
    ctx.lineTo(dp.x, dp.y + 9);
    ctx.lineTo(dp.x - 7, dp.y);
    ctx.closePath();
    ctx.fillStyle = snap.delivery.carrying ? 'rgba(85, 242, 194, 0.95)' : 'rgba(85, 242, 194, 0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240, 255, 250, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Origin: amber crate, only while the pickup is still relevant
    if (!snap.delivery.carrying) {
      const ox = toX(origin.x);
      const oy = toY(origin.z);
      if (Math.abs(ox - cx) <= R && Math.abs(oy - cy) <= R) {
        const pulse = 0.7 + Math.sin(t * 4.5) * 0.3;
        ctx.fillStyle = `rgba(255, 189, 63, ${pulse.toFixed(2)})`;
        ctx.fillRect(ox - 4.5, oy - 4.5, 9, 9);
        ctx.strokeStyle = 'rgba(255, 235, 170, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(ox - 4.5, oy - 4.5, 9, 9);
      }
    }
  }

  // Objectives
  for (const o of snap.objectives) {
    const dx = o.x - snap.player.x;
    const dz = o.z - snap.player.z;
    if (Math.hypot(dx, dz) > range) continue;
    const ox = toX(o.x);
    const oy = toY(o.z);
    if (o.type === 0) {
      // SAM — red warning triangle
      ctx.beginPath();
      ctx.moveTo(ox, oy - 9);
      ctx.lineTo(ox + 8, oy + 7);
      ctx.lineTo(ox - 8, oy + 7);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 85, 102, 0.95)';
      ctx.fill();
    } else {
      // RADAR — antenna mast + dish
      ctx.strokeStyle = 'rgba(126, 224, 255, 0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ox, oy + 6);
      ctx.lineTo(ox, oy - 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ox, oy - 6, 4, Math.PI, 0);
      ctx.stroke();
    }
  }

  // Friendly extraction marker stays clamped to the radar edge.
  if (snap.extraction) {
    const dx = snap.extraction.x - snap.player.x;
    const dz = snap.extraction.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const inRange = dist <= range;
    const ep = inRange ? { x: toX(snap.extraction.x), y: toY(snap.extraction.z) } : edgeX(dx, dz);
    // Zone radius: pulsing green circle so the landing area itself reads.
    if (inRange && snap.extraction.radius > 0) {
      const rPx = Math.max(3, (snap.extraction.radius / range) * R);
      const pulse = 0.5 + Math.sin(t * 3) * 0.15;
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(85, 242, 162, ${pulse.toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ep.x, ep.y, rPx * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = snap.extraction.active ? 'rgba(100,255,175,1)' : 'rgba(85,242,162,0.9)';
    ctx.font = '900 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', ep.x, ep.y);
    ctx.strokeStyle = 'rgba(210,255,230,0.9)';
    ctx.strokeRect(ep.x - 8, ep.y - 8, 16, 16);
    // Pad elevation vs the player — "▲ 42m" reads as a rooftop to climb to.
    const dy = snap.extraction.elevation - (snap.player.y ?? 0);
    const dir = dy > 4 ? '▲' : dy < -4 ? '▼' : '≈';
    ctx.font = '800 9px system-ui, sans-serif';
    ctx.fillStyle = dy > 4 ? 'rgba(255, 189, 63, 0.95)' : 'rgba(160, 230, 200, 0.95)';
    ctx.fillText(`${dir} ${Math.abs(Math.round(dy))}m`, ep.x, ep.y + 16);
  }

  // Enemies inside the radar radius
  for (const e of snap.enemies) {
    if (e.boss) continue;
    const dx = e.x - snap.player.x;
    const dz = e.z - snap.player.z;
    if (Math.hypot(dx, dz) > range) continue;
    const ex = toX(e.x);
    const ey = toY(e.z);
    // Variant markers override base-type icons — color/roll says "what is it".
    const v = e.variant;
    if (v === EnemyVariant.KAMIKAZE_DRONE) {
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 7));
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex + 5.5, ey + 5);
      ctx.lineTo(ex - 5.5, ey + 5);
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 34, 68, ${pulse})`;
      ctx.fill();
    } else if (v === EnemyVariant.SCOUT_DRONE) {
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex + 3.5, ey);
      ctx.lineTo(ex, ey + 7);
      ctx.lineTo(ex - 3.5, ey);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 120, 140, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.ATTACK_GUNSHIP || v === EnemyVariant.ROCKET_GUNSHIP || v === EnemyVariant.HEAVY_GUNSHIP) {
      const size = v === EnemyVariant.HEAVY_GUNSHIP ? 9 : v === EnemyVariant.ROCKET_GUNSHIP ? 6.5 : 6;
      ctx.beginPath();
      ctx.moveTo(ex, ey - size);
      ctx.lineTo(ex + size * 0.75, ey);
      ctx.lineTo(ex, ey + size);
      ctx.lineTo(ex - size * 0.75, ey);
      ctx.closePath();
      ctx.fillStyle = v === EnemyVariant.ROCKET_GUNSHIP ? 'rgba(255, 170, 51, 0.95)' : 'rgba(255, 90, 90, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.MISSILE_CARRIER) {
      // Amber missile marker: slim body + fin
      ctx.fillStyle = 'rgba(255, 194, 63, 0.95)';
      ctx.fillRect(ex - 1.5, ey - 7, 3, 12);
      ctx.beginPath();
      ctx.moveTo(ex, ey - 7);
      ctx.lineTo(ex - 5, ey - 3.5);
      ctx.lineTo(ex + 5, ey - 3.5);
      ctx.closePath();
      ctx.fill();
    } else if (v === EnemyVariant.FLAK_TANK || v === EnemyVariant.SIEGE_TANK) {
      const size = v === EnemyVariant.SIEGE_TANK ? 9 : 6;
      ctx.fillStyle = 'rgba(255, 120, 60, 0.95)';
      ctx.fillRect(ex - size * 0.5, ey - size * 0.5, size, size);
      ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
      ctx.beginPath();
      ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (v === EnemyVariant.SHIELD_DRONE) {
      ctx.beginPath();
      ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(85, 238, 255, 0.95)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 60, 60, 0.95)';
      ctx.fill();
    } else if (v === EnemyVariant.REPAIR_DRONE) {
      ctx.beginPath();
      ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(85, 255, 153, 0.95)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(85, 255, 153, 0.95)';
      ctx.fill();
    } else if (e.type === 1) {
      ctx.beginPath();
      ctx.moveTo(ex, ey - 6);
      ctx.lineTo(ex + 4.5, ey);
      ctx.lineTo(ex, ey + 6);
      ctx.lineTo(ex - 4.5, ey);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 80, 80, 0.95)';
      ctx.fill();
    } else if (e.type === 2) {
      ctx.fillStyle = 'rgba(255, 80, 80, 0.95)';
      ctx.fillRect(ex - 3.5, ey - 3.5, 7, 7);
    } else if (e.type === 3) {
      ctx.beginPath();
      ctx.moveTo(ex, ey - 6);
      ctx.lineTo(ex + 5, ey + 4);
      ctx.lineTo(ex - 5, ey + 4);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 120, 120, 0.95)';
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255, 70, 70, 0.9)';
      ctx.beginPath();
      ctx.arc(ex, ey, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (e.elite) {
      ctx.strokeStyle = 'rgba(255, 170, 60, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(ex, ey, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Repaint SAMs above normal contacts and reveal the envelope only while engaged.
  for (const o of snap.objectives) {
    if (o.type !== 0) continue;
    const dx = o.x - snap.player.x;
    const dz = o.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range) continue;
    const ox = toX(o.x);
    const oy = toY(o.z);
    const engaged = o.samState === 'TRACKING' || o.samState === 'LOCKING' || o.samState === 'FIRING';
    if (engaged && o.detectionRange) {
      ctx.beginPath();
      ctx.arc(ox, oy, Math.min(R, (o.detectionRange / range) * R), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 77, 62, 0.045)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 105, 70, 0.16)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const lockPulse = o.samState === 'LOCKING' ? 0.58 + Math.abs(Math.sin(t * 9)) * 0.42 : 0.9;
    ctx.beginPath();
    ctx.moveTo(ox, oy - 10);
    ctx.lineTo(ox + 9, oy + 8);
    ctx.lineTo(ox - 9, oy + 8);
    ctx.closePath();
    ctx.fillStyle = o.samState === 'RELOADING'
      ? 'rgba(255, 174, 70, 0.72)'
      : `rgba(255, 65, 82, ${lockPulse})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 235, 210, 0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const threat of snap.threats) {
    const dx = threat.x - snap.player.x;
    const dz = threat.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const mp = dist > range ? edgeX(dx, dz) : { x: toX(threat.x), y: toY(threat.z) };
    ctx.save();
    ctx.translate(mp.x, mp.y);
    ctx.rotate(Math.atan2(dx, -dz));
    ctx.fillStyle = threat.target === 'DECOY' ? 'rgba(130, 220, 190, 0.9)' : 'rgba(255, 153, 45, 0.98)';
    ctx.fillRect(-1.8, -7, 3.6, 12);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(4.5, -4);
    ctx.lineTo(-4.5, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Boss — large crimson ring, clamped to the edge if far away
  for (const e of snap.enemies) {
    if (!e.boss) continue;
    const dx = e.x - snap.player.x;
    const dz = e.z - snap.player.z;
    const dist = Math.hypot(dx, dz);
    const bp = dist > range ? edgeX(dx, dz) : { x: toX(e.x), y: toY(e.z) };
    const pulse = 1 + Math.sin(t * 3) * 0.12;
    ctx.strokeStyle = 'rgba(255, 60, 80, 0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 11 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 60, 80, 0.9)';
    ctx.fill();
  }

  // Player — centered heading arrow (body heading only; gun aim never affects it).
  // The engine sets heading = atan2(velocity.x, velocity.z), so the nose points
  // along world (sin h, cos h). North-up (screen up = world -Z) then needs a
  // canvas rotation of PI - h: forward (-Z, h=PI) points up, strafe right (+X,
  // h=PI/2) points right.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI - snap.player.heading);
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(8, 9);
  ctx.lineTo(0, 5);
  ctx.lineTo(-8, 9);
  ctx.closePath();
  ctx.fillStyle = 'rgba(110, 235, 255, 0.95)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(240, 255, 255, 0.95)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function MinimapPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<MinimapSnapshot | null>(null);

  useEffect(() => {
    const onMinimap = (e: Event) => {
      snapRef.current = (e as CustomEvent<MinimapSnapshot>).detail;
    };
    window.addEventListener('helistrike:minimap', onMinimap);
    return () => window.removeEventListener('helistrike:minimap', onMinimap);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      drawMinimap(ctx, canvas, snapRef.current);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pointer-events-none absolute right-4 top-28 z-20 sm:right-6">
      <canvas
        ref={canvasRef}
        width={360}
        height={360}
        className="block"
        style={{ width: 'min(180px, 26vw)', height: 'min(180px, 26vw)' }}
        aria-label="Tactical minimap"
      />
    </div>
  );
}

function MenuButton({
  children,
  onClick,
  secondary,
  size = 'md',
}: {
  children: ReactNode;
  onClick: () => void;
  secondary?: boolean;
  size?: 'md' | 'sm';
}) {
  const sizing =
    size === 'sm'
      ? 'h-11 min-w-32 px-3 text-[15px] tracking-[0.1em] sm:flex-1 sm:min-w-0'
      : 'h-12 min-w-44 px-6 text-lg tracking-[0.16em]';
  return (
    <button
      className={`pointer-events-auto rounded-[7px] border-2 font-black uppercase transition hover:-translate-y-0.5 active:translate-y-1 ${sizing} ${
        secondary
          ? 'border-white/60 bg-[#264fb1]/85 text-white shadow-[0_6px_0_#16265f,0_12px_22px_rgba(0,0,0,0.28)] hover:bg-[#315fd0] active:shadow-[0_3px_0_#16265f,0_8px_16px_rgba(0,0,0,0.22)]'
          : 'border-white/75 bg-[#ff3344] text-white shadow-[0_6px_0_#931521,0_12px_22px_rgba(0,0,0,0.28)] hover:bg-[#ff4b59] active:shadow-[0_3px_0_#931521,0_8px_16px_rgba(0,0,0,0.22)]'
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function ThreeDMenu({
  mode,
  score,
  highScore,
  wave,
  isNewBest,
  stats,
  onStart,
  onSettings,
  onHangar,
}: {
  mode: GameMode;
  score: number;
  highScore: number;
  wave: number;
  isNewBest: boolean;
  stats: RunStats | null;
  onStart: () => void;
  onSettings: () => void;
  onHangar: () => void;
}) {
  const isGameOver = mode === 'gameover';

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-gradient-to-b from-[#9fdce8]/30 via-[#7fd9e6]/20 to-[#20417f]/35 px-4">
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card">
            <div className="menu-title-slab">
              <span>{isGameOver ? (stats?.status === 'EXTRACTED' ? 'Run Complete — Extracted' : 'Aircraft Destroyed') : 'Heli-Strike'}</span>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3 text-center">
              <div className="menu-stat">
                <span>Score</span>
                <strong>{score.toLocaleString()}</strong>
              </div>
              <div className="menu-stat">
                <span>Best</span>
                <strong>{highScore.toLocaleString()}</strong>
              </div>
              <div className="menu-stat">
                <span>Stage</span>
                <strong>{wave || '-'}</strong>
              </div>
            </div>

            {isGameOver && stats && (
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                <div className="run-stat">
                  <span>Time</span>
                  <strong>{formatDuration(stats.time)}</strong>
                </div>
                <div className="run-stat">
                  <span>Kills</span>
                  <strong>{stats.kills}</strong>
                </div>
                <div className="run-stat">
                  <span>Max Combo</span>
                  <strong>{stats.maxCombo}x</strong>
                </div>
                <div className="run-stat">
                  <span>Accuracy</span>
                  <strong>{Math.round(stats.accuracy * 100)}%</strong>
                </div>
                <div className="run-stat"><span>Threat</span><strong>{stats.threatLevel ?? 1}</strong></div>
                <div className="run-stat"><span>Deliveries</span><strong>{stats.deliveries ?? 0}</strong></div>
                <div className="run-stat"><span>SAM Sites</span><strong>{stats.samSitesDestroyed ?? 0}</strong></div>
                <div className="run-stat">
                  <span>{stats.status === 'EXTRACTED' ? 'Bonus Secured' : 'Bonus Lost'}</span>
                  <strong>{stats.status === 'EXTRACTED' ? stats.securedThreatBonus ?? 0 : stats.lostUnsecured ?? 0} CR</strong>
                </div>
              </div>
            )}

            {isNewBest && (
              <div className="mt-3 rounded-[6px] border-2 border-[#ffe66d] bg-[#ffe66d]/25 px-4 py-2 text-center text-sm font-black uppercase tracking-[0.16em] text-white shadow-[0_3px_0_rgba(0,0,0,0.22)]">
                New High Score
              </div>
            )}

            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <MenuButton size={isGameOver ? 'md' : 'sm'} onClick={onStart}>
                {isGameOver ? 'Restart' : 'Start'}
              </MenuButton>
              {!isGameOver && (
                <MenuButton size="sm" secondary onClick={onSettings}>
                  Settings
                </MenuButton>
              )}
              {!isGameOver && (
                <MenuButton size="sm" secondary onClick={onHangar}>
                  Hangar
                </MenuButton>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-sm font-black uppercase tracking-[0.12em] text-white/95">
              <div className="menu-chip">WASD Move</div>
              <div className="menu-chip">Mouse Aim</div>
              <div className="menu-chip">Space Climb</div>
              <div className="menu-chip">Alt Descend</div>
              <div className="menu-chip col-span-2 text-center text-[#ff3344] bg-[#ff3344]/10 border-[#ff3344]/30 py-1.5 rounded-[5px] border">Q / R-Click Lock Salvo</div>
              <div className="menu-chip col-span-2 text-center text-[#ffbd3f]">C Deploy Flares</div>
              <div className="menu-chip col-span-2 text-center border-white/20 py-1.5 rounded-[5px]">ESC / P Pause</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VirtualJoystick({ side, onStick }: { side: 'left' | 'right'; onStick: (v: StickPayload) => void }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const handleMove = (clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const max = rect.width / 2 - 14;
    const mag = Math.hypot(dx, dy);
    if (mag > max) {
      dx = (dx / mag) * max;
      dy = (dy / mag) * max;
    }
    setKnob({ x: dx, y: dy });
    onStick({ x: dx / max, y: dy / max, active: true });
  };

  const reset = () => {
    setActiveId(null);
    setKnob({ x: 0, y: 0 });
    onStick({ x: 0, y: 0, active: false });
  };

  return (
    <div
      ref={baseRef}
      className={`joystick-base absolute bottom-7 ${side === 'left' ? 'left-5' : 'right-5'}`}
      onPointerDown={(e) => {
        e.preventDefault();
        baseRef.current?.setPointerCapture?.(e.pointerId);
        setActiveId(e.pointerId);
        handleMove(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activeId !== e.pointerId) return;
        handleMove(e.clientX, e.clientY);
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
    >
      <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      <span className="joystick-label">{side === 'left' ? 'Move' : 'Aim'}</span>
    </div>
  );
}

function FireButton({ onFire }: { onFire: (active: boolean) => void }) {
  return (
    <button
      type="button"
      className="fire-button absolute bottom-[11.5rem] right-5"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onFire(true);
      }}
      onPointerUp={() => onFire(false)}
      onPointerCancel={() => onFire(false)}
      onPointerLeave={() => onFire(false)}
    >
      FIRE
    </button>
  );
}

function PauseOverlay({
  onResume,
  onRestart,
  onSettings,
  onQuit,
}: {
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  onQuit: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#081331]/45 px-4 backdrop-blur-[2px]">
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card w-[min(400px,calc(100vw-32px))] text-center">
            <div className="text-4xl font-black uppercase tracking-[0.1em] text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.45)]">
              Paused
            </div>
            <div className="mt-2 text-xs font-black uppercase tracking-[0.18em] text-white/70">
              Esc to Resume
            </div>
            <div className="mt-6 flex flex-col items-center gap-3">
              <MenuButton onClick={onResume}>Resume</MenuButton>
              <MenuButton secondary onClick={onRestart}>Restart</MenuButton>
              <MenuButton secondary onClick={onSettings}>Settings</MenuButton>
              <MenuButton secondary onClick={onQuit}>Quit to Menu</MenuButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`toggle-track ${checked ? 'toggle-on' : ''}`}
      aria-pressed={checked}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: GameSettings;
  onChange: (patch: Partial<GameSettings>) => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-[#081331]/55 px-4 backdrop-blur-[2px]">
      <div className="menu-perspective">
        <div className="menu-rig">
          <div className="menu-card w-[min(460px,calc(100vw-32px))]">
            <div className="text-center text-3xl font-black uppercase tracking-[0.1em] text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.45)]">
              Settings
            </div>

            <div className="mt-6 flex flex-col gap-5">
              <div className="setting-row">
                <div>
                  <div className="setting-label">Difficulty</div>
                  <div className="setting-desc">Enemy HP, damage & swarm density</div>
                </div>
                <div className="flex gap-2">
                  {(['casual', 'normal', 'hard'] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => onChange({ difficulty: d })}
                      className={`seg-btn ${settings.difficulty === d ? 'seg-on' : ''}`}
                    >
                      {d === 'casual' ? 'Casual' : d === 'normal' ? 'Normal' : 'Hard'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Invert Y-Axis</div>
                  <div className="setting-desc">Flips gamepad / touch aim direction</div>
                </div>
                <Toggle checked={settings.invertedY} onChange={(v) => onChange({ invertedY: v })} />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Auto-Aim</div>
                  <div className="setting-desc">Locks guns onto the nearest enemy — the gun turret tracks the target while the helicopter flies on course</div>
                </div>
                <Toggle checked={settings.autoAim} onChange={(v) => onChange({ autoAim: v })} />
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Stick Sensitivity</div>
                  <div className="setting-desc">Gamepad & touch movement speed</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="setting-value">{settings.gamepadSensitivity.toFixed(1)}x</span>
                  <input
                    type="range"
                    min={0.4}
                    max={4}
                    step={0.1}
                    value={settings.gamepadSensitivity}
                    onChange={(e) => onChange({ gamepadSensitivity: Number(e.target.value) })}
                    className="slider-arcade w-32"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Visual Quality</div>
                  <div className="setting-desc">Low/Medium scale render resolution; High adds bloom FX & max pixels</div>
                </div>
                <div className="flex gap-2">
                  {(['low', 'medium', 'high'] as const).map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => onChange({ quality: q })}
                      className={`seg-btn ${settings.quality === q ? 'seg-on' : ''}`}
                    >
                      {q === 'low' ? 'Low' : q === 'medium' ? 'Medium' : 'High'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Volume</div>
                  <div className="setting-desc">Master sound & music level</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="setting-value">{Math.round(settings.volume * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.volume}
                    onChange={(e) => onChange({ volume: Number(e.target.value) })}
                    className="slider-arcade w-32"
                  />
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-center">
              <MenuButton onClick={onClose}>Done</MenuButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const WEAPON_MASTERY_INFO: { name: string; altFire: string; color: string }[] = [
  { name: 'Machine Gun', altFire: 'Tracer Rounds: +25% damage', color: '#ff2a2a' },
  { name: 'Missile', altFire: 'Twin Salvo: fires a second missile', color: '#44ff44' },
  { name: 'Rocket', altFire: 'Napalm Warheads: larger blast', color: '#ffaa00' },
  { name: 'Shotgun', altFire: 'Slug Burst: +15% damage', color: '#ffdd22' },
];

const HELICOPTER_MODEL_INFO: { id: HelicopterModel; name: string; desc: string; color: string; dark: string }[] = [
  { id: HelicopterModel.APACHE, name: 'Apache', desc: 'Balanced attack helicopter', color: '#2d3a2e', dark: '#1a211a' },
  { id: HelicopterModel.NIGHTHAWK, name: 'Nighthawk', desc: 'Angular stealth gunship', color: '#242c30', dark: '#101820' },
  { id: HelicopterModel.WARLOCK, name: 'Warlock', desc: 'Heavy gunship, big payload', color: '#3a4436', dark: '#242c2a' },
];

function HelicopterCard({
  name,
  desc,
  color,
  dark,
  selected,
  onSelect,
}: {
  name: string;
  desc: string;
  color: string;
  dark: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`group flex flex-col items-center gap-2 rounded-xl border-2 px-3 py-4 text-center transition hover:-translate-y-1 ${
        selected
          ? 'border-[#ffe66d] bg-[#ffe66d]/15 shadow-[0_8px_24px_rgba(255,230,109,0.2)]'
          : 'border-white/20 bg-[#12294a]/85 hover:border-white/50'
      }`}
    >
      {/* Stylized top-down helicopter silhouette preview */}
      <div className="relative h-14 w-28" style={{ perspective: '300px' }}>
        <div className="absolute left-1/2 top-1/2 h-2 w-16 -translate-x-1/2 -translate-y-1/2 rounded-[3px]" style={{ background: '#161a18', transform: 'rotateX(70deg) rotateZ(-8deg)' }} />
        <div
          className="absolute left-1/2 top-1/2 h-4 w-12 -translate-x-1/2 -translate-y-1/2 rounded-[4px] border border-white/30"
          style={{ background: color, boxShadow: `0 4px 0 ${color}99` }}
        />
        <div className="absolute left-1/2 top-1/2 h-2 w-7 -translate-x-1/2 -translate-y-1/2 rounded-[2px]" style={{ background: dark }} />
      </div>
      <span className={`text-sm font-black uppercase tracking-wider ${selected ? 'text-[#ffe66d]' : 'text-white'}`}>
        {name}
      </span>
      <span className="text-[11px] font-semibold leading-snug text-white/70">{desc}</span>
      <span
        className={`mt-1 rounded-[4px] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${
          selected ? 'bg-[#ffe66d] text-[#3d2b08]' : 'bg-white/10 text-white/60'
        }`}
      >
        {selected ? 'Selected' : 'Select'}
      </span>
    </button>
  );
}

function HangarScreen({
  mastery,
  playerModel,
  credits,
  hangarUpgrades,
  onSelectModel,
  onBuyUpgrade,
  onBack,
}: {
  mastery: number[];
  playerModel: HelicopterModel;
  credits: number;
  hangarUpgrades: HangarUpgrades;
  onSelectModel: (m: HelicopterModel) => void;
  onBuyUpgrade: (id: HangarUpgradeId) => void;
  onBack: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#081331]/60 px-4 backdrop-blur-[2px]">
      <div className="menu-perspective">
        <div className="menu-rig max-h-[88vh] overflow-y-auto">
          <div className="menu-card w-[min(620px,calc(100vw-32px))]">
            <div className="text-center text-3xl font-black uppercase tracking-[0.1em] text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.45)]">
              Hangar
            </div>
            <div className="mt-1 text-center text-xs font-bold uppercase tracking-[0.18em] text-white/60">
              Aircraft, weapon mastery, and permanent systems
            </div>

            <div className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-lg border border-[#ffe66d]/55 bg-[#3d2b08]/65 px-3 py-1.5">
              <CoinIcon />
              <span className="text-xl font-black text-[#ffe66d]">{credits.toLocaleString()} CREDITS</span>
            </div>

            <div className="mt-5 text-center text-sm font-black uppercase tracking-[0.2em] text-[#7ee0ff]">
              Permanent Systems
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {(Object.entries(HANGAR_UPGRADE_INFO) as [HangarUpgradeId, (typeof HANGAR_UPGRADE_INFO)[HangarUpgradeId]][]).map(([id, info]) => {
                const rank = hangarUpgrades[id];
                const cost = info.costs[rank];
                const maxed = cost === undefined;
                const affordable = !maxed && credits >= cost;
                return (
                  <div key={id} className="flex flex-col rounded-xl border-2 border-white/18 bg-[#12294a]/85 px-3 py-3 text-center">
                    <div className="text-xs font-black uppercase tracking-wide text-white">{info.name}</div>
                    <div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-[#7ee0ff]">Rank {rank} / {info.costs.length}</div>
                    <div className="mt-2 flex justify-center gap-1">
                      {info.costs.map((_, index) => index + 1).map((level) => (
                        <span key={level} className={`h-1.5 w-8 rounded-full ${level <= rank ? 'bg-[#55f2c2]' : 'bg-white/12'}`} />
                      ))}
                    </div>
                    <div className="mt-2 min-h-8 text-[11px] font-semibold leading-snug text-white/65">{info.description}</div>
                    <button
                      type="button"
                      disabled={!affordable}
                      onClick={() => onBuyUpgrade(id)}
                      className={`mt-3 rounded-md border px-2 py-1.5 text-[10px] font-black uppercase tracking-wider transition ${
                        affordable
                          ? 'border-[#ffe66d] bg-[#ffe66d]/18 text-[#ffe66d] hover:bg-[#ffe66d]/28'
                          : 'cursor-not-allowed border-white/12 bg-black/15 text-white/35'
                      }`}
                    >
                      {maxed ? 'Max Rank' : `${cost} Credits`}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Player aircraft selector */}
            <div className="mt-4 text-center text-sm font-black uppercase tracking-[0.2em] text-[#7ee0ff]">
              Aircraft
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2.5">
              {HELICOPTER_MODEL_INFO.map((m) => (
                <Fragment key={m.id}>
                  <HelicopterCard
                    name={m.name}
                    desc={m.desc}
                    color={m.color}
                    dark={m.dark}
                    selected={playerModel === m.id}
                    onSelect={() => onSelectModel(m.id)}
                  />
                </Fragment>
              ))}
            </div>

            {/* Weapon mastery */}
            <div className="mt-5 text-center text-sm font-black uppercase tracking-[0.2em] text-[#7ee0ff]">
              Weapons
            </div>
            <div className="mt-2 text-center text-[11px] font-bold uppercase tracking-[0.16em] text-white/50">
              Max rank unlocks a signature alt-fire
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {WEAPON_MASTERY_INFO.map((w, i) => {
                const lvl = mastery[i] ?? 0;
                const maxed = lvl >= 5;
                return (
                  <div
                    key={w.name}
                    className="flex items-center gap-3 rounded-xl border-2 bg-[#12294a]/85 px-4 py-3"
                    style={{ borderColor: maxed ? w.color : 'rgba(255,255,255,0.18)' }}
                  >
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg font-black"
                      style={{ background: `${w.color}26`, color: w.color, border: `2px solid ${w.color}66` }}
                    >
                      {i + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-black uppercase tracking-wide text-white">{w.name}</span>
                        <span className="text-xs font-black text-[#7ee0ff]">LV.{lvl}</span>
                      </div>
                      <div className="mt-1 flex gap-1">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <div
                            key={n}
                            className="h-1.5 flex-1 rounded-full"
                            style={{
                              background: n <= lvl ? w.color : 'rgba(255,255,255,0.12)',
                            }}
                          />
                        ))}
                      </div>
                      <div className="mt-1.5 text-[11px] font-semibold leading-snug text-white/70">
                        {maxed ? <span className="text-[#ffe66d]">★ {w.altFire}</span> : 'Kill with this weapon to earn XP'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 flex justify-center">
              <MenuButton onClick={onBack}>Back</MenuButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const modeRef = useRef<GameMode>('menu');
  const [mode, setMode] = useState<GameMode>('menu');
  const [hintsKey, setHintsKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showHangar, setShowHangar] = useState(false);
  const [mastery, setMastery] = useState<number[]>(() => readMastery());
  const [credits, setCredits] = useState(() => readDeliveryCredits());
  const [hangarUpgrades, setHangarUpgrades] = useState<HangarUpgrades>(() => readHangarUpgrades());
  const [playerModel, setPlayerModel] = useState<HelicopterModel>(() => {
    try {
      const n = Number(window.localStorage.getItem('helistrike:playerModel'));
      return n === HelicopterModel.NIGHTHAWK || n === HelicopterModel.WARLOCK ? n : HelicopterModel.APACHE;
    } catch {
      return HelicopterModel.APACHE;
    }
  });
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);
  const [touchDevice, setTouchDevice] = useState(false);
  const [score, setScore] = useState(0);
  const [health, setHealth] = useState(100);
  const [fuel, setFuel] = useState(100);
  const [wave, setWave] = useState(0);
  const [runLevel, setRunLevel] = useState(1);
  const [runXpProgress, setRunXpProgress] = useState(0);
  const [waveMessage, setWaveMessage] = useState<string | null>(null);
  const [highScore, setHighScore] = useState(0);
  const [isNewBest, setIsNewBest] = useState(false);
  const [runStats, setRunStats] = useState<RunStats | null>(null);
  const [bossInfo, setBossInfo] = useState<{ hp: number; maxHp: number } | null>(null);
  const [weaponInfo, setWeaponInfo] = useState<{
    name: string;
    ammo: number;
    maxAmmo: number;
    type: number;
    reloading: boolean;
    reloadTimer: number;
    level?: number;
  } | null>(null);
  const [comboInfo, setComboInfo] = useState<{
    count: number;
    multiplier: number;
    timer: number;
  } | null>(null);
  const [statusInfo, setStatusInfo] = useState<{
    damageBoost: number;
    shield: number;
    speedBoost: number;
    threat: number;
    afterburner?: boolean;
    risk?: number | null;
  } | null>(null);
  const [salvoInfo, setSalvoInfo] = useState<{
    locks: number;
    cooldown: number;
    isPainting: boolean;
    ready: boolean;
  } | null>(null);
  const [countermeasureInfo, setCountermeasureInfo] = useState<{
    charges: number; maxCharges: number; cooldown: number; ready: boolean;
  } | null>(null);
  const [threatInfo, setThreatInfo] = useState<{
    points: number; level: number; name: string; rewardMultiplier: number;
  } | null>(null);
  const [unsecuredCredits, setUnsecuredCredits] = useState(0);
  const [extraction, setExtraction] = useState<{
    distance: number; bearing: number; progress: number; active: boolean; carrying: boolean;
  } | null>(null);
  const [upgradeOffer, setUpgradeOffer] = useState<UpgradeOption[] | null>(null);
  const [announcement, setAnnouncement] = useState<{
    text: string;
    sub: string;
    color: string;
    key: number;
  } | null>(null);
  const [objectives, setObjectives] = useState<{
    sam: boolean;
    radar: boolean;
    count: number;
  } | null>(null);
  const [samThreat, setSamThreat] = useState<{
    state: 'TRACKING' | 'LOCKING' | 'INBOUND';
    progress: number;
    distance: number;
    bearing: number;
  } | null>(null);
  const [delivery, setDelivery] = useState<DeliveryHudSnapshot | null>(null);
  const [perfStats, setPerfStats] = useState<PerfStats | null>(null);
  const [showPerf, setShowPerf] = useState(true);

  const applySettings = (patch: Partial<GameSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    window.localStorage.setItem('helistrike:settings', JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('helistrike:settings', { detail: next }));
  };

  const dispatchStick = (name: string) => (value: StickPayload) => {
    window.dispatchEvent(new CustomEvent(name, { detail: value }));
  };
  const setFire = (active: boolean) => {
    window.dispatchEvent(new CustomEvent('helistrike:fire', { detail: { active } }));
  };

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    setHighScore(readHighScore());
  }, []);

  // Refresh mastery when returning to the menu (after a run levels weapons)
  useEffect(() => {
    if (mode === 'menu') setMastery(readMastery());
  }, [mode]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GameEngine(canvasRef.current);
    engineRef.current = engine;

    // Apply persisted settings + auto-detect touch
    const persisted = readSettings();
    const touch = detectTouch();
    const initial = { ...persisted, touchMode: persisted.touchMode || touch };
    setTouchDevice(touch);
    setSettings(initial);
    window.localStorage.setItem('helistrike:settings', JSON.stringify(initial));
    window.dispatchEvent(new CustomEvent('helistrike:settings', { detail: initial }));

    const handleUpdate = (e: CustomEvent) => {
      const nextScore = e.detail.score;
      setScore(nextScore);
      setWave(e.detail.wave);
      setRunLevel(e.detail.runLevel ?? 1);
      setRunXpProgress(e.detail.runXpProgress ?? 0);
      setWaveMessage(e.detail.playing ? e.detail.message : null);
      setWeaponInfo(e.detail.weapon || null);
      setComboInfo(e.detail.combo || null);
      setStatusInfo(e.detail.status || null);
      setSalvoInfo(e.detail.salvo || null);
      setCountermeasureInfo(e.detail.countermeasures || null);
      setThreatInfo(e.detail.threatSystem || null);
      setUnsecuredCredits(e.detail.unsecuredCredits ?? 0);
      setExtraction(e.detail.extraction || null);
      setBossInfo(e.detail.boss || null);
      setObjectives(e.detail.objectives || null);
      setSamThreat(e.detail.samThreat || null);
      setDelivery(e.detail.delivery || null);
      if (Number.isFinite(e.detail.credits)) setCredits(e.detail.credits);

      const storedHighScore = readHighScore();
      if (nextScore > storedHighScore) {
        window.localStorage.setItem('helistrike:highScore', String(nextScore));
        setHighScore(nextScore);
      }
    };

    const handleUpgradeOffer = (e: CustomEvent) => {
      setUpgradeOffer(e.detail?.options ?? null);
    };

    const handleAnnounce = (e: CustomEvent) => {
      const d = e.detail ?? {};
      setAnnouncement({
        text: d.text ?? '',
        sub: d.sub ?? '',
        color: d.color ?? '#ffe66d',
        key: Date.now(),
      });
      window.setTimeout(() => setAnnouncement(null), 2400);
    };

    const handleGameOver = (e: CustomEvent) => {
      const finalScore = e.detail.score;
      setMode('gameover');
      setRunStats({
        time: e.detail.survivalTime ?? e.detail.time ?? 0,
        kills: e.detail.kills ?? 0,
        maxCombo: e.detail.maxCombo ?? 0,
        accuracy: e.detail.accuracy ?? 0,
        wave: e.detail.wave ?? 0,
        status: e.detail.status ?? 'DESTROYED',
        threatLevel: e.detail.threatLevel ?? 1,
        deliveries: e.detail.deliveries ?? 0,
        samSitesDestroyed: e.detail.samSitesDestroyed ?? 0,
        lostUnsecured: e.detail.lostUnsecured ?? 0,
        securedThreatBonus: e.detail.securedThreatBonus ?? 0,
      });

      const storedHighScore = readHighScore();
      setIsNewBest(finalScore >= storedHighScore && finalScore > 0);
      if (finalScore > storedHighScore) {
        window.localStorage.setItem('helistrike:highScore', String(finalScore));
        setHighScore(finalScore);
      }
    };

    const handleStats = (e: CustomEvent) => {
      setHealth(e.detail.currentHealth);
      setFuel(e.detail.currentFuel);
    };

    const handleAutoPause = () => {
      if (modeRef.current === 'playing') {
        setMode('paused');
        engineRef.current?.setPaused(true);
      }
    };

    window.addEventListener('helistrike:update', handleUpdate as EventListener);
    window.addEventListener('helistrike:stats', handleStats as EventListener);
    window.addEventListener('helistrike:gameover', handleGameOver as EventListener);
    window.addEventListener('helistrike:autopause', handleAutoPause as EventListener);
    window.addEventListener('helistrike:upgrade-offer', handleUpgradeOffer as EventListener);
    window.addEventListener('helistrike:announce', handleAnnounce as EventListener);

    return () => {
      window.removeEventListener('helistrike:update', handleUpdate as EventListener);
      window.removeEventListener('helistrike:stats', handleStats as EventListener);
      window.removeEventListener('helistrike:gameover', handleGameOver as EventListener);
      window.removeEventListener('helistrike:autopause', handleAutoPause as EventListener);
      window.removeEventListener('helistrike:upgrade-offer', handleUpgradeOffer as EventListener);
      window.removeEventListener('helistrike:announce', handleAnnounce as EventListener);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // On-screen perf overlay (Pass 10 cleanup): poll the engine's renderer stats
  // a few times per second — cheap, zero GL cost. F2 toggles it.
  const showPerfRef = useRef(showPerf);
  showPerfRef.current = showPerf;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!showPerfRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;
      setPerfStats(engine.getPerfStats());
    }, 500);
    const onPerfKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        setShowPerf((v) => !v);
      }
    };
    window.addEventListener('keydown', onPerfKey);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('keydown', onPerfKey);
    };
  }, []);

  const pauseGame = () => {
    if (mode !== 'playing') return;
    setMode('paused');
    engineRef.current?.setPaused(true);
  };

  const resumeGame = () => {
    if (mode !== 'paused') return;
    setMode('playing');
    engineRef.current?.setPaused(false);
  };

  const startRun = () => {
    if (mode === 'playing' || mode === 'paused') return;
    setMode('playing');
    setRunStats(null);
    setIsNewBest(false);
    setShowHangar(false);
    setHintsKey((k) => k + 1);
    engineRef.current?.startGame();
  };

  const restartRun = () => {
    setMode('playing');
    setRunStats(null);
    setIsNewBest(false);
    setShowHangar(false);
    setHintsKey((k) => k + 1);
    engineRef.current?.startGame();
  };

  const quitToMenu = () => {
    setMode('menu');
    setRunStats(null);
    setIsNewBest(false);
    setShowSettings(false);
    setShowHangar(false);
    setUpgradeOffer(null);
    engineRef.current?.setPaused(true);
  };

  const chooseUpgrade = (id: UpgradeId) => {
    setUpgradeOffer(null);
    window.dispatchEvent(new CustomEvent('helistrike:upgrade-choice', { detail: { id } }));
  };

  const selectPlayerModel = (model: HelicopterModel) => {
    setPlayerModel(model);
    window.localStorage.setItem('helistrike:playerModel', String(model));
    window.dispatchEvent(new CustomEvent('helistrike:player-model', { detail: { model } }));
  };

  const purchaseHangarUpgrade = (id: HangarUpgradeId) => {
    const result = buyHangarUpgrade(credits, hangarUpgrades, id);
    if (!result.purchased) return;
    setCredits(result.credits);
    setHangarUpgrades(result.upgrades);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key.toLowerCase() !== 'p') return;
      if (showSettings) {
        setShowSettings(false);
        return;
      }
      if (upgradeOffer) return; // upgrade roulette handles its own pause
      if (mode === 'playing') pauseGame();
      else if (mode === 'paused') resumeGame();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, showSettings, upgradeOffer]);

  // Readability pass: heavier drop shadow so white numbers read clean over
  // the bright low-poly sky instead of washing out.
  const textShadow = { textShadow: '0 2px 0 rgba(0,0,0,0.62), 0 3px 10px rgba(0,0,0,0.55), 0 0 16px rgba(0,0,0,0.3)' };
  const hudDim = mode !== 'playing' ? 'opacity-35' : 'opacity-100';
  const dangerOpacity = mode === 'playing' ? clampPercent(35 - health) / 100 : 0;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#97dff0] font-sans text-white pointer-events-auto select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full touch-none z-0" />
      <div className="arcade-scanlines pointer-events-none absolute inset-0 z-10" />
      <div className="arcade-vignette pointer-events-none absolute inset-0 z-10" />
      <div
        className="pointer-events-none absolute inset-0 z-10 transition-opacity duration-300"
        style={{
          opacity: dangerOpacity,
          background: 'radial-gradient(circle at center, transparent 45%, rgba(239,35,60,0.72) 100%)',
        }}
      />

      <div className={`pointer-events-none absolute inset-0 z-20 transition-opacity duration-300 ${hudDim}`}>
        <div className="arcade-marquee absolute left-1/2 top-0 hidden -translate-x-1/2 px-7 py-1 text-[11px] font-black uppercase tracking-[0.22em] text-[#ffe66d] sm:block">
          Heli-Strike Arcade Assault
        </div>

        <div className={`hud-panel absolute left-4 top-3 flex flex-col gap-1.5 px-3 py-2 sm:left-6 sm:top-5 ${health <= 30 ? 'hud-danger' : ''}`}>
          <div className="hud-label">Systems</div>
          <div className="flex items-center gap-2">
            <HeartIcon />
            <Meter value={health} color={health > 30 ? 'bg-[#35e66d]' : 'bg-[#ef233c]'} />
            <span className="min-w-12 text-2xl font-black leading-none" style={textShadow}>{Math.round(health)}</span>
          </div>
          <div className="flex items-center gap-2">
            <GasIcon />
            <Meter value={fuel} color={fuel > 20 ? 'bg-[#2bd66f]' : 'bg-[#ff3344]'} />
            <span className="min-w-12 text-2xl font-black leading-none" style={textShadow}>{Math.round(fuel)}%</span>
          </div>
        </div>

        <div className="hud-panel absolute left-1/2 top-3 -translate-x-1/2 px-6 py-1.5 text-center sm:top-5">
          <div className="hud-label">Stage {wave === 0 ? '-' : wave}</div>
          <div className="mt-0.5 text-3xl font-black leading-none sm:text-4xl" style={textShadow}>{score.toLocaleString()}</div>
        </div>

        <div className="hud-panel absolute right-4 top-4 flex items-center gap-2 px-3 py-1.5 sm:right-6 sm:top-6">
          <CoinIcon />
          <div className="text-right">
            <div className="text-3xl font-black leading-none" style={textShadow}>{credits.toLocaleString()}</div>
            {unsecuredCredits > 0 && <div className="mt-1 text-[10px] font-black uppercase tracking-wider text-[#ffbd3f]" style={textShadow}>Unsecured +{unsecuredCredits.toLocaleString()}</div>}
          </div>
        </div>

        {/* Center stack: Threat, objectives, SAM banner flow top-down with a
            fixed gap — nothing can collide (combo + boss live below it). */}
        <div className="pointer-events-none absolute left-1/2 top-[4.6rem] flex -translate-x-1/2 flex-col items-center gap-1.5">
        {threatInfo && mode === 'playing' && (
          <div className="hud-panel px-3 py-1 text-center">
            <div className="hud-label">Threat {'█'.repeat(threatInfo.level)}{'░'.repeat(5 - threatInfo.level)}</div>
            <div className={`text-[11px] font-black uppercase ${threatInfo.level >= 4 ? 'text-[#ff5566]' : threatInfo.level >= 2 ? 'text-[#ffbd3f]' : 'text-[#bfeeff]'}`}>
              {threatInfo.name} · x{threatInfo.rewardMultiplier.toFixed(2)} reward
            </div>
          </div>
        )}

        {/* Destroyable objective indicators */}
        {objectives && objectives.count > 0 && mode === 'playing' && (
          <div className="flex items-center gap-2">
            {objectives.sam && (
              <span className="rounded-[4px] border border-[#ff5566]/70 bg-[#3d0f14]/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#ff99aa]" style={textShadow}>
                🎯 SAM
              </span>
            )}
            {objectives.radar && (
              <span className="rounded-[4px] border border-[#7ee0ff]/70 bg-[#0a2a3a]/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#bfeeff]" style={textShadow}>
                📡 RADAR
              </span>
            )}
          </div>
        )}

        {samThreat && mode === 'playing' && (
          <div className="w-[min(290px,70vw)] text-center">
            <div className={`rounded-md border px-3 py-1.5 backdrop-blur-sm ${
              samThreat.state === 'INBOUND'
                ? 'border-[#ff3344] bg-[#4a0710]/85 text-[#ff8b96]'
                : samThreat.state === 'LOCKING'
                  ? 'border-[#ff9b3d]/80 bg-[#3e2108]/75 text-[#ffc16f]'
                  : 'border-[#ffd35c]/45 bg-[#352b0b]/55 text-[#ffe392]'
            }`}>
              <div className="flex items-center justify-center gap-2 text-xs font-black uppercase tracking-[0.2em]" style={textShadow}>
                <span style={{ transform: `rotate(${samThreat.bearing}deg)` }}>▲</span>
                <span>{samThreat.state === 'INBOUND' ? 'Missile inbound' : samThreat.state === 'LOCKING' ? 'SAM lock' : 'SAM tracking'}</span>
                <span className="text-white/70">{samThreat.distance}m</span>
              </div>
              {samThreat.state === 'LOCKING' && (
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/50">
                  <div className="h-full bg-[#ff9b3d]" style={{ width: `${clampPercent(samThreat.progress * 100)}%` }} />
                </div>
              )}
              {samThreat.state === 'INBOUND' && countermeasureInfo?.ready && (
                <div className="mt-1 text-[10px] font-black uppercase tracking-wider text-[#ffbd3f]">[C] Flares ready</div>
              )}
            </div>
          </div>
        )}
        </div>

        {/* Tactical minimap — north-up radar, ~12 Hz engine feed */}
        {mode === 'playing' && <MinimapPanel />}

        {countermeasureInfo && mode === 'playing' && (
          <div className="hud-panel pointer-events-none absolute left-4 top-[20.5rem] px-3 py-2 sm:left-6 sm:top-[21rem]">
            <div className="hud-label text-[#ffbd3f]">Flares · C</div>
            <div className="mt-1 text-base tracking-[0.18em] text-[#ffbd3f]">
              {'●'.repeat(countermeasureInfo.charges)}<span className="text-white/25">{'○'.repeat(countermeasureInfo.maxCharges - countermeasureInfo.charges)}</span>
            </div>
            {countermeasureInfo.cooldown > 0 && <div className="text-[10px] font-black text-white/65">{countermeasureInfo.cooldown.toFixed(1)}s</div>}
          </div>
        )}

        {extraction && mode === 'playing' && (
          <div className="pointer-events-none absolute right-4 top-[32.5rem] w-[min(250px,44vw)] sm:right-6 sm:top-[33rem]">
            <div className="hud-panel border-[#55f2a2]/60 px-3 py-2">
              <div className="hud-label text-[#55f2a2]">Extraction Available</div>
              <div className="mt-1 flex justify-between text-xs font-black"><span>{extraction.distance}m</span><span className="text-[#ffbd3f]">Secure +{unsecuredCredits} CR</span></div>
              {extraction.active && (
                <div className="mt-2"><div className="text-[10px] font-black uppercase">Extracting {Math.round(extraction.progress * 100)}%</div><div className="mt-1 h-1.5 bg-black/45"><div className="h-full bg-[#55f2a2]" style={{ width: `${clampPercent(extraction.progress * 100)}%` }} /></div></div>
              )}
              {extraction.carrying && <div className="mt-1 text-[9px] font-black text-[#ffbd3f]">ACTIVE DELIVERY WILL BE ABANDONED</div>}
            </div>
          </div>
        )}

        {extraction && extraction.distance > 70 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-[24%] -translate-x-1/2 text-center">
            <div className="text-3xl font-black text-[#55f2a2]" style={{ ...textShadow, transform: `rotate(${extraction.bearing}deg)` }}>▲</div>
            <div className="text-[10px] font-black uppercase tracking-widest" style={textShadow}>Extract · {extraction.distance}m</div>
          </div>
        )}

        {/* Compact delivery contract card */}
        {delivery && mode === 'playing' && (
          <div className="pointer-events-none absolute right-4 top-[19rem] w-[min(250px,44vw)] sm:right-6 sm:top-[19.5rem]">
            <div className={`hud-panel px-3 py-2.5 ${delivery.difficulty === 'HIGH_VALUE' ? 'border-[#d78cff]/70' : 'border-[#55f2c2]/45'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="hud-label text-[#55f2c2]">Delivery</span>
                <span className={`rounded-[3px] px-1.5 py-0.5 text-[9px] font-black tracking-wider ${
                  delivery.difficulty === 'HIGH_VALUE'
                    ? 'bg-[#d78cff]/25 text-[#edc8ff]'
                    : delivery.difficulty === 'RISKY'
                      ? 'bg-[#ff8a44]/25 text-[#ffbd8e]'
                      : 'bg-white/10 text-white/55'
                }`}>
                  {delivery.difficulty.replace('_', ' ')}
                </span>
              </div>
              <div className="mt-1 text-base font-black uppercase tracking-wide text-white" style={textShadow}>
                <span className="mr-1.5 text-[#ffbd3f]">{delivery.cargoIcon}</span>{delivery.cargoName}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-black uppercase tracking-wider">
                <span className={delivery.action === 'PICKUP' ? 'text-[#ffbd3f]' : 'text-[#55f2c2]'}>{delivery.action}</span>
                <span className="text-white">{delivery.distance >= 1000 ? `${(delivery.distance / 1000).toFixed(1)} km` : `${delivery.distance} m`}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-white/55">{delivery.destinationName}</div>
              <div className="mt-2 flex items-end justify-between gap-2 border-t border-white/12 pt-1.5">
                <div>
                  <div className="hud-label">Reward</div>
                  <div className="text-base font-black text-[#ffe66d]">{delivery.reward} CR</div>
                  {delivery.samRiskBonus > 0 && <div className="text-[9px] font-black uppercase text-[#ff9b3d]">+{delivery.samRiskBonus} SAM risk</div>}
                </div>
                {delivery.timeBonusRemaining !== null && (
                  <div className="text-right">
                    <div className="hud-label">Time Bonus</div>
                    <div className={delivery.timeBonusRemaining > 0 ? 'text-base font-black text-[#55f2c2]' : 'text-base font-black text-white/35'}>
                      {formatDuration(delivery.timeBonusRemaining)}
                    </div>
                  </div>
                )}
              </div>
              {(delivery.state === 'PICKUP_READY' || delivery.state === 'DELIVERING') && (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-widest">
                    <span className={delivery.state === 'DELIVERING' ? 'text-[#55f2c2]' : 'text-[#ffbd3f]'}>
                      Hold position
                    </span>
                    <span className="text-white/60">{Math.round(clampPercent(delivery.progress * 100))}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/45">
                    <div
                      className={`h-full transition-[width] duration-75 ${delivery.state === 'DELIVERING' ? 'bg-[#55f2c2]' : 'bg-[#ffbd3f]'}`}
                      style={{ width: `${clampPercent(delivery.progress * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Edge-style route direction cue; the world beacon takes over nearby. */}
        {delivery && delivery.action !== 'COMPLETE' && delivery.distance > 70 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-[20%] -translate-x-1/2 text-center">
            <div
              className={`mx-auto text-3xl font-black ${delivery.action === 'PICKUP' ? 'text-[#ffbd3f]' : 'text-[#55f2c2]'}`}
              style={{ ...textShadow, transform: `rotate(${delivery.bearing}deg)` }}
            >
              ▲
            </div>
            <div className="mt-0.5 text-[10px] font-black uppercase tracking-[0.18em] text-white" style={textShadow}>
              {delivery.action} · {delivery.distance}m
            </div>
          </div>
        )}

        {/* Arcade announcement toast */}
        {announcement && mode === 'playing' && (
          <div key={announcement.key} className="arcade-announce pointer-events-none absolute left-1/2 top-[30%] -translate-x-1/2 text-center">
            <div className="text-4xl font-black uppercase tracking-widest" style={{ ...textShadow, color: announcement.color }}>
              {announcement.text}
            </div>
            {announcement.sub && (
              <div className="mt-1 text-sm font-bold uppercase tracking-[0.2em] text-white" style={textShadow}>
                {announcement.sub}
              </div>
            )}
          </div>
        )}

        {/* Boss health bar — below the combo display so it never collides
            with the Threat panel at top-[4.6rem]. */}
        {bossInfo && mode === 'playing' && (
          <div className="absolute left-1/2 top-[18.5rem] w-[min(480px,70vw)] -translate-x-1/2">
            <div className="hud-panel px-3 py-2">
              <div className="hud-label text-[#e79bff]">Hostile Gunship — Archon</div>
              <div className="mt-1.5 h-3.5 overflow-hidden rounded-[2px] border border-black/60 bg-black/55 shadow-[0_2px_0_rgba(0,0,0,0.35)]">
                <div
                  className="h-full bg-gradient-to-r from-[#6b1fc2] to-[#d84cff] transition-[width] duration-200"
                  style={{ width: `${clampPercent((bossInfo.hp / Math.max(1, bossInfo.maxHp)) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {mode === 'playing' && !upgradeOffer && (
          <button
            type="button"
            onClick={pauseGame}
            className="pointer-events-auto absolute right-4 top-[4.6rem] rounded-[6px] border-2 border-white/70 bg-[#264fb1]/85 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-[0_4px_0_#16265f,0_8px_18px_rgba(0,0,0,0.24)] transition hover:-translate-y-0.5 hover:bg-[#315fd0] active:translate-y-1 active:shadow-[0_2px_0_#16265f,0_5px_12px_rgba(0,0,0,0.22)] sm:right-6 sm:top-[5.2rem]"
            style={textShadow}
          >
            Pause
          </button>
        )}

        {/* Weapon + XP + Salvo — one left stack with a fixed gap so the panels
            can never collide as content grows (LV badges, reloading, locks). */}
        <div className="pointer-events-none absolute left-4 top-[8.25rem] flex flex-col items-start gap-2 sm:left-6 sm:top-[9rem]">
          {weaponInfo && mode === 'playing' && (
            <div className="hud-panel px-3 py-2">
              <div className="flex items-center gap-2">
                <BulletIcon />
                <span className="text-base font-black uppercase tracking-wider" style={textShadow}>
                  {weaponInfo.name}
                </span>
                {(weaponInfo.level ?? 1) > 1 && (
                  <span className="rounded-[3px] border border-[#7ee0ff]/60 bg-[#0a2a3a]/80 px-1.5 py-0.5 text-[10px] font-black text-[#7ee0ff]">
                    LV.{weaponInfo.level}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2">
                {weaponInfo.reloading ? (
                  <span className="text-base font-black text-yellow-300" style={textShadow}>
                    RELOADING... {Math.ceil(weaponInfo.reloadTimer)}s
                  </span>
                ) : (
                  <span className="text-base font-black" style={textShadow}>
                    {weaponInfo.ammo} / {weaponInfo.maxAmmo}
                  </span>
                )}
              </div>
            </div>
          )}

          {mode === 'playing' && (
            <div className="flex items-center gap-2">
              <span className="rounded-[4px] border border-[#56e6ff]/80 bg-[#0a2a3a]/80 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#bfeeff]" style={textShadow}>
                LV.{runLevel}
              </span>
              <div className="h-2 w-32 overflow-hidden rounded-[2px] border border-black/45 bg-black/40">
                <div
                  className="h-full rounded-[2px] bg-gradient-to-r from-[#2b9fd8] to-[#56e6ff] transition-[width] duration-200"
                  style={{ width: `${clampPercent(runXpProgress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {salvoInfo && mode === 'playing' && (
            <div className="hud-panel px-3 py-2">
              <div className="flex items-center gap-2">
                <TargetIcon />
                <span className="text-sm font-black uppercase tracking-wider" style={textShadow}>
                  Multi-Salvo
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                {salvoInfo.isPainting ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-red-400 animate-pulse uppercase" style={textShadow}>
                      Locking:
                    </span>
                    <div className="flex gap-0.5">
                      {[0, 1, 2, 3, 4, 5].map((idx) => {
                        const active = idx < salvoInfo.locks;
                        return (
                          <div
                            key={idx}
                            className={`h-4.5 w-3.5 border border-black/45 rounded-[2px] transition-all duration-150 ${active ? 'bg-[#ff3344] shadow-[0_0_8px_#ff3344] border-red-300' : 'bg-black/40'}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                ) : salvoInfo.cooldown > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-black text-white/50" style={textShadow}>
                      COOLDOWN
                    </span>
                    <div className="h-2 w-20 overflow-hidden rounded-[2px] border border-black/45 bg-black/40">
                      <div className="h-full bg-red-400/50 transition-all duration-300" style={{ width: `${(salvoInfo.cooldown / 5.0) * 100}%` }} />
                    </div>
                    <span className="text-xs font-black text-white/60" style={textShadow}>
                      {salvoInfo.cooldown}s
                    </span>
                  </div>
                ) : (
                  <span className="text-xs font-extrabold text-[#35e66d] animate-pulse" style={textShadow}>
                    READY (HOLD Q / R-CLICK)
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Combo Display with expiry timer bar — sits below the center stack
            so it never collides with Threat/objectives/SAM banner. */}
        {comboInfo && comboInfo.count > 1 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-[14.5rem] -translate-x-1/2 text-center">
            <div className="text-2xl font-black text-yellow-300" style={textShadow}>
              {comboInfo.count}x COMBO
            </div>
            <div className="text-sm font-bold text-yellow-200" style={textShadow}>
              x{comboInfo.multiplier.toFixed(1)} MULTIPLIER
            </div>
            <div className="mx-auto mt-1.5 h-1.5 w-40 overflow-hidden rounded-full border border-black/40 bg-black/40">
              <div
                className="h-full rounded-full bg-gradient-to-r from-yellow-500 to-yellow-300 transition-[width] duration-100"
                style={{ width: `${clampPercent((comboInfo.timer / 3.0) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {statusInfo && mode === 'playing' && (
          <div className={`pointer-events-none absolute right-4 flex flex-col items-end gap-1 text-[11px] font-black uppercase tracking-[0.12em] opacity-80 sm:right-6 top-[37.5rem] sm:top-[38rem]`}>
            {statusInfo.threat > 0.68 && (
              <div className="hud-status border-[#ff3344]/60 text-[#ffd3d7]" style={textShadow}>
                Threat High
              </div>
            )}
            {statusInfo.afterburner && (
              <div className="hud-status border-[#ff7722]/60 text-[#ffb066] animate-pulse" style={textShadow}>
                🔥 Afterburner
              </div>
            )}
            {statusInfo.risk && statusInfo.risk > 1 && (
              <div className="hud-status border-[#ff3344]/60 text-[#ff8899]" style={textShadow}>
                RISK x{statusInfo.risk.toFixed(2)}
              </div>
            )}
            {statusInfo.damageBoost > 0 && (
              <div className="hud-status border-[#ffe66d]/50 text-[#ffe66d]" style={textShadow}>
                Damage {Math.ceil(statusInfo.damageBoost)}s
              </div>
            )}
            {statusInfo.shield > 0 && (
              <div className="hud-status border-[#80d8ff]/50 text-[#bfeeff]" style={textShadow}>
                Shield {Math.ceil(statusInfo.shield)}s
              </div>
            )}
            {statusInfo.speedBoost > 0 && (
              <div className="hud-status border-[#ff88ff]/50 text-[#ffd0ff]" style={textShadow}>
                Boost {Math.ceil(statusInfo.speedBoost)}s
              </div>
            )}
          </div>
        )}

        {/* Contextual onboarding — short fading hints, never a persistent bar */}
        {mode === 'playing' && !touchDevice && <ControlHints runId={hintsKey} />}
      </div>

      {mode === 'playing' && waveMessage && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/10">
          <h2 className="whitespace-pre-line text-center text-5xl font-black uppercase tracking-widest text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.55)] sm:text-6xl">
            {waveMessage}
          </h2>
        </div>
      )}

      {/* Touch controls */}
      {mode === 'playing' && touchDevice && (
        <div className="absolute inset-0 z-30">
          <VirtualJoystick side="left" onStick={dispatchStick('helistrike:left-stick')} />
          <VirtualJoystick side="right" onStick={dispatchStick('helistrike:right-stick')} />
          <FireButton onFire={setFire} />
          <button
            type="button"
            aria-label="Deploy flares"
            onPointerDown={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('helistrike:countermeasure')); }}
            className="pointer-events-auto absolute bottom-36 right-8 h-16 w-16 rounded-full border-2 border-[#ffbd3f] bg-[#613914]/80 text-[10px] font-black uppercase text-[#ffe0a0]"
          >Flares</button>
        </div>
      )}

      {mode === 'paused' && (
        <PauseOverlay
          onResume={resumeGame}
          onRestart={restartRun}
          onSettings={() => setShowSettings(true)}
          onQuit={quitToMenu}
        />
      )}

      {/* Weapon upgrade roulette */}
      {upgradeOffer && mode === 'playing' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45">
          <div className="w-[min(640px,92vw)] rounded-2xl border-2 border-[#7ee0ff]/60 bg-[#0b1c33]/95 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.6)] sm:p-7">
            <div className="mb-1 text-center text-[11px] font-black uppercase tracking-[0.3em] text-[#7ee0ff]">
              Level Up
            </div>
            <h2 className="mb-5 text-center text-2xl font-black uppercase tracking-widest text-white" style={textShadow}>
              Choose an Upgrade
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {upgradeOffer.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => chooseUpgrade(opt.id)}
                  className="group flex flex-col items-center gap-2 rounded-xl border-2 border-white/25 bg-[#12294a]/90 px-4 py-5 text-center transition hover:-translate-y-1 hover:border-[#7ee0ff] hover:bg-[#17345c] hover:shadow-[0_10px_28px_rgba(126,224,255,0.25)] active:translate-y-0"
                >
                  <span className="text-4xl transition-transform group-hover:scale-125">{opt.icon}</span>
                  <span className="text-sm font-black uppercase tracking-wide text-[#7ee0ff]">{opt.title}</span>
                  <span className="text-xs font-semibold leading-snug text-white/80">{opt.desc}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 text-center text-[11px] font-bold uppercase tracking-wider text-white/40">
              Game paused — pick one
            </div>
          </div>
        </div>
      )}

      {showSettings && <SettingsPanel settings={settings} onChange={applySettings} onClose={() => setShowSettings(false)} />}

      {showHangar && mode === 'menu' && (
        <HangarScreen
          mastery={mastery}
          playerModel={playerModel}
          credits={credits}
          hangarUpgrades={hangarUpgrades}
          onSelectModel={selectPlayerModel}
          onBuyUpgrade={purchaseHangarUpgrade}
          onBack={() => setShowHangar(false)}
        />
      )}

      {(mode === 'menu' || mode === 'gameover') && !showHangar && (
        <ThreeDMenu
          mode={mode}
          score={score}
          highScore={highScore}
          wave={wave}
          isNewBest={isNewBest}
          stats={runStats}
          onStart={startRun}
          onSettings={() => setShowSettings(true)}
          onHangar={() => setShowHangar(true)}
        />
      )}

      {/* On-screen perf overlay (dev aid) — F2 toggles, hidden on touch devices */}
      {showPerf && !touchDevice && perfStats && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-30 select-none rounded-[5px] border border-white/20 bg-black/55 px-2 py-1 font-mono text-[10px] font-bold leading-tight text-[#7ee0ff] shadow-[0_2px_8px_rgba(0,0,0,0.35)]" style={textShadow}>
          <div>{perfStats.fps} FPS · {perfStats.drawCalls} DC · {(perfStats.triangles / 1000).toFixed(1)}k TRI</div>
          <div className="text-white/75">
            {perfStats.geometries} GEO · {perfStats.textures} TEX · {perfStats.programs} PROG
          </div>
          <div className="text-[#ffe66d]">
            {perfStats.enemies} EN · {perfStats.powerups} PU · {perfStats.objectives} OBJ · {perfStats.quality.toUpperCase()}
          </div>
        </div>
      )}
    </div>
  );
}
