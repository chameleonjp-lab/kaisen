import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';
import { releaseBomb } from '../src/ordnance';
import { updateQuaternion } from '../src/flight';
import { beginShipWreck, isShipObstacle, shipWreckPose, SHIP_SINK_SECONDS } from '../src/ship-wreck';
const neutral = { turn: 0, climb: 0, fire: false, loop: false };
function combatWreck(crossing = false) {
  const state = createGame(123, 'normal');
  for (const plane of [...state.allies, ...state.enemies]) plane.health = 0;
  for (const [i, ship] of state.ships.entries()) {
    ship.position.set(10000 + i * 1000, 0, 10000); ship.previous.copy(ship.position); ship.guns.forEach(gun => gun.health = 0);
  }
  const ship = state.ships[0]; ship.health = 1400; ship.position.set(0, 0, 0); ship.previous.copy(ship.position);
  ship.yaw = 0; ship.quaternion.identity(); ship.previousQuaternion.identity(); ship.velocity.set(0, 0, 0);
  state.player.position.set(crossing ? 0 : 30000, crossing ? 25 : 1000, crossing ? -70 : 30000);
  state.player.previous.copy(state.player.position); state.player.yaw = crossing ? Math.PI : 0; updateQuaternion(state.player);
  const bomb = releaseBomb(50000, state.player)!; bomb.age = 1; bomb.position.set(10, 15, 110); bomb.previous.copy(bomb.position); bomb.velocity.set(0, -600, 0);
  state.ordnance.push(bomb); startGame(state); stepGame(state, neutral);
  assert.equal(ship.health, 0); assert.equal(state.phase, 'playing'); assert.ok(ship.wreck);
  return state;
}

test('a live torpedo-altitude flight cannot pass through a visibly sinking bridge', () => {
  const state = combatWreck(true);
  for (let i = 0; i < 60 && state.phase === 'playing'; i++) stepGame(state, neutral);
  assert.equal(state.player.health, 0); assert.equal(state.deathCause, 'ship-wreck-collision');
  assert.equal(state.result?.outcome, 'defeat'); assert.ok(state.elapsed < 1);
  assert.equal(state.ships.filter(ship => ship.health > 0).length, 3);
});

test('wreck drift, sink and list use one frozen origin and freeze during a combat pause', () => {
  const state = combatWreck(), ship = state.ships[0], origin = JSON.stringify(ship.wreck);
  for (let i = 0; i < 180; i++) stepGame(state, neutral);
  const position = new Vector3(), rotation = new Quaternion(); shipWreckPose(ship.wreck!, state.elapsed, position, rotation);
  assert.ok(position.distanceTo(ship.position) < 1e-10); assert.ok(rotation.angleTo(ship.quaternion) < 1e-7);
  assert.equal(JSON.stringify(ship.wreck), origin);
  pauseGame(state); const frozen = JSON.stringify(state); stepGame(state, neutral, .25); assert.equal(JSON.stringify(state), frozen); resumeGame(state);
  assert.equal(isShipObstacle(ship, ship.wreck!.since + SHIP_SINK_SECONDS - .001), true);
  assert.equal(isShipObstacle(ship, ship.wreck!.since + SHIP_SINK_SECONDS), false);
  shipWreckPose(ship.wreck!, ship.wreck!.since + SHIP_SINK_SECONDS, position, rotation);
  assert.ok(position.y < -50, 'the complete 42m ship is submerged before expiry');
  beginShipWreck(ship, 99); assert.equal(JSON.stringify(ship.wreck), origin, 'later contacts cannot restart sinking');
});

test('wrecks stop later gun rounds and armed bombs without another hull kill or damage credit', () => {
  const state = combatWreck(), ship = state.ships[0], since = ship.wreck!.since;
  const position = new Vector3(0, 25, -50);
  state.bullets.push({ id: 50001, owner: 1, team: 'friendly', kind: 'cannon', damage: 200,
    position, previous: position.clone(), velocity: new Vector3(0, 0, 12000), life: 1 });
  const bomb = releaseBomb(50002, state.player)!; bomb.age = 1; bomb.position.set(10, 15, 110); bomb.previous.copy(bomb.position); bomb.velocity.set(0, -600, 0);
  state.ordnance.push(bomb); stepGame(state, neutral);
  assert.equal(state.bullets.some(round => round.id === 50001), false); assert.equal(state.ordnance.length, 0);
  assert.equal(state.stats.playerShipKills, 1); assert.equal(ship.health, 0); assert.equal(ship.wreck!.since, since);
  assert.equal(state.events.filter(event => event.type === 'kill').length, 0);
  assert.ok(state.events.some(event => event.type === 'hit' && event.detail === 'wreck' && event.amount === 0));
  assert.ok(state.events.some(event => event.type === 'ordnance-impact' && event.detail === 'wreck' && event.amount === 0));
});
