import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGame, startGame, stepGame } from '../../src/simulation';
import type { FlightInput } from '../../src/types';
import { createBrowserMissionPilot } from '../../tests/helpers/mission-browser-pilot';
import { pointerOffsetForControls } from '../../tests/helpers/touch-reload-pilot';

test('Normal default fleet clears through manual fire and circular input with six/seven and coarse twelve tick hold', context => {
  for (const pattern of [[6], [6, 7], [12]]) {
    const state = createGame(undefined, 'normal'), pilot = createBrowserMissionPilot();
    startGame(state);
    let nextSample = 0, sample = 0, navalShots = 0;
    let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
    const reloads: { type: 'reload-start' | 'reload-complete'; tick: number }[] = [];
    for (let i = 0; i < 60 * 600 && state.phase === 'playing'; i++) {
      if (state.tick >= nextSample) {
        nextSample = state.tick + pattern[sample++ % pattern.length];
        const before = JSON.stringify(state), snapshot = JSON.parse(before);
        const requested = pilot(snapshot);
        assert.equal(JSON.stringify(snapshot), before, 'pilot must only observe its snapshot');
        assert.equal(JSON.stringify(state), before, 'pilot must not modify the live world');
        const { dx, dy } = pointerOffsetForControls(requested.turn, requested.climb);
        const distance = Math.hypot(dx, dy);
        assert.ok(distance <= 36 + 1e-9, 'legal circular pointer radius');
        const response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
        held = { ...requested, turn: distance ? dx / distance * response : 0,
          climb: distance ? -dy / distance * response : 0, viewAspect: 393 / 852 };
      }
      const previousShots = state.stats.shots;
      stepGame(state, held);
      assert.equal(state.mode, 'normal');
      if (!held.fire && !held.bomb && !held.torpedo) assert.equal(state.stats.shots, previousShots, 'Normal launches only on the corresponding manual action');
      for (const event of state.events) {
        if (event.type === 'reload-start' || event.type === 'reload-complete') reloads.push({ type: event.type, tick: state.tick });
        if (event.type === 'shot' && state.ships.some(ship => ship.id === event.owner)) navalShots++;
      }
    }
    context.diagnostic(JSON.stringify({pattern,time:state.elapsed,hp:state.player.health,reason:state.endReason,cause:state.deathCause,stats:state.stats}));
    assert.equal(state.config.shipCount, 4);
    assert.equal(state.endReason, 'all-clear', `hold pattern ${pattern}`);
    assert.equal(state.result?.outcome, 'victory');
    assert.ok(state.player.health > 0);
    assert.ok(state.enemies.every(target => target.health <= 0));
    assert.ok(state.ships.every(target => target.health <= 0));
    assert.ok(state.stats.playerAircraftKills > 0 && state.stats.playerShipKills > 0);
    assert.ok(state.stats.shots > 0 && navalShots > 0, 'real manual combat and naval retaliation');
    // Bombs now sink armored hulls. A legitimate early victory need not spend
    // an entire gun magazine; dedicated reload tests still require all 360 ticks.
    if (reloads[1]) assert.equal(reloads[1].tick - reloads[0].tick, 360, 'full fixed-tick six-second reload');
  }
});

const neutral = { turn: 0, climb: 0, fire: false, loop: false };

/** A reproducible pilot that only sends real FlightInput, never edits live state. */
function flyFeedbackMission(pattern = [6]) {
  const state = createGame(), pilot = createBrowserMissionPilot(); startGame(state);
  let next = 0, sample = 0, held = { ...neutral, steeringActive: true, viewAspect: 393 / 852 };
  for (let tick = 0; tick < 60 * 600 && state.phase === 'playing'; tick++) {
    if (state.tick >= next) {
      next = state.tick + pattern[sample++ % pattern.length];
      const request = pilot(state), { dx, dy } = pointerOffsetForControls(request.turn, request.climb);
      const distance = Math.hypot(dx, dy), response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
      assert.ok(distance <= 36 + 1e-9);
      held = { ...neutral, ...request, turn: distance ? dx / distance * response : 0, climb: distance ? -dy / distance * response : 0, steeringActive: true, viewAspect: 393 / 852 };
    }
    stepGame(state, held);
  }
  return state;
}

test('approved four-ship mission reaches all-clear through real inputs while idle is not a guaranteed win', context => {
  const active = flyFeedbackMission();
  context.diagnostic(JSON.stringify({ time: active.elapsed, hp: active.player.health, kills: active.stats }));
  assert.equal(active.endReason, 'all-clear'); assert.ok(active.player.health > 0);
  assert.equal(active.ships.length, 4); assert.ok(active.enemies.every(e => e.health <= 0));
  assert.equal(active.stats.playerShipKills + active.stats.allyShipKills, 4);
  assert.ok(active.stats.playerAircraftKills > 0 && active.stats.playerShipKills > 0);
  const idle = createGame(); startGame(idle);
  for(let tick=0; tick<60*240 && idle.phase==='playing'; tick++)stepGame(idle,neutral);
  assert.notEqual(idle.result?.outcome,'victory');
  assert.notEqual(idle.endReason,'all-clear');
  const liveObjectives = idle.ships.filter(ship=>ship.health>0).length;
  assert.ok(liveObjectives > 0,'idle must leave an uncleared mission objective during this acceptance window');
  context.diagnostic(`idle after 240 seconds: phase=${idle.phase}, health=${idle.player.health}, liveObjectives=${liveObjectives}`);
});

test('standard mission remains reachable through circular touch conversion with six/seven tick sample jitter', context => {
  const state = flyFeedbackMission([6,7]);
  context.diagnostic(JSON.stringify({time:state.elapsed,hp:state.player.health,kills:state.stats}));
  assert.equal(state.endReason,'all-clear');assert.ok(state.player.health>0);
  assert.equal(state.stats.playerShipKills+state.stats.allyShipKills,4);
  assert.ok(state.enemies.every(e=>e.health<=0));
});
