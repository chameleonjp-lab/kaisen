import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { createGame, startGame, pauseGame, resumeGame, stepGame, FIXED_DT } from '../src/simulation';
import { getFlightCameraPose } from '../src/flight-view';
import { FlightPresentation } from '../src/flight-presentation';

const input = { turn: 0, climb: .45, steeringActive: true, fire: false, loop: false };
const forward = (state: ReturnType<typeof createGame>) => {
  const position = new Vector3(), rotation = new Quaternion();
  getFlightCameraPose(state.player, state.mode, position, rotation);
  return new Vector3(0, 0, -1).applyQuaternion(rotation);
};
const angle = (a: Vector3, b: Vector3) => Math.atan2(new Vector3().crossVectors(a, b).length(), a.dot(b));

test('Normal camera moves on every 120Hz presentation sample between 60Hz ticks', () => {
  for (const command of [input, { ...input, climb: -.45 }, { ...input, turn: .45, climb: 0 }]) {
    const state = createGame(73, 'normal'), view = new FlightPresentation(); startGame(state);
    let accumulator = 0, previous = forward(state); const rates: number[] = [];
    for (let frame = 0; frame < 50; frame++) {
      accumulator += FIXED_DT / 2;
      if (accumulator + 1e-9 >= FIXED_DT) {
        view.capture(state); stepGame(state, command); accumulator -= FIXED_DT;
      }
      const before = JSON.stringify(state), sampled = view.sample(state, accumulator / FIXED_DT);
      const current = forward(sampled);
      if (frame > 2) rates.push(angle(previous, current) / (FIXED_DT / 2));
      assert.equal(JSON.stringify(state), before, 'sampling must not change physics, input, weapons, clock or scoring');
      previous = current;
    }
    assert.ok(Math.min(...rates) > .3, `no repeated fixed pose between ticks: ${rates}`);
    assert.ok(Math.max(...rates) / Math.min(...rates) < 1.02, 'no alternating zero/double camera velocity');
  }
});

test('presentation shares one interpolation phase for aircraft, ships, projectiles and camera', () => {
  const state = createGame(73, 'normal'), view = new FlightPresentation(); startGame(state);
  view.capture(state); const oldPlayer = state.player.position.clone(), oldShip = state.ships[0].position.clone();
  stepGame(state, { ...input, fire: true });
  const sampled = view.sample(state, .25);
  assert.ok(sampled.player.position.distanceTo(oldPlayer.clone().lerp(state.player.position, .25)) < 1e-10);
  assert.ok(sampled.ships[0].position.distanceTo(oldShip.clone().lerp(state.ships[0].position, .25)) < 1e-10);
  for (let i = 0; i < state.bullets.length; i++)
    assert.ok(sampled.bullets[i].position.distanceTo(state.bullets[i].previous.clone().lerp(state.bullets[i].position, .25)) < 1e-10);
  assert.equal(sampled.tick, state.tick);
  assert.ok(Math.abs(sampled.elapsed - (state.elapsed - FIXED_DT * .75)) < 1e-12);
  pauseGame(state); assert.equal(view.sample(state, .25), state, 'pause draws the authoritative final pose');
  resumeGame(state); assert.equal(view.sample(state, 0), state, 'resume must not jump backwards to a stale pose');
  const next = createGame(73, 'normal'); startGame(next); assert.equal(view.sample(next, .5), next);
  const easy = createGame(73, 'easy'); startGame(easy); view.capture(easy); stepGame(easy, input);
  assert.equal(view.sample(easy, .5), easy, 'Easy retains its targeting presentation');
});
