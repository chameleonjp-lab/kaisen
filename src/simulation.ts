import { Vector3 } from 'three';
import { assignTargets, targetFor, updateAI } from './ai';
import { autoFireTarget, getFlightAssist, predictedShotDirection } from './flight-assist';
import { advanceThrottle, clamp, createFlightController, forwardOf, MAX_SPEED, updateAircraftMotion, updatePlayerLoop } from './flight';
import type { FlightController } from './flight';
import { AA_COOLDOWN, AA_MUZZLE_SPEED, AA_RANGE, FIXED_DT, makeAircraft, makeFleet, MAX_BULLETS, MAX_EVENTS_PER_STEP, resolveMissionConfig, SEA_COLLISION_HEIGHT } from './mission';
import type { Aircraft, Bullet, CombatTarget, EndReason, FlightInput, GameEvent, GameMode, GameState, MissionConfig, Ship, Team } from './types';
export { FIXED_DT } from './mission';

const EPSILON = 1e-8;
const BULLET_LIFETIME = 1.5;
const HIT_SPHERES = [
  { center: new Vector3(0, 0, -3.8), radius: 3 },
  { center: new Vector3(0, 0, 0), radius: 4.6 },
  { center: new Vector3(0, 0, 3.4), radius: 2.7 },
  { center: new Vector3(4, 0, 0.25), radius: 2.1 },
  { center: new Vector3(-4, 0, 0.25), radius: 2.1 },
];
interface SimulationMeta {
  nextEntityId: number; nextEventId: number; accumulator: number; pendingLoop: boolean;
  flight: FlightController; deathReason: EndReason | null;
}
const metadata = new WeakMap<GameState, SimulationMeta>();
function metaFor(state: GameState): SimulationMeta {
  const meta = metadata.get(state);
  if (!meta) throw new Error('Game state must be created with createGame');
  return meta;
}
function emit(state: GameState, type: GameEvent['type'], position: Vector3, owner: number, target?: CombatTarget, team?: Team): void {
  const meta = metaFor(state);
  if (state.events.length >= MAX_EVENTS_PER_STEP) {
    if (type !== 'end' && type !== 'kill') return;
    state.events.shift();
  }
  state.events.push({ id: meta.nextEventId++, type, position: position.clone(), owner, target: target?.id, targetKind: target?.kind, team });
}

export function createGame(seed = 0x4b414953, config: Partial<MissionConfig> | GameMode = {}): GameState {
  const normalized = (Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0x4b414953) || 0x4b414953;
  let randomState = normalized;
  const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 0x100000000; };
  const mission = resolveMissionConfig(config);
  const player = makeAircraft(1, 'friendly', new Vector3(0, 350, 240), 0, 'player');
  const allies = [-1, 1, -2, 2].map((side, index) => makeAircraft(2 + index, 'friendly', new Vector3(side * 62, 350 + index * 13, 280 + Math.abs(side) * 36), 0, index < 2 ? 'interceptor' : 'strike'));
  const enemies = Array.from({ length: 5 }, (_, index) => makeAircraft(10 + index, 'enemy', new Vector3((index - 2) * 115, 355 + (random() - 0.5) * 65, -350 - Math.abs(index - 2) * 85), 0));
  const state: GameState = {
    phase: 'ready', mode: mission.mode, config: mission, seed: normalized, player, allies, enemies,
    ships: makeFleet(mission.shipCount), bullets: [], events: [], elapsed: 0, tick: 0,
    stats: { playerAircraftKills: 0, playerShipKills: 0, allyAircraftKills: 0, allyShipKills: 0, shots: 0, hits: 0, loops: 0, damageTaken: 0 },
    result: null, endReason: null,
  };
  metadata.set(state, { nextEntityId: 1000, nextEventId: 1, accumulator: 0, pendingLoop: false, flight: createFlightController(player), deathReason: null });
  assignTargets(state);
  return state;
}
export function startGame(state: GameState): void { if (state.phase === 'ready') state.phase = 'playing'; }
export function pauseGame(state: GameState): void {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  const meta = metaFor(state); meta.accumulator = 0; meta.pendingLoop = false; meta.flight.loopHeld = false;
}
export function resumeGame(state: GameState): void { if (state.phase === 'paused') state.phase = 'playing'; }

function finish(state: GameState, reason: EndReason): void {
  if (state.phase === 'ended') return;
  state.phase = 'ended'; state.endReason = reason;
  state.result = Object.freeze({ outcome: reason === 'all-clear' ? 'victory' : 'defeat', time: state.elapsed,
    playerAircraftKills: state.stats.playerAircraftKills, playerShipKills: state.stats.playerShipKills,
    allyAircraftKills: state.stats.allyAircraftKills, allyShipKills: state.stats.allyShipKills,
    alliesSurvived: state.allies.filter(item => item.health > 0).length });
  emit(state, 'end', state.player.position, state.player.id);
}
function registerDestruction(state: GameState, target: CombatTarget, owner: number, team?: Team): void {
  emit(state, 'kill', target.position, owner, target, team);
  if (target.team !== 'enemy' || team !== 'friendly') return;
  if (owner === state.player.id) {
    if (target.kind === 'ship') state.stats.playerShipKills += 1;
    else state.stats.playerAircraftKills += 1;
  } else {
    if (target.kind === 'ship') state.stats.allyShipKills += 1;
    else state.stats.allyAircraftKills += 1;
  }
}
function destroy(state: GameState, target: CombatTarget, owner: number, team?: Team): void {
  if (target.health <= 0) return;
  target.health = 0;
  registerDestruction(state, target, owner, team);
}

/** Earliest segment/sphere time, including a start inside the shape. */
export function segmentSphereEntry(start: Vector3, end: Vector3, radius: number): number | null {
  const delta = end.clone().sub(start); const a = delta.lengthSq(); const c = start.lengthSq() - radius * radius;
  if (c <= 0) return 0;
  if (a < EPSILON) return null;
  const b = 2 * start.dot(delta); const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const entry = (-b - Math.sqrt(discriminant)) / (2 * a);
  return entry >= 0 && entry <= 1 ? entry : null;
}
export function sweptAircraftHitTime(bullet: Bullet, aircraft: Aircraft, stepFraction = 1): number | null {
  const endCenter = aircraft.previous.clone().lerp(aircraft.position, stepFraction);
  if (segmentSphereEntry(bullet.previous.clone().sub(aircraft.previous), bullet.position.clone().sub(endCenter), 8) === null) return null;
  let first: number | null = null;
  for (const sphere of HIT_SPHERES) {
    const offset = sphere.center.clone().applyQuaternion(aircraft.quaternion);
    const start = bullet.previous.clone().sub(aircraft.previous).sub(offset);
    const end = bullet.position.clone().sub(endCenter).sub(offset);
    const time = segmentSphereEntry(start, end, sphere.radius);
    if (time !== null && (first === null || time < first)) first = time;
  }
  return first;
}
/** Slab intersection in ship-local coordinates; no sphere pretending to be a long hull. */
export function segmentBoxEntry(start: Vector3, end: Vector3, min: Vector3, max: Vector3): number | null {
  let enter = 0, exit = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < EPSILON) { if (start[axis] < min[axis] || start[axis] > max[axis]) return null; continue; }
    let near = (min[axis] - start[axis]) / delta; let far = (max[axis] - start[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near); exit = Math.min(exit, far);
    if (enter > exit) return null;
  }
  return enter;
}
export function sweptShipHitTime(bullet: Pick<Bullet, 'previous' | 'position'>, ship: Ship, padding = 0, stepFraction = 1): number | null {
  const inverse = ship.quaternion.clone().invert();
  const start = bullet.previous.clone().sub(ship.previous).applyQuaternion(inverse);
  const endCenter = ship.previous.clone().lerp(ship.position, stepFraction);
  const end = bullet.position.clone().sub(endCenter).applyQuaternion(inverse);
  const boxes = [
    [new Vector3(-ship.width / 2 - padding, -padding, -ship.length / 2 - padding), new Vector3(ship.width / 2 + padding, ship.height * 0.36 + padding, ship.length / 2 + padding)],
    [new Vector3(-ship.width * 0.3 - padding, ship.height * 0.3 - padding, -ship.length * 0.22 - padding), new Vector3(ship.width * 0.3 + padding, ship.height + padding, ship.length * 0.2 + padding)],
  ];
  let first: number | null = null;
  for (const [min, max] of boxes) {
    const time = segmentBoxEntry(start, end, min, max);
    if (time !== null && (first === null || time < first)) first = time;
  }
  return first;
}
export function aircraftContactTime(a: Aircraft, b: Aircraft): number | null {
  if (segmentSphereEntry(a.previous.clone().sub(b.previous), a.position.clone().sub(b.position), 16) === null) return null;
  let first: number | null = null;
  for (const sphereA of HIT_SPHERES) for (const sphereB of HIT_SPHERES) {
    const offset = sphereA.center.clone().applyQuaternion(a.quaternion).sub(sphereB.center.clone().applyQuaternion(b.quaternion));
    const time = segmentSphereEntry(a.previous.clone().sub(b.previous).add(offset), a.position.clone().sub(b.position).add(offset), sphereA.radius + sphereB.radius);
    if (time !== null && (first === null || time < first)) first = time;
  }
  return first;
}

function resolveContacts(state: GameState): void {
  const meta = metaFor(state);
  const planes = [state.player, ...state.allies, ...state.enemies];
  for (const plane of planes) {
    if (plane.health <= 0) continue;
    if (plane.position.y <= SEA_COLLISION_HEIGHT) {
      destroy(state, plane, plane.id); emit(state, 'splash', plane.position, plane.id);
      if (plane === state.player) meta.deathReason = 'sea';
      continue;
    }
    for (const ship of state.ships) {
      if (ship.health <= 0 || plane.team === ship.team) continue;
      if (sweptShipHitTime(plane, ship, 3) !== null) {
        // A ram never damages a ship or creates a route to an all-clear.
        destroy(state, plane, ship.id, ship.team);
        if (plane === state.player) meta.deathReason = 'collision';
        break;
      }
    }
  }
  for (const friendly of [state.player, ...state.allies]) for (const enemy of state.enemies) {
    if (friendly.health <= 0 || enemy.health <= 0) continue;
    const time = aircraftContactTime(friendly, enemy);
    if (time === null) continue;
    friendly.position.lerpVectors(friendly.previous, friendly.position, time);
    enemy.position.lerpVectors(enemy.previous, enemy.position, time);
    destroy(state, friendly, enemy.id, 'enemy'); destroy(state, enemy, friendly.id, 'friendly');
    if (friendly === state.player) meta.deathReason = 'collision';
  }
}

function appendBullet(state: GameState, bullet: Omit<Bullet, 'id' | 'previous'>): void {
  if (state.bullets.length >= MAX_BULLETS) return;
  state.bullets.push({ ...bullet, id: metaFor(state).nextEntityId++, previous: bullet.position.clone() });
  if (bullet.owner === state.player.id) state.stats.shots += 1;
  emit(state, 'shot', bullet.position, bullet.owner, undefined, bullet.team);
}
function fireAircraft(state: GameState, plane: Aircraft, firing: boolean, target: CombatTarget | null): void {
  plane.fireClock = Math.max(0, plane.fireClock - FIXED_DT);
  plane.cannonClock = Math.max(0, plane.cannonClock - FIXED_DT);
  if (!firing || plane.health <= 0) return;
  const player = plane === state.player;
  for (const kind of ['mg', 'cannon'] as const) {
    const clock = kind === 'mg' ? 'fireClock' : 'cannonClock';
    if (plane[clock] > EPSILON) continue;
    for (const side of [-1, 1]) {
      const forward = forwardOf(plane);
      const offset = kind === 'mg' ? new Vector3(side * 0.3, 0.52, -4.25) : new Vector3(side * 2.5, 0, -2.4);
      const position = plane.position.clone().add(offset.applyQuaternion(plane.quaternion));
      const speed = plane.speed + (kind === 'mg' ? 820 : 700);
      const direction = target ? predictedShotDirection(position, forward, target, speed, BULLET_LIFETIME) : forward;
      if (!player) {
        // AI gunnery is finite-accuracy, even when its steering solution is ideal.
        const spread = plane.team === 'enemy' ? 0.022 : 0.012;
        direction.x += Math.sin(state.tick * 1.7 + plane.id * 3 + side) * spread;
        direction.y += Math.cos(state.tick * 1.3 + plane.id * 2 + side) * spread;
        direction.normalize();
      }
      appendBullet(state, { owner: plane.id, team: plane.team, kind, position, velocity: direction.multiplyScalar(speed), life: BULLET_LIFETIME,
        damage: player ? (kind === 'mg' ? 5 : 25) : plane.team === 'friendly' ? (kind === 'mg' ? 3 : 12) : (kind === 'mg' ? 2 : 8) });
    }
    plane[clock] = player ? (kind === 'mg' ? 1 / 12 : 1 / 4) : (kind === 'mg' ? 0.28 : 0.95);
  }
}
function updateShips(state: GameState): void {
  for (const ship of state.ships) {
    if (ship.health <= 0) continue;
    ship.previous.copy(ship.position); ship.age += FIXED_DT;
    ship.position.addScaledVector(ship.velocity, FIXED_DT);
    ship.fireClock = Math.max(0, ship.fireClock - FIXED_DT);
  }
}
function fireShip(state: GameState, ship: Ship): void {
  if (ship.health <= 0 || ship.fireClock > EPSILON) return;
  const candidates = [state.player, ...state.allies].filter(item => item.health > 0 && item.position.distanceTo(ship.position) < AA_RANGE);
  candidates.sort((a, b) => a.position.distanceToSquared(ship.position) - b.position.distanceToSquared(ship.position) || a.id - b.id);
  const target = candidates[0]; ship.targetId = target?.id ?? null;
  if (!target) return;
  ship.fireClock = AA_COOLDOWN;
  const position = ship.position.clone().add(new Vector3(0, ship.height + 2, 0));
  const duration = Math.min(2.6, position.distanceTo(target.position) / AA_MUZZLE_SPEED);
  const aim = target.position.clone().addScaledVector(forwardOf(target), target.speed * duration * 0.82);
  // Deterministic, modest AA dispersion. The launch direction never changes afterward.
  aim.x += Math.sin(state.tick * 0.7 + ship.id) * 12; aim.y += Math.cos(state.tick * 0.4 + ship.id) * 7;
  appendBullet(state, { owner: ship.id, team: 'enemy', kind: 'aa', position, velocity: aim.sub(position).normalize().multiplyScalar(AA_MUZZLE_SPEED), life: 3.6, damage: 8 });
}

function damageTarget(state: GameState, target: CombatTarget, bullet: Bullet, position: Vector3): void {
  if (target.health <= 0) return;
  const damage = Math.min(target.health, bullet.damage); target.health -= damage;
  if (target === state.player) state.stats.damageTaken += damage;
  if (bullet.owner === state.player.id) state.stats.hits += 1;
  emit(state, 'hit', position, bullet.owner, target, bullet.team);
  emit(state, 'damage', position, target.id, target, target.team);
  if (target.health <= 0) registerDestruction(state, target, bullet.owner, bullet.team);
}
function updateBullets(state: GameState): void {
  const survivors: Bullet[] = [];
  const candidates: CombatTarget[] = [state.player, ...state.allies, ...state.enemies, ...state.ships];
  for (const bullet of state.bullets) {
    if (bullet.life <= 0) continue;
    bullet.previous.copy(bullet.position);
    const travel = Math.min(FIXED_DT, bullet.life);
    bullet.position.addScaledVector(bullet.velocity, travel); bullet.life = Math.max(0, bullet.life - FIXED_DT);
    const seaTime = bullet.previous.y <= 0 ? 0 : bullet.position.y <= 0 ? bullet.previous.y / (bullet.previous.y - bullet.position.y) : Infinity;
    let target: CombatTarget | null = null, first = seaTime;
    for (const candidate of candidates) {
      if (candidate.health <= 0 || candidate.team === bullet.team || candidate.id === bullet.owner) continue;
      const hit = candidate.kind === 'ship' ? sweptShipHitTime(bullet, candidate, 0, travel / FIXED_DT) : sweptAircraftHitTime(bullet, candidate, travel / FIXED_DT);
      if (hit !== null && (hit < first || (hit === first && target !== null && candidate.id < target.id))) { target = candidate; first = hit; }
    }
    if (target) { damageTarget(state, target, bullet, bullet.previous.clone().lerp(bullet.position, first)); continue; }
    if (seaTime !== Infinity) { emit(state, 'splash', bullet.previous.clone().lerp(bullet.position, seaTime), bullet.owner); continue; }
    if (bullet.life > 0) survivors.push(bullet);
  }
  state.bullets = survivors;
}

function fixedStep(state: GameState, input: FlightInput): void {
  const meta = metaFor(state), player = state.player;
  if (player.health <= 0) { finish(state, meta.deathReason ?? 'shot-down'); return; }
  state.tick += 1; state.elapsed = state.tick * FIXED_DT;
  player.previous.copy(player.position); player.age += FIXED_DT;
  const targets: CombatTarget[] = [...state.enemies, ...state.ships].filter(item => item.health > 0);
  const assist = getFlightAssist(player, targets, input, state.mode);
  const slew = (current: number, target: number, rate: number) => current + clamp(target - current, -rate * FIXED_DT, rate * FIXED_DT);
  const manual = Math.max(Math.abs(input.turn), Math.abs(input.climb)) >= 0.35;
  const flight = meta.flight;
  flight.assistTurn = manual ? 0 : slew(flight.assistTurn, assist.turn - input.turn, 2.5);
  flight.assistClimb = manual ? 0 : slew(flight.assistClimb, assist.climb - input.climb, 1.5);
  if (flight.assistTurn * input.turn < 0) flight.assistTurn = 0;
  if (flight.assistClimb * input.climb < 0) flight.assistClimb = 0;
  flight.responseMultiplier = slew(flight.responseMultiplier, assist.responseMultiplier, 2.5);
  const adjusted = { ...input, turn: input.turn + flight.assistTurn, climb: input.climb + flight.assistClimb };
  const loopPressed = input.loop && !flight.loopHeld; flight.loopHeld = input.loop;
  const completed = updatePlayerLoop(player, flight, adjusted, input, loopPressed, FIXED_DT, advanceThrottle(flight, input, state.mode, FIXED_DT), MAX_SPEED, flight.responseMultiplier);
  if (completed) { state.stats.loops += 1; emit(state, 'loop', player.position, player.id); }
  assignTargets(state);
  for (const plane of [...state.allies, ...state.enemies]) {
    if (plane.health <= 0) continue;
    plane.previous.copy(plane.position); plane.age += FIXED_DT;
    updateAI(state, plane, FIXED_DT);
    updateAircraftMotion(plane, plane.aiTurn, plane.aiClimb, FIXED_DT, plane.aiPhase === 'extend' ? 118 : 112);
  }
  updateShips(state); resolveContacts(state);
  const autoTarget = autoFireTarget(player, targets, state.mode, input.viewAspect);
  fireAircraft(state, player, state.mode === 'easy' ? autoTarget !== null : input.fire, autoTarget);
  for (const plane of [...state.allies, ...state.enemies]) fireAircraft(state, plane, plane.aiFire, targetFor(state, plane.targetId));
  for (const ship of state.ships) fireShip(state, ship);
  updateBullets(state);
  // Resolve every in-flight round before choosing the outcome. Death wins a simultaneous all-clear.
  if (player.health <= 0) finish(state, meta.deathReason ?? 'shot-down');
  else if (state.enemies.every(item => item.health <= 0) && state.ships.every(item => item.health <= 0)) finish(state, 'all-clear');
}

/** Fixed 60 Hz. Suspended frame gaps are ignored; callers pause on blur/visibility changes. */
export function stepGame(state: GameState, rawInput: FlightInput, dt = FIXED_DT): void {
  if (state.phase !== 'playing' || !Number.isFinite(dt) || dt <= 0 || dt > 0.25) return;
  const meta = metaFor(state);
  meta.accumulator += dt;
  meta.pendingLoop ||= Boolean(rawInput.loop);
  if (meta.accumulator + EPSILON < FIXED_DT) return;
  state.events.length = 0;
  const input: FlightInput = { ...rawInput,
    turn: clamp(Number.isFinite(rawInput.turn) ? rawInput.turn : 0, -1, 1),
    climb: clamp(Number.isFinite(rawInput.climb) ? rawInput.climb : 0, -1, 1), loop: meta.pendingLoop };
  meta.pendingLoop = false;
  while (meta.accumulator + EPSILON >= FIXED_DT && state.phase === 'playing') {
    meta.accumulator = Math.max(0, meta.accumulator - FIXED_DT);
    fixedStep(state, input);
    input.loop = Boolean(rawInput.loop);
  }
}
