import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Quaternion, Vector3 } from 'three';
import { advanceThrottle, createFlightController, MAX_SPEED, STALL_SPEED, updateAircraftMotion, updatePlayerLoop, updateQuaternion } from '../src/flight';
import { getFlightCameraPose } from '../src/flight-view';
import { makeAircraft } from '../src/mission';

const neutral = { turn: 0, climb: 0, fire: false, loop: false };
const dt = 1 / 60;
/** Independent reference equations transcribed from source 025cad49 updateAircraftMotion. */
function referenceStep(p: { pitch: number; yaw: number; bank: number; speed: number; position: Vector3 }, turn: number, climb: number, trim: number): void {
  const limit = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const authority = (p.speed <= 85 ? .92 + ((p.speed - 65) / 20) * .23 : p.speed <= 110 ? 1.15 - ((p.speed - 85) / 25) * .15 : 1)
    * limit(1 - Math.max(0, p.speed - 115) * .008, .78, 1);
  p.pitch += (climb * .95 - p.pitch) * (1 - Math.exp(-dt * 4.2));
  p.yaw = ((p.yaw - turn * .82 * authority * dt + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  p.bank += (turn * .72 - p.bank) * (1 - Math.exp(-dt * 5.5));
  p.speed = limit(p.speed + ((trim - p.speed) * .72 - Math.abs(turn) * 2.7 - Math.max(0, climb) * 2.1 - Math.sin(p.pitch) * 2.6) * dt, 65, 141);
  p.position.addScaledVector(new Vector3(0, 0, -1).applyEuler(new Euler(p.pitch, p.yaw, -p.bank, 'YXZ')), p.speed * dt);
}

test('source motion parity across slow/cruise/fast throttle and changing stick traces', () => {
  for (const speed of [65, 85, 110, 141]) {
    const actual = makeAircraft(1, 'friendly', new Vector3(0, 2400, 0), 0, 'player'); actual.speed = speed;
    const expected = { pitch: 0, yaw: 0, bank: 0, speed, position: actual.position.clone() };
    for (let tick = 0; tick < 600; tick++) {
      const turn = Math.sin(tick / 73) * .8, climb = Math.cos(tick / 110) * .6, preferred = tick < 300 ? 141 : 65;
      updateAircraftMotion(actual, turn, climb, dt, preferred, false, 141, .95); referenceStep(expected, turn, climb, preferred);
    }
    assert.ok(actual.position.distanceTo(expected.position) < 1e-8);
    for (const key of ['pitch', 'yaw', 'bank', 'speed'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-10, key);
  }
});

test('five second source loop restores heading and pitch then has two second cooldown', () => {
  const plane = makeAircraft(1, 'friendly', new Vector3(0, 800, 0), .3, 'player'); plane.pitch = .12;
  const control = createFlightController(plane); let completed = 0;
  for (let i = 0; i < 300; i++) completed += Number(updatePlayerLoop(plane, control, neutral, neutral, i === 0, dt, 110, 141, 1));
  assert.equal(completed, 1); assert.equal(plane.loopProgress, 0); assert.equal(plane.loopCooldown, 2);
  assert.equal(plane.yaw, .3); assert.equal(plane.pitch, .12); assert.ok(plane.position.toArray().every(Number.isFinite));
  updatePlayerLoop(plane, control, neutral, neutral, true, dt, 110, 141, 1); assert.equal(plane.loopProgress, 0);
});

test('intent revision cancels a loop smoothly and throttle retains source mode semantics', () => {
  const plane = makeAircraft(1, 'friendly', new Vector3(0, 800, 0), 0, 'player'); const control = createFlightController(plane);
  const input = { ...neutral, steeringRevision: 1 };
  for (let i = 0; i < 90; i++) updatePlayerLoop(plane, control, input, input, i === 0, dt, 110, 141, 1);
  const before = plane.position.clone();
  const beforePitch = plane.pitch, beforeSpeed = plane.speed;
  const cameraPosition = new Vector3(), beforeCamera = new Quaternion(), afterCamera = new Quaternion();
  getFlightCameraPose(plane, 'normal', cameraPosition, beforeCamera);
  const steering = { ...neutral, turn: .5, steeringRevision: 2 };
  updatePlayerLoop(plane, control, steering, steering, false, dt, 110, 141, 1);
  assert.equal(plane.loopProgress, 0); assert.equal(plane.loopCooldown, 2); assert.ok(plane.position.distanceTo(before) < 3);
  getFlightCameraPose(plane, 'normal', cameraPosition, afterCamera);
  assert.ok(Math.abs(plane.pitch - beforePitch) <= .82 * expectedAuthority(beforeSpeed) * dt + 1e-12,
    'cancelling beyond vertical keeps pitch on its continuous loop branch and applies at most one rate step');
  assert.ok(beforeCamera.angleTo(afterCamera) < .08,
    'the rendered camera follows loop cancellation without the π Euler-branch snap');
  for (let i = 0; i < 600; i++) advanceThrottle(control, { ...neutral, accelerate: true }, 'easy', dt);
  assert.equal(control.playerTargetSpeed, 110);
  for (let i = 0; i < 600; i++) advanceThrottle(control, { ...neutral, accelerate: true }, 'normal', dt);
  assert.equal(control.playerTargetSpeed, MAX_SPEED);
  for (let i = 0; i < 600; i++) advanceThrottle(control, { ...neutral, brake: true }, 'normal', dt);
  assert.equal(control.playerTargetSpeed, STALL_SPEED);
});

function manualStep(plane: ReturnType<typeof makeAircraft>, turn: number, climb: number, responseMultiplier = 1, mode: 'easy' | 'normal' = 'normal') {
  const control = createFlightController(plane);
  const input = { ...neutral, turn, climb, steeringActive: true };
  updatePlayerLoop(plane, control, input, input, false, dt, 110, 141, responseMultiplier, mode);
}

function cameraForward(plane: ReturnType<typeof makeAircraft>, mode: 'easy' | 'normal') {
  const position = new Vector3(), rotation = new Quaternion();
  getFlightCameraPose(plane, mode, position, rotation);
  return new Vector3(0, 0, -1).applyQuaternion(rotation).normalize();
}

function cameraAngle(before: Vector3, after: Vector3): number {
  // atan2 keeps the small per-tick angle accurate; acos loses significant
  // digits near a dot product of one, especially when comparing rate ratios.
  return Math.atan2(new Vector3().crossVectors(before, after).length(), before.dot(after));
}

function expectedAuthority(speed: number): number {
  const lowSpeed = speed <= 85 ? .92 + ((speed - 65) / 20) * .23
    : speed <= 110 ? 1.15 - ((speed - 85) / 25) * .15 : 1;
  return lowSpeed * Math.max(.78, Math.min(1, 1 - Math.max(0, speed - 115) * .008));
}

test('manual pitch and yaw share signed per-second rates across the speed envelope', () => {
  for (const speed of [65, 85, 110, 141]) {
    const step = .82 * expectedAuthority(speed) * dt;
    for (const direction of [-1, 1]) {
      for (const mode of ['easy', 'normal'] as const) {
        const vertical = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
        vertical.speed = speed;
        const beforeVertical = cameraForward(vertical, mode);
        manualStep(vertical, 0, direction * .6, 1, mode);
        assert.ok(Math.abs(vertical.pitch - direction * .6 * step) < 1e-12, `pitch ${speed}m/s ${direction}`);
        assert.ok(Math.abs(cameraAngle(beforeVertical, cameraForward(vertical, mode)) - .6 * step) < 1e-12,
          `${mode} actual camera-forward pitch angle ${speed}m/s ${direction}`);

        const horizontal = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
        horizontal.speed = speed;
        const neutralBaseline = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
        neutralBaseline.speed = speed;
        manualStep(neutralBaseline, 0, 0, 1, mode);
        manualStep(horizontal, direction * .6, 0, 1, mode);
        assert.ok(horizontal.yaw * direction < 0, 'right and left preserve their signed yaw directions');
        assert.ok(Math.abs(cameraAngle(cameraForward(neutralBaseline, mode), cameraForward(horizontal, mode)) - .6 * step) < 1e-12,
          `${mode} actual camera-forward yaw angle against neutral baseline ${speed}m/s ${direction}`);
      }
    }
  }
});

test('manual keyboard diagonals share one circular authority budget in actual camera angle', () => {
  const speed = 110, step = .82 * expectedAuthority(speed) * dt;
  for (const mode of ['easy', 'normal'] as const) for (const turn of [-1, 1]) for (const climb of [-1, 1]) {
    const plane = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player'); plane.speed = speed;
    const before = cameraForward(plane, mode);
    manualStep(plane, turn, climb, 1, mode);
    assert.ok(Math.abs(plane.pitch - climb * step / Math.SQRT2) < 1e-12);
    assert.ok(plane.yaw * turn < 0);
    assert.ok(Math.abs(cameraAngle(before, cameraForward(plane, mode)) - step) < 1e-12,
      `${mode} combined input has the exact finite camera-forward rate`);
  }
});

test('actual camera rate keeps direction, strength, pitch and yaw symmetric in both views', () => {
  for (const mode of ['easy', 'normal'] as const) for (const speed of [65, 110, 141])
    for (const initialPitch of [-.9, 0, .9]) for (const direction of [-1, 1]) {
      const authority = expectedAuthority(speed), angularStep = .82 * authority * dt;
      const vertical = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
      vertical.speed = speed; vertical.pitch = initialPitch;
      updateQuaternion(vertical);
      const beforeVertical = cameraForward(vertical, mode);
      manualStep(vertical, 0, direction * .45, 1, mode);
      assert.ok(Math.abs(cameraAngle(beforeVertical, cameraForward(vertical, mode)) - .45 * angularStep) < 1e-12,
        `${mode} vertical p=${initialPitch} v=${speed} sign=${direction}`);

      const yawed = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
      yawed.speed = speed; yawed.pitch = initialPitch;
      const neutral = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
      neutral.speed = speed; neutral.pitch = initialPitch;
      updateQuaternion(yawed); updateQuaternion(neutral);
      manualStep(neutral, 0, 0, 1, mode);
      manualStep(yawed, direction * .45, 0, 1, mode);
      assert.ok(Math.abs(cameraAngle(cameraForward(neutral, mode), cameraForward(yawed, mode)) - .45 * angularStep) < 1e-12,
        `${mode} horizontal p=${initialPitch} v=${speed} sign=${direction}`);
    }
});

test('camera-forward manual rate preserves the yaw-only offscreen 1.65 multiplier', () => {
  for (const mode of ['easy', 'normal'] as const) {
    const speed = 110, angularStep = .82 * expectedAuthority(speed) * dt;
    const boosted = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
    const visible = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
    boosted.speed = visible.speed = speed;
    manualStep(boosted, .6, 0, 1.65, mode);
    manualStep(visible, .6, 0, 1, mode);
    const boostedAngle = cameraAngle(
      cameraForward(makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player'), mode), cameraForward(boosted, mode));
    const visibleBaseline = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player'); visibleBaseline.speed = speed;
    manualStep(visibleBaseline, 0, 0, 1, mode);
    const visibleAngle = cameraAngle(cameraForward(visibleBaseline, mode), cameraForward(visible, mode));
    assert.ok(Math.abs(boostedAngle - .6 * angularStep * 1.65) < 1e-12);
    assert.ok(Math.abs(visibleAngle - .6 * angularStep) < 1e-12);
    assert.ok(Math.abs(boostedAngle / visibleAngle - 1.65) < 1e-12);
  }
});

test('bank keeps its established camera offset while no longer steering the optical axis', () => {
  for (const mode of ['easy', 'normal'] as const) {
    const level = makeAircraft(1, 'friendly', new Vector3(30, 900, -40), .4, 'player');
    const banked = makeAircraft(1, 'friendly', new Vector3(30, 900, -40), .4, 'player');
    banked.bank = .72;
    updateQuaternion(level); updateQuaternion(banked);
    const levelPosition = new Vector3(), bankPosition = new Vector3();
    const levelRotation = new Quaternion(), bankRotation = new Quaternion();
    getFlightCameraPose(level, mode, levelPosition, levelRotation);
    getFlightCameraPose(banked, mode, bankPosition, bankRotation);
    assert.ok(cameraForward(level, mode).distanceTo(cameraForward(banked, mode)) < 1e-12,
      `${mode} bank roll does not alter camera forward`);
    assert.ok(Math.abs(levelRotation.angleTo(bankRotation) - .72 * .45) < 1e-12,
      `${mode} retained 45% bank is optical-axis roll only`);
    const oldOffsetRotation = banked.quaternion.clone().multiply(new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), banked.bank * (1 - .45)));
    const expectedPosition = new Vector3(0, 11, 29).applyQuaternion(oldOffsetRotation).add(banked.position);
    assert.ok(bankPosition.distanceTo(expectedPosition) < 1e-12, `${mode} retains the established 45%-bank camera position`);
  }
});

test('manual pitch reverses smoothly away from level, neutral return obeys the same rate, and limits hold', () => {
  const reverse = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
  reverse.pitch = .4; reverse.speed = 110;
  const start = reverse.pitch, maxStep = .5 * .82 * expectedAuthority(reverse.speed) * dt;
  manualStep(reverse, 0, -.5);
  assert.ok(reverse.pitch < start && start - reverse.pitch <= maxStep + 1e-12, 'opposite input changes an existing climb at the signed rate');
  assert.ok(reverse.pitch > 0, 'one tick cannot snap through level');

  const level = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
  level.pitch = .6; level.speed = 110;
  const before = level.pitch;
  const control = createFlightController(level);
  for (let i = 0; i < 240; i++) {
    const input = { ...neutral };
    const previous = level.pitch, previousSpeed = level.speed;
    updatePlayerLoop(level, control, input, input, false, dt, 110, 141, 1);
    assert.ok(Math.abs(level.pitch - previous) <= .82 * expectedAuthority(previousSpeed) * dt + 1e-12,
      'neutral leveling remains rate-bounded while speed authority changes');
    if (i === 0) assert.ok(before - level.pitch < .02, 'first neutral tick cannot snap toward the horizon');
  }
  assert.ok(Math.abs(level.pitch) < .01, 'neutral input still returns to horizontal flight');

  for (const direction of [-1, 1]) {
    const limited = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), 0, 'player');
    const command = direction;
    for (let i = 0; i < 180; i++) manualStep(limited, 0, command);
    assert.ok(Math.abs(limited.pitch) <= .95 + 1e-12, 'held input never crosses the player pitch limit');
    assert.ok(Math.abs(limited.pitch - direction * .95) < 1e-10, 'held input reaches the existing pitch limit');
  }
});
