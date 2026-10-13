import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { createGame, startGame, stepGame } from '../src/simulation';
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

test('Normal bomb pulse waits for the accepted straight pass and keeps a useful cue through touch delay', () => {
  const state = createGame(undefined, 'normal');
  startGame(state);
  state.enemies = [];
  state.ships = state.ships.slice(0, 1);
  const ship = state.ships[0];
  ship.position.set(0, 0, -1680);
  ship.previous.copy(ship.position);
  ship.velocity.set(0, 0, -1e-6);
  ship.yaw = 0;
  ship.quaternion.identity();
  ship.previousQuaternion.identity();
  state.player.position.set(0, 900, 120);
  state.player.speed = 130;
  state.player.yaw = state.player.pitch = state.player.bank = 0;
  updateQuaternion(state.player);
  state.tick = 30;
  state.elapsed = .5;

  const pilot = createBrowserMissionPilot();
  const observe = (turn: number, climb: number) => {
    const bombGuide = currentBombGuide(state);
    const cue = bombReleaseCue(state, bombGuide);
    return { ...JSON.parse(JSON.stringify(state)), bombGuide, bombButton: { ready: String(cue.ready) },
      controlsInput: { turn, climb } };
  };

  const turning = observe(.85, .011);
  assert.equal(turning.bombGuide.kind, 'direct');
  assert.equal(shouldAttemptBomb(turning), false, 'a live direct cue does not pulse under an accepted turn');
  const lock = pilot(turning);
  assert.equal(lock.turn, 0);
  assert.equal(lock.climb, .02);
  assert.equal(lock.bomb, true);

  const accepted: FlightInput = { ...lock, steeringActive: true, steeringRevision: 1,
    viewAspect: 393 / 852, accelerate: false, brake: false };
  for (let tick = 0; tick < 6; tick++) stepGame(state, { ...accepted, bomb: false });
  const aligned = observe(accepted.turn, accepted.climb);
  assert.equal(aligned.bombGuide.kind, 'direct');
  assert.equal(shouldAttemptBomb(aligned), true, 'the straight pass is accepted before deciding to pulse');
  assert.equal(pilot.preview(aligned).bomb, true);
  const decisionTick = state.tick, payloadDelayTicks = 8;
  for (let tick = 0; tick < payloadDelayTicks; tick++) stepGame(state, { ...accepted, bomb: false });
  assert.equal(state.tick - decisionTick, payloadDelayTicks);
  const atRelease = observe(accepted.turn, accepted.climb);
  assert.equal(atRelease.bombGuide.kind, 'direct');
  assert.equal(shouldAttemptBomb(atRelease), true, 'the decided cue remains useful until the delayed pulse is consumed');
  const bombsBefore = state.player.bombs;
  stepGame(state, { ...accepted, bomb: true });
  assert.equal(state.player.bombs, bombsBefore - 1);
  assert.ok(state.events.some(event => event.type === 'payload-release' && event.owner === state.player.id && event.tick === state.tick));
  pilot.recordBombRelease(bombsBefore);

  const healthBefore = ship.health;
  for (let tick = 0; tick < 1800 && ship.health === healthBefore; tick++) stepGame(state, { ...accepted, bomb: false });
  assert.equal(healthBefore - ship.health, 1800, 'the acknowledged payload resolves as the real direct ship hit');
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
