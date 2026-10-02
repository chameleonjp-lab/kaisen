import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { createGame, startGame, stepGame, pauseGame, resumeGame } from '../src/simulation';
import { FIXED_DT, PLAYER_MG_CAPACITY, PLAYER_CANNON_CAPACITY, PLAYER_RELOAD_TICKS, REINFORCEMENT_TICK, MAX_BULLETS } from '../src/mission';
import type { Bullet, GameState } from '../src/types';
const neutral = { turn: 0, climb: 0, fire: false, loop: false };
function isolated(): GameState {
  const state = createGame(91, 'normal');
  for (const x of [...state.allies, ...state.enemies, ...state.ships]) x.health = 0;
  state.ships[0].health = 1000;
  state.ships[0].position.set(20000, 0, -20000);
  state.ships[0].previous.copy(state.ships[0].position);
  state.player.position.set(1000, 500, 1000); state.player.previous.copy(state.player.position);
  startGame(state); return state;
}
function shot(owner: number, team: Bullet['team'], position: Vector3, velocity: Vector3): Bullet {
  return { id: 99999, owner, team, position, previous: position.clone(), velocity, life: 1, damage: 200, kind: 'cannon' };
}
function killable(state: GameState, generation: 'initial' | 'reinforcement', owner = state.player.id) {
  const enemy = state.enemies[0]; enemy.health = 1; enemy.generation = generation;
  enemy.position.set(0, 500, -60); enemy.previous.copy(enemy.position);
  state.bullets.push(shot(owner, 'friendly', new Vector3(0, 500, 0), new Vector3(0, 0, -12000)));
  return enemy;
}
test('emitted twin volleys exactly consume magazines and start one six-second reload', () => {
  const s = isolated();
  while (s.player.reloadTicksRemaining === 0 && s.tick < 800) stepGame(s, { ...neutral, fire: true });
  assert.equal(s.player.reloadTicksRemaining, PLAYER_RELOAD_TICKS);
  assert.equal(s.player.mg, 0); assert.equal(s.player.cannon, 0);
  assert.equal(s.stats.shots, PLAYER_MG_CAPACITY + PLAYER_CANNON_CAPACITY);
  assert.equal(s.events.filter(e => e.type === 'reload-start').length, 1);
  const end = s.tick + PLAYER_RELOAD_TICKS;
  for (let i = 0; i < PLAYER_RELOAD_TICKS - 1; i++) stepGame(s, { ...neutral, fire: true });
  assert.equal(s.player.reloadTicksRemaining, 1); assert.equal(s.stats.shots, 384);
  stepGame(s, neutral);
  assert.equal(s.tick, end); assert.equal(s.player.reloadTicksRemaining, 0);
  assert.equal(s.player.mg, PLAYER_MG_CAPACITY); assert.equal(s.player.cannon, PLAYER_CANNON_CAPACITY);
  assert.equal(s.events.filter(e => e.type === 'reload-complete').length, 1);
  stepGame(s, { ...neutral, fire: true }); assert.equal(s.stats.shots, 388);
});
test('reload freezes while paused, survives target loss, ends with mission and resets on retry', () => {
  const s = isolated(); s.player.mg = 2; s.player.cannon = 2;
  stepGame(s, { ...neutral, fire: true }); assert.equal(s.player.reloadTicksRemaining, 360);
  pauseGame(s); const before = JSON.stringify(s);
  for (let i = 0; i < 400; i++) stepGame(s, { ...neutral, fire: true });
  assert.equal(JSON.stringify(s), before);
  resumeGame(s); stepGame(s, neutral); assert.equal(s.player.reloadTicksRemaining, 359);
  s.player.health = 0; stepGame(s, neutral); const ended = JSON.stringify(s);
  stepGame(s, neutral, .25); assert.equal(JSON.stringify(s), ended);
  const retry = createGame(); assert.equal(retry.player.reloadTicksRemaining, 0); assert.equal(retry.player.mg, 288);
});
test('projectile saturation reserves complete twin volleys without losing ammunition', () => {
  const s = isolated();
  s.bullets = Array.from({ length: MAX_BULLETS - 1 }, (_, id) => ({ ...shot(888, 'friendly', new Vector3(8000, 900, 0), new Vector3()), id }));
  stepGame(s, { ...neutral, fire: true });
  assert.equal(s.stats.shots, 0); assert.equal(s.player.mg, 288); assert.equal(s.player.cannon, 96);
  assert.equal(s.player.reloadTicksRemaining, 0);
});
test('180 seconds spawns exactly three new enemies once and preserves surviving initial aircraft', () => {
  const s = isolated(); const initial = s.enemies[0]; initial.health = 57;
  initial.position.set(-10000, 500, 0); initial.previous.copy(initial.position);
  const ids = new Set(s.enemies.map(e => e.id));
  s.tick = REINFORCEMENT_TICK - 2; s.elapsed = s.tick * FIXED_DT;
  stepGame(s, neutral); assert.equal(s.reinforcementsSpawned, false); assert.equal(s.enemies.length, 5);
  pauseGame(s); stepGame(s, neutral, .25); assert.equal(s.tick, REINFORCEMENT_TICK - 1);
  resumeGame(s); stepGame(s, neutral);
  assert.equal(s.tick, REINFORCEMENT_TICK); assert.equal(s.reinforcementsSpawned, true);
  const added = s.enemies.filter(e => e.generation === 'reinforcement');
  assert.equal(added.length, 3); assert.equal(s.enemies.length, 8); assert.equal(initial.health, 57);
  assert.ok(added.every(e => !ids.has(e.id) && e.health === 100));
  assert.equal(new Set(s.enemies.map(e => e.id)).size, 8);
  assert.equal(s.events.filter(e => e.type === 'reinforcement').length, 1);
  for (let i = 0; i < 60; i++) stepGame(s, neutral);
  assert.equal(s.enemies.length, 8);
});
test('full clear before 180 wins immediately; wave on boundary must also be destroyed', () => {
  const early = isolated(); early.tick = REINFORCEMENT_TICK - 2; early.elapsed = early.tick * FIXED_DT;
  early.ships[0].health = 0; stepGame(early, neutral);
  assert.equal(early.result?.outcome, 'victory'); assert.equal(early.reinforcementsSpawned, false);
  stepGame(early, neutral); assert.equal(early.enemies.length, 5);
  const boundary = isolated(); boundary.tick = REINFORCEMENT_TICK - 1; boundary.elapsed = boundary.tick * FIXED_DT;
  boundary.ships[0].health = 0; stepGame(boundary, neutral);
  assert.equal(boundary.phase, 'playing'); assert.equal(boundary.enemies.filter(e => e.health > 0).length, 3);
  for (const e of boundary.enemies) e.health = 0; stepGame(boundary, neutral);
  assert.equal(boundary.result?.outcome, 'victory');
  assert.equal(createGame().reinforcementsSpawned, false);
});
test('only player reinforcement kills heal once, capped at max HP; no points are introduced', () => {
  for (const [generation, owner, hp, expected] of [['reinforcement', 1, 50, 65], ['reinforcement', 1, 95, 100], ['initial', 1, 50, 50], ['reinforcement', 2, 50, 50]] as const) {
    const s = isolated(); s.player.health = hp; killable(s, generation, owner);
    stepGame(s, neutral); assert.equal(s.player.health, expected);
    const events = s.events.filter(e => e.type === 'heal');
    assert.equal(events.length, expected > hp ? 1 : 0);
    if (events.length) assert.equal(events[0].amount, expected - hp);
    stepGame(s, neutral); assert.equal(s.player.health, expected);
    assert.equal('score' in s.stats, false);
  }
});
test('all damage resolves before healing so a same-tick lethal hit cannot be resurrected', () => {
  const s = isolated(); s.player.health = 1; const e = killable(s, 'reinforcement');
  s.bullets.push(shot(e.id, 'enemy', new Vector3(1000, 500, 1060), new Vector3(0, 0, -12000)));
  stepGame(s, neutral); assert.equal(s.player.health, 0); assert.equal(s.result?.outcome, 'defeat');
  assert.equal(s.events.filter(e => e.type === 'heal').length, 0);
});
test('naval rounds integrate gravity without homing toward later target positions', () => {
  const s = isolated(); const b = shot(100, 'enemy', new Vector3(4000, 800, 4000), new Vector3(500, 30, -100));
  b.kind = 'aa'; b.gravity = 9.80665; b.life = 4; s.bullets.push(b);
  for (let i = 0; i < 60; i++) stepGame(s, { ...neutral, turn: i % 2 ? 1 : -1 });
  assert.ok(Math.abs(b.position.y - (800 + 30 - 9.80665 / 2)) < 1e-9);
  assert.ok(Math.abs(b.velocity.y - (30 - 9.80665)) < 1e-9);
  assert.equal(b.velocity.x, 500); assert.equal(b.velocity.z, -100);
});
