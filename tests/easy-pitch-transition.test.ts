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
