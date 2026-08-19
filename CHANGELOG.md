# Changelog

All notable changes to Heli-Strike are tracked here. Entries follow the major
"Backup" commits on `main`.

## Backup: helicopter physics overhaul, enemy AI lead/LOS + turret aim & hit-flash, denser city, wave-scaling API, SP1/HD graphics toggle

### Graphics — SP1 / HD modes

- **New `Graphics Mode` setting** (Settings → SP1 / HD) replacing the old
  Low/Medium/High visual-quality row. Persists to `helistrike:settings`.
  - **SP1** (default): the original chunky low-res PS1-style look — low render
    resolution, no bloom, no MSAA, nearest-neighbor upscale
    (`image-rendering: pixelated`), direct rendering.
  - **HD**: crisp full-resolution render (up to 2x device pixel ratio), 4x MSAA
    via the effect composer's render targets, bloom enabled, and the PS1 color
    quantizer/dither pass disabled.
- Renderer branching (`getMaxPixelRatio`, `renderFrame`, `applyComposerQuality`,
  `applySettings`, `applyGovernorQuality`) now keys off `settings.graphics`.
- The adaptive quality governor still applies on top of either mode, shedding
  resolution/particles/bloom under load.

### Helicopter physics

- **Hover-settle spring** — a damped spring grounds the helicopter near the
  floor so landings settle instead of bouncing; spring is off above range so
  free flight is unchanged.
- **Yaw-rate limit** — nose turn is capped and lerps by speed instead of
  snapping exponentially.
- **Per-model movement profiles** — Apache (balanced), Nighthawk (fast/turny),
  Warlock (heavy/banky) each define speed, acceleration, turn, and bank ratios.
- **Climb/descend pitch** — the hull pitches with vertical velocity.
- **Wind drift** — storm wind now physically nudges the helicopter (capped).
- **Collision tuning** — roof/street landings damp vertical velocity, reduce
  landing damage, and no longer trigger the slam/explosion; wall damage scales
  with the angle of approach.

### Enemy AI

- **Aim leading** — `leadAim` solves a fixed-point intercept so gunships,
  flak tanks, interceptors, gatling heavies, drones, and standard enemies fire
  where the helicopter will be, not where it was.
- **Line-of-sight** — `hasLineOfSight` (segment vs. building AABBs) blocks shots
  through taller buildings; blocked shots don't consume the cooldown. Artillery
  and homing shots intentionally ignore LOS.

### Turrets

- **Aim pitch** — barrel tracks the player vertically, clamped to the gun's
  travel, with real-velocity lead; muzzle position respects pitch.
- **Hit-flash** — `takeDamage` triggers a brief red emissive flash on the
  turret's body that eases back to rest.

### City density

- Downtown, midtown, industrial, and residential district densities raised
  (~+0.16-0.18) and open-space chance cut, making the battlefield noticeably
  denser while staying within test-guarded ranges.

### Wave scaling — public API

- New unified wave surface wrapping the threat-budget director:
  - `waveSpawnBudget(wave, threatLevel)` — total spawn budget this wave.
  - `waveComposition(wave, remainingBudget, rng?)` — picks a wave-gated squad
    template stream, else an individual variant, budget- and wave-gated.
  - `waveStatScale(wave)` — unified `{ hp, damage, fireRate }` multipliers.
- New variants (Interceptor, Minelayer, Gatling Heavy) are fully wired end-to-end
  with tests.

## Backup: neon-arcade UI restyle + layered explosion effects with sound

- Neon-arcade UI restyle across menus/HUD.
- Layered explosion effects with sound.