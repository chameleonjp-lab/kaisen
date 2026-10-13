import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../../src/simulation';
import { currentBombGuide, bombReleaseCue } from '../../src/bomb-guide';
import { createBrowserMissionPilot, shouldAttemptBomb } from '../../tests/helpers/mission-browser-pilot';
import { pointerOffsetForControls } from '../../tests/helpers/touch-reload-pilot';
import type { FlightInput } from '../../src/types';

/** Optional long deterministic strategy scenarios. Recorded cycles and payload delays
 * are repeated modulo their stored arrays as condition models, not chronological replay. */

test('actual aim-PR seed and request/acceptance cadence retain strict all-clear with a physically held stick', context => {
  const timing = JSON.parse(readFileSync(new URL('../../tests/fixtures/browser-input-acceptance-aim-ci.json', import.meta.url), 'utf8'));
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
  const timing = JSON.parse(readFileSync(new URL('../../tests/fixtures/browser-input-acceptance-easy-ci50.json', import.meta.url), 'utf8'));
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

test('CI55 Easy uses fresh live damage cues through delayed touch pulses and clears the real mission', context => {
  const timing = JSON.parse(readFileSync(new URL('../../tests/fixtures/browser-input-acceptance-ci55-easy-timing.json', import.meta.url), 'utf8'));
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

  context.diagnostic(JSON.stringify({ tick: state.tick, elapsed: state.elapsed, result: state.result?.outcome,
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
  const timing = JSON.parse(readFileSync(new URL('../../tests/fixtures/browser-input-acceptance-ci55-normal-timing.json', import.meta.url), 'utf8'));
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
