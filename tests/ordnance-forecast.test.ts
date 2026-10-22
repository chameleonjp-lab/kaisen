import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame } from '../src/simulation';
import { releaseBomb, releaseTorpedo, stepOrdnance, createOrdnanceStepper } from '../src/ordnance';
import { advanceShipMotion } from '../src/ship-motion';
import { isShipObstacle, beginShipWreck } from '../src/ship-wreck';
import { FIXED_DT } from '../src/mission';

test('reused forecast geometry matches real fixed-step collisions for bombs, torpedoes and wrecks', () => {
  for (const kind of ['bomb', 'torpedo'] as const) for (const wreck of [false, true]) {
    const state = createGame(73, 'normal');
    state.player.position.set(10, kind === 'bomb' ? 201.2 : 50, 700);
    state.ships[0].position.set(0, 0, 0); state.ships[0].previous.copy(state.ships[0].position);
    if (wreck) { state.ships[0].health = 0; beginShipWreck(state.ships[0], 0); }
    const ships = state.ships.map(ship => Object.assign(ship, { collisionActive: isShipObstacle(ship, 0) }));
    const actual = (kind === 'bomb' ? releaseBomb(1, state.player) : releaseTorpedo(1, state.player, 0, state.ships[0].id))!;
    const forecast = { ...actual, position: actual.position.clone(), previous: actual.previous.clone(), velocity: actual.velocity.clone() };
    const advanceForecast = createOrdnanceStepper(ships);
    for (let tick = 0; tick < 1800; tick++) {
      const time = tick * FIXED_DT;
      for (const ship of ships) { advanceShipMotion(ship, time + FIXED_DT, FIXED_DT); ship.collisionActive = isShipObstacle(ship, time + FIXED_DT); }
      const expected = stepOrdnance(actual, ships, time, FIXED_DT), observed = advanceForecast(forecast, time, FIXED_DT);
      assert.deepEqual(observed, expected, `${kind} wreck=${wreck} tick=${tick}`);
      assert.deepEqual(forecast, actual);
      if (!expected.active) break;
    }
  }
});
