import { createFeedbackEasyPilot } from './helpers/feedback-easy-pilot';
import { pointerOffsetForControls } from './helpers/touch-reload-pilot';
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
function flyFeedbackMission(pattern = [6]) {
  const state = createGame(), pilot = createFeedbackEasyPilot(); startGame(state);
  let next = 0, sample = 0, held = { ...neutral, viewAspect: 393 / 852 };
  for (let tick = 0; tick < 60 * 600 && state.phase === 'playing'; tick++) {
    if (state.tick >= next) {
      next = state.tick + pattern[sample++ % pattern.length];
      const request = pilot(state), { dx, dy } = pointerOffsetForControls(request.turn, request.climb);
      const distance = Math.hypot(dx, dy), response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
      assert.ok(distance <= 36 + 1e-9);
      held = { ...neutral, turn: distance ? dx / distance * response : 0, climb: distance ? -dy / distance * response : 0, viewAspect: 393 / 852 };
    }
    stepGame(state, held);
  }
  return state;
}

// Imported here to make the pilot's production flight-math dependency explicit.
import { desiredFlightInput, forwardOf } from '../src/flight';

test('approved four-ship mission reaches all-clear through real inputs while idle is not a guaranteed win', context => {
  const active = flyFeedbackMission();
  context.diagnostic(JSON.stringify({ time: active.elapsed, hp: active.player.health, kills: active.stats }));
  assert.equal(active.endReason, 'all-clear'); assert.ok(active.player.health > 0);
  assert.equal(active.ships.length, 4); assert.ok(active.enemies.every(e => e.health <= 0));
  assert.equal(active.stats.playerShipKills + active.stats.allyShipKills, 4);
  assert.ok(active.stats.playerAircraftKills > 0 && active.stats.playerShipKills > 0);
  const idle = createGame(); startGame(idle);
  for(let tick=0; tick<60*240 && idle.phase==='playing'; tick++)stepGame(idle,neutral);
  assert.equal(idle.result?.outcome,'defeat');
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

test('standard mission remains reachable through circular touch conversion with six/seven tick sample jitter', context => {
  const state = flyFeedbackMission([6,7]);
  context.diagnostic(JSON.stringify({time:state.elapsed,hp:state.player.health,kills:state.stats}));
  assert.equal(state.endReason,'all-clear');assert.ok(state.player.health>0);
  assert.equal(state.stats.playerShipKills+state.stats.allyShipKills,4);
  assert.ok(state.enemies.every(e=>e.health<=0));
});

test('large-fleet tactical replay is identical across the complete authoritative state', () => {
  const first = flyLargeFleetMission(7), second = flyLargeFleetMission(7);
  // Seven ships remain an internal stress fixture; standard four-ship completion is tested above.
  assert.ok(first.state.phase === 'ended' || first.state.tick === 60 * 240);
  assert.equal(JSON.stringify(first.state), JSON.stringify(second.state));
});
