import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';
import { updateQuaternion } from '../src/flight';
import { predictBombImpact } from '../src/ordnance';
import { bombReleaseCue, currentBombGuide } from '../src/bomb-guide';
import { createBrowserMissionPilot, shouldAttemptBomb } from './helpers/mission-browser-pilot';
import { absolutePitchTargetToRateCommand } from './helpers/pitch-rate-conversion';
import { pointerOffsetForControls } from './helpers/touch-reload-pilot';
import type { FlightInput } from '../src/types';

test('CI53 ready blast cues produce a real payload request when direct-center geometry misses', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/browser-bomb-cues-ci53.json', import.meta.url), 'utf8'));
  for (const mode of ['easy', 'normal'] as const) {
    const route = fixture.routes[mode];
    const snapshot = route.snapshot;
    const hit = snapshot.bombGuide.affected.find((entry: any) => entry.damage > 0);
    const ship = snapshot.ships.find((candidate: any) => candidate.id === hit?.shipId);
    assert.ok(hit && ship?.health > 0);
    assert.equal(snapshot.phase, 'playing');
    assert.equal(snapshot.bombButton.ready, 'true');
    assert.equal(route.oldRequest.bomb, false, 'the archived helper ignored this live ready cue');

    const aircraft = { ...snapshot.player,
      position: new Vector3(snapshot.player.position.x, snapshot.player.position.y, snapshot.player.position.z),
      quaternion: new Quaternion().fromArray(snapshot.player.quaternion) };
    const impact = predictBombImpact(aircraft, ship.position.y + 9);
    assert.ok(impact, 'the strict center check has a valid ballistic prediction');
    const futureShip = new Vector3(ship.position.x, ship.position.y, ship.position.z)
      .addScaledVector(new Vector3(ship.velocity.x, ship.velocity.y, ship.velocity.z), impact.time);
    const localOffset = impact.position.clone().sub(futureShip)
      .applyQuaternion(new Quaternion().fromArray(ship.quaternion).invert());
    assert.ok(Math.abs(localOffset.x) >= ship.width * .36 || Math.abs(localOffset.z) >= ship.length * .35,
      'the original narrow direct-center gate would reject the recorded blast cue');

    const before = JSON.stringify(snapshot);
    const request = createBrowserMissionPilot()(snapshot);
    assert.equal(request.bomb, true, `${mode} follows the user-visible affected-ship cue`);
    assert.equal(JSON.stringify(snapshot), before, 'reading the cue does not mutate the observed world');
    assert.ok(Math.hypot(...Object.values(pointerOffsetForControls(request.turn, request.climb)) as number[]) <= 36 + 1e-9);

    const blocked = structuredClone(snapshot);
    blocked.bombButton.ready = 'false';
    assert.equal(createBrowserMissionPilot()(blocked).bomb, false,
      'an affected forecast alone is not enough when the actual payload button is not ready');
  }
});

test('live-cue previews do not advance pilot history or unsubmitted controls', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/browser-bomb-cues-ci53.json', import.meta.url), 'utf8'));
  for (const mode of ['easy', 'normal'] as const) {
    const cue = structuredClone(fixture.routes[mode].snapshot);
    const before = JSON.stringify(cue);
    const prior = structuredClone(cue);
    prior.tick -= 6;
    prior.elapsed -= 6 / 60;
    prior.bombButton.ready = 'false';

    const baseline = createBrowserMissionPilot();
    const once = createBrowserMissionPilot();
    const repeated = createBrowserMissionPilot();
    // Initialize each stateful pilot with the same preceding accepted sample.
    const baselinePrior = baseline(prior);
    assert.deepEqual(once(prior), baselinePrior);
    assert.deepEqual(repeated(prior), baselinePrior);

    const onePreview = once.preview(cue);
    assert.equal(onePreview.bomb, true, `${mode} preview follows the live cue`);
    assert.deepEqual(repeated.preview(cue), onePreview);
    assert.deepEqual(repeated.preview(cue), onePreview);
    assert.deepEqual(repeated.preview(cue), onePreview);
    assert.equal(JSON.stringify(cue), before, 'preview leaves the observed cue snapshot untouched');

    // Model the next real read after the physical release, with the actual rack decrement.
    const afterRelease = structuredClone(cue);
    afterRelease.tick += 1;
    afterRelease.elapsed += 1 / 60;
    afterRelease.player.bombs -= 1;
    afterRelease.player.bombReloadTicks = 180;
    afterRelease.player.payloadCooldown = 180;
    afterRelease.bombButton.ready = 'false';
    afterRelease.bombGuide = null;
    assert.ok(afterRelease.player.bombs < cue.player.bombs, 'the physical-release model consumes one round');

    const withoutPreview = baseline(afterRelease);
    assert.deepEqual(once(afterRelease), withoutPreview,
      `${mode} one preview does not add an unsubmitted trim or alter the next command`);
    assert.deepEqual(repeated(afterRelease), withoutPreview,
      `${mode} repeated previews preserve cadence, target history and the next command`);

    const next = structuredClone(afterRelease);
    next.tick += 6;
    next.elapsed += 6 / 60;
    const baselineNext = baseline(next);
    assert.deepEqual(once(next), baselineNext, `${mode} state progression remains identical after the next real sample`);
    assert.deepEqual(repeated(next), baselineNext, `${mode} repeated previews do not perturb later history`);
  }
});

test('Easy escape state advances only after a verified bomb-release acknowledgement', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/browser-bomb-cues-ci53.json', import.meta.url), 'utf8'));
  const cue = structuredClone(fixture.routes.easy.snapshot);
  const prior = structuredClone(cue);
  prior.tick -= 6;
  prior.elapsed -= 6 / 60;
  prior.bombButton.ready = 'false';

  const unacknowledged = createBrowserMissionPilot();
  const acknowledged = createBrowserMissionPilot();
  unacknowledged(prior);
  acknowledged(prior);
  assert.equal(acknowledged.preview(cue).bomb, true);

  const afterRelease = structuredClone(cue);
  afterRelease.tick += 1;
  afterRelease.elapsed += 1 / 60;
  afterRelease.player.bombs -= 1;
  afterRelease.player.bombReloadTicks = 180;
  afterRelease.player.payloadCooldown = 180;
  afterRelease.bombButton.ready = 'false';
  afterRelease.bombGuide = null;
  assert.ok(afterRelease.player.bombs < cue.player.bombs, 'the acknowledgement follows a real rack decrement');

  acknowledged.recordBombRelease(cue.player.bombs);
  const exitCommand = acknowledged(afterRelease);
  const attackCommand = unacknowledged(afterRelease);
  assert.notDeepEqual(exitCommand, attackCommand,
    'only the post-release acknowledgement commits the Easy exit leg');
  assert.equal(exitCommand.bomb, false);
});

test('explicit browser payload readiness blocks an otherwise-valid local center estimate', () => {
  const state = createGame(undefined, 'easy');
  startGame(state);
  state.enemies = [];
  state.ships = [state.ships[0]];
  const ship = state.ships[0];
  ship.position.set(0, 0, -1800);
  ship.previous.copy(ship.position);
  ship.velocity.set(0, 0, -1e-6);
  ship.quaternion.identity();
  ship.previousQuaternion.identity();
  ship.yaw = 0;
  state.player.position.set(0, 1000, 0);
  state.player.speed = 125;
  state.player.pitch = state.player.yaw = 0;
  updateQuaternion(state.player);

  const impact = predictBombImpact(state.player, ship.position.y + 9);
  assert.ok(impact);
  assert.ok(Math.abs(impact.position.z - ship.position.z) < ship.length * .35,
    'the strict local center estimate would request a release');
  const withoutBrowserFeedback = createBrowserMissionPilot()(JSON.parse(JSON.stringify(state)));
  assert.equal(withoutBrowserFeedback.bomb, true, 'unit-only states retain the local estimate fallback');

  const browserSnapshot = JSON.parse(JSON.stringify(state));
  browserSnapshot.bombButton = { ready: 'false' };
  assert.equal(createBrowserMissionPilot()(browserSnapshot).bomb, false,
    'present browser readiness is authoritative even when local geometry is centered');
});

test('collision avoidance uses TTC beyond 240 m after a delayed observation', () => {
  const state = createGame(undefined, 'normal');
  startGame(state);
  state.enemies = state.enemies.slice(0, 1);
  const enemy = state.enemies[0];
  state.player.position.set(0, 900, 0);
  state.player.speed = 110;
  state.player.yaw = state.player.pitch = 0;
  updateQuaternion(state.player);
  enemy.position.set(14.62, 900, -259);
  enemy.speed = 100;
  enemy.yaw = Math.PI;
  enemy.pitch = 0;
  enemy.health = 100;
  updateQuaternion(enemy);

  const relative = enemy.position.clone().sub(state.player.position);
  // Player flies toward -Z at 110 m/s; the hostile flies toward +Z at 100 m/s.
  const relativeVelocity = new Vector3(0, 0, enemy.speed + state.player.speed);
  const closingTime = -relative.dot(relativeVelocity) / relativeVelocity.lengthSq();
  const closestSeparation = relative.addScaledVector(relativeVelocity, closingTime).length();
  assert.ok(enemy.position.distanceTo(state.player.position) > 240);
  assert.ok(closingTime > 0 && closingTime < 1.5);
  assert.ok(closestSeparation < 40);

  const pilot = createBrowserMissionPilot();
  pilot(JSON.parse(JSON.stringify(state)));
  state.tick += 6;
  state.elapsed += 6 / 60;
  const fastCadenceRequest = pilot(JSON.parse(JSON.stringify(state)));
  assert.ok(fastCadenceRequest.turn !== 0 || fastCadenceRequest.climb !== -1,
    'regular six-tick sampling retains the earlier 240 m envelope');
  state.tick += 12;
  state.elapsed += 12 / 60;
  const delayedRequest = pilot(JSON.parse(JSON.stringify(state)));
  assert.equal(delayedRequest.turn, 0);
  assert.equal(delayedRequest.climb, -1, 'the observed delay enables the existing TTC and clearance bounds');
  assert.equal(delayedRequest.fire, false);
});

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

test('CI55 local shell153 Easy timing uses live damage cues and clears the real mission', context => {
  const timing = JSON.parse(readFileSync(new URL('./fixtures/browser-input-acceptance-ci55-easy-timing.json', import.meta.url), 'utf8'));
  const state = createGame(timing.source.seed, timing.source.config), pilot = createBrowserMissionPilot();
  startGame(state);
  const pauseTicks = new Set([14, 353]);
  let cycleIndex = 0, payloadIndex = 0, nextSample = 15;
  let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, bomb: false, torpedo: false,
    steeringActive: true, steeringRevision: 0, viewAspect: 393 / 852, accelerate: false, brake: false };
  let pending: { tick: number; turn: number; climb: number } | null = null;
  let pulseAt: number | null = null, postPulseCycle: readonly number[] | null = null;
  let bombsReleased = 0, directCues = 0, lethalBlastCues = 0, attempts = 0;
  let cueExpiries = 0;

  const observe = () => {
    const guide = state.player.bombs > 0 && state.player.bombReloadTicks === 0 ? currentBombGuide(state) : null;
    const cue = bombReleaseCue(state, guide);
    return { ...state, bombGuide: guide, bombButton: { ready: String(cue.ready) },
      controlsInput: { turn: held.turn, climb: held.climb } } as typeof state & {
        bombGuide: typeof guide; bombButton: { ready: string }; controlsInput: { turn: number; climb: number };
      };
  };

  const requestSteering = (request: FlightInput, delivery: number, cycle: number) => {
    const { dx, dy } = pointerOffsetForControls(request.turn, request.climb);
    const radius = Math.hypot(dx, dy);
    assert.ok(radius <= 36 + 1e-9, 'live-feedback route stays inside the unchanged physical stick circle');
    const response = radius / 36 <= .08 ? 0 : (radius / 36 - .08) / .92;
    const turn = radius ? dx / radius * response : 0;
    const climb = radius ? -dy / radius * response : 0;
    assert.ok(Math.abs(turn - request.turn) < 1e-9 && Math.abs(climb - request.climb) < 1e-9);
    pending = { tick: state.tick + Math.max(1, delivery), turn, climb };
    nextSample = state.tick + Math.max(1, delivery) + Math.max(1, cycle);
  };

  for (let tick = 0; tick < 60 * 600 && state.phase === 'playing'; tick++) {
    const nextTick = state.tick + 1;
    if (pauseTicks.has(state.tick)) { pauseGame(state); resumeGame(state); }

    if (state.tick === nextSample && pulseAt === null) {
      const snapshot = observe();
      const row = timing.cycles[cycleIndex++ % timing.cycles.length] as [number, number];
      if (shouldAttemptBomb(snapshot) && pilot.preview(snapshot).bomb) {
        attempts++;
        const affected = snapshot.bombGuide!.affected
          .map(hit => ({ hit, ship: state.ships.find(candidate => candidate.id === hit.shipId) }))
          .find(({ hit, ship }) => ship && ship.health > 0 && hit.damage > 0 &&
            (snapshot.bombGuide!.kind === 'direct' || hit.damage + 1e-6 >= ship.health));
        assert.ok(affected?.ship, 'a driver-approved pulse has a live affected target');
        if (snapshot.bombGuide!.kind === 'direct') directCues++;
        else lethalBlastCues++;
        postPulseCycle = row;
        pulseAt = state.tick + timing.payloadDelayTicks[payloadIndex++ % timing.payloadDelayTicks.length];
      } else {
        requestSteering(pilot(snapshot), row[0], row[1]);
      }
    }

    if (pending?.tick === nextTick) {
      held = { ...held, turn: pending.turn, climb: pending.climb, steeringActive: true,
        steeringRevision: held.steeringRevision! + Number(Math.hypot(pending.turn - held.turn, pending.climb - held.climb) > 1e-4) };
      pending = null;
    }
    const beforeBombs = state.player.bombs;
    const pulse = pulseAt === nextTick;
    stepGame(state, { ...held, bomb: pulse });
    if (state.player.bombs < beforeBombs) {
      bombsReleased += beforeBombs - state.player.bombs;
      assert.equal(pulse, true, 'only an actual one-tick touch pulse consumes a bomb');
      assert.ok(state.events.findLast(event => event.type === 'payload-release' && event.owner === state.player.id && event.tick === state.tick),
        'the release is recorded by the real mission simulation');
      pilot.recordBombRelease(beforeBombs);
      pulseAt = null;
      const [delivery, cycle] = postPulseCycle!;
      requestSteering(pilot(observe()), delivery, cycle);
      postPulseCycle = null;
    } else if (pulse) {
      cueExpiries++;
      pulseAt = null;
      const [delivery, cycle] = postPulseCycle!;
      requestSteering(pilot(observe()), delivery, cycle);
      postPulseCycle = null;
    }
  }

  context.diagnostic(JSON.stringify({ source: timing.source.note, evidence: 'Node causal replay, not browser input-acceptance evidence',
    tick: state.tick, elapsed: state.elapsed, result: state.result?.outcome,
    hp: state.player.health, bombsReleased, attempts, directCues, lethalBlastCues, cueExpiries,
    stats: state.stats, ships: state.ships.map(ship => ship.health) }));
  assert.ok(attempts > 0 && directCues > 0, 'the actual live guide supplies useful direct cues');
  assert.ok(bombsReleased > 0, 'live-guided requests become real bomb releases');
  assert.equal(state.endReason, 'all-clear');
  assert.equal(state.result?.outcome, 'victory');
  assert.ok(state.elapsed < 600, 'the existing 600-second bound remains strict');
  assert.ok(state.player.health > 0);
  assert.ok(state.stats.playerAircraftKills > 0 && state.stats.playerShipKills > 0);
  assert.ok([...state.enemies, ...state.ships].every(target => target.health <= 0));
});

test('CI55 Normal recorded cadence releases on the current accepted pose and clears with live damage', context => {
  const timing = JSON.parse(readFileSync(new URL('./fixtures/browser-input-acceptance-ci55-normal-timing.json', import.meta.url), 'utf8'));
  const state = createGame(timing.source.seed, timing.source.config), pilot = createBrowserMissionPilot();
  startGame(state);
  let cycleIndex = 0, payloadIndex = 0, nextSample = timing.source.startTick;
  let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, bomb: false, torpedo: false,
    steeringActive: false, steeringRevision: 0, viewAspect: 393 / 852, accelerate: false, brake: false };
  let pending: { tick: number; input: FlightInput } | null = null;
  let pulseAt: number | null = null, postPulseCycle: readonly number[] | null = null;
  let pendingCue: { readTick: number; kind: string; affected: Array<{ shipId: number; damage: number; health: number }> } | null = null;
  let bombsReleased = 0, usefulCandidates = 0, directCues = 0, lethalBlastCues = 0;
  let bombImpactEvents = 0, actualBombDamage = 0, cueExpiries = 0;
  const bombDamagedShips = new Set<number>();
  const releaseAudit: unknown[] = [];

  const observe = () => {
    const guide = state.player.bombs > 0 && state.player.bombReloadTicks === 0 ? currentBombGuide(state) : null;
    const cue = bombReleaseCue(state, guide);
    return { ...state, bombGuide: guide, bombButton: { ready: String(cue.ready) },
      controlsInput: { turn: held.turn, climb: held.climb } } as typeof state & {
        bombGuide: typeof guide; bombButton: { ready: string }; controlsInput: { turn: number; climb: number };
      };
  };

  const queueInput = (request: FlightInput, row: readonly number[]) => {
    const { dx, dy } = pointerOffsetForControls(request.turn, request.climb);
    const radius = Math.hypot(dx, dy);
    assert.ok(radius <= 36 + 1e-9, 'Normal steering stays inside the unchanged physical stick circle');
    const response = radius / 36 <= .08 ? 0 : (radius / 36 - .08) / .92;
    const turn = radius ? dx / radius * response : 0;
    const climb = radius ? -dy / radius * response : 0;
    assert.ok(Math.abs(turn - request.turn) < 1e-9 && Math.abs(climb - request.climb) < 1e-9);
    const delivery = Math.max(1, row[0]), cycle = Math.max(1, row[1]);
    pending = { tick: state.tick + delivery, input: { ...request, turn, climb, steeringActive: true } };
    nextSample = state.tick + delivery + cycle;
  };

  for (let tick = 0; tick < 60 * 600 && state.phase === 'playing'; tick++) {
    const nextTick = state.tick + 1;
    if (state.tick === nextSample && pulseAt === null) {
      const snapshot = observe();
      const row = timing.cycles[cycleIndex++ % timing.cycles.length] as [number, number];
      if (shouldAttemptBomb(snapshot) && pilot.preview(snapshot).bomb) {
        usefulCandidates++;
        const guide = snapshot.bombGuide!;
        if (guide.kind === 'direct') directCues++;
        else lethalBlastCues++;
        pendingCue = { readTick: state.tick, kind: guide.kind, affected: guide.affected.map(hit => ({
          shipId: hit.shipId, damage: hit.damage,
          health: state.ships.find(ship => ship.id === hit.shipId)?.health ?? 0,
        })) };
        postPulseCycle = row;
        pulseAt = state.tick + timing.payloadDelayTicks[payloadIndex++ % timing.payloadDelayTicks.length];
      } else {
        queueInput(pilot(snapshot), row);
      }
    }

    if (pending?.tick === nextTick) {
      const request = pending.input;
      held = { ...held, turn: request.turn, climb: request.climb, fire: Boolean(request.fire),
        accelerate: Boolean(request.accelerate), brake: Boolean(request.brake), steeringActive: true,
        steeringRevision: held.steeringRevision! + Number(Math.hypot(request.turn - held.turn, request.climb - held.climb) > 1e-4) };
      pending = null;
    }
    const beforeBombs = state.player.bombs;
    const pulse = pulseAt === nextTick;
    stepGame(state, { ...held, bomb: pulse });
    const impactEvents = state.events.filter(event => event.tick === state.tick && event.type === 'ordnance-impact'
      && event.owner === state.player.id && event.weapon === 'bomb' && (event.amount ?? 0) > 0);
    for (const event of impactEvents) {
      bombImpactEvents++;
      actualBombDamage += event.amount ?? 0;
      if (event.target !== undefined) bombDamagedShips.add(event.target);
    }
    if (state.player.bombs < beforeBombs) {
      bombsReleased += beforeBombs - state.player.bombs;
      assert.equal(pulse, true, 'only an actual one-tick touch pulse consumes a bomb');
      assert.ok(pendingCue, 'a real bomb follows a current useful cue');
      assert.ok(state.events.findLast(event => event.type === 'payload-release' && event.owner === state.player.id && event.tick === state.tick),
        'the release is recorded by the real mission simulation');
      releaseAudit.push({ ...pendingCue, releaseTick: state.tick, bombsAfter: state.player.bombs });
      pilot.recordBombRelease(beforeBombs);
      pulseAt = null; pendingCue = null;
      queueInput(pilot(observe()), postPulseCycle!);
      postPulseCycle = null;
    } else if (pulse) {
      cueExpiries++;
      pulseAt = null; pendingCue = null;
      queueInput(pilot(observe()), postPulseCycle!);
      postPulseCycle = null;
    }
  }

  context.diagnostic(JSON.stringify({ source: timing.source.note, evidence: 'Node causal replay, not browser input-acceptance evidence',
    tick: state.tick, elapsed: state.elapsed, result: state.result?.outcome, hp: state.player.health,
    bombsReleased, usefulCandidates, directCues, lethalBlastCues, bombImpactEvents, actualBombDamage,
    bombDamagedShips: [...bombDamagedShips], cueExpiries, releaseAudit, stats: state.stats,
    ships: state.ships.map(ship => ship.health) }));
  assert.ok(usefulCandidates > 0 && directCues > 0, 'fresh live direct cues are available from the recorded Normal cadence');
  assert.equal(cueExpiries, 0, 'the live cue request reaches the actual payload input');
  assert.equal(bombsReleased, usefulCandidates, 'every approved Normal cue produces a real release');
  assert.ok(bombImpactEvents > 0 && actualBombDamage > 0, 'released bombs cause recorded hull damage in stepGame');
  assert.ok(bombDamagedShips.size > 0, 'the live-guided payloads damage at least one real ship');
  assert.equal(state.endReason, 'all-clear');
  assert.equal(state.result?.outcome, 'victory');
  assert.ok(state.elapsed < 600, 'the existing 600-second bound remains strict');
  assert.ok(state.player.health > 0);
  assert.ok(state.stats.playerAircraftKills > 0 && state.stats.playerShipKills > 0);
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
