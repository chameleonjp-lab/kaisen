import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
import { updateQuaternion } from '../src/flight';
import { createBrowserMissionPilot } from './helpers/mission-browser-pilot';
import { pointerOffsetForControls } from './helpers/touch-reload-pilot';
import type { FlightInput } from '../src/types';

test('held-stick ship pilot descends toward its staging altitude instead of opposing an absent Easy pull', () => {
  const state = createGame(undefined, 'easy');
  state.enemies = [];
  state.ships = state.ships.slice(1, 2);
  const ship = state.ships[0];
  const stage = ship.position.clone().addScaledVector(ship.velocity.clone().normalize().negate(), 1800);
  stage.y = 900;
  state.player.position.copy(stage).add({ x: 0, y: 50, z: 800 });
  state.player.yaw = state.player.pitch = 0;
  updateQuaternion(state.player);
  // The weave's vertical component is zero at this observation time.
  state.elapsed = .5; state.tick = 30;
  const before = JSON.stringify(state);
  const request = createBrowserMissionPilot()(JSON.parse(before));
  assert.equal(JSON.stringify(state), before);
  assert.ok(request.climb < 0, 'a physical stick owns pitch; there is no residual nose-down assist to oppose');
  assert.ok(Math.hypot(request.turn, request.climb) <= 1);
});

test('actual aim-PR seed and request/acceptance cadence retain strict all-clear with a physically held stick', context => {
  const timing = JSON.parse(readFileSync(new URL('./fixtures/browser-input-acceptance-aim-ci.json', import.meta.url), 'utf8'));
  const state = createGame(timing.seed, timing.config), pilot = createBrowserMissionPilot();
  startGame(state);
  let next = timing.startTick, index = 0;
  let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, steeringActive: true, viewAspect: 393 / 852 };
  let pending: { tick: number; input: FlightInput } | null = null;
  for (let tick = 0; tick < 60 * 600 && state.phase === 'playing'; tick++) {
    if (pending && tick >= pending.tick) { held = pending.input; pending = null; }
    if (tick >= next) {
      const [cycleTicks, deliveryTicks] = timing.cycles[index++ % timing.cycles.length];
      next = tick + cycleTicks;
      const before = JSON.stringify(state), request = pilot(JSON.parse(before));
      assert.equal(JSON.stringify(state), before);
      const { dx, dy } = pointerOffsetForControls(request.turn, request.climb), distance = Math.hypot(dx, dy);
      assert.ok(distance <= 36 + 1e-9);
      const response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
      pending = { tick: tick + deliveryTicks, input: { ...request, viewAspect: 393 / 852, steeringActive: true,
        turn: distance ? dx / distance * response : 0, climb: distance ? -dy / distance * response : 0 } };
    }
    stepGame(state, held);
  }
  context.diagnostic(JSON.stringify({ seed: timing.seed, time: state.elapsed, hp: state.player.health,
    reason: state.endReason, stats: state.stats, ships: state.ships.map(ship => ship.health) }));
  assert.equal(state.result?.outcome, 'victory');
  assert.equal(state.endReason, 'all-clear');
  assert.ok(state.player.health > 0);
  assert.ok([...state.enemies, ...state.ships].every(target => target.health <= 0));
  assert.ok(state.stats.playerAircraftKills > 0 && state.stats.playerShipKills > 0);
});
