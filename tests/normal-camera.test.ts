import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { getFlightAssist } from '../src/flight-assist';
import { createFlightController, updatePlayerLoop, updateQuaternion } from '../src/flight';
import { getFlightCameraPose } from '../src/flight-view';
import { makeAircraft } from '../src/mission';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { FlightInput } from '../src/types';

const neutral: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };

test('Normal held steering crosses zero pitch input without an unsolicited level-return step', () => {
  for (const pitch of [-.6, .6]) for (const turn of [0, -.3, .3]) {
    const player = makeAircraft(1, 'friendly', new Vector3(0, 1000, 0), 0, 'player');
    player.pitch = pitch; updateQuaternion(player);
    const controller = createFlightController(player);
    for (const climb of [.001, 0, -.001, 0, .001, 0]) {
      const input = { ...neutral, turn, climb, steeringActive: true };
      const before = player.pitch;
      updatePlayerLoop(player, controller, input, input, false, 1 / 60, 110, 141, 1, 'normal');
      if (climb === 0) assert.equal(player.pitch, before, 'a held horizontal/neutral drag must not command a descent or ascent');
      else assert.ok((player.pitch - before) * climb > 0, 'micro-steering keeps its requested direction');
    }
    const beforeRelease = player.pitch;
    updatePlayerLoop(player, controller, neutral, neutral, false, 1 / 60, 110, 141, 1, 'normal');
    assert.ok(Math.abs(player.pitch) < Math.abs(beforeRelease), 'releasing steering retains the existing level return');
    assert.ok(Math.abs(player.pitch - beforeRelease) < .02, 'release stays within the established angular rate');
  }
});

test('Normal does not select steering targets or vary response with enemy visibility', () => {
  const state = createGame(73, 'normal');
  const input = { ...neutral, turn: .3, climb: -.1, steeringActive: true };
  const lock = createFlightController(state.player).targetLock;
  const assist = getFlightAssist(state.player, [...state.enemies, ...state.ships], input, 'normal', lock,
    () => { assert.fail('manual flight must not query target line of sight'); });
  assert.equal(assist.turn, input.turn);
  assert.equal(assist.climb, input.climb);
  assert.equal(assist.responseMultiplier, 1);
  assert.equal(lock.key, null);
  assert.equal(getFlightAssist(state.player, [], input, 'normal').responseMultiplier, 1);
});

test('Normal camera and flight stay identical as aircraft or ships cross the sight and viewport', () => {
  for (const pitch of [-.6, 0, .6]) for (const input of [neutral,
    { ...neutral, turn: .3, climb: 0, steeringActive: true },
    { ...neutral, turn: .3, climb: .001, steeringActive: true },
    { ...neutral, climb: -.3, steeringActive: true, fire: true }]) {
    let expected: unknown;
    for (const kind of ['aircraft', 'ship'] as const) for (const location of ['sight', 'edge', 'offscreen', 'behind'] as const) {
      const state = createGame(73, 'normal');
      state.player.position.set(0, 1500, 0); state.player.previous.copy(state.player.position);
      state.player.pitch = pitch; updateQuaternion(state.player);
      for (const target of [...state.allies, ...state.enemies, ...state.ships]) target.health = 0;
      const target = kind === 'aircraft' ? state.enemies[0] : state.ships[0];
      target.health = target.maxHealth;
      const position = new Vector3(), rotation = new Quaternion();
      getFlightCameraPose(state.player, 'normal', position, rotation);
      if (location === 'sight') target.position.set(0, 0, -504.5).applyQuaternion(state.player.quaternion).add(state.player.position);
      else target.position.set(location === 'edge' ? 125 : location === 'offscreen' ? 1000 : 0, 0,
        location === 'behind' ? 500 : -500).applyQuaternion(rotation).add(position);
      target.previous.copy(target.position);
      startGame(state); stepGame(state, input);
      getFlightCameraPose(state.player, 'normal', position, rotation);
      const actual = { position: state.player.position.toArray(), rotation: state.player.quaternion.toArray(),
        pitch: state.player.pitch, yaw: state.player.yaw, bank: state.player.bank, speed: state.player.speed,
        cameraPosition: position.toArray(), cameraRotation: rotation.toArray(), shots: state.stats.shots };
      expected ??= actual;
      assert.deepEqual(actual, expected, `${kind} ${location}: enemy acquisition cannot change the same manual command`);
    }
  }
});
