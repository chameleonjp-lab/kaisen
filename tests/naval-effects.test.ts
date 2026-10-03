import assert from 'node:assert/strict';
import {test} from 'node:test';
import {KaisenScene} from '../src/scene';
import {createGame, startGame, stepGame} from '../src/simulation';
import {FIXED_DT} from '../src/mission';
import {MAX_NAVAL_SHOTS_PER_STEP} from '../src/naval';
import type {GameEvent} from '../src/types';

// Exercise the real event consumer without pretending a fake renderer proves pixels.
function effectConsumer() {
  const state = createGame();
  const view = Object.assign(Object.create(KaisenScene.prototype), {
    current: state, lastEvent: 0, particles: [], navalFlashes: [], wrecks: new Map(),
  });
  return {state, view};
}

test('naval flashes follow emitted barrel events only and never replay an event', () => {
  const {state, view} = effectConsumer();
  startGame(state);
  let events: GameEvent[] = [];
  for (let i = 0; i < 1200 && events.length === 0; i++) {
    stepGame(state, {turn: .2, climb: .1, fire: false, loop: false});
    events = state.events.filter(e => e.type === 'shot' && state.ships.some(s => s.id === e.owner));
  }
  assert.ok(events.length > 0, 'real naval barrel shots occur in the mission');
  assert.ok(events.every(e => e.tick === state.tick));
  view.events(events, state.elapsed);
  assert.equal(view.navalFlashes.length, events.length);
  events.forEach((event, index) => {
    assert.deepEqual(view.navalFlashes[index].p.toArray(), event.position.toArray());
    assert.equal(view.navalFlashes[index].born, event.tick! * FIXED_DT);
  });
  const before = JSON.stringify(state);
  view.events(events, state.elapsed);
  assert.equal(view.navalFlashes.length, events.length);
  assert.equal(JSON.stringify(state), before, 'visual effects cannot create bullets or change damage');
});

test('stale, aircraft and idle events cannot invent naval flashes; fixed pause time freezes them', () => {
  const {state, view} = effectConsumer();
  const event: GameEvent = {id: 1, tick: 60, type: 'shot', owner: state.ships[0].id, position: state.ships[0].position.clone()};
  view.events([event], 1.3);
  assert.equal(view.navalFlashes.length, 0, 'slow rendering must not replay old volleys');
  view.events([{...event, id: 2, owner: state.player.id, tick: 80}], 80 * FIXED_DT);
  view.events([], 80 * FIXED_DT);
  assert.equal(view.navalFlashes.length, 0);
  view.events([{...event, id: 3, tick: 90}], 1.5);
  view.events([], 1.5);
  assert.equal(view.navalFlashes.length, 1);
  view.events([], 1.7);
  assert.equal(view.navalFlashes.length, 0);
});

test('bounded flash storage shares a fixed particle batch and keeps the newest real events', () => {
  const {state, view} = effectConsumer();
  const events: GameEvent[] = Array.from({length: MAX_NAVAL_SHOTS_PER_STEP * 7 + 48}, (_, i) => ({
    id: i + 1, tick: 60, type: 'shot', owner: state.ships[0].id, position: state.ships[0].position.clone(),
  }));
  view.events(events, 1);
  assert.equal(view.navalFlashes.length, MAX_NAVAL_SHOTS_PER_STEP * 7);
  assert.equal(view.navalFlashes.length, 308);
  assert.equal(view.particles.length, 1, 'one grouped muzzle-smoke plume for the same mount/tick volley');
});
