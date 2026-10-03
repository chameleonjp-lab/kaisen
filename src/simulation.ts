import { Quaternion, Vector3 } from 'three';
import { assignTargets, targetFor, updateAI } from './ai';
import { autoFireTarget, getFlightAssist, predictedShotDirection } from './flight-assist';
import { advanceThrottle, clamp, createFlightController, forwardOf, MAX_SPEED, updateAircraftMotion, updatePlayerLoop } from './flight';
import type { FlightController } from './flight';
import { FIXED_DT, makeAircraft, makeFleet, MAX_BULLETS, MAX_EVENTS_PER_STEP, REINFORCEMENT_HEAL, REINFORCEMENT_TICK, ALLY_RESPAWN_TICKS, FRIENDLY_DAMAGE_PENALTY, FRIENDLY_KILL_PENALTY, PLAYER_BOMB_CAPACITY, PLAYER_TORPEDO_CAPACITY, PAYLOAD_RELOAD_TICKS, MAX_ORDNANCE, INITIAL_FLIGHT_ALTITUDE, resolveMissionConfig } from './mission';
import { beginPlayerReload, tickPlayerReload } from './ammunition';
import { aircraftDamageMultiplier, AIRCRAFT_BASE_DAMAGE } from './aircraft-damage';
import { releaseBomb, releaseTorpedo, checkTorpedoRelease, stepOrdnance, type OrdnanceKind } from './ordnance';
import { beginShipWreck, shipWreckPose, isShipObstacle } from './ship-wreck';
import { applyAircraftRoundToShip, segmentMountContact, exposedNavalMountPoint } from './naval-damage';
import { aircraftSeaContact } from './sea-contact';
import { oceanHeight } from './ocean';
import { segmentNavalHullEntry, shipCollisionBoxes, stepNavalGuns, CAPITAL_SHIP, NAVAL_MOUNTS, NAVAL_COLLISION_BOUNDS } from './naval';
import type { Aircraft, Bullet, CombatTarget, EndReason, FlightInput, GameEvent, GameMode, GameState, MissionConfig, Ship, Team } from './types';
export { FIXED_DT } from './mission';

const EPSILON = 1e-8;
const SHIP_PART_MIN = new Vector3().fromArray(NAVAL_COLLISION_BOUNDS.min);
const SHIP_PART_MAX = new Vector3().fromArray(NAVAL_COLLISION_BOUNDS.max);
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
  previousOrientations: Map<number, Quaternion>; pendingHeal: number; pendingBomb: boolean; pendingTorpedo: boolean; bombHeld: boolean; torpedoHeld: boolean;
}
const metadata = new WeakMap<GameState, SimulationMeta>();
function metaFor(state: GameState): SimulationMeta {
  const meta = metadata.get(state);
  if (!meta) throw new Error('Game state must be created with createGame');
  return meta;
}
function emit(state: GameState, type: GameEvent['type'], position: Vector3, owner: number, target?: CombatTarget, team?: Team): GameEvent | undefined {
  const meta = metaFor(state);
  if (state.events.length >= MAX_EVENTS_PER_STEP) {
    if (!['end', 'kill', 'reinforcement', 'ally-respawn', 'heal', 'reload-start', 'reload-complete', 'payload-release', 'payload-rejected', 'payload-reload', 'ordnance-impact', 'ordnance-dud', 'mount-destroyed'].includes(type)) return;
    const cosmetic = state.events.findIndex(e => e.type === 'shot' || e.type === 'hit' || e.type === 'splash');
    state.events.splice(Math.max(0, cosmetic), 1);
  }
  const event: GameEvent = { id: meta.nextEventId++, tick: state.tick, type, position: position.clone(), owner, target: target?.id, targetKind: target?.kind, targetTeam: target?.team, team };
  if (target?.kind === 'ship') event.localPosition = position.clone().sub(target.position).applyQuaternion(target.quaternion.clone().invert());
  if (type === 'kill' || type === 'ally-respawn') {
    const ownerSlot = state.allies.findIndex(ally => ally.id === owner);
    const targetSlot = state.allies.findIndex(ally => ally.id === target?.id);
    if (ownerSlot >= 0) event.ownerAllySlot = ownerSlot;
    if (targetSlot >= 0) event.targetAllySlot = targetSlot;
  }
  state.events.push(event);
  return event;
}

export function createGame(seed = 0x4b414953, config: Partial<MissionConfig> | GameMode = {}): GameState {
  const normalized = (Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0x4b414953) || 0x4b414953;
  let randomState = normalized;
  const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return (randomState >>> 0) / 0x100000000; };
  const mission = resolveMissionConfig(config);
  const player = makeAircraft(1, 'friendly', new Vector3(0, INITIAL_FLIGHT_ALTITUDE, 240), 0, 'player');
  const allies = [-1, 1, -2, 2].map((side, index) => makeAircraft(2 + index, 'friendly', new Vector3(side * 62, INITIAL_FLIGHT_ALTITUDE + index * 13, 280 + Math.abs(side) * 36), 0, index < 2 ? 'interceptor' : 'strike'));
  const enemies = Array.from({ length: 5 }, (_, index) => makeAircraft(10 + index, 'enemy', new Vector3((index - 2) * 115, 355 + (random() - 0.5) * 65, -350 - Math.abs(index - 2) * 85), 0));
  const state: GameState = {
    phase: 'ready', reinforcementsSpawned: false, mode: mission.mode, config: mission, seed: normalized, player, allies, enemies,
    ships: makeFleet(mission.shipCount), bullets: [], ordnance: [], events: [], elapsed: 0, tick: 0,
    stats: { playerAircraftKills: 0, playerShipKills: 0, allyAircraftKills: 0, allyShipKills: 0, shots: 0, hits: 0, loops: 0, damageTaken: 0, friendlyDamage: 0, friendlyKills: 0, score: 0 },
    result: null, endReason: null, deathCause: null, allyRespawnAt: {},
  };
  metadata.set(state, { nextEntityId: 1000, nextEventId: 1, accumulator: 0, pendingLoop: false, flight: createFlightController(player), deathReason: null, previousOrientations: new Map(), pendingHeal: 0, pendingBomb: false, pendingTorpedo: false, bombHeld: false, torpedoHeld: false });
  assignTargets(state);
  return state;
}
export function startGame(state: GameState): void { if (state.phase === 'ready') state.phase = 'playing'; }
export function pauseGame(state: GameState): void {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  const meta = metaFor(state); meta.accumulator = 0; meta.pendingLoop = false; meta.flight.loopHeld = false;
  meta.pendingBomb = false; meta.pendingTorpedo = false; meta.bombHeld = false; meta.torpedoHeld = false;
}
export function resumeGame(state: GameState): void { if (state.phase === 'paused') state.phase = 'playing'; }

function finish(state: GameState, reason: EndReason): void {
  if (state.phase === 'ended') return;
  state.phase = 'ended'; state.endReason = reason;
  state.result = Object.freeze({ outcome: reason === 'all-clear' ? 'victory' : 'defeat', time: state.elapsed,
    playerAircraftKills: state.stats.playerAircraftKills, playerShipKills: state.stats.playerShipKills,
    allyAircraftKills: state.stats.allyAircraftKills, allyShipKills: state.stats.allyShipKills,
    alliesSurvived: state.allies.filter(item => item.health > 0).length, score: state.stats.score, friendlyDamage: state.stats.friendlyDamage, friendlyKills: state.stats.friendlyKills });
  emit(state, 'end', state.player.position, state.player.id);
}
function registerDestruction(state: GameState, target: CombatTarget, owner: number, team?: Team): void {
  if (target.kind === 'ship') beginShipWreck(target, state.elapsed);
  emit(state, 'kill', target.position, owner, target, team);
  if (target.kind === 'aircraft' && target.team === 'friendly' && target !== state.player) {
    state.allyRespawnAt[target.id] = state.tick + ALLY_RESPAWN_TICKS;
    if (state.mode === 'normal' && owner === state.player.id && team === 'friendly') {
      state.stats.friendlyKills += 1;
      state.stats.score -= FRIENDLY_KILL_PENALTY;
    }
  }
  if (target.team !== 'enemy' || team !== 'friendly') return;
  if (owner === state.player.id) {
    if (target.kind === 'ship') state.stats.playerShipKills += 1;
    else {
      state.stats.playerAircraftKills += 1;
      if (target.generation === 'reinforcement') metaFor(state).pendingHeal += REINFORCEMENT_HEAL;
    }
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
const shipSolids = new WeakMap<Ship, { min: Vector3; max: Vector3 }[]>();
export function sweptShipHitTime(bullet: Pick<Bullet, 'previous' | 'position'>, ship: Ship, padding = 0, stepFraction = 1): number | null {
  const inverse = ship.quaternion.clone().invert();
  const start = bullet.previous.clone().sub(ship.previous).applyQuaternion(inverse);
  const endCenter = ship.previous.clone().lerp(ship.position, stepFraction);
  const end = bullet.position.clone().sub(endCenter).applyQuaternion(inverse);
  // Reject distant segments before allocating/testing detailed ship solids.
  const broadScale = new Vector3(ship.width / CAPITAL_SHIP.width, ship.height / CAPITAL_SHIP.height, ship.length / CAPITAL_SHIP.length);
  if (segmentBoxEntry(start, end, SHIP_PART_MIN.clone().multiply(broadScale).addScalar(-padding),
    SHIP_PART_MAX.clone().multiply(broadScale).addScalar(padding)) === null) return null;
  let boxes = shipSolids.get(ship);
  if (!boxes) { boxes = shipCollisionBoxes(ship); shipSolids.set(ship, boxes); }
  let first: number | null = segmentNavalHullEntry(start, end, padding);
  for (const { min, max } of boxes) {
    const time = segmentBoxEntry(start, end, padding ? min.clone().addScalar(-padding) : min, padding ? max.clone().addScalar(padding) : max);
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
    const seaContact = aircraftSeaContact(plane, meta.previousOrientations.get(plane.id) ?? plane.quaternion, state.elapsed - FIXED_DT, state.elapsed);
    if (seaContact) {
      plane.position.lerpVectors(plane.previous, plane.position, seaContact.fraction);
      plane.quaternion.slerpQuaternions(meta.previousOrientations.get(plane.id) ?? plane.quaternion, plane.quaternion.clone(), seaContact.fraction);
      destroy(state, plane, plane.id); emit(state, 'splash', seaContact.point, plane.id);
      if (plane === state.player) { meta.deathReason = 'sea'; state.deathCause = 'sea'; }
      continue;
    }
    for (const ship of state.ships) {
      if (!isShipObstacle(ship, state.elapsed) || plane.team === ship.team) continue;
      if (sweptShipHitTime(plane, ship, 3) !== null) {
        // A ram never damages a ship or creates a route to an all-clear.
        destroy(state, plane, ship.id, ship.team);
        if (plane === state.player) { meta.deathReason = 'collision'; state.deathCause = ship.health <= 0 ? 'ship-wreck-collision' : 'ship-collision'; }
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
    if (friendly === state.player) { meta.deathReason = 'collision'; state.deathCause = 'aircraft-collision'; }
  }
}

function appendBullet(state: GameState, bullet: Omit<Bullet, 'id' | 'previous'>): boolean {
  if (state.bullets.length >= MAX_BULLETS) return false;
  state.bullets.push({ ...bullet, id: metaFor(state).nextEntityId++, previous: bullet.position.clone(), distanceTravelled: 0 });
  if (bullet.owner === state.player.id) state.stats.shots += 1;
  const shot = emit(state, 'shot', bullet.position, bullet.owner, undefined, bullet.team);
  if (shot) shot.weapon = bullet.kind;
  if (shot && bullet.mountId) { shot.mountId = bullet.mountId; shot.detail = NAVAL_MOUNTS.find(mount => mount.id === bullet.mountId)?.weapon; }
  return true;
}
function fireAircraft(state: GameState, plane: Aircraft, firing: boolean, target: CombatTarget | null): void {
  plane.fireClock = Math.max(0, plane.fireClock - FIXED_DT);
  plane.cannonClock = Math.max(0, plane.cannonClock - FIXED_DT);
  if (!firing || plane.health <= 0) return;
  const player = plane === state.player;
  if (player && plane.reloadTicksRemaining > 0) return;
  const navalAim = target?.kind === 'ship' ? exposedNavalMountPoint(target, plane.position) : undefined;
  for (const kind of ['mg', 'cannon'] as const) {
    const clock = kind === 'mg' ? 'fireClock' : 'cannonClock';
    if (plane[clock] > EPSILON || (player && plane[kind] < 2)) continue;
    // Reserve both barrels together. No one-sided shot or ammo loss on saturation.
    if (state.bullets.length + 2 > MAX_BULLETS) continue;
    for (const side of [-1, 1]) {
      const forward = forwardOf(plane);
      const offset = kind === 'mg' ? new Vector3(side * 0.3, 0.52, -4.25) : new Vector3(side * 2.5, 0, -2.4);
      const position = plane.position.clone().add(offset.applyQuaternion(plane.quaternion));
      const speed = plane.speed + (kind === 'mg' ? 820 : 700);
      const direction = target ? predictedShotDirection(position, forward, target, speed, BULLET_LIFETIME, navalAim) : forward;
      if (!player) {
        // AI gunnery is finite-accuracy, even when its steering solution is ideal.
        const spread = plane.team === 'enemy' ? 0.022 : 0.012;
        direction.x += Math.sin(state.tick * 1.7 + plane.id * 3 + side) * spread;
        direction.y += Math.cos(state.tick * 1.3 + plane.id * 2 + side) * spread;
        direction.normalize();
      }
      appendBullet(state, { owner: plane.id, team: plane.team, kind, position, velocity: direction.multiplyScalar(speed), life: BULLET_LIFETIME,
        damage: AIRCRAFT_BASE_DAMAGE[player ? 'player' : plane.team === 'friendly' ? 'ally' : 'enemy'][kind] });
    }
    if (player) plane[kind] -= 2;
    plane[clock] = player ? (kind === 'mg' ? 1 / 12 : 1 / 4) : (kind === 'mg' ? 0.28 : 0.95);
  }
  if (player && beginPlayerReload(plane)) emit(state, 'reload-start', plane.position, plane.id);
}
function tickPayloads(state: GameState, plane: Aircraft): void {
  if (plane.health <= 0) return;
  plane.payloadCooldown = Math.max(0, plane.payloadCooldown - FIXED_DT);
  for (const kind of ['bomb', 'torpedo'] as const) {
    const clock = kind === 'bomb' ? 'bombReloadTicks' : 'torpedoReloadTicks';
    if (plane[clock] > 0 && --plane[clock] === 0) {
      plane[kind === 'bomb' ? 'bombs' : 'torpedoes'] = kind === 'bomb' ? PLAYER_BOMB_CAPACITY : PLAYER_TORPEDO_CAPACITY;
      if (plane === state.player) {
        const event = emit(state, 'payload-reload', plane.position, plane.id);
        if (event) event.weapon = kind;
      }
    }
  }
}
function firePayload(state: GameState, plane: Aircraft, kind: OrdnanceKind): void {
  if (plane.health <= 0) return;
  const player = plane === state.player, ammo = kind === 'bomb' ? 'bombs' : 'torpedoes';
  const clock = kind === 'bomb' ? 'bombReloadTicks' : 'torpedoReloadTicks';
  const reject = (reason: string) => {
    if (!player) return;
    const event = emit(state, 'payload-rejected', plane.position, plane.id);
    if (event) { event.weapon = kind; event.detail = reason; }
  };
  if (plane[ammo] <= 0 || plane[clock] > 0) { reject('reload'); return; }
  if (plane.payloadCooldown > 0) { reject('cooldown'); return; }
  if (state.ordnance.length >= MAX_ORDNANCE - (player ? 0 : 4)) { reject('capacity'); return; }
  if (kind === 'torpedo') {
    const check = checkTorpedoRelease(plane, state.elapsed);
    if (!check.allowed) { reject(check.reason ?? 'invalid'); return; }
  }
  const id = metaFor(state).nextEntityId;
  const round = kind === 'bomb' ? releaseBomb(id, plane) : releaseTorpedo(id, plane, state.elapsed);
  if (!round) { reject('invalid'); return; }
  metaFor(state).nextEntityId++;
  if (!player) round.damage *= .5;
  state.ordnance.push(round); plane[ammo]--; plane.payloadCooldown = .5;
  if (plane[ammo] === 0) plane[clock] = PAYLOAD_RELOAD_TICKS;
  if (player) state.stats.shots++;
  const event = emit(state, 'payload-release', round.position, plane.id, undefined, plane.team);
  if (event) event.weapon = kind;
}
function updatePayloads(state: GameState): void {
  const obstacles = state.ships.filter(ship => isShipObstacle(ship, state.elapsed)).map(ship => ({ ...ship, collisionActive: true }));
  state.ordnance = state.ordnance.filter(round => {
    const result = stepOrdnance(round, obstacles, state.elapsed - FIXED_DT, FIXED_DT);
    for (const outcome of result.outcomes) {
      const ship = 'shipId' in outcome ? state.ships.find(item => item.id === outcome.shipId) : undefined;
      if (outcome.type === 'impact' && ship && ship.health > 0 && round.team !== ship.team) {
        const actual = Math.min(ship.health, outcome.damage); ship.health -= actual;
        if (round.owner === state.player.id) state.stats.hits++;
        // Local blast damages nearby exposed mounts; hull damage is counted only once.
        const local = outcome.position.clone().sub(ship.position).applyQuaternion(ship.quaternion.clone().invert());
        ship.superstructureHealth = Math.max(0, ship.superstructureHealth - outcome.damage * .15);
        for (let index = 0; index < ship.guns.length; index++) {
          const gun = ship.guns[index]; if (gun.health <= 0) continue;
          const distance = local.distanceTo(new Vector3(...NAVAL_MOUNTS[index].pivot));
          const damage = outcome.damage * .15 * Math.max(0, 1 - distance / 38);
          const previous = gun.health; gun.health = Math.max(0, previous - damage);
          if (previous > 0 && gun.health <= 0) {
            const event = emit(state, 'mount-destroyed', outcome.position, round.owner, ship, round.team);
            if (event) event.mountId = gun.mountId;
          }
        }
        const event = emit(state, 'ordnance-impact', outcome.position, round.owner, ship, round.team);
        if (event) { event.weapon = round.kind; event.amount = actual; }
        if (ship.health <= 0) registerDestruction(state, ship, round.owner, round.team);
      } else if (outcome.type === 'impact' && ship) {
        const event = emit(state, 'ordnance-impact', outcome.position, round.owner, ship, round.team);
        if (event) { event.weapon = round.kind; event.amount = 0; event.detail = 'wreck'; }
      } else {
        const event = emit(state, outcome.type === 'splash' ? 'splash' : 'ordnance-dud', outcome.position, round.owner, ship, round.team);
        if (event) { event.weapon = round.kind; event.detail = outcome.type === 'dud' ? outcome.reason : undefined; }
      }
    }
    return result.active;
  });
}

function updateShips(state: GameState): void {
  for (const ship of state.ships) {
    if (ship.health <= 0) {
      if (ship.wreck) {
        ship.previous.copy(ship.position); ship.previousQuaternion.copy(ship.quaternion);
        shipWreckPose(ship.wreck, state.elapsed, ship.position, ship.quaternion);
        ship.velocity.copy(ship.wreck.velocity).multiplyScalar(Math.exp(-Math.max(0, state.elapsed - ship.wreck.since) / 8));
      }
      continue;
    }
    ship.previous.copy(ship.position); ship.previousQuaternion.copy(ship.quaternion); ship.age += FIXED_DT;
    ship.yaw += Math.sin(ship.age * .04 + ship.id) * .0035 * FIXED_DT;
    const roll = Math.sin(ship.age * .39 + ship.id) * .008;
    const pitch = Math.sin(ship.age * .29 + ship.id * .7) * .004;
    ship.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), ship.yaw)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll));
    const speed = ship.velocity.length();
    ship.velocity.set(-Math.sin(ship.yaw) * speed, 0, -Math.cos(ship.yaw) * speed);
    ship.position.addScaledVector(ship.velocity, FIXED_DT);
  }
}
function fireShip(state: GameState, ship: Ship): void {
  if (ship.health <= 0) return;
  const shots = stepNavalGuns(ship, [state.player, ...state.allies], state.tick, FIXED_DT);
  for (const shot of shots) appendBullet(state, { ...shot, owner: ship.id, team: 'enemy' });
}

function damageTarget(state: GameState, target: CombatTarget, bullet: Bullet, position: Vector3, mountIndex: number | null = null): void {
  if (target.health <= 0) {
    if (target.kind === 'ship') {
      const event = emit(state, 'hit', position, bullet.owner, target, bullet.team);
      if (event) { event.amount = 0; event.weapon = bullet.kind; event.detail = 'wreck'; }
    }
    return;
  }
  const multiplier = bullet.kind === 'aa' ? 1 : aircraftDamageMultiplier(bullet.kind, bullet.distanceTravelled ?? 0);
  if (target.kind === 'ship' && bullet.kind !== 'aa') {
    const local = position.clone().sub(target.position).applyQuaternion(target.quaternion.clone().invert());
    const result = applyAircraftRoundToShip(target, bullet.damage * multiplier, local, mountIndex);
    if (bullet.owner === state.player.id) state.stats.hits++;
    const hit = emit(state, 'hit', position, bullet.owner, target, bullet.team);
    if (hit) { hit.amount = result.partDamage; hit.armor = result.armor; hit.weapon = bullet.kind; }
    if (result.mountDestroyed && mountIndex !== null) {
      const event = emit(state, 'mount-destroyed', position, bullet.owner, target, bullet.team);
      if (event) event.mountId = target.guns[mountIndex].mountId;
    }
    return;
  }
  const requestedDamage = bullet.damage * multiplier;
  const damage = requestedDamage >= target.health - EPSILON ? target.health : requestedDamage; target.health -= damage;
  if (target === state.player) state.stats.damageTaken += damage;
  if (bullet.owner === state.player.id && target.team !== bullet.team) state.stats.hits += 1;
  if (state.mode === 'normal' && bullet.owner === state.player.id && target.team === 'friendly') {
    state.stats.friendlyDamage += damage;
    state.stats.score -= damage * FRIENDLY_DAMAGE_PENALTY;
  }
  if (target === state.player && target.health <= 0) {
    state.deathCause = bullet.kind === 'aa' ? 'naval-fire' : 'enemy-aircraft';
  }
  const hit = emit(state, 'hit', position, bullet.owner, target, bullet.team);
  if (hit) { hit.amount = damage; hit.weapon = bullet.kind; }
  const damaged = emit(state, 'damage', position, target.id, target, target.team);
  if (damaged) { damaged.amount = damage; damaged.weapon = bullet.kind; }
  if (target.health <= 0) registerDestruction(state, target, bullet.owner, bullet.team);
}
function updateBullets(state: GameState): void {
  const survivors: Bullet[] = [];
  const candidates: CombatTarget[] = [state.player, ...state.allies, ...state.enemies, ...state.ships];
  for (const bullet of state.bullets) {
    if (bullet.life <= 0) continue;
    bullet.previous.copy(bullet.position);
    const travel = Math.min(FIXED_DT, bullet.life);
    bullet.position.addScaledVector(bullet.velocity, travel);
    bullet.position.y -= 0.5 * (bullet.gravity ?? 0) * travel * travel;
    bullet.velocity.y -= (bullet.gravity ?? 0) * travel;
    bullet.life = Math.max(0, bullet.life - FIXED_DT);
    const startClearance = bullet.previous.y - oceanHeight(bullet.previous.x, bullet.previous.z, state.elapsed - FIXED_DT);
    const endClearance = bullet.position.y - oceanHeight(bullet.position.x, bullet.position.z, state.elapsed - FIXED_DT + travel);
    const seaTime = startClearance <= 0 ? 0 : endClearance <= 0 ? startClearance / (startClearance - endClearance) : Infinity;
    let target: CombatTarget | null = null, first = seaTime, mountIndex: number | null = null;
    for (const candidate of candidates) {
      if ((candidate.kind === 'ship' ? !isShipObstacle(candidate, state.elapsed) : candidate.health <= 0) || candidate.id === bullet.owner) continue;
      // Other hulls stop their fleet's AA. Only the Normal player's rounds damage allies; AI retains team protection.
      if (candidate.team === bullet.team && !(bullet.kind === 'aa' && candidate.kind === 'ship')
        && !(state.mode === 'normal' && bullet.owner === state.player.id && bullet.team === 'friendly' && candidate.kind === 'aircraft')) continue;
      let hit = candidate.kind === 'ship' ? sweptShipHitTime(bullet, candidate, 0, travel / FIXED_DT) : sweptAircraftHitTime(bullet, candidate, travel / FIXED_DT);
      let partIndex: number | null = null;
      if (candidate.kind === 'ship') {
        const inverse = candidate.quaternion.clone().invert();
        const scale = new Vector3(candidate.width / CAPITAL_SHIP.width, candidate.height / CAPITAL_SHIP.height, candidate.length / CAPITAL_SHIP.length);
        const start = bullet.previous.clone().sub(candidate.previous).applyQuaternion(inverse).divide(scale);
        const end = bullet.position.clone().sub(candidate.previous.clone().lerp(candidate.position, travel / FIXED_DT)).applyQuaternion(inverse).divide(scale);
        const part = segmentBoxEntry(start, end, SHIP_PART_MIN, SHIP_PART_MAX) === null ? null : segmentMountContact(start, end, candidate);
        if (part && (hit === null || part.fraction <= hit + 1e-8)) { hit = part.fraction; partIndex = part.index; }
      }
      if (hit !== null && (hit < first || (hit === first && target !== null && candidate.id < target.id))) { target = candidate; first = hit; mountIndex = partIndex; }
    }
    const segmentDistance = bullet.previous.distanceTo(bullet.position);
    bullet.distanceTravelled = (bullet.distanceTravelled ?? 0) + segmentDistance * (Number.isFinite(first) ? first : 1);
    if (target) {
      const point = bullet.previous.clone().lerp(bullet.position, first);
      if (target.team !== bullet.team || (state.mode === 'normal' && bullet.owner === state.player.id && target.kind === 'aircraft' && bullet.team === 'friendly')) damageTarget(state, target, bullet, point, mountIndex);
      else emit(state, 'hit', point, bullet.owner, target, bullet.team);
      continue;
    }
    if (seaTime !== Infinity) { emit(state, 'splash', bullet.previous.clone().lerp(bullet.position, seaTime), bullet.owner); continue; }
    if (bullet.life > 0) survivors.push(bullet);
  }
  state.bullets = survivors;
}

/** Every 40 active seconds, replace only dead enemy slots up to five living aircraft. */
function spawnReinforcements(state: GameState): void {
  if (state.tick % REINFORCEMENT_TICK !== 0) return;
  const missing = state.enemies.filter(enemy => enemy.health <= 0);
  if (!missing.length) return;
  state.reinforcementsSpawned = true;
  const forward = forwardOf(state.player);
  const horizontal = new Vector3(forward.x, 0, forward.z).normalize();
  if (horizontal.lengthSq() < EPSILON) horizontal.set(0, 0, -1);
  const right = new Vector3(-horizontal.z, 0, horizontal.x);
  for (let index = 0; index < missing.length; index++) {
    const position = state.player.position.clone().addScaledVector(horizontal, 1400).addScaledVector(right, (index - (missing.length - 1) / 2) * 180);
    position.y = Math.max(220, state.player.position.y + 100 + index * 35);
    const yaw = Math.atan2(position.x - state.player.position.x, position.z - state.player.position.z);
    const enemy = makeAircraft(metaFor(state).nextEntityId++, 'enemy', position, yaw);
    enemy.generation = 'reinforcement';
    const slot = state.enemies.indexOf(missing[index]);
    metaFor(state).previousOrientations.delete(missing[index].id);
    state.enemies[slot] = enemy;
  }
  const event = emit(state, 'reinforcement', state.player.position, state.player.id);
  if (event) event.amount = missing.length;
}

function respawnAllies(state: GameState): void {
  for (let slot = 0; slot < state.allies.length; slot++) {
    const previous = state.allies[slot], due = state.allyRespawnAt[previous.id];
    if (previous.health > 0 || due === undefined || state.tick < due) continue;
    const forward = forwardOf(state.player), side = slot % 2 === 0 ? -1 : 1;
    const right = new Vector3(-forward.z, 0, forward.x).normalize();
    const position = state.player.position.clone().addScaledVector(forward, -350 - slot * 50).addScaledVector(right, side * 150);
    position.y = Math.max(220, state.player.position.y + 80 + slot * 30);
    const replacement = makeAircraft(metaFor(state).nextEntityId++, 'friendly', position, state.player.yaw, previous.role);
    // A new ID prevents old bullets/targets from becoming the resurrected aircraft.
    state.allies[slot] = replacement;
    delete state.allyRespawnAt[previous.id];
    metaFor(state).previousOrientations.delete(previous.id);
    emit(state, 'ally-respawn', replacement.position, replacement.id);
  }
}

function fixedStep(state: GameState, input: FlightInput): void {
  const meta = metaFor(state), player = state.player;
  if (player.health <= 0) { finish(state, meta.deathReason ?? 'shot-down'); return; }
  state.tick += 1; state.elapsed = state.tick * FIXED_DT;
  respawnAllies(state);
  meta.pendingHeal = 0;
  for (const plane of [player, ...state.allies, ...state.enemies]) {
    let previous = meta.previousOrientations.get(plane.id);
    if (!previous) { previous = new Quaternion(); meta.previousOrientations.set(plane.id, previous); }
    previous.copy(plane.quaternion);
  }
  for (const plane of [player, ...state.allies]) tickPayloads(state, plane);
  if (tickPlayerReload(player)) emit(state, 'reload-complete', player.position, player.id);
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
  const bombPressed = Boolean(input.bomb) && !meta.bombHeld;
  const torpedoPressed = Boolean(input.torpedo) && !meta.torpedoHeld;
  meta.bombHeld = Boolean(input.bomb); meta.torpedoHeld = Boolean(input.torpedo);
  if (bombPressed) firePayload(state, player, 'bomb');
  if (torpedoPressed) firePayload(state, player, 'torpedo');
  for (const plane of state.allies) if (plane.aiBomb) firePayload(state, plane, 'bomb');
  const autoTarget = autoFireTarget(player, targets, state.mode, input.viewAspect);
  fireAircraft(state, player, state.mode === 'easy' ? autoTarget !== null : input.fire, autoTarget);
  for (const plane of [...state.allies, ...state.enemies]) fireAircraft(state, plane, plane.aiFire, targetFor(state, plane.targetId));
  for (const ship of state.ships) fireShip(state, ship);
  updateBullets(state); updatePayloads(state);
  // A kill bonus cannot resurrect a plane killed by any round in this same tick.
  if (player.health > 0 && meta.pendingHeal > 0) {
    const amount = Math.min(meta.pendingHeal, player.maxHealth - player.health);
    player.health += amount;
    if (amount > 0) {
      const event = emit(state, 'heal', player.position, player.id);
      if (event) event.amount = amount;
    }
  }
  // Resolve every in-flight round before choosing the outcome. Death wins a simultaneous all-clear.
  if (player.health <= 0) finish(state, meta.deathReason ?? 'shot-down');
  else if (state.enemies.every(item => item.health <= 0) && state.ships.every(item => item.health <= 0)) finish(state, 'all-clear');
  else spawnReinforcements(state);
}

/** Fixed 60 Hz. Suspended frame gaps are ignored; callers pause on blur/visibility changes. */
export function stepGame(state: GameState, rawInput: FlightInput, dt = FIXED_DT): void {
  if (state.phase !== 'playing' || !Number.isFinite(dt) || dt <= 0 || dt > 0.25) return;
  const meta = metaFor(state);
  meta.accumulator += dt;
  meta.pendingLoop ||= Boolean(rawInput.loop);
  meta.pendingBomb ||= Boolean(rawInput.bomb); meta.pendingTorpedo ||= Boolean(rawInput.torpedo);
  if (meta.accumulator + EPSILON < FIXED_DT) return;
  state.events.length = 0;
  const input: FlightInput = { ...rawInput,
    turn: clamp(Number.isFinite(rawInput.turn) ? rawInput.turn : 0, -1, 1),
    climb: clamp(Number.isFinite(rawInput.climb) ? rawInput.climb : 0, -1, 1), loop: meta.pendingLoop, bomb: meta.pendingBomb, torpedo: meta.pendingTorpedo };
  meta.pendingLoop = false; meta.pendingBomb = false; meta.pendingTorpedo = false;
  while (meta.accumulator + EPSILON >= FIXED_DT && state.phase === 'playing') {
    meta.accumulator = Math.max(0, meta.accumulator - FIXED_DT);
    fixedStep(state, input);
    input.loop = Boolean(rawInput.loop); input.bomb = Boolean(rawInput.bomb); input.torpedo = Boolean(rawInput.torpedo);
  }
}
