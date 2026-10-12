import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';
import { updateQuaternion } from '../src/flight';
import { createBrowserMissionPilot } from './helpers/mission-browser-pilot';
import { absolutePitchTargetToRateCommand } from './helpers/pitch-rate-conversion';
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

test('CI50 Easy cadence regression clears with strict state transitions and physical bomb releases', context => {
  const timing = JSON.parse(readFileSync(new URL('./fixtures/browser-input-acceptance-easy-ci50.json', import.meta.url), 'utf8'));
  assert.equal(timing.recordedFailure.tick, 4534);
  assert.equal(timing.recordedFailure.outcome, 'defeat');
  assert.equal(timing.recordedFailure.deathCause, 'naval-fire');
  const state = createGame(timing.seed, timing.config), pilot = createBrowserMissionPilot();
  startGame(state);
  let timingIndex = 0, nextObserve = timing.initialObserveTick, revision = 0, bombsReleased = 0;
  let firstBombRequest: unknown = null, checkedRecordedBombAttempt = false;
  let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, bomb: false, torpedo: false,
    steeringActive: false, steeringRevision: 0, viewAspect: 393 / 852, accelerate: false, brake: false };
  let pending: Array<{ tick: number; turn: number; climb: number }> = [];
  const bombPulses = new Set<number>();
  const steeringEvents = new Map(timing.steeringActiveEvents.map(([tick, active]: [number, boolean]) => [tick, active]));
  const pauseTicks = new Set(timing.pausesAtTicks as number[]);
  let firstBombTargetId: number | null = null;
  let firstBombReleasedAt: number | null = null, firstBombReleaseDistance: number | null = null;
  let firstBombReleaseAltitude: number | null = null, postReleaseAltitude: number | null = null;
  let firstPostReleaseRequest: FlightInput | null = null, postReleaseDistance: number | null = null;

  for (let tick = 0; tick < 60 * 600 && state.phase === 'playing'; tick++) {
    const nextTick = state.tick + 1;
    if (pauseTicks.has(state.tick)) { pauseGame(state); resumeGame(state); }
    const active = steeringEvents.get(nextTick);
    if (active !== undefined) {
      held = { ...held, steeringActive: active };
      if (!active) held = { ...held, turn: 0, climb: 0 };
    }

    if (state.tick === nextObserve) {
      const [acceptedAfter, deliveryAfter, cycleAfter, bombAfter] = timing.timings[timingIndex % timing.timings.length];
      const request = pilot(state);
      if (firstBombReleasedAt !== null && firstPostReleaseRequest === null && state.tick > firstBombReleasedAt)
        firstPostReleaseRequest = request;
      const { dx, dy } = pointerOffsetForControls(request.turn, request.climb);
      const radius = Math.hypot(dx, dy);
      assert.ok(radius <= 36 + 1e-9, 'pilot request stays inside the physical stick circle');
      const response = radius / 36 <= .08 ? 0 : (radius / 36 - .08) / .92;
      const deliveredTurn = radius > 0 ? dx / radius * response : 0;
      const deliveredClimb = radius > 0 ? -dy / radius * response : 0;
      assert.ok(Math.abs(deliveredTurn - request.turn) < 1e-9);
      assert.ok(Math.abs(deliveredClimb - request.climb) < 1e-9);
      if (request.bomb && firstBombRequest === null) firstBombRequest = {
        tick: state.tick, health: state.player.health, bombs: state.player.bombs,
        position: state.player.position.toArray(), ships: state.ships.map(ship => ship.health),
        request: { turn: request.turn, climb: request.climb, bomb: request.bomb },
      };
      if (state.tick === timing.recordedFirstBombRequest.tick) {
        const recorded = timing.recordedFirstBombRequest;
        const position = state.player.position.toArray();
        assert.ok(Math.abs(state.player.health - recorded.health) < 1e-8);
        assert.ok(Math.hypot(...position.map((value: number, index: number) => value - recorded.position[index])) < .5,
          'the original bomb approach is reached from the recorded seed and cadence');
        assert.deepEqual(state.ships.map(ship => ship.health), recorded.shipHealth);
        assert.equal(request.bomb, true, 'the original approach still requests a legal bomb release');
        assert.ok(Math.hypot(request.turn - recorded.request.turn, request.climb - recorded.request.climb) < .05,
          'the predicted approach command remains in force until the browser releases the payload');
        firstBombTargetId = state.ships[recorded.shipHealth.indexOf(Math.min(...recorded.shipHealth))].id;
        checkedRecordedBombAttempt = true;
      }
      pending.push({ tick: state.tick + Math.max(1, deliveryAfter), turn: deliveredTurn, climb: deliveredClimb });
      const acceptedTick = state.tick + Math.max(1, acceptedAfter);
      if (request.bomb) bombPulses.add(acceptedTick + Math.max(1, bombAfter));
      timingIndex++;
      nextObserve = acceptedTick + Math.max(1, cycleAfter);
    }

    for (const input of pending.filter(input => input.tick === nextTick)) {
      revision += Number(Math.hypot(input.turn - held.turn, input.climb - held.climb) > 1e-4);
      held = { ...held, turn: input.turn, climb: input.climb, steeringActive: true, steeringRevision: revision };
    }
    pending = pending.filter(input => input.tick > nextTick);
    const beforeBombs = state.player.bombs;
    stepGame(state, { ...held, bomb: bombPulses.has(nextTick) });
    if (state.player.bombs < beforeBombs) {
      bombsReleased += beforeBombs - state.player.bombs;
      if (firstBombReleasedAt === null) {
        const ship = state.ships.find(candidate => candidate.id === firstBombTargetId);
        firstBombReleasedAt = state.tick;
        firstBombReleaseDistance = ship ? state.player.position.distanceTo(ship.position) : null;
        firstBombReleaseAltitude = state.player.position.y;
      }
    }
    if (firstBombReleasedAt !== null && state.tick >= firstBombReleasedAt + 120 && postReleaseDistance === null) {
      const ship = state.ships.find(candidate => candidate.id === firstBombTargetId);
      if (ship && firstBombReleaseDistance !== null) {
        postReleaseDistance = state.player.position.distanceTo(ship.position);
        postReleaseAltitude = state.player.position.y;
      }
    }
  }

  context.diagnostic(JSON.stringify({ tick: state.tick, result: state.result?.outcome, hp: state.player.health,
    bombsReleased, firstBombRequest, firstBombReleasedAt, firstBombReleaseDistance, postReleaseDistance,
    firstBombReleaseAltitude, postReleaseAltitude,
    firstPostReleaseRequest, stats: state.stats, ships: state.ships.map(ship => ship.health) }));
  assert.equal(checkedRecordedBombAttempt, true, 'the old attack is compared at the original bomb request');
  assert.ok(firstBombReleasedAt !== null, 'the legal request reaches a real bomb release in stepGame');
  assert.ok(firstPostReleaseRequest, 'the pilot observes the released bomb before choosing its exit command');
  assert.ok(Math.hypot(firstPostReleaseRequest.turn - timing.recordedFirstBombRequest.request.turn,
    firstPostReleaseRequest.climb - timing.recordedFirstBombRequest.request.climb) > .5,
    'the post-release command leaves the original attack approach');
  assert.ok(firstBombReleaseAltitude !== null && postReleaseAltitude !== null);
  assert.ok(postReleaseAltitude > firstBombReleaseAltitude + 30,
    'the route gains altitude during the two seconds after physical release');
  assert.equal(state.endReason, 'all-clear');
  assert.equal(state.result?.outcome, 'victory');
  assert.ok(state.elapsed < 600);
  assert.ok(state.player.health > 0);
  assert.ok(bombsReleased > 0, 'the route releases actual ordnance through stepGame');
  assert.ok(state.stats.playerShipKills > 0);
  assert.ok([...state.enemies, ...state.ships].every(target => target.health <= 0));
});

test('rate-converted manual descent reaches the real torpedo envelope and splashes the released round', () => {
  const state = createGame(undefined, 'normal');
  startGame(state);
  let lastCommandTick = -6, lastCommandElapsed = state.elapsed - 6 / 60;
  let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, bomb: false, torpedo: false,
    steeringActive: true, viewAspect: 393 / 852 };

  for (let ticks = 0; ticks < 30 * 60; ticks++) {
    if (state.player.position.y >= 20 && state.player.position.y < 80 && Math.abs(state.player.pitch) < .2) break;
    if (state.tick - lastCommandTick >= 6) {
      const sampleDt = Math.max(1 / 60, state.elapsed - lastCommandElapsed);
      const absolutePitchTarget = Math.max(-.65, Math.min(.3, (65 - state.player.position.y) / 180));
      held = { ...held, climb: absolutePitchTargetToRateCommand(absolutePitchTarget, state.player.pitch, state.player.speed, sampleDt) };
      lastCommandTick = state.tick;
      lastCommandElapsed = state.elapsed;
    }
    stepGame(state, held);
  }

  assert.equal(state.phase, 'playing');
  assert.ok(state.player.position.y >= 20 && state.player.position.y < 80);
  assert.ok(Math.abs(state.player.pitch) < .2);
  assert.ok(state.player.health > 0);
  const torpedoesBefore = state.player.torpedoes;
  stepGame(state, { ...held, torpedo: true });
  assert.equal(state.player.torpedoes, torpedoesBefore - 1);
  assert.ok(state.player.torpedoReloadTicks > 0);
  const torpedo = state.ordnance.find(round => round.owner === state.player.id && round.kind === 'torpedo');
  assert.ok(torpedo);
  assert.equal(torpedo.phase, 'air');
  for (let ticks = 0; ticks < 12 * 60 && torpedo.phase !== 'water'; ticks++) stepGame(state, { ...held, torpedo: false });
  assert.equal(torpedo.phase, 'water');
  assert.ok(state.player.health > 0);
});
