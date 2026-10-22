import { BOMB_BLAST, bombBlastDamage, closestBombHullPoint } from './bomb-blast';
import { Quaternion, Vector3 } from 'three';
import { CAPITAL_SHIP, NAVAL_GRAVITY, NAVAL_COLLISION_BOUNDS, segmentNavalHullEntry, shipCollisionBoxes } from './naval';
import type { NavalMountState } from './naval';
import { oceanHeight } from './ocean';
import type { Aircraft, Ship, Team } from './types';
import { segmentMountContact } from './naval-damage';
import { FIXED_DT } from './mission';
import { advanceShipMotion } from './ship-motion';
import { isShipObstacle } from './ship-wreck';

/** Provisional game tuning, not a historical weapon performance model. Metres/seconds. */
export const ORDNANCE_TUNING = Object.freeze({
  bomb: Object.freeze({ damage: 1800, life: 30, armingAge: .25 }),
  torpedo: Object.freeze({ damage: 2000, life: 70, waterSpeed: 24, depth: 1.5,
    armingDistance: 80, minReleaseAltitude: 15, maxReleaseAltitude: 90,
    maxReleaseSpeed: 125, maxReleasePitch: .25, maxReleaseBank: .4,
    maxEntryVerticalSpeed: 60, diveSpeed: 6 }),
  releaseOffset: 1.2, maxStep: 1 / 30,
});
export type OrdnanceKind = 'bomb' | 'torpedo';
export interface OrdnanceRound {
  id: number; owner: number; team: Team; kind: OrdnanceKind; phase: 'air' | 'water';
  position: Vector3; previous: Vector3; velocity: Vector3;
  life: number; age: number; waterDistance: number; damage: number;
  /** Captured on release; losing this ship permanently leaves the last water heading. */
  targetShipId?: number; guidanceLost?: boolean;
}
export type OrdnanceAircraft = Pick<Aircraft, 'id' | 'team' | 'position' | 'quaternion' | 'speed' | 'pitch' | 'bank'>;
/** Previous/current transforms bracket this caller-owned fixed step. No HP is mutated here. */
export interface OrdnanceShip {
  collisionActive?: boolean;
  id: number; health: number; position: Vector3; previous: Vector3;
  quaternion: Quaternion; previousQuaternion?: Quaternion;
  length: number; width: number; height: number; guns?: NavalMountState[];
}
export type TorpedoReleaseRejection = 'invalid' | 'altitude' | 'speed' | 'pitch' | 'bank' | 'no-target' | 'out-of-range' | 'unsafe-entry';
export interface TorpedoReleaseCheck { allowed: boolean; reason: TorpedoReleaseRejection | null; altitude: number; }
export interface GuidedTorpedoReleaseCheck extends TorpedoReleaseCheck { targetShipId: number | null; }
type OutcomeBase = { kind: OrdnanceKind; position: Vector3 };
export type OrdnanceOutcome =
  | (OutcomeBase & { type: 'impact'; shipId: number; damage: number; blast?: boolean })
  | (OutcomeBase & { type: 'splash' })
  | (OutcomeBase & { type: 'dud'; reason: 'air-contact' | 'unarmed' | 'violent-entry'; shipId?: number });
export interface OrdnanceStepResult { active: boolean; outcomes: OrdnanceOutcome[]; }
export interface BombImpactPrediction { position: Vector3; time: number; }

const EPS = 1e-9;
const AIR_SUBSTEP = 1 / 120;
const finiteVector = (v: Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const validQuaternion = (q: Quaternion) => [q.x, q.y, q.z, q.w, q.lengthSq()].every(Number.isFinite) && q.lengthSq() > EPS;
function validAircraft(aircraft: OrdnanceAircraft): boolean {
  return finiteVector(aircraft.position) && validQuaternion(aircraft.quaternion) &&
    [aircraft.id, aircraft.speed, aircraft.pitch, aircraft.bank].every(Number.isFinite) &&
    aircraft.speed >= 0 && aircraft.speed <= 1000 && (aircraft.team === 'friendly' || aircraft.team === 'enemy');
}
function releasePosition(aircraft: OrdnanceAircraft): Vector3 {
  return new Vector3(0, -ORDNANCE_TUNING.releaseOffset, 0)
    .applyQuaternion(aircraft.quaternion.clone().normalize()).add(aircraft.position);
}
function releaseVelocity(aircraft: OrdnanceAircraft): Vector3 {
  return new Vector3(0, 0, -aircraft.speed).applyQuaternion(aircraft.quaternion.clone().normalize());
}
function release(id: number, aircraft: OrdnanceAircraft, kind: OrdnanceKind): OrdnanceRound | null {
  if (!Number.isFinite(id) || !validAircraft(aircraft)) return null;
  const position = releasePosition(aircraft), tuning = ORDNANCE_TUNING[kind];
  return { id, owner: aircraft.id, team: aircraft.team, kind, phase: 'air', position,
    previous: position.clone(), velocity: releaseVelocity(aircraft), life: tuning.life,
    age: 0, waterDistance: 0, damage: tuning.damage };
}
export function releaseBomb(id: number, aircraft: OrdnanceAircraft): OrdnanceRound | null {
  return release(id, aircraft, 'bomb');
}
/** Altitude is measured at the payload rack against the actual wave at release time. */
export function checkTorpedoRelease(aircraft: OrdnanceAircraft, time: number): TorpedoReleaseCheck {
  if (!validAircraft(aircraft) || !Number.isFinite(time)) return { allowed: false, reason: 'invalid', altitude: 0 };
  const position = releasePosition(aircraft), t = ORDNANCE_TUNING.torpedo;
  const altitude = position.y - oceanHeight(position.x, position.z, time);
  const reason: TorpedoReleaseRejection | null = altitude < t.minReleaseAltitude - EPS || altitude > t.maxReleaseAltitude + EPS ? 'altitude' :
    aircraft.speed > t.maxReleaseSpeed + EPS ? 'speed' : Math.abs(aircraft.pitch) > t.maxReleasePitch + EPS ? 'pitch' :
      Math.abs(aircraft.bank) > t.maxReleaseBank + EPS ? 'bank' : null;
  return { allowed: reason === null, reason, altitude };
}
/** Without a target this remains the raw physical release used by low-level tests. */
export function releaseTorpedo(id: number, aircraft: OrdnanceAircraft, time: number, targetShipId?: number): OrdnanceRound | null {
  if (!checkTorpedoRelease(aircraft, time).allowed || (targetShipId !== undefined && !Number.isFinite(targetShipId))) return null;
  const round = release(id, aircraft, 'torpedo');
  if (round && targetShipId !== undefined) { round.targetShipId = targetShipId; round.guidanceLost = false; }
  return round;
}
/** Ordinary vacuum aiming guide at one chosen height; it reads no target or future state. */
export function predictBombImpact(aircraft: OrdnanceAircraft, surfaceHeight: number): BombImpactPrediction | null {
  if (!validAircraft(aircraft) || !Number.isFinite(surfaceHeight)) return null;
  const position = releasePosition(aircraft), velocity = releaseVelocity(aircraft), height = position.y - surfaceHeight;
  if (height < 0) return null;
  const time = (velocity.y + Math.sqrt(velocity.y ** 2 + 2 * NAVAL_GRAVITY * height)) / NAVAL_GRAVITY;
  if (!Number.isFinite(time) || time < 0 || time > ORDNANCE_TUNING.bomb.life) return null;
  position.addScaledVector(velocity, time); position.y = surfaceHeight;
  return { position, time };
}

function boxEntry(start: Vector3, end: Vector3, min: Vector3, max: Vector3): number | null {
  let enter = 0, exit = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < EPS) { if (start[axis] < min[axis] || start[axis] > max[axis]) return null; continue; }
    let near = (min[axis] - start[axis]) / delta, far = (max[axis] - start[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near); exit = Math.min(exit, far);
    if (enter > exit) return null;
  }
  return enter;
}
function validShip(ship: OrdnanceShip): boolean {
  return (ship.health > 0 || ship.collisionActive === true) && ship.health >= 0 && Number.isFinite(ship.health) && Number.isFinite(ship.id) && finiteVector(ship.position) && finiteVector(ship.previous) &&
    validQuaternion(ship.quaternion) && (!ship.previousQuaternion || validQuaternion(ship.previousQuaternion)) &&
    [ship.length, ship.width, ship.height].every(v => Number.isFinite(v) && v > EPS);
}
interface ShipSweep {
  ship: OrdnanceShip; before: Quaternion; after: Quaternion; scale: Vector3;
  boxes: { min: Vector3; max: Vector3 }[]; radius: number;
}
function collisionRadius(ship: OrdnanceShip): number {
  const min = NAVAL_COLLISION_BOUNDS.min, max = NAVAL_COLLISION_BOUNDS.max;
  return Math.hypot(ship.width / CAPITAL_SHIP.width * Math.max(Math.abs(min[0]), Math.abs(max[0])),
    ship.height / CAPITAL_SHIP.height * Math.max(Math.abs(min[1]), Math.abs(max[1])),
    ship.length / CAPITAL_SHIP.length * Math.max(Math.abs(min[2]), Math.abs(max[2])));
}
/** Rotation-independent bounds include all physical mounts, both ship endpoints and blast reach. */
function nearSegment(start: Vector3, end: Vector3, ship: OrdnanceShip, radius: number): boolean {
  return Math.min(start.x, end.x) <= Math.max(ship.previous.x, ship.position.x) + radius &&
    Math.max(start.x, end.x) >= Math.min(ship.previous.x, ship.position.x) - radius &&
    Math.min(start.y, end.y) <= Math.max(ship.previous.y, ship.position.y) + radius &&
    Math.max(start.y, end.y) >= Math.min(ship.previous.y, ship.position.y) - radius &&
    Math.min(start.z, end.z) <= Math.max(ship.previous.z, ship.position.z) + radius &&
    Math.max(start.z, end.z) >= Math.min(ship.previous.z, ship.position.z) - radius;
}
function shipSweeps(ships: readonly OrdnanceShip[]): ShipSweep[] {
  return ships.filter(validShip).map(ship => ({ ship,
    before: (ship.previousQuaternion ?? ship.quaternion).clone().normalize(), after: ship.quaternion.clone().normalize(),
    scale: new Vector3(ship.width / CAPITAL_SHIP.width, ship.height / CAPITAL_SHIP.height, ship.length / CAPITAL_SHIP.length),
    boxes: shipCollisionBoxes(ship), radius: collisionRadius(ship),
  }));
}
function localAt(point: Vector3, sweep: ShipSweep, fraction: number): Vector3 {
  const position = sweep.ship.previous.clone().lerp(sweep.ship.position, fraction);
  const inverse = sweep.before.clone().slerp(sweep.after, fraction).invert();
  return point.clone().sub(position).applyQuaternion(inverse);
}
function firstShipContact(start: Vector3, end: Vector3, ships: readonly ShipSweep[], from: number, to: number): { shipId: number; fraction: number } | null {
  let first: { shipId: number; fraction: number } | null = null;
  for (const sweep of ships) {
    if (!nearSegment(start, end, sweep.ship, sweep.radius)) continue;
    const a = localAt(start, sweep, from), b = localAt(end, sweep, to);
    const scaledA = a.clone().divide(sweep.scale), scaledB = b.clone().divide(sweep.scale);
    if (!finiteVector(a) || !finiteVector(b) || !finiteVector(scaledA) || !finiteVector(scaledB)) continue;
    if (boxEntry(scaledA, scaledB, new Vector3().fromArray(NAVAL_COLLISION_BOUNDS.min),
      new Vector3().fromArray(NAVAL_COLLISION_BOUNDS.max)) === null) continue;
    let fraction = segmentNavalHullEntry(scaledA, scaledB);
    if (sweep.ship.guns) {
      const mount = segmentMountContact(scaledA, scaledB, { guns: sweep.ship.guns });
      if (mount && (fraction === null || mount.fraction < fraction)) fraction = mount.fraction;
    }
    for (const box of sweep.boxes) {
      const hit = boxEntry(a, b, box.min, box.max);
      if (hit !== null && (fraction === null || hit < fraction)) fraction = hit;
    }
    if (fraction !== null && (!first || fraction < first.fraction || (fraction === first.fraction && sweep.ship.id < first.shipId)))
      first = { shipId: sweep.ship.id, fraction };
  }
  return first;
}
/** Water shock reaches a live hull surface, never a centre/AABB or a sunk obstacle. */
function bombWaterBlast(round: OrdnanceRound, sweeps: readonly ShipSweep[], fraction: number): OrdnanceOutcome[] {
  if (round.age + EPS < ORDNANCE_TUNING.bomb.armingAge) return [];
  const outcomes: OrdnanceOutcome[] = [];
  for (const sweep of sweeps) {
    if (sweep.ship.health <= 0) continue;
    const local = localAt(round.position, sweep, fraction);
    const nearest = closestBombHullPoint(local, sweep.scale);
    // Near-miss strength is independent of direct-hit tuning; retain the round's allied damage scale.
    const maximumBlast = BOMB_BLAST.maximumDamage * (round.damage / ORDNANCE_TUNING.bomb.damage);
    const damage = bombBlastDamage(maximumBlast, local.distanceTo(nearest));
    if (damage <= EPS) continue;
    const rotation = sweep.before.clone().slerp(sweep.after, fraction);
    const world = nearest.applyQuaternion(rotation).add(sweep.ship.previous.clone().lerp(sweep.ship.position, fraction));
    const blocker = firstShipContact(round.position, world, sweeps.filter(other => other !== sweep), fraction, fraction);
    if (blocker && blocker.fraction < 1 - EPS) continue;
    outcomes.push({ type: 'impact', kind: 'bomb', shipId: sweep.ship.id, position: world, damage, blast: true });
  }
  return outcomes;
}

function ballisticPosition(position: Vector3, velocity: Vector3, dt: number): Vector3 {
  const next = position.clone().addScaledVector(velocity, dt); next.y -= .5 * NAVAL_GRAVITY * dt * dt; return next;
}
/** Solve within a short ballistic segment; wave position and time both advance during the sweep. */
function waterContact(position: Vector3, velocity: Vector3, time: number, duration: number): number | null {
  const clearance = (dt: number) => {
    const p = ballisticPosition(position, velocity, dt); return p.y - oceanHeight(p.x, p.z, time + dt);
  };
  if (clearance(0) <= 0) return 0;
  if (clearance(duration) > 0) return null;
  let low = 0, high = duration;
  for (let i = 0; i < 32; i++) {
    const mid = (low + high) / 2;
    if (clearance(mid) > 0) low = mid; else high = mid;
  }
  return high;
}
function validRound(round: OrdnanceRound): boolean {
  return finiteVector(round.position) && finiteVector(round.previous) && finiteVector(round.velocity) &&
    [round.id, round.owner, round.life, round.age, round.waterDistance, round.damage].every(Number.isFinite) &&
    round.age >= 0 && round.waterDistance >= 0 && round.damage >= 0 && round.velocity.lengthSq() <= 1000 ** 2 &&
    (round.kind === 'bomb' || round.kind === 'torpedo') &&
    (round.targetShipId === undefined || (round.kind === 'torpedo' && Number.isFinite(round.targetShipId))) &&
    (round.phase === 'air' || (round.phase === 'water' && round.kind === 'torpedo')) &&
    round.life <= ORDNANCE_TUNING[round.kind].life + EPS;
}
function elapse(round: OrdnanceRound, time: number): void {
  round.age += time; round.life = Math.max(0, round.life - time);
}
/**
 * Advances one fixed step without damage application, clock changes or array removal.
 * A guided torpedo steers only after splash, toward the one captured live ship ID.
 * Every supplied live ship is a physical obstacle; the caller owns any team damage policy.
 * Translation is swept in relative space; short angular/ballistic substeps bound curved-path error.
 * Invalid/paused dt leaves the round untouched. Expired or malformed rounds return inactive.
 */
export function stepOrdnance(round: OrdnanceRound, ships: readonly OrdnanceShip[], startTime: number, dt: number): OrdnanceStepResult {
  const outcomes: OrdnanceOutcome[] = [];
  if (!validRound(round) || round.life <= 0) { round.life = 0; return { active: false, outcomes }; }
  if (!Number.isFinite(startTime) || !Number.isFinite(dt) || dt <= 0 || dt > ORDNANCE_TUNING.maxStep + EPS)
    return { active: true, outcomes };
  // Conservative world-space broad phase includes the entire curved short step and blast radius.
  // It avoids building every distant ship's collision boxes for each forecast tick.
  const endBound = ballisticPosition(round.position, round.velocity, Math.min(dt, round.life));
  const nearBomb = (ship: OrdnanceShip) => round.kind !== 'bomb' ||
    nearSegment(round.position, endBound, ship, collisionRadius(ship) + BOMB_BLAST.radius + 1);
  return advanceOrdnance(round, shipSweeps(ships.filter(nearBomb)), startTime, dt);
}

/** A read-only forecast owns these ships; dimensions/mount geometry stay fixed, transforms may advance each tick. */
export function createOrdnanceStepper(ships: readonly OrdnanceShip[]) {
  const geometry = shipSweeps(ships);
  return (round: OrdnanceRound, startTime: number, dt: number): OrdnanceStepResult => {
    if (!validRound(round) || round.life <= 0) { round.life = 0; return { active: false, outcomes: [] }; }
    if (!Number.isFinite(startTime) || !Number.isFinite(dt) || dt <= 0 || dt > ORDNANCE_TUNING.maxStep + EPS)
      return { active: true, outcomes: [] };
    const end = ballisticPosition(round.position, round.velocity, Math.min(dt, round.life));
    const nearby = geometry.filter(sweep => validShip(sweep.ship) && (round.kind !== 'bomb' ||
      nearSegment(round.position, end, sweep.ship, sweep.radius + BOMB_BLAST.radius + 1)));
    for (const sweep of nearby) {
      sweep.before.copy(sweep.ship.previousQuaternion ?? sweep.ship.quaternion).normalize();
      sweep.after.copy(sweep.ship.quaternion).normalize();
    }
    return advanceOrdnance(round, nearby, startTime, dt);
  };
}

/** Forecasts may reuse collision geometry and consume only the remaining part of a ship frame. */
function advanceOrdnance(round: OrdnanceRound, sweeps: readonly ShipSweep[], startTime: number, dt: number, from = 0, to = 1, stopAtSplash = false): OrdnanceStepResult {
  const outcomes: OrdnanceOutcome[] = [];
  const rotationSteps = Math.max(1, ...sweeps.map(s => Math.ceil(s.before.angleTo(s.after) / .02)));
  const substep = Math.min(AIR_SUBSTEP, dt / rotationSteps), expiresThisStep = round.life <= dt, horizon = Math.min(dt, round.life);
  round.previous.copy(round.position);
  let elapsed = 0;
  while (elapsed < horizon - EPS && round.life > 0) {
    const duration = Math.min(substep, horizon - elapsed), start = round.position.clone();
    const startFraction = from + (to - from) * elapsed / dt;
    const endFraction = from + (to - from) * (elapsed + duration) / dt;
    if (round.phase === 'air') {
      const end = ballisticPosition(start, round.velocity, duration);
      const hit = firstShipContact(start, end, sweeps, startFraction, endFraction);
      const water = waterContact(start, round.velocity, startTime + elapsed, duration);
      // A deck/hull encountered before the sea always owns the first contact, including duds.
      if (hit && (water === null || hit.fraction * duration <= water + EPS)) {
        const time = hit.fraction * duration;
        round.position.copy(start).lerp(end, hit.fraction); round.velocity.y -= NAVAL_GRAVITY * time;
        elapse(round, time); round.life = 0;
        outcomes.push(round.kind === 'bomb' && round.age + EPS >= ORDNANCE_TUNING.bomb.armingAge ?
          { type: 'impact', kind: round.kind, shipId: hit.shipId, position: round.position.clone(), damage: round.damage } :
          { type: 'dud', kind: round.kind, shipId: hit.shipId, position: round.position.clone(), reason: round.kind === 'bomb' ? 'unarmed' : 'air-contact' });
        break;
      }
      if (water !== null) {
        round.position.copy(ballisticPosition(start, round.velocity, water));
        round.velocity.y -= NAVAL_GRAVITY * water; elapse(round, water); elapsed += water;
        outcomes.push({ type: 'splash', kind: round.kind, position: round.position.clone() });
        const horizontalSpeed = Math.hypot(round.velocity.x, round.velocity.z);
        if (round.kind === 'bomb') {
          outcomes.push(...bombWaterBlast(round, sweeps, from + (to - from) * elapsed / dt));
          round.life = 0; break;
        }
        if (Math.abs(round.velocity.y) > ORDNANCE_TUNING.torpedo.maxEntryVerticalSpeed + EPS || horizontalSpeed <= EPS) {
          outcomes.push({ type: 'dud', kind: round.kind, position: round.position.clone(), reason: 'violent-entry' });
          round.life = 0; break;
        }
        round.phase = 'water'; round.velocity.multiplyScalar(ORDNANCE_TUNING.torpedo.waterSpeed / horizontalSpeed); round.velocity.y = 0;
        // No instant 1.5m vertical teleport: the remaining step begins at the actual splash.
        if (stopAtSplash) return { active: round.life > 0, outcomes };
        continue;
      }
      round.position.copy(end); round.velocity.y -= NAVAL_GRAVITY * duration;
    } else {
      if (round.targetShipId !== undefined && !round.guidanceLost) {
        const target = sweeps.find(s => s.ship.id === round.targetShipId && s.ship.health > 0);
        if (!target) round.guidanceLost = true;
        else {
          const position = target.ship.previous.clone().lerp(target.ship.position, startFraction);
          const dx = position.x - start.x, dz = position.z - start.z, distance = Math.hypot(dx, dz);
          if (distance > EPS) {
            round.velocity.x = dx / distance * ORDNANCE_TUNING.torpedo.waterSpeed;
            round.velocity.z = dz / distance * ORDNANCE_TUNING.torpedo.waterSpeed;
          }
        }
      }
      const end = start.clone().addScaledVector(round.velocity, duration), t = ORDNANCE_TUNING.torpedo;
      const desiredY = oceanHeight(end.x, end.z, startTime + elapsed + duration) - t.depth;
      end.y = start.y + Math.max(-t.diveSpeed * duration, Math.min(t.diveSpeed * duration, desiredY - start.y));
      const horizontalDistance = Math.hypot(end.x - start.x, end.z - start.z);
      const hit = firstShipContact(start, end, sweeps, startFraction, endFraction);
      const fraction = hit?.fraction ?? 1;
      round.position.copy(start).lerp(end, fraction); round.waterDistance += horizontalDistance * fraction;
      round.velocity.y = (end.y - start.y) / duration;
      if (hit) {
        elapse(round, duration * fraction); round.life = 0;
        outcomes.push(round.waterDistance + EPS >= t.armingDistance ?
          { type: 'impact', kind: round.kind, shipId: hit.shipId, position: round.position.clone(), damage: round.damage } :
          { type: 'dud', kind: round.kind, shipId: hit.shipId, position: round.position.clone(), reason: 'unarmed' });
        break;
      }
    }
    elapse(round, duration); elapsed += duration;
  }
  // Consume sub-nanosecond residuals too, so very short remaining lifetimes cannot live forever.
  if (round.life > 0 && elapsed < horizon) elapse(round, horizon - elapsed);
  if (expiresThisStep) round.life = 0;
  return { active: round.life > 0, outcomes };
}

function copyForecastShip(ship: Ship, time: number): Ship & { collisionActive: boolean } {
  return { ...ship, collisionActive: isShipObstacle(ship, time), position: ship.position.clone(), previous: ship.previous.clone(),
    quaternion: ship.quaternion.clone(), previousQuaternion: ship.previousQuaternion.clone(), velocity: ship.velocity.clone(),
    wreck: ship.wreck ? { ...ship.wreck, position: ship.wreck.position.clone(), rotation: ship.wreck.rotation.clone(), velocity: ship.wreck.velocity.clone() } : null };
}

/** Shared product launch rule. Includes the launch tick's immediate payload step, then splash and the first 80m.
 * The aircraft/ships have already moved in this tick; its wave time and ship sweep still start one tick earlier.
 * No future combat or aircraft input is read.
 */
export function checkGuidedTorpedoRelease(aircraft: OrdnanceAircraft, ships: readonly Ship[], time: number): GuidedTorpedoReleaseCheck {
  const envelope = checkTorpedoRelease(aircraft, time);
  const reject = (reason: TorpedoReleaseRejection): GuidedTorpedoReleaseCheck => ({ ...envelope, allowed: false, reason, targetShipId: null });
  if (!envelope.allowed) return reject(envelope.reason ?? 'invalid');
  const live = ships.filter(ship => ship.health > 0 && ship.team !== aircraft.team && validShip(ship));
  if (!live.length) return reject('no-target');
  const predicted = ships.filter(ship => validShip({ ...ship, collisionActive: isShipObstacle(ship, time) })).map(ship => copyForecastShip(ship, time));
  const geometry = shipSweeps(predicted);
  const nextFrame = (endTime: number) => {
    for (const ship of predicted) {
      advanceShipMotion(ship, endTime, FIXED_DT); ship.collisionActive = isShipObstacle(ship, endTime);
    }
    for (const sweep of geometry) {
      sweep.before.copy(sweep.ship.previousQuaternion ?? sweep.ship.quaternion).normalize();
      sweep.after.copy(sweep.ship.quaternion).normalize();
    }
    return geometry.filter(sweep => sweep.ship.health > 0 || sweep.ship.collisionActive);
  };
  const falling = release(-1, aircraft, 'torpedo')!;
  const launchStepTime = time - FIXED_DT;
  let frameTime = launchStepTime, sweeps: readonly ShipSweep[] = geometry, launchFrame = true;
  while (falling.phase === 'air' && falling.life > 0) {
    if (launchFrame) launchFrame = false;
    else sweeps = nextFrame(frameTime + FIXED_DT);
    const result = advanceOrdnance(falling, sweeps, frameTime, FIXED_DT, 0, 1, true);
    if (!result.active || result.outcomes.some(outcome => outcome.type === 'dud')) return reject('unsafe-entry');
    if (falling.phase === 'air') frameTime += FIXED_DT;
  }
  if (falling.phase !== 'water') return reject('unsafe-entry');
  const splashTime = launchStepTime + falling.age, splashFraction = Math.max(0, Math.min(1, (splashTime - frameTime) / FIXED_DT));
  const t = ORDNANCE_TUNING.torpedo;
  const candidates = live.filter(ship => {
    const sweep = sweeps.find(item => item.ship.id === ship.id);
    if (!sweep || !finiteVector(ship.velocity)) return false;
    const speed = ship.velocity.length(), position = sweep.ship.previous.clone().lerp(sweep.ship.position, splashFraction);
    // The air leg consumes lifetime; it never increases the underwater range budget.
    const distance = Math.hypot(position.x - falling.position.x, position.z - falling.position.z);
    return speed < t.waterSpeed && distance / (t.waterSpeed - speed) <= falling.life + EPS;
  }).map(ship => ({ ship, round: { ...falling, position: falling.position.clone(), previous: falling.position.clone(),
    velocity: falling.velocity.clone(), targetShipId: ship.id, guidanceLost: false } as OrdnanceRound, eligible: true }));
  if (!candidates.length) return reject('out-of-range');
  // Inspect the real first hull contact, rather than measuring 80m to the ship's centre.
  const checkArming = (dt: number, from = 0) => {
    for (const candidate of candidates) {
      if (!candidate.eligible || candidate.round.waterDistance + EPS >= t.armingDistance || candidate.round.life <= 0) continue;
      const result = advanceOrdnance(candidate.round, sweeps, frameTime + from * FIXED_DT, dt, from, 1);
      if (result.outcomes.some(outcome => outcome.type === 'dud') || (!result.active && !result.outcomes.some(outcome => outcome.type === 'impact')))
        candidate.eligible = false;
    }
  };
  const remainder = FIXED_DT * (1 - splashFraction);
  if (remainder > EPS) checkArming(remainder, splashFraction);
  frameTime += FIXED_DT;
  while (candidates.some(candidate => candidate.eligible && candidate.round.life > 0 && candidate.round.waterDistance + EPS < t.armingDistance)) {
    sweeps = nextFrame(frameTime + FIXED_DT); checkArming(FIXED_DT); frameTime += FIXED_DT;
  }
  const origin = releasePosition(aircraft), forward = new Vector3(0, 0, -1).applyQuaternion(aircraft.quaternion.clone().normalize());
  forward.y = 0; forward.normalize();
  const ranked = candidates.filter(candidate => candidate.eligible).map(candidate => {
    const offset = candidate.ship.position.clone().sub(origin); offset.y = 0;
    const distance = offset.length(), alignment = distance > EPS ? forward.dot(offset) / distance : 1;
    return { id: candidate.ship.id, distance, alignment };
  }).sort((a, b) => b.alignment - a.alignment || a.distance - b.distance || a.id - b.id);
  return ranked.length ? { ...envelope, targetShipId: ranked[0].id } : reject('out-of-range');
}
