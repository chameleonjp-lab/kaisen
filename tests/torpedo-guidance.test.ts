import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { FIXED_DT, makeAircraft, makeFleet } from '../src/mission';
import { NAVAL_GRAVITY } from '../src/naval';
import { oceanHeight } from '../src/ocean';
import { checkGuidedTorpedoRelease, ORDNANCE_TUNING, releaseTorpedo, stepOrdnance } from '../src/ordnance';
import { advanceShipMotion } from '../src/ship-motion';
import { torpedoReleaseCue } from '../src/mission-hud';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';
import type { Ship } from '../src/types';

const neutral = { turn: 0, climb: 0, fire: false, loop: false };
const close = (a: number, b: number, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} versus ${b}`);
const aircraft = () => makeAircraft(1, 'friendly', new Vector3(0, 50, 0), 0, 'player');
function place(ship: Ship, x: number, z: number, speed = 0, yaw = 0): Ship {
  ship.position.set(x, 0, z); ship.previous.copy(ship.position); ship.yaw = yaw;
  ship.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), yaw); ship.previousQuaternion.copy(ship.quaternion);
  ship.velocity.set(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed); ship.age = 0;
  ship.guns.forEach(gun => { gun.health = 0; gun.cooldown = 1000; });
  return ship;
}
function ship(x: number, z: number, id = 100, speed = 0, yaw = 0): Ship {
  const result = makeFleet(4)[0]; result.id = id; return place(result, x, z, speed, yaw);
}
function quiet() {
  const state = createGame(123, 'normal');
  state.allies.forEach(plane => { plane.health = 0; });
  state.enemies.forEach((plane, index) => {
    plane.health = index === 0 ? plane.maxHealth : 0;
    plane.position.set(30000, 5000, 30000); plane.previous.copy(plane.position);
  });
  state.ships.forEach(item => { item.health = 0; });
  state.player.position.set(0, 50, 0); state.player.previous.copy(state.player.position);
  state.player.quaternion.identity(); state.player.pitch = state.player.bank = state.player.yaw = 0;
  startGame(state); return state;
}

test('shared guided release retains inclusive rack boundaries and imposes no extra bearing cone', () => {
  for (const altitude of [15, 90]) {
    const source = aircraft(); source.speed = 125; source.position.y = altitude + 1.2;
    const result = checkGuidedTorpedoRelease(source, [ship(700, -700)], 0);
    assert.equal(result.allowed, true); assert.equal(result.targetShipId, 100); close(result.altitude, altitude);
  }
  const source = aircraft(), behind = ship(0, 600);
  assert.equal(checkGuidedTorpedoRelease(source, [behind], 0).targetShipId, behind.id, 'a reachable rear bearing remains valid');
});

test('guided target order is forward bearing, then distance, then stable ID, and ignores dead ships', () => {
  const source = aircraft(), dead = ship(0, -700, 1); dead.health = 0;
  const ahead = ship(0, -1100, 40), closerSide = ship(500, -500, 2);
  assert.equal(checkGuidedTorpedoRelease(source, [dead, closerSide, ahead], 0).targetShipId, ahead.id);
  const nearer = ship(0, -900, 50);
  assert.equal(checkGuidedTorpedoRelease(source, [ahead, nearer], 0).targetShipId, nearer.id);
  const lowId = ship(0, -1100, 7);
  for (const order of [[ahead, lowId], [lowId, ahead]])
    assert.equal(checkGuidedTorpedoRelease(source, order, 0).targetShipId, lowId.id);
});

test('the lifetime boundary deducts the air leg and never credits its flight distance to water range', () => {
  const source = aircraft(), rackY = source.position.y - 1.2;
  // The launch tick advances payloads at elapsed-FIXED_DT after the aircraft/ships have moved.
  // Independent ballistic/wave root, rather than an expected value copied from the launch checker.
  let low = 0, high = 10;
  for (let i = 0; i < 60; i++) {
    const time = (low + high) / 2;
    const clearance = rackY - .5 * NAVAL_GRAVITY * time ** 2 - oceanHeight(0, -source.speed * time, time - FIXED_DT);
    if (clearance > 0) low = time; else high = time;
  }
  const splashZ = -source.speed * high, waterBudget = 24 * (70 - high);
  assert.equal(checkGuidedTorpedoRelease(source, [ship(0, splashZ - waterBudget + .001)], 0).allowed, true);
  assert.equal(checkGuidedTorpedoRelease(source, [ship(0, splashZ - waterBudget - .001)], 0).reason, 'out-of-range');
  assert.equal(checkGuidedTorpedoRelease(source, [ship(0, -2000)], 0).reason, 'out-of-range');
  assert.equal(ORDNANCE_TUNING.torpedo.life, 70); assert.equal(ORDNANCE_TUNING.torpedo.waterSpeed, 24);
});

test('arming eligibility measures first hull contact rather than a centre farther than 80m', () => {
  const source = aircraft(); source.position.y = 16.2;
  // Splash is about z=-192. A centre 200m ahead has a 135m half-hull, so contact is under 80m.
  assert.equal(checkGuidedTorpedoRelease(source, [ship(0, -390)], 0).reason, 'out-of-range');
  assert.equal(checkGuidedTorpedoRelease(source, [ship(0, -450)], 0).allowed, true);
});

test('launch-tick wave and moving-hull frames reject the observed 79.9936m contact and permit the armed neighbor', () => {
  // Before the forecast used the real launch frame, 414.578m was accepted but actually dudded at 79.9936m.
  for (const [distance, accepted] of [[414.5780081285536, false], [414.66800812855365, true]] as const) {
    const state = quiet(), target = state.ships[0]; target.health = target.maxHealth;
    place(target, 0, -distance); state.player.position.y = 16.2;
    stepGame(state, { ...neutral, torpedo: true });
    assert.equal(state.player.torpedoes, accepted ? 0 : 1);
    if (!accepted) {
      assert.equal(state.player.torpedoReloadTicks, 0); assert.equal(state.player.payloadCooldown, 0);
      assert.equal(state.events.find(event => event.type === 'payload-rejected')?.detail, 'out-of-range');
      continue;
    }
    const round = state.ordnance[0]; assert.ok(round);
    let impact = false;
    for (let tick = 1; tick < 1000 && round.life > 0; tick++) {
      advanceShipMotion(target, (tick + 1) * FIXED_DT, FIXED_DT);
      const result = stepOrdnance(round, [target], tick * FIXED_DT, FIXED_DT);
      assert.equal(result.outcomes.some(outcome => outcome.type === 'dud'), false);
      impact ||= result.outcomes.some(outcome => outcome.type === 'impact');
    }
    assert.equal(impact, true); assert.ok(round.waterDistance >= 80);
    close(round.waterDistance, 80.08357867173657, 1e-7);
  }
});

test('no target, range and unsafe-entry refusals share HUD reasons and consume no round, reload or cooldown', () => {
  for (const [reason, short] of [['no-target', '標的なし'], ['out-of-range', '射程外'], ['unsafe-entry', '投下不可']] as const) {
    const state = quiet();
    if (reason !== 'no-target') {
      state.ships[0].health = state.ships[0].maxHealth;
      place(state.ships[0], 0, reason === 'out-of-range' ? -10000 : -200);
    }
    if (reason === 'unsafe-entry') state.player.position.y = 25;
    const before = JSON.stringify(state);
    assert.equal(checkGuidedTorpedoRelease(state.player, state.ships, state.elapsed).reason, reason);
    assert.equal(torpedoReleaseCue(state).short, short); assert.equal(JSON.stringify(state), before);
    stepGame(state, { ...neutral, torpedo: true });
    assert.equal(state.events.find(event => event.type === 'payload-rejected')?.detail, reason);
    assert.equal(state.player.torpedoes, 1); assert.equal(state.player.torpedoReloadTicks, 0);
    assert.equal(state.player.payloadCooldown, 0); assert.equal(state.ordnance.length, 0); assert.equal(state.stats.shots, 0);
  }
});

test('a released guided torpedo collides with the moving hull and credits damage, contribution and kill only once', () => {
  const state = quiet(), target = state.ships[0]; target.health = 2000;
  place(target, 400, -700, 6, Math.PI / 2);
  const start = target.position.clone();
  assert.equal(torpedoReleaseCue(state).ready, true);
  stepGame(state, { ...neutral, torpedo: true });
  const round = state.ordnance[0]; assert.ok(round); assert.equal(round.targetShipId, target.id);
  assert.equal(round.phase, 'air'); assert.equal(target.health, 2000, 'release does not apply damage');
  const impacts = [];
  for (let tick = 0; tick < 30 * 60 && target.health > 0; tick++) {
    const health = target.health; stepGame(state, neutral);
    const events = state.events.filter(event => event.type === 'ordnance-impact'); impacts.push(...events);
    if (target.health < health) assert.equal(events.length, 1, 'damage follows the real impact event');
  }
  assert.equal(target.health, 0); assert.equal(impacts.length, 1); assert.equal(impacts[0].amount, 2000);
  assert.equal(impacts[0].target, target.id); assert.ok(target.position.distanceTo(start) > 30);
  assert.ok(impacts[0].position.distanceTo(target.position) < 150, 'impact occurs at the moving hull');
  assert.ok(round.waterDistance >= 80); assert.equal(round.life, 0); assert.equal(state.ordnance.length, 0);
  assert.equal(state.stats.hits, 1); assert.equal(state.stats.playerShipKills, 1);
  close(state.stats.score, 1000); assert.equal(state.scoring.targets.find(item => item.id === target.id)?.playerDamage, 2000);
  for (let tick = 0; tick < 120; tick++) stepGame(state, neutral);
  assert.equal(state.stats.hits, 1); assert.equal(state.stats.playerShipKills, 1); close(state.stats.score, 1000);
  assert.deepEqual(stepOrdnance(round, [target], state.elapsed, FIXED_DT).outcomes, []);
});

test('air flight preserves launch heading; later aircraft steering cannot change water guidance or fixed ID', () => {
  const source = aircraft(), target = ship(400, -700, 100, 6, Math.PI / 2);
  const selection = checkGuidedTorpedoRelease(source, [target], 0);
  const first = releaseTorpedo(1, source, 0, selection.targetShipId!)!, second = releaseTorpedo(2, source, 0, selection.targetShipId!)!;
  source.position.set(10000, 5000, -10000); source.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2));
  source.speed = 125; source.pitch = .2; source.bank = .3;
  for (let tick = 0; tick < 8 * 60; tick++) {
    advanceShipMotion(target, (tick + 1) * FIXED_DT, FIXED_DT);
    const air = first.phase === 'air';
    stepOrdnance(first, [target], tick * FIXED_DT, FIXED_DT); stepOrdnance(second, [target], tick * FIXED_DT, FIXED_DT);
    if (air && first.phase === 'air') close(first.position.x, 0);
    assert.deepEqual(first.position, second.position); assert.deepEqual(first.velocity, second.velocity);
    assert.equal(first.targetShipId, target.id); assert.equal(second.targetShipId, target.id);
  }
  assert.equal(first.phase, 'water'); assert.ok(first.velocity.x > 0); close(Math.hypot(first.velocity.x, first.velocity.z), 24);
});

test('dead or missing targets permanently preserve final heading and never capture another ship', () => {
  for (const missing of [false, true]) {
    const source = aircraft(), target = ship(700, -900), other = ship(-600, -900, 101);
    const round = releaseTorpedo(1, source, 0, target.id)!;
    for (let tick = 0; tick < 5 * 60; tick++) {
      advanceShipMotion(target, (tick + 1) * FIXED_DT, FIXED_DT);
      stepOrdnance(round, [target], tick * FIXED_DT, FIXED_DT);
    }
    assert.equal(round.phase, 'water'); const heading = new Vector3(round.velocity.x, 0, round.velocity.z);
    target.health = 0;
    stepOrdnance(round, missing ? [other] : [target, other], 5, FIXED_DT);
    assert.equal(round.guidanceLost, true); assert.equal(round.targetShipId, target.id);
    close(round.velocity.x, heading.x); close(round.velocity.z, heading.z);
    target.health = 4000; target.position.x = -700; target.previous.copy(target.position);
    stepOrdnance(round, [target, other], 5 + FIXED_DT, FIXED_DT);
    close(round.velocity.x, heading.x); close(round.velocity.z, heading.z);
  }
});

test('guided release remains one edge with 360-tick reload and frozen flight/lifetime during pause', () => {
  const state = quiet(), target = state.ships[0]; target.health = target.maxHealth;
  place(target, 800, -700);
  stepGame(state, { ...neutral, torpedo: true });
  const round = state.ordnance[0]; assert.ok(round); assert.equal(state.player.torpedoReloadTicks, 360);
  for (let tick = 0; tick < 3; tick++) stepGame(state, { ...neutral, torpedo: true });
  assert.equal(state.stats.shots, 1); assert.equal(state.player.torpedoes, 0);
  pauseGame(state); const frozen = JSON.stringify(state); stepGame(state, neutral, .25);
  assert.equal(JSON.stringify(state), frozen); resumeGame(state);
  for (let tick = 0; tick < 356; tick++) stepGame(state, neutral);
  assert.equal(state.player.torpedoes, 0); assert.equal(state.player.torpedoReloadTicks, 1);
  stepGame(state, neutral); assert.equal(state.player.torpedoes, 1); assert.equal(state.player.torpedoReloadTicks, 0);
  assert.equal(state.events.filter(event => event.type === 'payload-reload' && event.weapon === 'torpedo').length, 1);
  assert.equal(torpedoReleaseCue(state).ready, true); assert.equal(round.targetShipId, target.id);
});
