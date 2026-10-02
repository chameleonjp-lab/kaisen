import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignTargets, updateAI } from '../src/ai';
import { createGame, startGame, stepGame } from '../src/simulation';
import { FIXED_DT, MAX_BULLETS } from '../src/mission';
import { autoFireTarget, getFlightAssist, predictedShotDirection, targetAimPoint } from '../src/flight-assist';
import { projectFlightTarget } from '../src/flight-view';
import { updateQuaternion } from '../src/flight';
import { Vector3 } from 'three';
import { flyLargeFleetMission } from './helpers/large-fleet-pilot';

const neutral = { turn: 0, climb: 0, fire: false, loop: false };

test('role assignments spread targets and stay stable until the assigned unit is destroyed', () => {
  const state = createGame(55); const ids = state.allies.map(item => item.targetId);
  assert.ok(ids.slice(0, 2).every(id => state.enemies.some(item => item.id === id)));
  assert.ok(ids.slice(2).every(id => state.ships.some(item => item.id === id)));
  assert.equal(new Set(ids).size, 4);
  state.enemies.reverse(); state.ships.reverse(); assignTargets(state);
  assert.deepEqual(state.allies.map(item => item.targetId), ids);
  const first = state.enemies.find(item => item.id === ids[0])!; first.health = 0; assignTargets(state);
  assert.notEqual(state.allies[0].targetId, first.id); assert.equal(state.allies[1].targetId, ids[1]);
});

test('damaged AI extends and re-enters rather than fleeing permanently; ships remain valid after all aircraft die', () => {
  const state = createGame(55); const plane = state.allies[0]; plane.health = 10;
  for (const enemy of state.enemies) enemy.health = 0;
  assignTargets(state); const target = state.ships.find(item => item.id === plane.targetId)!;
  assert.ok(target);
  plane.position.copy(target.position); plane.position.y = 65;
  updateAI(state, plane, FIXED_DT); assert.equal(plane.aiPhase, 'extend'); assert.equal(plane.aiFire, false);
  plane.position.y = 230; plane.position.z += 600;
  for (let i = 0; i < 310; i++) { state.tick++; updateAI(state, plane, FIXED_DT); }
  assert.notEqual(plane.aiPhase, 'extend'); assert.notEqual(plane.mode, 'flee');
});

test('air and surface targets use the actual shared projection/fire gate', () => {
  const state = createGame(21); const ship = state.ships[0];
  state.player.position.set(0, 350, 240); ship.position.set(0, 350, -300);
  assert.equal(autoFireTarget(state.player, [ship], 'easy', 393 / 852)?.id, ship.id);
  ship.position.x = 1000; assert.equal(autoFireTarget(state.player, [ship], 'easy', 393 / 852), null);
  ship.position.set(0, 350, -1300); assert.equal(autoFireTarget(state.player, [ship], 'easy', 393 / 852), null);
});

test('deterministic bounded fleet simulations include actual AI and real projectiles', () => {
  for (const shipCount of [3, 5, 7] as const) {
    const a = createGame(2026, { shipCount }), b = createGame(2026, { shipCount }); startGame(a); startGame(b);
    for (let i = 0; i < 60 * 40; i++) {
      const input = { ...neutral, turn: Math.sin(i / 180) * .6, climb: .10, loop: i === 500 };
      stepGame(a, input); stepGame(b, input);
      assert.ok(a.bullets.length <= MAX_BULLETS);
      for (const aircraft of [a.player, ...a.allies, ...a.enemies]) assert.ok([aircraft.speed, aircraft.pitch, aircraft.yaw, ...aircraft.position.toArray()].every(Number.isFinite));
    }
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(a.enemies.length, 5); assert.equal(a.allies.length, 4); assert.equal(a.ships.length, shipCount);
  }
});

/** A reproducible pilot that only sends real FlightInput, never edits live state. */
function flyMission(shipCount: 3 | 5 | 7) {
  const state = createGame(undefined, { shipCount }); startGame(state);
  let targetId: number | null = null, extensionTicks = 0, attackingShip = false;
  let waypoint = state.player.position.clone();
  for (let i = 0; i < 60 * 240 && state.phase === 'playing'; i++) {
    const targets = [...state.enemies, ...state.ships].filter(item => item.health > 0);
    const target = targets.find(item => item.id === targetId) ?? targets.sort((a, b) => state.player.position.distanceTo(a.position) - state.player.position.distanceTo(b.position))[0];
    if (!target) break;
    if (targetId !== target.id) attackingShip = false;
    targetId = target.id;
    let aim = target.position.clone(); const distance = state.player.position.distanceTo(aim);
    const heading = forwardOf(state.player); heading.y = 0;
    const horizontal = aim.clone().sub(state.player.position); horizontal.y = 0;
    const tooCloseToLineUp = target.kind === 'ship' && !attackingShip && distance < 360 && heading.angleTo(horizontal) > .25;
    if (extensionTicks <= 0 && (tooCloseToLineUp || state.player.position.y < 90 || distance < (target.kind === 'ship' ? 210 : 70))) {
      extensionTicks = 360; attackingShip = false;
      waypoint = state.player.position.clone().addScaledVector(forwardOf(state.player), 740);
      waypoint.y = Math.max(250, state.player.position.y + 100);
    }
    if (extensionTicks > 0) { extensionTicks--; aim = waypoint; }
    else if (target.kind === 'ship') {
      const heading = forwardOf(state.player); heading.y = 0;
      const horizontal = aim.clone().sub(state.player.position); horizontal.y = 0;
      if (heading.angleTo(horizontal) < .25 && distance > 330) attackingShip = true;
      aim.y = attackingShip ? targetAimPoint(target).y : 250;
    }
    const controls = desiredFlightInput(state.player, aim);
    stepGame(state, { ...neutral, turn: controls.turn, climb: controls.climb * .62 / .95 });
  }
  return state;
}

// Imported here to make the pilot's production flight-math dependency explicit.
import { desiredFlightInput, forwardOf } from '../src/flight';

test('complete input-only missions reach all-clear for every fleet size, while idle is not a guaranteed win', context => {
  for (const shipCount of [3, 5, 7] as const) {
    // Larger internal fleets need a fore/aft attack plan against the new real mount arcs.
    // The default mission retains its original nearest-target route below and the touch test.
    const tactical = shipCount === 3 ? null : flyLargeFleetMission(shipCount);
    const active = tactical?.state ?? flyMission(shipCount);
    if (tactical) {
      const [start, completed] = tactical.diagnostics.reloads;
      assert.equal(start.type, 'reload-start'); assert.equal(completed.type, 'reload-complete');
      assert.equal(completed.tick - start.tick, 360);
      assert.equal(start.mg + start.cannon, 0); assert.equal(completed.mg + completed.cannon, 384);
      assert.ok(tactical.diagnostics.minAltitude > 100);
    }
    context.diagnostic(JSON.stringify({ shipCount, reason: active.endReason, time: active.elapsed, hp: active.player.health, kills: active.stats, survivors: active.ships.map(s => s.health) }));
    assert.equal(active.endReason, 'all-clear', `${shipCount}-ship real-input route`);
    assert.ok(active.player.health > 0);
    assert.equal(active.stats.playerAircraftKills + active.stats.allyAircraftKills, active.enemies.length);
    assert.equal(active.stats.playerShipKills + active.stats.allyShipKills, shipCount);
    assert.ok(active.stats.playerAircraftKills + active.stats.playerShipKills > 0);
    const idle = createGame(undefined, { shipCount }); startGame(idle);
    for (let i = 0; i < 60 * 240 && idle.phase === 'playing'; i++) stepGame(idle, neutral);
    assert.equal(idle.result?.outcome, 'defeat');
    assert.ok(idle.enemies.some(item => item.health > 0) || idle.ships.some(item => item.health > 0));
  }
});


test('surface marker, steering and auto-fire share the above-water point at the circle edge', () => {
  const state = createGame(21), player = state.player, ship = state.ships[0];
  player.position.set(0, 150, 0); player.pitch = -.276; updateQuaternion(player);
  ship.position.set(0, 0, -400); ship.velocity.set(0, 0, 0);
  const aspect = 393 / 852, point = targetAimPoint(ship);
  assert.equal(point.y, ship.height * .4);
  assert.equal(projectFlightTarget(player, ship.position, aspect, 'easy').inCircle, false, 'sea-level base reproduces old mismatch');
  assert.equal(projectFlightTarget(player, point, aspect, 'easy').inCircle, true);
  assert.equal(autoFireTarget(player, [ship], 'easy', aspect), ship);
  const assist = getFlightAssist(player, [ship], { ...neutral, viewAspect: aspect }, 'easy');
  assert.equal(assist.hasVisibleTarget, true); assert.equal(assist.turn, 0); assert.equal(assist.climb, 0, 'point inside circle needs no steering pull');
  const forward = forwardOf(player);
  const predicted = predictedShotDirection(player.position, forward, ship, 930, 1.5);
  assert.ok(predicted.distanceTo(point.clone().sub(player.position).normalize()) < 1e-12);
  // Shift just outside the shared circle: every aspect uses the same point and gate.
  for (const viewAspect of [393 / 852, 1, 852 / 393]) for (const pitch of [-.34, -.276, -.20]) {
    player.pitch = pitch; updateQuaternion(player);
    const projected = projectFlightTarget(player, targetAimPoint(ship), viewAspect, 'easy');
    assert.equal(autoFireTarget(player, [ship], 'easy', viewAspect) !== null, projected.inCircle);
  }
  const original = player.position.clone(), aircraftPoint = targetAimPoint(player);
  assert.deepEqual(aircraftPoint, original); aircraftPoint.add(new Vector3(1, 2, 3));
  assert.deepEqual(player.position, original, 'shared point is never an alias to mutable authoritative position');
});


test('a nearby ship acquired behind a strike aircraft triggers repositioning instead of a staging orbit', () => {
  const state = createGame(21), plane = state.allies[2], ship = state.ships[0];
  plane.targetId = ship.id; plane.aiPhase = 'approach'; plane.aiPhaseTime = 1;
  plane.position.copy(ship.position).add(new Vector3(0, 230, -120)); plane.yaw = 0; updateQuaternion(plane);
  updateAI(state, plane, FIXED_DT);
  assert.equal(plane.aiPhase, 'extend'); assert.equal(plane.aiFire, false);
  assert.ok(plane.aiWaypoint.distanceTo(plane.position) > 400, 'creates enough space for another straight attack run');
});

/** Source input.ts radial conversion, exercised with a physical 36 CSS-pixel stick. */
function sourceStickInput(dx: number, dy: number) {
  const distance = Math.hypot(dx, dy);
  const magnitude = Math.min(distance / 36, 1);
  const response = magnitude <= .08 ? 0 : (magnitude - .08) / .92;
  return { turn: distance === 0 ? 0 : dx / distance * response, climb: distance === 0 ? 0 : -dy / distance * response };
}

test('default mission clears with unit-circle source touch conversion and 10 Hz sample-and-hold', context => {
  const state = createGame(); startGame(state);
  let targetId: number | null = null, extendUntilTick = 0, attackingShip = false;
  let waypoint = state.player.position.clone();
  let heldInput = { ...neutral, viewAspect: 393 / 852 };
  let samples = 0, maxCommandMagnitude = 0;
  // Only the real simulation below changes state. The pilot reads it and sends input.
  for (let i = 0; i < 60 * 240 && state.phase === 'playing'; i++) {
    if (i % 6 === 0) {
      const targets = [...state.enemies, ...state.ships].filter(item => item.health > 0);
      const target = targets.find(item => item.id === targetId) ?? targets.sort((a, b) => state.player.position.distanceTo(a.position) - state.player.position.distanceTo(b.position))[0];
      assert.ok(target);
      if (targetId !== target.id) attackingShip = false;
      targetId = target.id;
      let aim = target.position.clone(); const distance = state.player.position.distanceTo(aim);
      const heading = forwardOf(state.player); heading.y = 0;
      const horizontal = aim.clone().sub(state.player.position); horizontal.y = 0;
      const angle = heading.angleTo(horizontal);
      const tooCloseToLineUp = target.kind === 'ship' && !attackingShip && distance < 360 && angle > .25;
      if (state.tick >= extendUntilTick && (tooCloseToLineUp || state.player.position.y < 90 || distance < (target.kind === 'ship' ? 210 : 70))) {
        extendUntilTick = state.tick + 360; attackingShip = false;
        waypoint = state.player.position.clone().addScaledVector(forwardOf(state.player), 740);
        waypoint.y = Math.max(250, state.player.position.y + 100);
      }
      if (state.tick < extendUntilTick) aim = waypoint;
      else if (target.kind === 'ship') {
        if (angle < .25 && distance > 330) attackingShip = true;
        aim.y = attackingShip ? targetAimPoint(target).y : 250;
      }
      const requested = desiredFlightInput(state.player, aim);
      let x = requested.turn, y = requested.climb * .62 / .95;
      const commandMagnitude = Math.hypot(x, y);
      if (commandMagnitude > 1) { x /= commandMagnitude; y /= commandMagnitude; }
      const dx = 36 * x, dy = -36 * y;
      assert.ok(Math.hypot(dx, dy) <= 36 + 1e-12, 'physical stick stays inside its circular radius');
      const stick = sourceStickInput(dx, dy);
      const magnitude = Math.hypot(stick.turn, stick.climb);
      assert.ok(magnitude <= 1 + 1e-12, 'real touch cannot request independent full-strength axes');
      maxCommandMagnitude = Math.max(maxCommandMagnitude, magnitude);
      heldInput = { ...neutral, ...stick, viewAspect: 393 / 852 }; samples++;
    }
    stepGame(state, heldInput);
  }
  context.diagnostic(JSON.stringify({ reason: state.endReason, time: state.elapsed, hp: state.player.health, kills: state.stats, survivors: state.ships.map(s => s.health) }));
  assert.equal(state.endReason, 'all-clear'); assert.ok(state.player.health > 0);
  assert.equal(state.stats.playerAircraftKills + state.stats.allyAircraftKills, state.enemies.length);
  assert.equal(state.stats.playerShipKills + state.stats.allyShipKills, 3);
  assert.ok(state.stats.playerAircraftKills + state.stats.playerShipKills > 0);
  context.diagnostic(JSON.stringify({ touchSampleHz: 10, radiusCssPx: 36, deadzone: .08, time: state.elapsed, health: state.player.health, samples, maxCommandMagnitude, kills: state.stats }));
});


test('large-fleet tactical replay is identical across the complete authoritative state', () => {
  const first = flyLargeFleetMission(7), second = flyLargeFleetMission(7);
  assert.equal(first.state.endReason, 'all-clear');
  assert.equal(JSON.stringify(first.state), JSON.stringify(second.state));
});
