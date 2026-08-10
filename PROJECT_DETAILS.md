# 🚁 Heli-Strike Arcade Assault — Complete Technical Spec

> Full reverse-engineered details of the codebase, written for AI-assisted rebuild or extension.
> Every number below is the actual value in the source. Total: ~11,500 lines of TypeScript.

---

## 1. Stack & Tooling

| Area | Choice |
|---|---|
| Framework | React 19 (`react`, `react-dom`) + TypeScript 5.8 |
| Build | Vite 6 (`@vitejs/plugin-react`, `@tailwindcss/vite`) — dev server on port 3000 |
| 3D | Three.js 0.184 (`three`, `@types/three`) |
| Physics | cannon-es 0.20 (no other physics deps) |
| Styling | Tailwind CSS 4 (`@import "tailwindcss"` in index.css) + hand-written arcade CSS |
| Tests | Vitest 4 (33 unit tests, all pass) |
| Other deps | `motion`, `lucide-react` (declared; UI is hand-built, not motion-based) |
| Assets | **Zero external assets** — all models are procedural boxes, all audio is Web Audio synthesis |

**package.json scripts**
```json
"dev": "vite --port=3000 --host=0.0.0.0",
"build": "vite build",
"preview": "vite preview",
"clean": "rm -rf dist",
"lint": "tsc --noEmit",          // typecheck only
"test": "vitest run"
```

**Entry:** `index.html` → `src/main.tsx` (StrictMode) → `App.tsx`.

---

## 2. Architecture — How It Fits Together

```
App.tsx (React shell: HUD/menus/settings/touch UI)
   │  creates + owns GameEngine on <canvas>
   ▼
GameEngine (src/game/engine.ts) — main loop (requestAnimationFrame tick), input,
│  AI director, waves, scoring, upgrades, event bridge
│
├── Helicopter / Enemy / Projectile / PowerUp / Objective / Turret (entities.ts)
├── CityEnvironment + TrafficCar + Billboard + Cloud (city.ts)
├── GPUParticleSystem / RainSystem / WeatherSystem / VolumetricExplosions (particles.ts)
├── AudioManager (audio.ts — synthesized Web Audio)
├── createBox / createGlowBox / createSkyDome / materials (materials.ts)
├── enums, configs, WeaponConfig (types.ts)
└── pure game math (logic.ts) ← tested by logic.test.ts
```

**Key architectural decisions:**
1. **Engine ↔ UI via `window` CustomEvents.** The engine never touches React state. React dispatches input events (`helistrike:*`) to the engine; the engine dispatches HUD snapshots back. See §11 for the full contract.
2. **Cannon world is step-less.** Physics bodies are moved *kinematically* by the engine each tick (`body.position.set` / `body.velocity.set`); no `world.step` loop for gameplay entities. Buildings/turrets/objectives use static bodies only for collision queries.
3. **Time is wall-clock seconds** (`performance.now()/1000`) with a `timeScale` for hit-stop. `delta = realDelta * timeScale`.
4. **Everything is low-poly procedural** — one shared `BoxGeometry().toNonIndexed()` per mesh with a flat-shaded Lambert material (`createLowPolyMaterial`) or an additive glow material (`createGlowMaterial`).
5. **Pure logic lives in `logic.ts`** (no THREE/CANNON/DOM imports) — that's the unit-tested layer.

---

## 3. Data Models (types.ts — full)

### Color/FX constants
```ts
SKY_CLEAR_COLOR  = 0x78cfe0   SKY_STORM_COLOR  = 0x51647f
FOG_CLEAR_COLOR  = 0x86d4df   FOG_STORM_COLOR  = 0x29364f
TARGET_RENDER_FPS = 60        MAX_RENDER_PIXEL_RATIO = 1.0
```

### Types
```ts
type RooftopSpot = { x, y, z }                         // enemy spawn point on a roof
interface CityBlock { x, z, width, depth, height, chunkId, meshes: Mesh[],
                      body?: CANNON.Body, hp, maxHp, destroyed,
                      collapseProgress?, initialHeights?[] }
interface EnemyLock { body: CANNON.Body; active: boolean }   // salvo lock target
interface WorldChunk { id, group: Group, bodies: Body[], blocks: CityBlock[], spots: RooftopSpot[] }
type StickInput = { x: number; y: number; active: boolean }
type QualityPreset = 'low' | 'high'
type Difficulty = 'casual' | 'normal' | 'hard'
interface GameSettings { invertedY, gamepadSensitivity, quality, volume, touchMode,
                         difficulty, autoAim }          // autoAim = gun turret tracks target
```

### Enums (numeric values matter — used via `type` index)
```ts
EnemyType    { BASIC=0, SHOOTER=1, TANK=2, DRONE=3, BOSS=4 }
EnemyModifier{ NONE=0, SHIELDED=1, REGENERATING=2, ELITE=4 }   // bit flags
AttackPattern{ CHASE=0, CIRCLE=1, KAMIKAZE=2, ARTILLERY=3 }
ObjectiveType{ SAM_SITE=0, RADAR_TOWER=1, AMMO_DEPOT=2 }
WeaponType   { MACHINE_GUN=0, MISSILE=1, ROCKET=2, SHOTGUN=3 }
HelicopterModel{ APACHE=0, NIGHTHAWK=1, WARLOCK=2 }
PowerUpType  { HEALTH=0, DAMAGE_BOOST=1, SHIELD=2, AMMO=3, SPEED_BOOST=4, BOMB=5, FUEL=6, XP_GEM=7 }
PowerUpState { IDLE, COLLECTING, COLLECTED }
```

### Weapon configs (the Armory)
```ts
interface WeaponConfig { name, damage, fireRate(sec), ammo, maxAmmo, reloadTime,
                         speed, count, spread, blastRadius, color, homing }
MACHINE_GUN: damage 13, fireRate 0.055, ammo/max 300, reload 1.5, speed 430,
             count 2 (twin tracers), spread 0.015, blast 0, color 0xff2a2a, homing false
MISSILE:     damage 55, fireRate 0.95, ammo 20, reload 2.5, speed 260, count 1,
             blast 16, color 0x44ff44, homing TRUE
ROCKET:      damage 80, fireRate 1.45, ammo 12, reload 3.2, speed 235, count 1,
             blast 28, color 0xffaa00, homing false
SHOTGUN:     damage 10/pellet, fireRate 0.45, ammo 40, reload 2.0, speed 280,
             count 6 pellets, spread 0.3, blast 0, color 0xffdd22, homing false
```

---

## 4. Pure Logic Layer (logic.ts — unit-tested)

### Difficulty
```ts
interface DifficultyConfig { enemyHp, enemyDamage, spawnRate, maxRisk, objectiveHp }
DIFFICULTIES = {
  casual: { 0.75, 0.7, 0.8, 0.5, 0.8 }
  normal: { 1,    1,   1,   0.75, 1 }
  hard:   { 1.45, 1.35, 1.25, 1.0, 1.35 }
}
```
`maxRisk` is the *bonus* ceiling: at 1 HP the score multiplier = 1 + maxRisk (1.5× casual, 1.75× normal, 2.0× hard).

### Wave curves (the difficulty curve)
```ts
waveEnemyCount(wave)   = 8 + floor(wave * 6.5)              // enemies budget per wave
waveEnemyPower(wave)   = min(9, 1 + (wave-1) * 0.18)        // HP ×1.18/wave, cap 9× (~wave 46)
waveEnemyDamage(wave)  = min(3.2, 1 + (wave-1) * 0.07)      // shot dmg ×1.07/wave, cap 3.2×
waveEnemyFireRate(wave)= max(0.45, 1 - (wave-1) * 0.04)     // ×0.96/wave (faster), floor 0.45
waveDuration(wave)     = max(30, 45 - (wave-1) * 1.5)       // 45s → 30s floor
comboMultiplier(count) = 1 + min(count * 0.1, 5.0)          // → max 6×
coinsForScore(score)   = floor(score / 100)
accuracyFor(hit, fired)= hit/fired clamped 0..1 (0 if no shots)
formatDuration(s)      = "m:ss"
```

### Weapon XP / levels (meta-progression)
```ts
MAX_WEAPON_LEVEL = 5
weaponXpForLevel(l)  // cumulative XP to REACH level l: l=2→4, 3→10, 4→18, 5→28
weaponLevelForXp(xp, maxLevel=5)
weaponLevelBonus(lvl): { damageMult: 1+(lvl-1)*0.18,
                         fireRateMult: max(0.55, 1-(lvl-1)*0.09),
                         reloadMult: max(0.5, 1-(lvl-1)*0.12),
                         extraProjectiles: lvl>=4 ? 1 : 0 }
```

### Run-level XP (Vampire-Survivors upgrade loop)
```ts
MAX_RUN_LEVEL = 15
runXpForLevel(l)  // cumulative XP to REACH level l: 10, 25, 45, 70, 100, ... (+5 per level after lv2)
runLevelForXp(xp, maxLevel=15)
xpForEnemyType(type, isElite): BOSS→50, elite→15, TANK→5, DRONE→3, SHOOTER→2, BASIC→1
```

### Risk / kill confirmations
```ts
riskMultiplier(health, maxHealth, maxBonus=0.75)
  // 1.0 above 40% HP; below, scales linearly: 1 + (1 - health/40%) * maxBonus
multikillTier(streak): 8+ "RAMPAGE!" #ff3344 | 6+ "KILLING SPREE" #ff6677 |
                       4+ "QUAD KILL" #ffaa22 | 3+ "TRIPLE KILL" #ffdd44 |
                       2+ "DOUBLE KILL" #ffee88 | else null
```

### Boss phases
```ts
bossPhaseForRatio(ratio): >0.66→3, >0.33→2, else 1     // phase 3 = easiest (start)
BOSS_TELEGRAPH_DURATION = 0.8                           // seconds of warning beam
bossVolleyConfig(phase): 1→{9 shots, 0.14 spread, 135 speed}
                         2→{7 shots, 0.12 spread, 115}
                         3→{5 shots, 0.17 spread, 115}
```

### Objectives
```ts
objectiveConfig(type): SAM  {hp 170, points 300, radius 4.2, "SAM SITE"}
                       RADAR{hp 220, points 250, radius 4.6, "RADAR TOWER"}
                       DEPOT{hp 190, points 200, radius 4.4, "AMMO DEPOT"}
```

### Mastery persistence
```ts
readMastery() → number[4] from localStorage 'helistrike:mastery' (each 0..5)
writeMastery(weaponIndex, level) → max across runs, writes back
```

### Upgrade roulette pool (pick 1 of 3)
```ts
type UpgradeId = 'damage'|'fireRate'|'ammo'|'reload'|'salvoCooldown'|'maxHealth'
               |'fuelEfficiency'|'shield'|'speed'|'bomb'
UPGRADE_POOL = [
  Overclock Rounds ⚡ (+25% damage all weapons)
  Hair Trigger 🔥 (+18% fire rate)
  Extended Mag 📦 (+30% max ammo)
  Speed Loader 🔧 (reload 25% faster)
  Salvo Overclock 🎯 (salvo cooldown -35%)
  Reinforced Hull 🛡️ (+20 max HP & heal 20)
  Turbine Tune ⛽ (fuel drain -30%)
  Aegis Field 🔮 (8s shield)
  Afterburners 💨 (+20% speed 12s)
  Airstrike 💣 (instant screen clear)
]
pickUpgrades(count, rng=Math.random) → distinct random picks (no duplicates)
```

---

## 5. Entities (entities.ts — 2,849 lines)

### Base `Entity` (abstract)
```ts
class Entity { active = true; constructor(scene, world); update(time); destroy() }
```

### `Helicopter` (player)
Fields: `model`, `targetPosition`, `lastTargetPosition`, `mainRotor`, `tailRotor`, `shieldMesh`, `gunMount` (Group), `gunAimMode`, `gunAimPoint`, `rotorHealth`, `engineHealth`, `hoverFloor`, `smoothedHoverFloor`, `aimPosition`, `dashTimer/dashDuration(0.28)/dashRollDirection/dashPitchDirection`.

Methods:
- `constructor(scene, world, model)` — builds one of 3 procedural models (51+ meshes each):
  - `buildApache` — military attack heli: body, cockpit, tail boom, stub wings, skids, 4-blade main rotor + tail rotor, gun turret under nose, nav lights (red/green wingtips), tail beacon, antenna.
  - `buildNighthawk` — angular stealth: twin tails, dark finish, beacons, no skids (retractable look).
  - `buildWarlock` — heavy gunship: bulky hull, wide wings, twin engine intakes with glow, roof beacon.
- `setTarget(x,y,z)` / `setAim(x,z)` / `setHoverFloor(h)` / `setGunAim(x,y,z,active)` — gun turret tracks the aim point in `gunAimMode` (auto-aim), body keeps flying straight.
- `takeDamage(amount)` — drains rotor/engine HP too, `triggerCrashTilt(strength)` (out-of-control wobble), `repair(percent)`, `reset()`.
- `update(...)` — **flight model**: WASD moves `targetPosition` on the XZ plane at ~movement speed; `Space`/`Alt` adjust target Y (climb/descend). A **PD controller** drives the body: `force = (error * Kp - velocity * Kd) * mass + gravityComp`, with per-axis gains (vertical: `ey*45 - vy*14`; horizontal similar). When no keys are held the target decays back onto the ship (`1 - exp(-delta*8)`) → true idle hover with a gentle breathing bob. Banking/tilt (pitch/roll) derives from velocity + hover bob; gun turret pitches to `gunAimPoint` when `gunAimMode`.
- `animateRotors(forceMag, maxForce, delta)` — rotor spin speed ∝ throttle.
- `triggerDash(dx, dz)` — double-tap W/A/S/D dash (bell-curve speed, max ~155).

### `Enemy`
Fields: `ring` (Group — everything yaws/bobs inside it), `hp/maxHp`, `type`, `modifier` (bit flags), `pattern`, `isElite`, `lastShotTime`, `basePoints` (default 50), `radius` (2.2), `shieldHp/shieldMaxHp/shieldMesh`, `lastDamageTime`, `regenPerSecond`, `patternTimer/patternCooldown`, `phase (1|2|3)`, `telegraphTimer/telegraphActive/telegraphStartTime/telegraphMesh`, `waveDamageMult/waveFireRateMult`, `personalityOffset`, `evadeTimer`, `flankDir`, `smoothVelX/smoothVelZ`, `enemyRotor/enemyTailRotor`.

Constructor builds type-specific low-poly models (inside `ring`, radius-proportional):
- **BOSS "Archon"** (31 meshes) — layered hull + belly, cockpit, glowing nose sensor, magenta core glow, twin nacelles w/ glowing intakes, broad wing + missile pylons + wingtip lights, twin tail booms/fins, dorsal spine, main rotor on raised mast.
- **TANK "Flakpanzer"** (21 meshes) — tracked chassis (2 tracks + 10 road wheels), sloped hull + glacis + side skirts, turret with quad AA barrels + glowing muzzle, radar dish + antenna lights.
- **DRONE** (20 meshes) — recon quad: camera dome, sensor pod w/ red eye, struts, blinking nav light, 4 rotor arms.
- **BASIC** — sleek interceptor: fuselage, delta wing, single tail fin, wingtip lights.
- **SHOOTER** — heavy gunship: twin engine pods w/ glow intakes, wing missiles, chin cannon w/ glowing muzzle, twin fins.

Methods:
- `takeDamage(amt, now)` → `'destroyed' | 'shield-broken' | 'hit'` (shield absorbs first, then regen checks).
- `applySmoothMovement(desiredX, desiredZ, delta, rate)` — first-order ease `k = min(1, delta*rate)` toward desired velocity; `smoothRate()` per type (TANK 5, BOSS 6, else 8; kamikaze uses 14).
- `updateDirection(targetPos, time, dist, dirX, dirZ, pool, repelX, repelZ, fireRateMult, delta, avoidX, avoidZ)` — per-pattern steering:
  - **CHASE** — approach + strafe (distance band around player, evasive reversals on `evadeTimer`/`lastDecisionTime`).
  - **CIRCLE** — orbit at tangent + slight inward (circle-strafe runs).
  - **KAMIKAZE** — dive straight at player at high speed (rate 14 smoothing).
  - **ARTILLERY** — keep range, lob arcing shells (gravity projectiles, `gravity` on Projectile).
  - **Boid repulsion** — separation force from nearby enemies flowing through the smoother.
  - **Building avoidance** — steering around block footprints (skip blocks the enemy flies over, altitude check), plus overlap safety-net push that biases `smoothVel` away (cap 36) instead of zeroing.
  - Firing: per-type weapons — BASIC/SHOOTER machine-gun tracers, TANK quad volleys/artillery, DRONE only dives, BOSS uses `updateBoss`.
- `updateBoss(targetPos, time, dist, dirX, dirZ, pool, repelX, repelZ, fireRateMult, delta, avoidX, avoidZ)`:
  - Phase transitions via `bossPhaseForRatio` with a 0.6s pivot pause.
  - Circle-strafes at speed 10 (rate-6 smoothing); hard-stops while telegraphing.
  - **Telegraph** (phase 1/2): `telegraphActive` → freeze + beam warning mesh for `BOSS_TELEGRAPH_DURATION`, then fires the full `bossVolleyConfig` spread (9/7/5 shots, magenta 0xff3366, damage 8).
  - **Regular volleys** stay weaker (≤5 shots, yellow 0xffd92e, damage 5), cadence by phase (3: 2.2s, 2: 1.7s, 1: 1.2s) × fireRateMult; phase ≤2 also throws a 10-shot radial ring burst at 90 speed.
  - Returns `fired` so the engine can shake/audio.

### `Projectile`
Fields: `active, mesh, pos/prevPos/vel (CANNON.Vec3), spawnTime, damage, blastRadius, target (EnemyLock, for homing), homingStrength, lifetime (1.35s), vy, gravity, waveDamageMult`.
- `spawn(...)` — sets position/velocity; homing projectiles lock a `target` with `homingStrength`.
- `update(now, delta, particles)` — integrate pos; homing steers toward target body; gravity for artillery arcs; sparks trail for some; lifetime expiry.
- `deactivate()` — hides mesh, deactivates, optionally tiny spark burst.
- `distancePointToProjectileSegmentSq(...)` — 3D point-to-segment hit test helper.

### `ProjectilePool`
- `pool: Projectile[]` fixed-size (player ~80 / enemy ~120).
- `spawn(...)` finds inactive projectile, reuses. `deactivateAll()`.
- `updatePositions(now, delta, particles)` — updates all, auto-expire.
- **Hit tests (2D x/z with Y caps):**
  - `checkObjectiveHits(objectives, onHit)` — radius `o.radius + 4.5`.
  - `checkTurretHits(turrets, onHit)` — vs turret base circle (radius ~5).
  - `checkEnemyHits(enemies, onHit)` — radius `e.radius + 2.2` (boss/tank get 1.5× via auto-aim scale).
  - `checkPlayerHits(playerPos, onHit)` — radius ~3.4 + camera shake.
  - Each projectile breaks on first hit (one target max).

### `PowerUp`
Fields: `mesh` (Group, tumbling), `type`, `active`, `position`, `spawnTime`, `value` (for gems), `groundRing` (+ optional `userData.beam` light pillar for bombs).
- Constructor builds per-type look (green cross=health, blue shield, red bomb, cyan gem, etc.).
- `update(time, delta)` — bob/spin; XP gems magnet toward player when close; **ground ring spins** (flat additive ring at pickup altitude — rooftop-aware); bomb pillar syncs position.
- `checkCollection(playerPos)` — collection radius ~14 (generous, VS-style vacuum).

### `Objective` (destroyable SAM / RADAR / DEPOT)
Fields: `type, active, hp/maxHp, radius, basePoints, position, mesh (Group), body (static CANNON), spawnTime, bobSeed, beacon (55-unit light pillar), labelSprite (floating "SAM SITE" billboard), deathTimer`.
- `update(time, delta)` — bobbing beacon + label always visible; **collapse-out death animation** (shrink+fade over ~0.35s, delta-driven) then `destroy()`.
- `takeDamage(amt)` → bool destroyed. `destroy()` idempotent (mesh/body/label/beacon disposal).
- `distanceTo(px, pz)`.

### `Turret` (rooftop gun turrets)
Fields: `active, hp (maxHp 26), position, mesh (Group), head (Group — yaw), yaw, block, chunkId, lastShotTime, fireInterval, range (200), basePoints (75), seed`.
- `isGone()` — turret died with its host building.
- `aimAt(px, pz, time)` — yaw head toward player, fires tracer on `fireInterval` (engine handles firing + hit checks).
- `takeDamage(amt)` — HP gates; destroyed → explosion.

---

## 6. GameEngine (engine.ts — 3,558 lines)

### Core fields (by system)
**Rendering:** `scene, camera (Perspective), cameraLookAtTarget, renderer, composer (EffectComposer), bloomPass (UnrealBloomPass), raycaster, mousePlane (y=-26), targetGroup + innerRing/outerRing (aim reticle), animationFrame, disposed`.
**Physics/world:** `world (CANNON.World)`, `city (CityEnvironment)`.
**Input:** `gamepadIndex, isMouseActive, movementKeys (Set), leftStick/rightStick, movementTarget (Vector3), keyboardVelocity (Vector2), hasInputThisFrame, aimPoint, mouseAimPoint, mouseAimValid, autoAimTarget, mouseNDC`.
**Run state:** `isPlaying, gameOverDispatched, cameraShake, score, totalKills, shotsFired, shotsHit, health (100), maxHealth, currentFuel (100), maxFuel, fuelDrainPerSecond (0.85), survivalTime, combatIntensity, directorTimer, battlefieldEventTimer (18s), lastSpawnSoundTime, lastCollisionDamageTime, crashSmokeTimer/crashSmokePos`.
**Waves:** `currentWave, enemiesSpawnedInWave, totalEnemiesInWave, spawnTimer, waveTimer, waveTransitionTimer, waveMessage, minibossSpawnedThisWave, objectives[]`.
**Weapons:** `currentWeapon, weapons (Map<WeaponType, WeaponConfig>), lastFireTime, muzzleFlip, reloadTimer, isReloading, lastFiredWeapon, weaponXp (Map), weaponLevels (Map)`.
**Salvo:** `isPaintingLocks, salvoLocks[], salvoCooldownTimer, salvoCooldown (5.0), lockPaintInterval (0.18), lockSearchRadius (38), salvoLockIndicators (Map<Enemy, Group>)`.
**Upgrades:** `runUpgrades (Record<UpgradeId, number>), pendingUpgradeOffer, upgradePaused, runLevel (1), runXp, pendingLevelUps`.
**Feel:** `killStreakCount, lastKillTime, announceQueue[], timeScale (1.0), hitStopTimer, comboCount, comboTimer, comboMultiplier, maxCombo, damageBoostTimer, shieldTimer, speedBoostTimer, dashCooldownTimer, dashActiveTimer, hitMarkerTimer/hitMarkerPosition, afterburnerActive, afterburnerDrainPerSecond (3.2)`.

### Lifecycle
- `constructor(canvas)` — sets up renderer (antialias, pixelRatio by quality), composer+bloom, cannon world (gravity), city, entities, pools, audio; binds ALL window listeners (keys, pointer, gamepad, blur, `helistrike:*`); starts `tick` rAF.
- `startGame()` → `resetGame()` + audio resume/music + first UI flush.
- `setPaused(bool)` — clears input, stops/starts music, lastTime reset.
- `resetGame()` — resets city, destroys enemies/powerups/objectives, deactivates projectiles, resets helicopter + all run state + upgrade maps + mastery-free weapon XP.
- `dispose()` — rAF cancel, remove listeners, dispose composer/renderer/audio.

### Input handlers
- `onKeyDown` (WASD/arrows movement, Space climb, Alt descend, Shift afterburner, 1-4 weapons, R reload, Q start salvo paint, Esc/P pause **via React**, double-tap dash detection via `lastTapTime`), `onKeyUp`.
- `onPointerMove/Down/Up` — mouse aim (projected onto y=-26 plane), fire while down.
- `onWheel` — scroll changes weapon.
- `onWindowBlur` → dispatch `helistrike:autopause`.
- `onGamepadConnected/Disconnected`, `pollGamepad(time, delta)` — 2 sticks + triggers fire.
- `onLeftStick/onRightStick` (touch), `onFireChange` (touch FIRE button).
- `onSettingsChanged` → `applySettings()` (pixel ratio, composer size, bloom on/off, volume).
- `onPlayerModelChanged` → `rebuildHelicopter()`.

### Aiming
- `findAutoAimTarget(maxDistance 245, useMouseCone)` — nearest active enemy within cone; `updateAutoAim()` — sets `autoAimTarget` + `helicopter.setGunAim(...)` (gun turret only, body unaffected).
- `getFallbackFireDirection()` — mouse aim vector when auto-aim off.
- `updateMouseAimFromEvent`, `updateStickAim` (invertedY aware).

### Combat
- `fireWeapons(time)` — the single fire path:
  1. Salvo paint (Q held): adds locks to `salvoLocks` (max 6) every 0.18s within 38 units.
  2. Normal fire: rate-gated by config.fireRate × level bonus × run upgrades; fires `count` (+extraProjectiles) projectiles from muzzle (muzzleFlip alternates barrel), MG tracer color/speed, homing missiles, AoE rockets/shotgun spread.
  3. Ammo decrement → auto `startReload()` when empty; reload timer (config.reloadTime × reloadMult).
  4. Muzzle flash + recoil flip + audio per weapon + `shotsFired++`.
- `onEnemyDestroyed(enemy, time)` — **the kill pipeline**: `totalKills++`, `grantWeaponXp(lastFiredWeapon)`, kill-streak counting (<1.4s window → streak++), `multikillTier` announce + `playKillCombo` + hit-stop(0.3, 0.35) at 3+, score += `floor(basePoints * comboMultiplier * risk)`, per-type hit-stop (BOSS 0.32, TANK 0.12, else 0.06; scale 0.02/0.05), `dropXpGem(xpForEnemyType)`, power-up drop chance (TANK 0.3, BOSS 1.0, else 0.14), elite guaranteed drop + "MINIBOSS DOWN" announce, explosion + volumetric + city damage + explosion audio.
- `grantWeaponXp(weapon)` — xp+1, level via `weaponLevelForXp`, announce "WEAPON LV.X" / "WEAPON MAXED" (+`maxHealth` 10, heal 10, `writeMastery` persist).
- `grantRunXp(amount, time)` — adds to runXp; each level crossed queues `pendingLevelUps` → `offerNextLevelUp()` → `offerUpgrade()` (pauses game, `helistrike:upgrade-offer` with 3 `pickUpgrades(3)`).
- `applyRunUpgrade(id)` — maps each UpgradeId to its buff (see pool; stacks recorded in `runUpgrades`).
- `switchWeapon`, `startReload`, `startPaintingLocks`, `releaseSalvo()` (fires 1 homing missile per lock from `salvoLocks`), `findSalvoTarget(center, radius)`, `updateSalvoIndicators/clearSalvoIndicators`.
- `applyPowerUp(type, time)` — HEALTH (+30, repair 30), DAMAGE_BOOST (×2 dmg 10s), SHIELD (8s), AMMO (refill), SPEED_BOOST (6s), FUEL (+35?), **BOMB (full reward pipeline — see §7)**, XP_GEM (`grantRunXp(value)`).

### AI Director & Waves
- `updateAIDirector(time, delta)` — computes `combatIntensity` (clamp 0..1.3) from survival time (min 1 at 180s, ×0.5) + enemy count (min 1 at 22, ×0.35) + low health (×0.3); periodic power-up spawn every 8–12s; time-driven wave advance (`waveTimer >= waveDuration`); boss on wave%10, miniboss on wave%5 (once per wave); continuous horde spawning with active cap `min(72, (26 + wave*3.2) * spawnRate)`, 1–3 at a time, cadence `max(0.16, (0.62 - wave*0.045) * (2 - spawnRate) * (1.15 - intensity*0.35))`; battlefield events every `max(12, 28 - intensity*12)`s.
- `startNextWave()` — wave++, budget, theme message (10=⚠ BOSS BATTLE ⚠, 5=MINIBOSS INBOUND, 1=ENGAGE THE DRONES, 3=STORM INCOMING, 4=SWARM TACTICS +10 enemies), spawns objectives `min(2, 1 + floor(wave/4))`, weather intensity from wave 3 (`(wave-2)*0.25` capped 1), milestone heal `10 + wave`, 2s transition breather.
- `spawnEnemy()` — type roulette by wave tier (see §8 for exact thresholds), then modifier/pattern personality rolls (TANK: artillery w4+, circle w5+, shielded 30% w5+, regenerating 25% w7+; DRONE: kamikaze w4+, shielded 20% w6+; SHOOTER: circle w4+, regen 25% w6+; BASIC: shielded 15% w8+); safe-spawn validation (8 attempts: not in frustum near-player <60u, not within 12u of other enemies); spawn burst particles + cue audio.
- `scaleEnemyForDifficulty(enemy)` — applies `difficulty.enemyHp * waveEnemyPower(wave)` to HP (and shield), sets `waveDamageMult = waveEnemyDamage`, `waveFireRateMult = waveEnemyFireRate`.
- `spawnMiniboss(time)` — scale `1 + floor(wave/5)*0.35`, type TANK (wave≥10) else DRONE, SHIELDED elite, pattern ARTILLERY/KAMIKAZE, announce "ELITE MINIBOSS", shake 2.5.
- `spawnBossBattle(time)` — BOSS with flat ×2.0 (HP/shield/basePoints), SHIELDED + CIRCLE, **3 escort minions** (SHOOTER/DRONE alternating), announce "⚠ BOSS BATTLE ⚠", hit-stop 0.35, shake 4.0.
- `getArcadeSpawnPoint(type, index, formationSize)` — flanks/behind/formation arcs around player.
- `triggerBattlefieldEvent(time)` — ambient events (weather surge, extra horde burst, miniboss assist, etc.).
- `spawnObjective()` / `destroyObjective(obj, time)` — objective rewards: SAM kill = enemy accuracy debuff, RADAR = EMP/all-enemy damage, **DEPOT = guaranteed BOMB + ammo refill**; score + points, announce, collapse handled by Objective.
- `updateTurrets(time, delta)` — ambient rooftop turrets track + fire tracer projectiles at the player (rate-gated), check hits vs player.

### Feel / timing
- `tick()` — rAF loop: hit-stop timer on real time, `delta = realDelta * timeScale`, idle-mode renders menu (spinning reticle rings + rotors), else full simulation: gamepad → keyboard movement → dash → target decay → clamp → helicopter.update → auto-aim → fire (if firing) → salvo → projectiles (player + enemy pools + hits) → enemies (direction + boss) → turrets → objectives → powerups (update + collection) → director → waves → city.update → particles/rain/weather/volumetrics → crash smoke → camera → UI (12 Hz).
- `triggerHitStop(duration, scale=0.05)` — sets `timeScale` + timer.
- `updateCamera()` — chase camera with look-ahead, camera shake decay, crash shake.
- `updateKeyboardMovement(delta)` — movementTarget from held keys (speed boosted by afterburner/speedBoost/dash), Y via Space/Alt, clampMovementTarget to city bounds/altitude.
- **Crash/collision:** `onHelicopterCollide` — building scrape vs slam damage (slow scrape = small damage + sparks + wobble; slam = heavy damage + hit-stop + shake + `crashSmoke` column + debris), rotor/engine damage.
- `updateCrashSmoke(delta, time)` — lingering smoke + embers at impact.

### UI bridge (see §11 for payloads)
`updateUI(time)` (12 Hz) → `helistrike:update`; `emitStatsIfChanged(force)` → `helistrike:stats`; `dispatchGameOver(time)` → `helistrike:gameover`; `announceQueue` flush → `helistrike:announce`; `runXpProgress()`.

---

## 7. Bomb Power-Up — Full Reward Pipeline (recently fixed)

`applyPowerUp(BOMB)` now:
1. For **every active enemy**: `totalKills++`, `grantWeaponXp(lastFiredWeapon)`, kill-streak increment, `score += floor(basePoints * comboMultiplier * risk)`, **drops an XP gem** (`xpForEnemyType`), power-up drop per normal rules (`TANK 0.3 / BOSS 1.0 / 0.14` or elite), then deactivate + small explosion + city damage.
2. One combined streak announce (`multikillTier(final streak)`) + `playKillCombo` + hit-stop (0.25, 0.2) at 3+.
3. Flat +150, mega explosion at player, volumetric 26, explosion audio, camera shake 4.5, "💥 BOMB AWAY!" announce ("Wiped out N enemies").
This is why bombs now feed XP/upgrades — they used to bypass all progression.

---

## 8. Enemy Type Roulette (exact thresholds from spawnEnemy)

| Wave | Rolls (rand) |
|---|---|
| ≥7 | 20% DRONE, 40% TANK, 70% SHOOTER, else BASIC |
| ≥5 | 30% TANK, 60% SHOOTER, 80% DRONE (only w≥6), else BASIC |
| w%4==0 (swarm) | 20% SHOOTER, mostly BASIC |
| ≥3 | 20%+wave*5% SHOOTER; >85%-wave*2% TANK |
| ≥2 | 30% SHOOTER |
| 1 | all BASIC |

---

## 9. City (city.ts — 1,166 lines)

### `CityEnvironment`
Grid constants: `cellSize 22`, `chunkDepth 132`, `halfWidthCells 9` (19 cells wide), `activeBehind 1`, `activeAhead 2` (chunks stream around player).

- `constructor(scene, world)` — cloud layer + fog + initial chunk generation + listeners (`onBuildingDestroyed`, `onHonk`).
- `reset(world)` — rebuild city.
- `getSpawnSpot(playerPos)` / `getAmbushSpot(playerPos, aheadMin 45, aheadMax 165)` — rooftop spawn points for enemies.
- `update(player, world, delta)` — chunk streaming (generate/destroy), `animateWorld` (traffic, billboards, clouds, beacons, turret placement, damaged-building smoke), buildings damageable.
- `damageNearby(x, z, radius, amount)` — AoE building damage + collapse.
- `damageProjectilePath(from, to, radius, amount)` — bullet line damage through blocks.
- `getHeightAt(x, z, clearanceRadius=0)` — ground/roof height + clearance check for collisions.
- `generateChunk(id, world)` — procedural blocks with seeded zones (`zoneForChunk`): downtown (tall), midtown, industrial, residential, waterfront; parks (`addCityPark`), bridges (`addBridge`), ground dressing (`addGroundDressing`), rooftop detail (`addRooftopDetail` — AC units, water towers, helipads, **turrets**, **beacons**), facade details (`addBuildingFacadeDetails` — windows, ledges, signs), smoke columns on damaged buildings.
- `addProceduralStructure` — multi-tier building stacking with setbacks, varied heights.
- `addTrafficCar` — road cars: `TrafficCar` fields `{x, baseX, z, speed, baseSpeed, minZ, maxZ, parts, lights, dodgeDir, dodgeTimer, dodgeCooldown, honkTimer}`; cars drive along roads, **swerve (dodge) and honk** when the helicopter buzzes low (`onHonk` → `audio.playHonk`).
- `addBillboards` / `buildBillboardTexture(zone, seed)` — animated roadside billboards: canvas textures with **scrolling marquee tickers** + glow panel.
- `Cloud` class — `{group, speed, driftY}` drifting cloud puffs; `buildCloudLayer`, `updateClouds`.
- `damageBlock(block, amount)` — HP gates, sparks, **building collapse animation** (`collapseProgress`, `initialHeights` — tiers sink + dust), destroys static body on full collapse.
- `distanceToBlockFootprintSq`, `segmentIntersectsBlockFootprint` — collision helpers for enemies/projectiles.
- `addStaticBox(x,y,z,w,h,d,world,group?)` — shared static body creator.

### `Turret` placement
Random rooftop turrets per chunk (seeded). Each is an `entities.Turret` (hp 26, range 200, basePoints 75, 3-barrel head). The engine's `updateTurrets` makes them track + fire tracers at the player; they die with their host building (`isGone`).

---

## 10. FX, Audio, Materials

### particles.ts
- **`GPUParticleSystem`** (max 5000, one BufferGeometry + ShaderMaterial, additive): `spawnExplosion(x,y,z,count,now,speedMult)` (white-hot → orange → smoke, gravity), `spawnSmoke` (rises, grey→dark), `spawnSparks` (short white→orange streaks). GPU-side aging via `uTime - startTime`; point sizes by type.
- **`RainSystem`** (2000 points): infinite rain box around player (`mod(position - playerPos + box, box) - box/2 + playerPos`), wind-slanted streaks, 2s loop.
- **`WeatherSystem`**: `stormIntensity` eases to `targetIntensity`; fog density `0.0058 + intensity*0.0052` (capped so skyline stays visible), sky/fog color lerp, turbulence `windForce` (used by flight), lightning when intensity > 0.4 (`isLightning` flag + flash).
- **`VolumetricExplosions`** (400 instanced icosahedra): pooled, random sizes, white→yellow→orange→grey color ramp, rising + scale curve, `spawn(x,y,z,count,size)`.

### audio.ts — `AudioManager` (fully synthesized, zero assets)
- Lazy `AudioContext` on first user gesture (`resume()`).
- **Engine loop** (always on during play): 38Hz triangle + 76Hz triangle + 2s looped white-noise (low-pass 350) + 6Hz LFO modulating pitch/volume — `updateEngine(speedFactor, altitude)` scales pitch (38+16×speed / 76+32×speed), LFO (6+3×speed), gain.
- **SFX** (each builds a one-shot node graph): `playLaser(x)`, `playMachineGun(x)` (stereo-panned by screen x), `playShotgun(x)`, `playMissileLaunch`, `playRocketLaunch`, `playReload`, `playPickup`, `playEnemySpawn`, `playEnemyFire`, `playExplosion(intensity)` (noise burst + low thump, 100ms anti-spam), `playHonk` (two-tone saw horn), `playHit`, `playLockBeep`, `playKillCombo(tier)` (3 rising notes), `playUpgrade` (4-note arpeggio C5-E5-G5-C6).
- **Music**: `startMusic/stopMusic` — 115ms step sequencer: 16-step bass line (MIDI 40/43/45/38/35/37, saw + low-pass) + 64-step lead melody (triangle), all via `setInterval`.
- `setVolume(0..1)` (master gain = volume × 0.5), `dispose()`.

### materials.ts
- `createLowPolyMaterial(colorHex)` — flat-shaded Lambert, slight emissive self-glow.
- `createGlowMaterial(colorHex, opacity=0.72)` — additive, depthWrite off.
- `createGlowBox(w,h,d,color,opacity)` — for cores/intakes/nav lights.
- `createBox(w,h,d,color)` — standard low-poly box (cast/receive shadow).
- `createSkyDome()` — gradient shader sphere (top 0x1f4f97 → horizon 0x78cfe0 + sun disc 0xffc66d).

---

## 11. Event Contract (engine ↔ React bridge)

### Engine → UI (`window.dispatchEvent(new CustomEvent(...))`)
| Event | Payload (detail) |
|---|---|
| `helistrike:update` | `{score, health, fuel, rotorHealth, engineHealth, wave, message, playing, runLevel, runXpProgress, weapon:{name,ammo,maxAmmo,type,reloading,reloadTimer,level}, combo:{count,multiplier,timer}, salvo:{locks,cooldown,isPainting,ready}, status:{damageBoost,shield,speedBoost,threat,afterburner,risk}, boss:{hp,maxHp,phase}, objectives:{sam,radar,depot,count}}` |
| `helistrike:stats` | `{currentHealth, maxHealth, currentFuel, maxFuel}` (throttled, only on change) |
| `helistrike:gameover` | `{score, wave, time, kills, maxCombo, survivalTime, accuracy}` |
| `helistrike:autopause` | — (window blur → React shows pause) |
| `helistrike:announce` | `{text, sub, color}` (queue flushed 1 per update tick) |
| `helistrike:upgrade-offer` | `{options: UpgradeOption[3]}` (game pauses; React shows roulette) |

### UI → Engine (React dispatches, engine listens)
| Event | Payload (detail) |
|---|---|
| `helistrike:settings` | full `GameSettings` (also persisted to localStorage by App) |
| `helistrike:fire` | `{active: boolean}` |
| `helistrike:left-stick` / `helistrike:right-stick` | `StickInput {x, y, active}` |
| `helistrike:upgrade-choice` | `{id: UpgradeId}` |
| `helistrike:player-model` | `{model: HelicopterModel}` |

### localStorage keys
`helistrike:settings` (GameSettings JSON) · `helistrike:highScore` (number) · `helistrike:mastery` (number[4]) · `helistrike:playerModel` (HelicopterModel number).

---

## 12. App.tsx — UI Shell (1,305 lines)

**Game modes:** `'menu' | 'playing' | 'paused' | 'gameover'` (+ overlay flags `showSettings`, `showHangar`, `upgradeOffer`).

**Components:**
- `MenuButton` (arcade bevel button, primary red / secondary blue), `KeyCap`, `Meter` (health/fuel bars), icons as inline SVGs (`HeartIcon`, `GasIcon`, `CoinIcon`, `BulletIcon`, `TargetIcon`).
- `ThreeDMenu` — perspective 3D menu card: title slab "HELI-STRIKE", Score/Best/Stage stats, game-over run stats (time, kills, max combo, accuracy), new-high-score badge, Start/Settings/Hangar buttons, control chips.
- `VirtualJoystick({side, onStick})` — pointer-capture joystick with knob + label (touch).
- `FireButton` — touch fire.
- `PauseOverlay` — Resume/Restart/Settings/Quit.
- `SettingsPanel` — Difficulty (Casual/Normal/Hard segmented), Invert Y, Auto-Aim toggle, Stick Sensitivity slider (0.4–4), Visual Quality (Low/High = bloom), Volume slider.
- `HangarScreen` — **Aircraft picker** (3 `HelicopterCard`s: Apache / Nighthawk / Warlock with stylized top-down silhouette previews) + **Weapon mastery grid** (4 weapons × 5 rank pips, rank-5 alt-fire blurb).
- Main `App` — owns the canvas + engine, subscribes to all `helistrike:*` events, renders HUD: health/fuel meters, stage + score, coin counter, objective chips (🎯 SAM / 📡 RADAR / 📦 DEPOT), arcade announcement toast (pop+float animation, 2.4s), boss health bar (phase color), pause button, weapon HUD (name, LV, ammo/reload), run-level + XP bar, salvo HUD (lock pips / cooldown / ready), combo display (count + multiplier + 3s expiry bar), status chips (Threat High, Afterburner, RISK x, Damage, Shield, Boost), control hint bar, wave transition overlay, upgrade roulette modal, touch controls.

**index.css highlights:** `arcade-scanlines` (CRT overlay, blend overlay), `arcade-vignette` (red/yellow edge tint), `arcade-marquee`, `menu-perspective/rig/card` (3D float animation), `menu-title-slab`, `menu-stat`, `menu-chip`, `run-stat`, `setting-row/label/desc/value`, `toggle-track/knob`, `slider-arcade`, `seg-btn`, `joystick-base/knob/label`, `fire-button`, `arcade-announce` + `announce-pop/fade` keyframes, responsive breakpoints.

---

## 13. Tests (logic.test.ts — 33 tests)

Covers: difficulty configs, wave curves (count/power/damage/fireRate/duration), combo multiplier caps, coins/accuracy/formatting, weapon XP levels + bonuses, run XP levels, XP-per-enemy values, risk multiplier extremes, multikill tiers (1→null, 2/3/4/6/9 labels), boss phase + volley configs, objective configs, mastery read/write (with mock storage), `pickUpgrades` (count, no-dupes, clamps), upgrade pool integrity.

Run: `npm test` (Vitest, 33/33 pass). Typecheck: `npm run lint` (`tsc --noEmit`). Build: `npm run build`.

---

## 14. How the Pieces Move Each Frame (tick order)

1. Hit-stop timer on real time → `timeScale`; `delta = realDelta * timeScale`.
2. Menu/idle: spin reticle rings, animate rotors, camera, render — no simulation.
3. `pollGamepad` → `updateKeyboardMovement` (movementTarget from WASD + Space/Alt + afterburner/speed boost).
4. Dash logic (double-tap surge, bell-curve velocity, target follows body).
5. Idle target decay (settle to hover) → clamp to bounds → `helicopter.update(...)` (PD controller + tilt + rotors + gun turret).
6. Auto-aim update (gun tracks target) → `fireWeapons` if firing (salvo paint or weapon fire).
7. Salvo release / indicators.
8. Projectile pools update + hit tests (objectives → turrets → enemies → player).
9. Enemies update (direction per pattern, boss state machine) + their fire → enemy projectiles.
10. Turrets aim + fire; objective updates (collapse anims); powerup update + collection (gems magnetize).
11. AI director: intensity, wave timer, horde spawns, boss/miniboss, battlefield events.
12. City: chunk streaming, traffic/billboards/clouds/beacons, damage collapse.
13. Particles/rain/weather/volumetrics + crash smoke + camera (shake) + 12 Hz HUD events.

---

## 15. ChatGPT Rebuild Prompts (suggested entry points)

- *"Build a 3D low-poly arcade helicopter shooter in React + Three.js + cannon-es with a Vampire-Survivors upgrade loop. Use the spec in PROJECT_DETAILS.md."*
- *"Implement the GameEngine tick pipeline and the window CustomEvent bridge between engine and React HUD exactly as specified in §6/§11."*
- *"Port the flight model: PD-controller hover with WASD-only movement, Space/Alt vertical, idle target decay, and double-tap dashes (§5 Helicopter)."*
- *"Recreate the wave director: time-driven waves, type roulette thresholds (§8), modifiers/patterns, miniboss every 5th wave, boss battle every 10th wave (§6)."*
- *"Reimplement the pure logic layer in logic.ts with the exact curves in §4 and keep it dependency-free so it stays unit-testable."*
- *"Synthesize all SFX + the rotor hum + chiptune music with Web Audio (audio.ts §10)."*
