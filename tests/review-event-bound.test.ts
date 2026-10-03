import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createGame, startGame, stepGame } from '../src/simulation';
import { FIXED_DT, MAX_EVENTS_PER_STEP, REINFORCEMENT_TICK } from '../src/mission';

test('a replenishment alert survives bounded cosmetic-event saturation without mutating a splash', () => {
  const state = createGame(123, 'normal');
  for (const plane of [...state.allies, ...state.enemies]) plane.health = 0;
  state.player.position.set(1000, 1000, 1000);
  state.player.previous.copy(state.player.position);
  state.tick = REINFORCEMENT_TICK - 1;
  state.elapsed = state.tick * FIXED_DT;
  for (let index = 0; index < MAX_EVENTS_PER_STEP; index++) {
    const position = new Vector3(30000 + index, -100, 30000);
    state.bullets.push({ id: 100000 + index, owner: 99999, team: 'enemy',
      position, previous: position.clone(), velocity: new Vector3(), life: 1, damage: .4, kind: 'mg' });
  }
  startGame(state);
  stepGame(state, { turn: 0, climb: 0, fire: false, loop: false });
  assert.equal(state.enemies.filter(enemy => enemy.health > 0).length, 5);
  assert.ok(state.events.length <= MAX_EVENTS_PER_STEP);
  assert.equal(state.events.find(event => event.type === 'reinforcement')?.amount, 5);
  assert.ok(state.events.filter(event => event.type === 'splash').every(event => event.amount === undefined));
});
