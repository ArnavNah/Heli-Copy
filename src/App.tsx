import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GameEngine, HelicopterModel } from './game';
import type { GameSettings, UpgradeId, UpgradeOption } from './game';
import { readMastery } from './game/logic';
import { coinsForScore, formatDuration } from './game/logic';

type GameMode = 'menu' | 'playing' | 'paused' | 'gameover';

type RunStats = {
  time: number;
  kills: number;
  maxCombo: number;
  accuracy: number;
  wave: number;
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

function Meter({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-4 w-28 overflow-hidden rounded-[4px] border-2 border-black/45 bg-black/35 shadow-[0_2px_0_rgba(0,0,0,0.35)] sm:w-44">
      <div className={`h-full ${color} transition-[width] duration-300`} style={{ width: `${clampPercent(value)}%` }} />
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
              <span>{isGameOver ? 'Run Ended' : 'Heli-Strike'}</span>
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
                  <div className="setting-desc">High enables bloom FX & sharp pixels</div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onChange({ quality: 'low' })}
                    className={`seg-btn ${settings.quality === 'low' ? 'seg-on' : ''}`}
                  >
                    Low
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange({ quality: 'high' })}
                    className={`seg-btn ${settings.quality === 'high' ? 'seg-on' : ''}`}
                  >
                    High
                  </button>
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
  onSelectModel,
  onBack,
}: {
  mastery: number[];
  playerModel: HelicopterModel;
  onSelectModel: (m: HelicopterModel) => void;
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
              Pick your aircraft — mastery persists across runs
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
  const [showSettings, setShowSettings] = useState(false);
  const [showHangar, setShowHangar] = useState(false);
  const [mastery, setMastery] = useState<number[]>(() => readMastery());
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
    depot: boolean;
    count: number;
  } | null>(null);
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
      setBossInfo(e.detail.boss || null);
      setObjectives(e.detail.objectives || null);

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
    engineRef.current?.startGame();
  };

  const restartRun = () => {
    setMode('playing');
    setRunStats(null);
    setIsNewBest(false);
    setShowHangar(false);
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

  const coins = coinsForScore(score);
  const textShadow = { textShadow: '0 2px 0 rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.35)' };
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

        <div className="absolute left-4 top-3 flex flex-col gap-2 sm:left-6 sm:top-5">
          <div className="flex items-center gap-2">
            <HeartIcon />
            <Meter value={health} color={health > 30 ? 'bg-[#35e66d]' : 'bg-[#ef233c]'} />
            <span className="min-w-10 text-xl font-black leading-none" style={textShadow}>{Math.round(health)}</span>
          </div>
          <div className="flex items-center gap-2">
            <GasIcon />
            <Meter value={fuel} color={fuel > 20 ? 'bg-[#2bd66f]' : 'bg-[#ff3344]'} />
            <span className="min-w-10 text-xl font-black leading-none" style={textShadow}>{Math.round(fuel)}%</span>
          </div>
        </div>

        <div className="absolute left-1/2 top-3 -translate-x-1/2 text-center sm:top-5">
          <div className="text-xs font-extrabold uppercase tracking-[0.14em] sm:text-sm sm:tracking-[0.18em]" style={textShadow}>Stage {wave === 0 ? '-' : wave}</div>
          <div className="mt-1 text-2xl font-black leading-none sm:text-3xl" style={textShadow}>{score.toLocaleString()}</div>
        </div>

        <div className="absolute right-4 top-4 flex items-center gap-2 sm:right-6 sm:top-6">
          <CoinIcon />
          <span className="text-3xl font-black leading-none" style={textShadow}>{coins.toLocaleString()}</span>
        </div>

        {/* Destroyable objective indicators */}
        {objectives && objectives.count > 0 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-[7.5rem] flex -translate-x-1/2 items-center gap-2">
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
            {objectives.depot && (
              <span className="rounded-[4px] border border-[#ffaa33]/70 bg-[#3d2b08]/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-[#ffd68f]" style={textShadow}>
                📦 DEPOT
              </span>
            )}
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

        {/* Boss health bar */}
        {bossInfo && mode === 'playing' && (
          <div className="absolute left-1/2 top-[4.5rem] w-[min(460px,68vw)] -translate-x-1/2">
            <div className="mb-1 text-center text-xs font-black uppercase tracking-[0.22em] text-[#d84cff]" style={textShadow}>
              Boss
            </div>
            <div className="h-3.5 overflow-hidden rounded-[4px] border-2 border-[#d84cff]/80 bg-black/45 shadow-[0_3px_0_rgba(0,0,0,0.35)]">
              <div
                className="h-full bg-gradient-to-r from-[#6b1fc2] to-[#d84cff] transition-[width] duration-200"
                style={{ width: `${clampPercent((bossInfo.hp / Math.max(1, bossInfo.maxHp)) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {mode === 'playing' && !upgradeOffer && (
          <button
            type="button"
            onClick={pauseGame}
            className="pointer-events-auto absolute right-4 top-14 rounded-[6px] border-2 border-white/70 bg-[#264fb1]/80 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-[0_4px_0_#16265f,0_8px_18px_rgba(0,0,0,0.24)] transition hover:-translate-y-0.5 hover:bg-[#315fd0] active:translate-y-1 active:shadow-[0_2px_0_#16265f,0_5px_12px_rgba(0,0,0,0.22)] sm:right-6 sm:top-16"
            style={textShadow}
          >
            Pause
          </button>
        )}

        {/* Weapon HUD */}
        {weaponInfo && mode === 'playing' && (
          <div className="pointer-events-none absolute left-4 top-20 flex flex-col gap-1 sm:left-6 sm:top-24">
            <div className="flex items-center gap-2">
              <BulletIcon />
              <span className="text-sm font-black uppercase tracking-wider" style={textShadow}>
                {weaponInfo.name}
              </span>
              {(weaponInfo.level ?? 1) > 1 && (
                <span className="rounded-[4px] border border-[#7ee0ff]/70 bg-[#0a2a3a]/70 px-1.5 py-0.5 text-[10px] font-black text-[#7ee0ff]">
                  LV.{weaponInfo.level}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {weaponInfo.reloading ? (
                <span className="text-sm font-black text-yellow-300" style={textShadow}>
                  RELOADING... {Math.ceil(weaponInfo.reloadTimer)}s
                </span>
              ) : (
                <span className="text-sm font-black" style={textShadow}>
                  {weaponInfo.ammo} / {weaponInfo.maxAmmo}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Run level + XP bar (Vampire-Survivors style) */}
        {mode === 'playing' && (
          <div className="pointer-events-none absolute left-4 top-[11.5rem] flex flex-col gap-1 sm:left-6 sm:top-[13.5rem]">
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
          </div>
        )}

        {/* Salvo HUD */}
        {salvoInfo && mode === 'playing' && (
          <div className="pointer-events-none absolute left-4 top-34 flex flex-col gap-1 sm:left-6 sm:top-38">
            <div className="flex items-center gap-2">
              <TargetIcon />
              <span className="text-sm font-black uppercase tracking-wider" style={textShadow}>
                Multi-Salvo
              </span>
            </div>
            <div className="flex items-center gap-2">
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

        {/* Combo Display with expiry timer bar */}
        {comboInfo && comboInfo.count > 1 && mode === 'playing' && (
          <div className="pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 text-center">
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
          <div className="pointer-events-none absolute right-4 top-28 flex flex-col items-end gap-1 text-xs font-black uppercase tracking-[0.12em] sm:right-6 sm:top-32">
            {statusInfo.threat > 0.68 && (
              <div className="rounded-[5px] border border-[#ff3344]/70 bg-[#40101a]/70 px-3 py-1 text-[#ffd3d7]" style={textShadow}>
                Threat High
              </div>
            )}
            {statusInfo.afterburner && (
              <div className="rounded-[5px] border border-[#ff7722]/80 bg-[#3d1f08]/80 px-3 py-1 text-[#ffb066] animate-pulse" style={textShadow}>
                🔥 Afterburner
              </div>
            )}
            {statusInfo.risk && statusInfo.risk > 1 && (
              <div className="rounded-[5px] border border-[#ff3344]/80 bg-[#3d0a12]/80 px-3 py-1 text-[#ff8899]" style={textShadow}>
                RISK x{statusInfo.risk.toFixed(2)}
              </div>
            )}
            {statusInfo.damageBoost > 0 && (
              <div className="rounded-[5px] border border-[#ffe66d]/70 bg-[#3d2b08]/70 px-3 py-1 text-[#ffe66d]" style={textShadow}>
                Damage {Math.ceil(statusInfo.damageBoost)}s
              </div>
            )}
            {statusInfo.shield > 0 && (
              <div className="rounded-[5px] border border-[#80d8ff]/70 bg-[#092a3f]/70 px-3 py-1 text-[#bfeeff]" style={textShadow}>
                Shield {Math.ceil(statusInfo.shield)}s
              </div>
            )}
            {statusInfo.speedBoost > 0 && (
              <div className="rounded-[5px] border border-[#ff88ff]/70 bg-[#38113a]/70 px-3 py-1 text-[#ffd0ff]" style={textShadow}>
                Boost {Math.ceil(statusInfo.speedBoost)}s
              </div>
            )}
          </div>
        )}

        {mode === 'playing' && !touchDevice && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-[6px] border border-white/30 bg-[#102447]/55 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-white shadow-[0_8px_24px_rgba(0,0,0,0.2),inset_0_0_18px_rgba(255,230,109,0.12)] backdrop-blur-sm">
            <div className="flex items-center gap-1">
              <KeyCap>WASD</KeyCap>
              <span style={textShadow}>Move</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <KeyCap>Shift</KeyCap>
              <span style={textShadow}>Afterburn</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <KeyCap>Space</KeyCap>
              <span style={textShadow}>Climb</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <KeyCap>Alt</KeyCap>
              <span style={textShadow}>Descend</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <BulletIcon />
              <span style={textShadow}>Hold Fire</span>
            </div>
            <div className="h-6 w-px bg-white/25" />
            <div className="flex items-center gap-1">
              <KeyCap>1-4</KeyCap>
              <span style={textShadow}>Weapons</span>
            </div>
          </div>
        )}
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
          onSelectModel={selectPlayerModel}
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

