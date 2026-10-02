import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { createGame, pauseGame, resumeGame, startGame, stepGame, sweptAircraftHitTime, sweptShipHitTime } from '../src/simulation';
import { updateQuaternion } from '../src/flight';
import { FIXED_DT, MAX_BULLETS, MAX_EVENTS_PER_STEP } from '../src/mission';
import type { Bullet, GameState } from '../src/types';

const neutral = { turn: 0, climb: 0, fire: false, loop: false };
function quietState(): GameState {
  const state = createGame(17, 'normal');
  state.player.position.set(1000, 500, 1000); state.player.previous.copy(state.player.position);
  for (const entity of [...state.allies, ...state.enemies, ...state.ships]) entity.health = 0;
  const ship = state.ships[0]; ship.health = ship.maxHealth; ship.position.set(10000, 0, -10000); ship.previous.copy(ship.position);
  startGame(state); return state;
}
function shot(owner: number, team: Bullet['team'], position: Vector3, velocity: Vector3, damage = 200): Bullet {
  return { id: 999999, owner, team, position, previous: position.clone(), velocity, life: 1, damage, kind: 'cannon' };
}
function snapshot(state: GameState): string { return JSON.stringify(state); }

test('fixed 5 versus 5 roster, provisional internal fleet counts, easy default, repeatable seed', () => {
  for (const shipCount of [3, 5, 7] as const) {
    const state = createGame(44, { shipCount });
    assert.equal(state.phase, 'ready'); assert.equal(state.mode, 'easy');
    assert.equal(state.allies.length + 1, 5); assert.equal(state.enemies.length, 5); assert.equal(state.ships.length, shipCount);
    assert.equal(new Set([state.player, ...state.allies, ...state.enemies, ...state.ships].map(item => item.id)).size, 10 + shipCount);
    assert.equal(snapshot(state), snapshot(createGame(44, { shipCount })));
  }
  assert.throws(() => createGame(1, { shipCount: 4 as 3 }));
});

test('all-clear waits for both categories and freezes the final tick exactly once', () => {
  for (const lastKind of ['aircraft', 'ship'] as const) {
    const state = quietState(); state.ships[0].health = 0;
    const target = lastKind === 'ship' ? state.ships[0] : state.enemies[0];
    target.health = 1; target.position.set(10000, lastKind === 'ship' ? 0 : 500, -10000);
    stepGame(state, neutral); assert.equal(state.phase, 'playing');
    target.health = 0; stepGame(state, neutral);
    assert.equal(state.endReason, 'all-clear'); assert.equal(state.result?.time, 2 * FIXED_DT);
    assert.equal(state.events.filter(event => event.type === 'end').length, 1);
    const frozen = snapshot(state);
    stepGame(state, { ...neutral, loop: true, fire: true }, 0.2); startGame(state); resumeGame(state);
    assert.equal(snapshot(state), frozen);
  }
});

test('allied final bullet counts toward clear and its own kill attribution', () => {
  const state = quietState(); state.ships[0].health = 0;
  const enemy = state.enemies[0]; enemy.health = 1; enemy.position.set(0, 500, -60); enemy.previous.copy(enemy.position); enemy.yaw = 0; updateQuaternion(enemy);
  state.bullets.push(shot(state.allies[0].id, 'friendly', new Vector3(0, 500, 0), new Vector3(0, 0, -12000)));
  stepGame(state, neutral);
  assert.equal(state.endReason, 'all-clear'); assert.equal(state.stats.allyAircraftKills, 1);
  assert.equal(state.stats.playerAircraftKills, 0); assert.equal(state.result?.allyAircraftKills, 1);
});

test('death wins a simultaneous final kill from already airborne shots', () => {
  const state = quietState(); state.ships[0].health = 0;
  const enemy = state.enemies[0]; enemy.health = 1; enemy.position.set(0, 500, -60); enemy.previous.copy(enemy.position);
  state.player.health = 1;
  state.bullets.push(shot(1, 'friendly', new Vector3(0, 500, 0), new Vector3(0, 0, -12000)));
  state.bullets.push(shot(enemy.id, 'enemy', new Vector3(1000, 500, 1060), new Vector3(0, 0, -12000)));
  stepGame(state, neutral);
  assert.equal(enemy.health, 0); assert.equal(state.player.health, 0);
  assert.equal(state.endReason, 'shot-down'); assert.equal(state.result?.outcome, 'defeat');
  assert.equal(state.stats.playerAircraftKills, 1);
});

test('swept fast projectile hits first enemy only, ignores its own team, never duplicates kills', () => {
  const state = quietState();
  const ally = state.allies[0]; ally.health = 100; ally.position.set(-80, 500, 0); ally.previous.copy(ally.position);
  for (let index = 0; index < 2; index++) { const enemy = state.enemies[index]; enemy.health = 100; enemy.position.set(index * 60, 500, 0); enemy.previous.copy(enemy.position); }
  state.bullets.push(shot(1, 'friendly', new Vector3(-200, 500, 0), new Vector3(24000, 0, 0)));
  stepGame(state, neutral);
  assert.equal(ally.health, 100); assert.equal(state.enemies[0].health, 0); assert.equal(state.enemies[1].health, 100);
  assert.equal(state.stats.playerAircraftKills, 1); assert.equal(state.bullets.length, 0);
  stepGame(state, neutral); assert.equal(state.stats.playerAircraftKills, 1);
});

test('aircraft sweep includes relative movement and close misses stay misses', () => {
  const state = quietState(), target = state.enemies[0];
  target.previous.set(-30, 500, 0); target.position.set(30, 500, 0);
  const bullet = shot(1, 'friendly', new Vector3(0, 500, 15), new Vector3()); bullet.previous.set(0, 500, -15);
  assert.notEqual(sweptAircraftHitTime(bullet, target), null);
  bullet.position.y += 30; bullet.previous.y += 30;
  assert.equal(sweptAircraftHitTime(bullet, target), null);
});

test('ship local hull and superstructure boxes take a single first impact; near-water misses miss', () => {
  const state = quietState(), ship = state.ships[0]; ship.position.set(0, 0, 0); ship.previous.copy(ship.position);
  const hit = shot(1, 'friendly', new Vector3(0, 8, -200), new Vector3()); hit.previous.set(0, 8, 200);
  assert.notEqual(sweptShipHitTime(hit, ship), null);
  const miss = shot(1, 'friendly', new Vector3(150, 8, -200), new Vector3()); miss.previous.set(150, 8, 200);
  assert.equal(sweptShipHitTime(miss, ship), null);
  ship.health = 100; state.bullets.push(shot(1, 'friendly', new Vector3(0, 8, 200), new Vector3(0, 0, -24000), 40));
  stepGame(state, neutral); assert.equal(ship.health, 60); assert.equal(state.events.filter(event => event.type === 'hit').length, 1);
});

test('pause, invalid frame gaps, and ended state do not mutate world or clock', () => {
  const state = quietState(); stepGame(state, neutral); pauseGame(state);
  const frozen = snapshot(state); stepGame(state, { ...neutral, fire: true, loop: true }, 0.2);
  assert.equal(snapshot(state), frozen); resumeGame(state);
  const resumed = snapshot(state);
  for (const dt of [0, -1, NaN, Infinity, 5]) stepGame(state, neutral, dt);
  assert.equal(snapshot(state), resumed);
  stepGame(state, neutral); assert.equal(state.elapsed, 2 * FIXED_DT);
});

test('sea collision replaces altitude deadline, and ramming cannot kill a ship', () => {
  const state = quietState(); state.player.position.y = 3;
  for (let i = 0; i < 660; i++) stepGame(state, neutral);
  assert.equal(state.phase, 'playing', '3m above flat collision surface has no old low-altitude timer');
  state.player.position.y = 2; stepGame(state, neutral); assert.equal(state.endReason, 'sea');
  const ram = quietState(), ship = ram.ships[0]; ram.player.position.copy(ship.position).add(new Vector3(0, 8, 0));
  stepGame(ram, neutral); assert.equal(ram.endReason, 'collision'); assert.equal(ship.health, ship.maxHealth);
});

test('dead units never respawn and all authoritative entities remain finite and bounded', () => {
  const state = quietState(); const roster = [...state.enemies, ...state.allies].map(item => item.id);
  for (let i = 0; i < 60 * 90; i++) {
    stepGame(state, { ...neutral, fire: true });
    assert.ok(state.bullets.length <= MAX_BULLETS); assert.ok(state.events.length <= MAX_EVENTS_PER_STEP);
  }
  assert.deepEqual([...state.enemies, ...state.allies].map(item => item.id), roster);
  assert.ok(state.enemies.every(item => item.health === 0));
  for (const entity of [state.player, ...state.allies, ...state.enemies, ...state.ships, ...state.bullets]) {
    assert.ok(entity.position.toArray().every(Number.isFinite));
  }
  assert.equal(state.player.mg, 1000); assert.equal(state.player.cannon, 120);
});

test('frame subdivision changes neither fixed simulation nor outcome', () => {
  const a = quietState(), b = quietState();
  const input = { ...neutral, turn: 0.3, climb: 0.15, fire: true };
  for (let i = 0; i < 300; i++) { stepGame(a, input, FIXED_DT); stepGame(b, input, FIXED_DT / 2); stepGame(b, input, FIXED_DT / 2); }
  assert.equal(snapshot(a), snapshot(b));
});

test('AA launches bounded, non-homing enemy rounds and respects range and cooldown', () => {
  const state = quietState(), ship = state.ships[0];
  ship.position.set(0, 0, 0); ship.previous.copy(ship.position); ship.fireClock = 0;
  state.player.position.set(0, 250, 500); state.player.previous.copy(state.player.position);
  stepGame(state, neutral);
  const bullet = state.bullets.find(item => item.kind === 'aa'); assert.ok(bullet);
  const velocity = bullet.velocity.clone(); const health = state.player.health;
  assert.equal(bullet.team, 'enemy'); assert.ok(ship.fireClock > 2);
  for (let i = 0; i < 20; i++) stepGame(state, { ...neutral, turn: 1, climb: 1 });
  assert.ok(bullet.velocity.equals(velocity), 'launched shot never tracks later steering');
  assert.equal(state.bullets.filter(item => item.kind === 'aa').length, 1);
  assert.equal(state.player.health, health, 'firing itself cannot directly deduct HP');
  state.player.position.set(5000, 250, 5000); ship.fireClock = 0;
  const shotsBefore = state.bullets.length; stepGame(state, neutral);
  assert.equal(state.bullets.length, shotsBefore, 'outside-range target causes no launch');
});

test('allied final ship kill is credited once even when the salvo has multiple rounds', () => {
  const state = quietState(), ship = state.ships[0]; ship.position.set(0, 0, 0); ship.previous.copy(ship.position); ship.health = 1;
  for (let i = 0; i < 2; i++) state.bullets.push(shot(state.allies[0].id, 'friendly', new Vector3(0, 8, 200), new Vector3(0, 0, -24000)));
  stepGame(state, neutral);
  assert.equal(state.endReason, 'all-clear'); assert.equal(state.stats.allyShipKills, 1); assert.equal(state.result?.allyShipKills, 1);
  assert.equal(state.events.filter(event => event.type === 'kill' && event.target === ship.id).length, 1);
});

test('friendly aircraft crossings are harmless while enemy contact ends the player flight', () => {
  const state = quietState(), ally = state.allies[0]; ally.health = 100; ally.position.copy(state.player.position); ally.previous.copy(ally.position);
  stepGame(state, neutral); assert.equal(state.player.health, 100); assert.equal(ally.health, 100); assert.equal(state.phase, 'playing');
  const enemy = state.enemies[0]; enemy.health = 100; enemy.position.copy(state.player.position); enemy.previous.copy(enemy.position);
  stepGame(state, neutral); assert.equal(state.endReason, 'collision'); assert.equal(state.player.health, 0);
});
