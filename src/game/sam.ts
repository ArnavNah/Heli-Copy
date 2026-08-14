export enum SamState {
  SEARCHING = "SEARCHING",
  TRACKING = "TRACKING",
  LOCKING = "LOCKING",
  FIRING = "FIRING",
  RELOADING = "RELOADING",
  DISABLED = "DISABLED",
  DESTROYED = "DESTROYED",
}

export const SAM_DETECTION_RANGE = 330;
export const SAM_FIRE_RANGE = 255;
export const SAM_MIN_FIRE_RANGE = 38;
export const SAM_YAW_SPEED = 1.45;
export const SAM_PITCH_SPEED = 0.72;
export const SAM_MIN_PITCH = 0.12;
export const SAM_MAX_PITCH = 0.9;
export const SAM_LOCK_DURATION = 1.15;
export const SAM_RELOAD_SECONDS = 5.5;
export const SAM_MISSILE_SPEED = 155;
export const SAM_MISSILE_TURN_RATE = 1.65;
export const SAM_MISSILE_LIFETIME = 4.8;
export const SAM_MIN_SPACING = 210;

export interface SamStateInput {
  distance: number;
  aligned: boolean;
  active: boolean;
  wave: number;
  detectionMultiplier?: number;
  lockSpeedMultiplier?: number;
}

export interface SamStateResult {
  fired: boolean;
  lockStarted: boolean;
  lockCancelled: boolean;
  beep: boolean;
}

/** Deterministic gameplay-only controller; rendering and projectile creation stay outside. */
export class SamStateMachine {
  state = SamState.SEARCHING;
  lockProgress = 0;
  reloadRemaining = 0;
  private beepRemaining = 0;

  reset() {
    this.state = SamState.SEARCHING;
    this.lockProgress = 0;
    this.reloadRemaining = 0;
    this.beepRemaining = 0;
  }

  disable(destroyed = false) {
    this.state = destroyed ? SamState.DESTROYED : SamState.DISABLED;
    this.lockProgress = 0;
    this.reloadRemaining = 0;
    this.beepRemaining = 0;
  }

  update(delta: number, input: SamStateInput): SamStateResult {
    const result: SamStateResult = {
      fired: false,
      lockStarted: false,
      lockCancelled: false,
      beep: false,
    };
    if (!input.active) {
      const wasLocking = this.state === SamState.LOCKING;
      this.disable(true);
      result.lockCancelled = wasLocking;
      return result;
    }

    const difficulty = Math.min(0.22, Math.max(0, input.wave - 1) * 0.018);
    const lockDuration = SAM_LOCK_DURATION * (1 - difficulty) / Math.max(1, input.lockSpeedMultiplier ?? 1);
    const reloadDuration = SAM_RELOAD_SECONDS * (1 - difficulty * 0.7);
    const inDetection = input.distance <= SAM_DETECTION_RANGE * (1 + difficulty * 0.25) * Math.max(1, input.detectionMultiplier ?? 1);
    const inFireEnvelope = input.distance <= SAM_FIRE_RANGE && input.distance >= SAM_MIN_FIRE_RANGE;

    if (this.state === SamState.DESTROYED || this.state === SamState.DISABLED) return result;

    if (this.state === SamState.FIRING) {
      this.state = SamState.RELOADING;
      this.reloadRemaining = reloadDuration;
    }

    if (this.state === SamState.RELOADING) {
      this.reloadRemaining = Math.max(0, this.reloadRemaining - delta);
      if (this.reloadRemaining === 0) {
        this.state = inDetection ? SamState.TRACKING : SamState.SEARCHING;
      }
      return result;
    }

    if (!inDetection) {
      result.lockCancelled = this.state === SamState.LOCKING;
      this.state = SamState.SEARCHING;
      this.lockProgress = 0;
      this.beepRemaining = 0;
      return result;
    }

    if (!inFireEnvelope || !input.aligned) {
      result.lockCancelled = this.state === SamState.LOCKING;
      this.state = SamState.TRACKING;
      this.lockProgress = 0;
      this.beepRemaining = 0;
      return result;
    }

    if (this.state !== SamState.LOCKING) {
      this.state = SamState.LOCKING;
      this.lockProgress = 0;
      this.beepRemaining = 0;
      result.lockStarted = true;
    }

    this.lockProgress = Math.min(1, this.lockProgress + delta / lockDuration);
    this.beepRemaining -= delta;
    if (this.beepRemaining <= 0) {
      result.beep = true;
      this.beepRemaining = 0.48 - this.lockProgress * 0.34;
    }
    if (this.lockProgress >= 1) {
      this.state = SamState.FIRING;
      this.lockProgress = 1;
      result.fired = true;
    }
    return result;
  }
}

export function shortestAngleDelta(target: number, current: number): number {
  let delta = target - current;
  while (delta < -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return delta;
}

export function stepAngle(current: number, target: number, speed: number, delta: number): number {
  const difference = shortestAngleDelta(target, current);
  const step = Math.min(Math.abs(difference), Math.max(0, speed * delta));
  return current + Math.sign(difference) * step;
}
