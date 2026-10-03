import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { AIRCRAFT_BASE_DAMAGE, AIRCRAFT_HEALTH, aircraftDamageMultiplier } from '../src/aircraft-damage';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { Bullet } from '../src/types';
const neutral = { turn: 0, climb: 0, fire: false, loop: false };

test('MG and cannon have separate four-band boundaries and finite input contract', () => {
  for (const [distance, mg, cannon] of [
    [0, 1, 1], [199.999, 1, 1], [200, .75, .9], [200.001, .75, .9],
    [499.999, .75, .9], [500, .5, .8], [500.001, .5, .8],
    [799.999, .5, .8], [800, .25, .7], [800.001, .25, .7], [1500, .25, .7],
  ]) {
    assert.equal(aircraftDamageMultiplier('mg', distance), mg);
    assert.equal(aircraftDamageMultiplier('cannon', distance), cannon);
  }
  for (const invalid of [-1, NaN, Infinity, -Infinity]) assert.throws(() => aircraftDamageMultiplier('mg', invalid), RangeError);
  assert.equal(AIRCRAFT_HEALTH, 80);
  assert.deepEqual(AIRCRAFT_BASE_DAMAGE, { player: { mg: 4, cannon: 20 }, ally: { mg: 2.4, cannon: 9.6 }, enemy: { mg: .32, cannon: .64 } });
});

function impact(kind: Bullet['kind'], travelled: number, shooter: 'player' | 'ally' | 'enemy', friendly = false) {
  const state = createGame(123, 'normal');
  for (const target of [...state.allies, ...state.enemies, ...state.ships]) target.health = 0;
  state.ships[0].health = state.ships[0].maxHealth; state.ships[0].position.set(30000, 0, 30000); state.ships[0].previous.copy(state.ships[0].position);
  state.player.position.set(10000, 1000, 10000); state.player.previous.copy(state.player.position);
  const target = shooter === 'enemy' ? state.player : friendly ? state.allies[1] : state.enemies[0];
  target.health = target.maxHealth; target.position.set(0, 1000, 0); target.previous.copy(target.position);
  const position = new Vector3(0, 1000, 20);
  const round: Bullet = { id: 90000, owner: shooter === 'player' ? 1 : shooter === 'ally' ? state.allies[0].id : state.enemies[1].id,
    team: shooter === 'enemy' ? 'enemy' : 'friendly', kind, damage: 10, distanceTravelled: travelled,
    position, previous: position.clone(), velocity: new Vector3(0, 0, -12000), life: 1 };
  state.bullets.push(round); startGame(state); stepGame(state, neutral);
  assert.ok(!state.bullets.includes(round), 'one real swept hit consumes the round');
  assert.ok(round.distanceTravelled! > travelled + 10 && round.distanceTravelled! < travelled + 20);
  return { state, target, round, damage: target.maxHealth - target.health };
}

test('all three aircraft shooter categories apply falloff once at the partial swept impact distance', () => {
  for (const shooter of ['player', 'ally', 'enemy'] as const) {
    for (const [travelled, mg, cannon] of [[0, 10, 10], [220, 7.5, 9], [520, 5, 8], [820, 2.5, 7]]) {
      assert.equal(impact('mg', travelled, shooter).damage, mg);
      assert.equal(impact('cannon', travelled, shooter).damage, cannon);
    }
  }
  // Full segment would end past 200m; actual first hit remains below it.
  assert.equal(impact('mg', 180, 'player').damage, 10);
  assert.equal(impact('aa', 900, 'enemy').damage, 10, 'naval projectiles do not acquire aircraft attenuation');
});

test('Normal friendly fire penalties use attenuated actual health loss', () => {
  const result = impact('mg', 820, 'player', true);
  assert.equal(result.damage, 2.5); assert.equal(result.state.stats.friendlyDamage, 2.5); assert.equal(result.state.stats.score, -25);
  assert.equal(result.state.stats.friendlyKills, 0); assert.equal(result.state.stats.playerAircraftKills, 0);
});

test('range accumulation leaves base projectile power unchanged between non-impact ticks', () => {
  const state = createGame(123, 'normal');
  const position = new Vector3(30000, 1000, 30000);
  const bullet: Bullet = { id: 90000, owner: 1, team: 'friendly', kind: 'mg', damage: 4, distanceTravelled: 199,
    position, previous: position.clone(), velocity: new Vector3(0, 0, -600), life: 1 };
  state.bullets.push(bullet); startGame(state);
  for (let i = 0; i < 3; i++) stepGame(state, neutral);
  assert.equal(bullet.distanceTravelled, 229); assert.equal(bullet.damage, 4);
});
