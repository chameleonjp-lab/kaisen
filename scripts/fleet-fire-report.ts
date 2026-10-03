/** Read-only local diagnostics. Run: node --import tsx scripts/fleet-fire-report.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { createGame, startGame, stepGame } from '../src/simulation';
import { desiredFlightInput, forwardOf } from '../src/flight';
import { targetAimPoint } from '../src/flight-assist';
import { FLIGHT_FOV, getFlightCameraPose } from '../src/flight-view';
import { NAVAL_MOUNTS, NAVAL_WEAPONS } from '../src/naval';
import { createTouchReloadPilot } from '../tests/helpers/touch-reload-pilot';
import { flyLargeFleetMission } from '../tests/helpers/large-fleet-pilot';
import type { FlightInput, GameState } from '../src/types';

const neutral: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
const round = (n: number) => Math.round(n * 1000) / 1000;
/** Same ordinary input policy and radial dead zone as the default touch regression. */
function defaultTouchPilot() {
  let targetId: number | null = null, extendUntilTick = 0, attackingShip = false;
  let waypoint = new Vector3();
  return (state: GameState): FlightInput => {
    const targets = [...state.enemies, ...state.ships].filter(t => t.health > 0);
    const target = targets.find(t => t.id === targetId) ?? targets.sort((a, b) => state.player.position.distanceTo(a.position) - state.player.position.distanceTo(b.position))[0];
    if (!target) return neutral;
    if (targetId !== target.id) attackingShip = false;
    targetId = target.id;
    let aim = target.position.clone();
    const distance = state.player.position.distanceTo(aim), heading = forwardOf(state.player); heading.y = 0;
    const horizontal = aim.clone().sub(state.player.position); horizontal.y = 0;
    const angle = heading.angleTo(horizontal);
    const tooClose = target.kind === 'ship' && !attackingShip && distance < 360 && angle > .25;
    if (state.tick >= extendUntilTick && (tooClose || state.player.position.y < 90 || distance < (target.kind === 'ship' ? 210 : 70))) {
      extendUntilTick = state.tick + 360; attackingShip = false;
      waypoint = state.player.position.clone().addScaledVector(forwardOf(state.player), 740);
      waypoint.y = Math.max(250, state.player.position.y + 100);
    }
    if (state.tick < extendUntilTick) aim = waypoint;
    else if (target.kind === 'ship') {
      if (angle < .25 && distance > 330) attackingShip = true;
      aim.y = attackingShip ? targetAimPoint(target).y : 250;
    }
    const requested = desiredFlightInput(state.player, aim);
    let x = requested.turn, y = requested.climb * .62 / .95, norm = Math.hypot(x, y);
    if (norm > 1) { x /= norm; y /= norm; norm = 1; }
    const response = norm <= .08 ? 0 : (norm - .08) / .92;
    return { ...neutral, turn: norm ? x / norm * response : 0, climb: norm ? y / norm * response : 0 };
  };
}
function lowPassPilot(side: number, altitude: number) {
  let waypoint = 0;
  const points = [new Vector3(side * 700, altitude, -1150), new Vector3(-side * 700, altitude, -1600), new Vector3(-side * 1000, 250, -2500)];
  return (state: GameState): FlightInput => {
    if (state.player.position.distanceTo(points[waypoint]) < 150 && waypoint < points.length - 1) waypoint++;
    const requested = desiredFlightInput(state.player, points[waypoint]);
    let turn = requested.turn, climb = requested.climb * .62 / .95;
    const norm = Math.hypot(turn, climb); if (norm > 1) { turn /= norm; climb /= norm; }
    return { ...neutral, turn, climb };
  };
}
function collector(name: string) {
  const camera = new PerspectiveCamera(FLIGHT_FOV, 393 / 852, .5, 22000), frustum = new Frustum();
  const previous = new Map<string, { target: number | null; salvo: number }>();
  const perMount: Record<string, number> = {}, categories = { heavy: 0, light: 0 }, targetRounds: Record<string, number> = {};
  const windows: Record<number, { samples: number; rounds: number; engagedMountTicks: number }> = {};
  let retargets = 0, readyWithTargetNoVolleyTicks = 0, samples = 0, aliveRoundSamples = 0, maxLive = 0;
  let visibleRoundSamples = 0, maxVisible = 0, zeroVisibleTicks = 0, shotsAtFrustumMuzzle = 0, minimumAltitude = Infinity;
  function segmentInFrustum(a: Vector3, b: Vector3) {
    let enter = 0, exit = 1;
    for (const plane of frustum.planes) {
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
      if (da < 0 && db < 0) return false;
      if (da >= 0 && db >= 0) continue;
      const t = da / (da - db);
      if (da < 0) enter = Math.max(enter, t); else exit = Math.min(exit, t);
      if (enter > exit) return false;
    }
    return true;
  }
  function observe(state: GameState) {
    samples++; minimumAltitude = Math.min(minimumAltitude, state.player.position.y);
    const window = windows[Math.floor((state.tick - 1) / 600) * 10] ??= { samples: 0, rounds: 0, engagedMountTicks: 0 };
    window.samples++; let emitted = 0;
    for (const ship of state.ships) for (const [index, gun] of ship.guns.entries()) {
      const definition = NAVAL_MOUNTS[index]; if (!definition.weapon.endsWith('aa')) continue;
      const key = `${ship.id}:${gun.mountId}`, before = previous.get(key), volleys = gun.salvo - (before?.salvo ?? 0);
      const rounds = volleys * NAVAL_WEAPONS[definition.weapon].barrels;
      emitted += rounds; perMount[key] = (perMount[key] ?? 0) + rounds;
      categories[definition.weapon === 'heavy-aa' ? 'heavy' : 'light'] += rounds;
      if (rounds && gun.targetId !== null) targetRounds[gun.targetId] = (targetRounds[gun.targetId] ?? 0) + rounds;
      if (before?.target != null && gun.targetId !== null && before.target !== gun.targetId) retargets++;
      if (ship.health > 0 && gun.targetId !== null) {
        window.engagedMountTicks++;
        // This broad observable includes tracking, dispersion-arc and occlusion gates.
        // It is deliberately not labelled "tracking" without internal instrumentation.
        if (gun.cooldown <= 0 && !volleys) readyWithTargetNoVolleyTicks++;
      }
      previous.set(key, { target: gun.targetId, salvo: gun.salvo });
    }
    const actualShots = state.events.filter(e => e.type === 'shot' && state.ships.some(s => s.id === e.owner));
    assert.equal(emitted, actualShots.length, 'all real barrels fit the projectile pool');
    window.rounds += emitted;
    getFlightCameraPose(state.player, state.mode, camera.position, camera.quaternion); camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const live = state.bullets.filter(b => b.kind === 'aa');
    const visible = live.filter(b => segmentInFrustum(b.position.clone().addScaledVector(b.velocity, -.025), b.position)).length;
    aliveRoundSamples += live.length; maxLive = Math.max(maxLive, live.length);
    visibleRoundSamples += visible; maxVisible = Math.max(maxVisible, visible); if (!visible) zeroVisibleTicks++;
    shotsAtFrustumMuzzle += actualShots.filter(e => frustum.containsPoint(e.position)).length;
  }
  function finish(state: GameState) {
    return { name, seed: state.seed, tick: state.tick, time: state.elapsed, outcome: state.endReason, hp: state.player.health,
      total: categories.heavy + categories.light, categories, targetRounds, retargets, readyWithTargetNoVolleyTicks,
      minAltitude: round(minimumAltitude), maxLive, meanLive: round(aliveRoundSamples / samples),
      frustum: { mean: round(visibleRoundSamples / samples), max: maxVisible, zeroTickFraction: round(zeroVisibleTicks / samples), shotsAtMuzzle: shotsAtFrustumMuzzle },
      windows, perMount };
  }
  return { observe, finish };
}
const results: unknown[] = [];
for (const [name, pilot] of [
  ['default-touch', defaultTouchPilot()], ['stern-reload-touch', createTouchReloadPilot()],
  ['low-port-70m', lowPassPilot(-1, 70)], ['low-starboard-40m', lowPassPilot(1, 40)],
] as const) {
  const state = createGame(), metrics = collector(name); startGame(state); let held = neutral;
  for (let tick = 0; tick < 60 * 120 && state.phase === 'playing'; tick++) {
    if (tick % 6 === 0) held = { ...neutral, ...pilot(state) };
    stepGame(state, held); metrics.observe(state);
  }
  results.push(metrics.finish(state));
}
for (const count of [5, 7] as const) {
  const metrics = collector(`tactical-${count}-ships`);
  const { state } = flyLargeFleetMission(count, metrics.observe); results.push(metrics.finish(state));
}
const source = readFileSync(fileURLToPath(new URL('../src/naval.ts', import.meta.url)));
console.log(JSON.stringify({ navalSha256: createHash('sha256').update(source).digest('hex'),
  method: '60Hz simulation; default seed; first four routes use legal circular inputs held six ticks, large fleets use existing direct-input tactical pilot. Frustum clips actual tracer segments at 393x852/FOV64/near0.5/far22000; no depth, fog or GPU cadence test. No state edits.', results }, null, 2));
