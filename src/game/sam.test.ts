import { describe, expect, it } from "vitest";
import {
  SAM_MIN_FIRE_RANGE,
  SamState,
  SamStateMachine,
  shortestAngleDelta,
  stepAngle,
} from "./sam";

const input = (distance: number, aligned = true, active = true, wave = 1) => ({
  distance,
  aligned,
  active,
  wave,
});

describe("SAM state machine", () => {
  it("searches outside detection and tracks before the fire envelope", () => {
    const sam = new SamStateMachine();
    sam.update(0.5, input(500));
    expect(sam.state).toBe(SamState.SEARCHING);
    sam.update(0.1, input(300, false));
    expect(sam.state).toBe(SamState.TRACKING);
  });

  it("locks, emits cadence beeps, fires once, and reloads", () => {
    const sam = new SamStateMachine();
    const first = sam.update(0.1, input(180));
    expect(first.lockStarted).toBe(true);
    expect(first.beep).toBe(true);
    expect(sam.state).toBe(SamState.LOCKING);

    let shots = 0;
    for (let i = 0; i < 20; i++) {
      if (sam.update(0.1, input(180)).fired) shots++;
    }
    expect(shots).toBe(1);
    expect([SamState.FIRING, SamState.RELOADING]).toContain(sam.state);
    sam.update(0.1, input(180));
    expect(sam.state).toBe(SamState.RELOADING);
    for (let i = 0; i < 60 && sam.state === SamState.RELOADING; i++) sam.update(0.1, input(180));
    expect(sam.state).toBe(SamState.TRACKING);
  });

  it("will not fire inside its minimum range and cancels an interrupted lock", () => {
    const sam = new SamStateMachine();
    sam.update(0.4, input(150));
    const cancelled = sam.update(0.1, input(SAM_MIN_FIRE_RANGE - 1));
    expect(cancelled.lockCancelled).toBe(true);
    expect(sam.state).toBe(SamState.TRACKING);
    expect(sam.lockProgress).toBe(0);
  });

  it("cancels lock and stays destroyed when the site becomes inactive", () => {
    const sam = new SamStateMachine();
    sam.update(0.4, input(150));
    const result = sam.update(0.1, input(150, true, false));
    expect(result.lockCancelled).toBe(true);
    expect(sam.state).toBe(SamState.DESTROYED);
    expect(sam.update(1, input(150)).fired).toBe(false);
  });
});

describe("SAM turret angle helpers", () => {
  it("takes the shortest wrapped turn and respects angular speed", () => {
    expect(shortestAngleDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(0.2);
    expect(stepAngle(0, Math.PI / 2, 1, 0.25)).toBeCloseTo(0.25);
  });
});
