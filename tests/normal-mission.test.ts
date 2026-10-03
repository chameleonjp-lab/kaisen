import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { FlightInput } from '../src/types';
import { createNormalMissionPilot } from './helpers/normal-mission-pilot';
import { pointerOffsetForControls } from './helpers/touch-reload-pilot';

test('Normal default fleet clears through manual fire and circular input with six/seven and coarse twelve tick hold', context => {
  for (const pattern of [[6], [6, 7], [12]]) {
    const state = createGame(undefined, 'normal'), pilot = createNormalMissionPilot();
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
      if (!held.fire) assert.equal(state.stats.shots, previousShots, 'Normal only shoots on manual fire');
      for (const event of state.events) {
        if (event.type === 'reload-start' || event.type === 'reload-complete') reloads.push({ type: event.type, tick: state.tick });
        if (event.type === 'shot' && state.ships.some(ship => ship.id === event.owner)) navalShots++;
      }
    }
    context.diagnostic(JSON.stringify({pattern,time:state.elapsed,hp:state.player.health,reason:state.endReason,stats:state.stats}));
    assert.equal(state.config.shipCount, 4);
    assert.equal(state.endReason, 'all-clear', `hold pattern ${pattern}`);
    assert.equal(state.result?.outcome, 'victory');
    assert.ok(state.player.health > 0);
    assert.ok(state.enemies.every(target => target.health <= 0));
    assert.ok(state.ships.every(target => target.health <= 0));
    assert.ok(state.stats.playerAircraftKills > 0 && state.stats.playerShipKills > 0);
    assert.ok(state.stats.shots > 384 && navalShots > 0, 'real manual combat and naval retaliation');
    assert.equal(reloads[0]?.type, 'reload-start');
    assert.equal(reloads[1]?.type, 'reload-complete');
    assert.equal(reloads[1].tick - reloads[0].tick, 360, 'full fixed-tick six-second reload');
  }
});
