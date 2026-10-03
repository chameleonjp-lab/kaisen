import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGame, startGame, stepGame } from '../src/simulation';
import { createTouchReloadPilot, pointerOffsetForControls } from './helpers/touch-reload-pilot';

test('real circular-stick mapping reaches and completes reload with six/seven tick sample jitter', () => {
  for (const pattern of [[6], [6, 7]]) {
    const state = createGame(), pilot = createTouchReloadPilot(); startGame(state);
    let next = 0, sample = 0;
    let held = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
    const reloads: number[] = [];
    for (let i = 0; i < 60 * 150 && reloads.length < 2 && state.phase === 'playing'; i++) {
      if (state.tick >= next) {
        next = state.tick + pattern[sample++ % pattern.length];
        const before = JSON.stringify(state);
        const requested = pilot(JSON.parse(before));
        assert.equal(JSON.stringify(state), before, 'pilot only observes');
        const { dx, dy } = pointerOffsetForControls(requested.turn, requested.climb);
        const distance = Math.hypot(dx, dy); assert.ok(distance <= 36 + 1e-9);
        const response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
        held = { ...held, turn: distance ? dx / distance * response : 0, climb: distance ? -dy / distance * response : 0 };
      }
      stepGame(state, held);
      for (const e of state.events) if (e.type === 'reload-start' || e.type === 'reload-complete') reloads.push(state.tick);
    }
    assert.ok(state.player.health > 0); // Full all-clear runs are covered in ai.test.ts for both hold patterns.
    assert.ok(reloads.length >= 2); assert.equal(reloads[1] - reloads[0], 360);
    assert.ok(state.stats.shots >= 384);
  }
});
