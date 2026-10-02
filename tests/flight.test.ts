import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Vector3 } from 'three';
import { advanceThrottle, createFlightController, MAX_SPEED, STALL_SPEED, updateAircraftMotion, updatePlayerLoop } from '../src/flight';
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
  const steering = { ...neutral, turn: .5, steeringRevision: 2 };
  updatePlayerLoop(plane, control, steering, steering, false, dt, 110, 141, 1);
  assert.equal(plane.loopProgress, 0); assert.equal(plane.loopCooldown, 2); assert.ok(plane.position.distanceTo(before) < 3);
  for (let i = 0; i < 600; i++) advanceThrottle(control, { ...neutral, accelerate: true }, 'easy', dt);
  assert.equal(control.playerTargetSpeed, 110);
  for (let i = 0; i < 600; i++) advanceThrottle(control, { ...neutral, accelerate: true }, 'normal', dt);
  assert.equal(control.playerTargetSpeed, MAX_SPEED);
  for (let i = 0; i < 600; i++) advanceThrottle(control, { ...neutral, brake: true }, 'normal', dt);
  assert.equal(control.playerTargetSpeed, STALL_SPEED);
});
