import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { makeAircraft } from '../src/mission';
import { createFlightController, updatePlayerLoop, updateQuaternion } from '../src/flight';
import { getFlightAssist, PLAYER_MAX_PITCH } from '../src/flight-assist';
import { FLIGHT_FOV, getFlightCameraPose } from '../src/flight-view';
import { clearFlightAssistance, smoothFlightAssistance } from '../src/flight-target';
import { createGame, startGame, stepGame } from '../src/simulation';

const neutral = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
function setup(pitch: number) {
  const player = makeAircraft(1, 'friendly', new Vector3(0, 1000, 0), 0, 'player');
  player.pitch = pitch; updateQuaternion(player);
  const position = new Vector3(), rotation = new Quaternion();
  getFlightCameraPose(player, 'easy', position, rotation);
  const point = new Vector3(0, Math.sign(pitch) * .6 * 500 * Math.tan(FLIGHT_FOV * Math.PI / 360), -500)
    .applyQuaternion(rotation).add(position);
  return { player, target: makeAircraft(2, 'enemy', point), controller: createFlightController(player) };
}
test('new Easy absolute-pitch assistance starts at current attitude, not horizontal', () => {
  for (const pitch of [-.6, -.3, .3, .6]) {
    const { player, target, controller } = setup(pitch);
    const assist = getFlightAssist(player, [target], neutral, 'easy', controller.targetLock);
    assert.ok((assist.climb * PLAYER_MAX_PITCH - pitch) * pitch > 0, 'target requests further pitch in the current direction');
    const adjusted = smoothFlightAssistance(controller, neutral, assist, 1 / 60, pitch / PLAYER_MAX_PITCH);
    updatePlayerLoop(player, controller, { ...neutral, ...adjusted }, neutral, false, 1 / 60, 110, 141, controller.responseMultiplier, 'easy');
    assert.ok((player.pitch - pitch) * pitch > 0, 'new target must not produce an opposite-direction dip');
    assert.ok(Math.abs(adjusted.climb - pitch / PLAYER_MAX_PITCH) <= 1.5 / 60 + 1e-12);
  }
});
test('target switch and manual release reseed absolute pitch from live attitude', () => {
  for (const transition of ['switch', 'manual-release'] as const) {
    const { player, target, controller } = setup(.6);
    let assist = getFlightAssist(player, [target], neutral, 'easy', controller.targetLock);
    smoothFlightAssistance(controller, neutral, assist, 1 / 60, player.pitch / PLAYER_MAX_PITCH);
    if (transition === 'switch') target.id = 3;
    else {
      const manual = { ...neutral, turn: .1, steeringActive: true };
      assist = getFlightAssist(player, [target], manual, 'easy', controller.targetLock);
      const adjusted = smoothFlightAssistance(controller, manual, assist, 1 / 60);
      assert.equal(adjusted.turn, manual.turn); assert.equal(adjusted.climb, manual.climb);
    }
    assist = getFlightAssist(player, [target], neutral, 'easy', controller.targetLock);
    const adjusted = smoothFlightAssistance(controller, neutral, assist, 1 / 60, player.pitch / PLAYER_MAX_PITCH);
    assert.ok(adjusted.climb * PLAYER_MAX_PITCH > player.pitch);
  }
});
test('lost target and neutral aim still clear assistance immediately', () => {
  for (const next of ['lost', 'neutral'] as const) {
    const { player, target, controller } = setup(.6);
    const assist = getFlightAssist(player, [target], neutral, 'easy', controller.targetLock);
    smoothFlightAssistance(controller, neutral, assist, 1 / 60, player.pitch / PLAYER_MAX_PITCH);
    const adjusted = smoothFlightAssistance(controller, neutral,
      { turn: 0, climb: 0, responseMultiplier: 1, hasVisibleTarget: next === 'neutral' }, 1 / 60, player.pitch / PLAYER_MAX_PITCH);
    assert.equal(adjusted.turn, 0); assert.equal(adjusted.climb, 0);
  }
});
test('fixed-tick Easy path supplies the live absolute-pitch origin', () => {
  for (const pitch of [-.6, .6]) {
    const { player, target } = setup(pitch);
    const state = createGame(73, 'easy');
    Object.assign(state.player, player); state.enemies = [target]; state.allies = []; state.ships = [];
    startGame(state); stepGame(state, neutral);
    assert.ok((state.player.pitch - pitch) * pitch > 0, 'simulation must preserve the requested pitch direction');
  }
});
test('an active absolute-pitch command can cross zero without restarting its origin', () => {
  const { controller } = setup(.3);
  const assist = { turn: 0, climb: -.5, responseMultiplier: 1, hasVisibleTarget: true };
  const first = smoothFlightAssistance(controller, neutral, assist, 1 / 60, .025);
  assert.equal(first.climb, 0);
  const second = smoothFlightAssistance(controller, neutral, assist, 1 / 60, .025);
  assert.equal(second.climb, -.025);
});
test('optional steering flag does not turn a small manual rate into an absolute pitch command', () => {
  const { player, target, controller } = setup(.6);
  const manual = { ...neutral, climb: .1 };
  const initial = getFlightAssist(player, [target], neutral, 'easy', controller.targetLock);
  smoothFlightAssistance(controller, neutral, initial, 1 / 60, player.pitch / PLAYER_MAX_PITCH);
  const assist = getFlightAssist(player, [target], manual, 'easy', controller.targetLock);
  const adjusted = smoothFlightAssistance(controller, manual, assist, 1 / 60);
  assert.ok(Math.abs(adjusted.climb - manual.climb) <= 1.5 / 60 + 1e-12, 'absolute attitude cannot leak into the manual rate');
  const next = smoothFlightAssistance(controller, manual, assist, 1 / 60);
  assert.ok(Math.abs(next.climb - adjusted.climb) <= 1.5 / 60 + 1e-12);

  const state = createGame(73, 'easy');
  Object.assign(state.player, player); state.enemies = [target]; state.allies = []; state.ships = [];
  startGame(state); stepGame(state, manual);
  assert.ok(state.player.pitch - .6 <= .125 * .82 / 60 + 1e-12, 'actual simulation keeps the small manual rate');
});

test('inactive assistance preserves the original enumerable state schema', () => {
  const makeState = () => ({ assistTurn: 0, assistClimb: 0, responseMultiplier: 1,
    targetLock: { key: null, manual: false, changed: false } });
  const expected = Object.keys(makeState()).sort();
  for (const transition of ['clear', 'changed', 'inactive'] as const) {
    const state = makeState();
    const active = { turn: 0, climb: .5, responseMultiplier: 1, hasVisibleTarget: true };
    smoothFlightAssistance(state, neutral, active, 1 / 60, .3);
    assert.ok(Object.hasOwn(state, 'assistClimbMode'));
    if (transition === 'clear') clearFlightAssistance(state);
    else {
      state.targetLock.changed = transition === 'changed';
      smoothFlightAssistance(state, neutral,
        { turn: 0, climb: 0, responseMultiplier: 1, hasVisibleTarget: false }, 1 / 60);
    }
    assert.deepEqual(Object.keys(state).sort(), expected, transition);
    assert.equal(Object.hasOwn(state, 'assistClimbMode'), false, transition);
  }
});
