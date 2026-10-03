import { Quaternion, Vector3 } from 'three';
import type { Aircraft } from './types';

/** Game-only, early-Yamato-inspired capital ship. Sources and limits: docs/NAVAL_REFERENCE.md. */
export const NAVAL_GRAVITY = 9.80665;
export const CAPITAL_SHIP = Object.freeze({ length: 263, width: 38.9, height: 42, deckHeight: 9 });
/** [longitudinal fraction, half-beam fraction]; shared exactly with the rendered hull. */
export const NAVAL_HULL_SECTIONS: readonly (readonly [number, number])[] = Object.freeze([
  [-.5, .01], [-.47, .10], [-.40, .28], [-.31, .41], [-.18, .49], [0, .5], [.27, .47], [.41, .37], [.48, .22], [.5, .14],
]);
export const NAVAL_HULL_BOTTOM = -3;
export const NAVAL_HULL_BOTTOM_INSET = .32;
const RAD = Math.PI / 180;
const EPS = 1e-8;
export type NavalWeaponKind = 'main' | 'secondary' | 'heavy-aa' | 'light-aa';
export interface NavalWeapon {
  readonly kind: NavalWeaponKind; readonly caliberMm: number; readonly barrels: number;
  readonly muzzleSpeed: number; readonly roundsPerMinute: number; readonly historicalMaxRange: number | null;
  /** These are explicitly game engagement/HP limits, not historical performance claims. */
  readonly range: number; readonly maxTargetAltitude: number; readonly life: number; readonly damage: number;
  readonly magazine: number; readonly reloadSeconds: number; readonly dispersion: number;
  readonly barrelLength: number; readonly barrelRadius: number; readonly barrelSpacing: number;
  readonly bodySize: readonly [number, number, number];
}
export const NAVAL_WEAPONS: Readonly<Record<NavalWeaponKind, NavalWeapon>> = Object.freeze({
  main: Object.freeze({ kind: 'main', caliberMm: 460, barrels: 3, muzzleSpeed: 780, roundsPerMinute: 1.8,
    historicalMaxRange: 42000, range: 0, maxTargetAltitude: 0, life: 0, damage: 0,
    magazine: 0, reloadSeconds: 0, dispersion: 0, barrelLength: 18, barrelRadius: .42, barrelSpacing: 2.8, bodySize: [15, 6, 17] as const }),
  secondary: Object.freeze({ kind: 'secondary', caliberMm: 155, barrels: 3, muzzleSpeed: 0, roundsPerMinute: 0,
    historicalMaxRange: null, range: 0, maxTargetAltitude: 0, life: 0, damage: 0,
    magazine: 0, reloadSeconds: 0, dispersion: 0, barrelLength: 7, barrelRadius: .20, barrelSpacing: 1.1, bodySize: [7, 3.8, 8] as const }),
  'heavy-aa': Object.freeze({ kind: 'heavy-aa', caliberMm: 127, barrels: 2, muzzleSpeed: 720, roundsPerMinute: 10,
    historicalMaxRange: null, range: 2800, maxTargetAltitude: 2600, life: 4.5, damage: 4.8,
    magazine: 0, reloadSeconds: 0, dispersion: .024, barrelLength: 4.6, barrelRadius: .14, barrelSpacing: 1.1, bodySize: [4.2, 2.7, 4.3] as const }),
  'light-aa': Object.freeze({ kind: 'light-aa', caliberMm: 25, barrels: 3, muzzleSpeed: 900, roundsPerMinute: 220,
    historicalMaxRange: null, range: 1250, maxTargetAltitude: 800, life: 1.7, damage: .8,
    magazine: 15, reloadSeconds: 60 * 15 / 110 - 60 * 15 / 220, dispersion: .033, barrelLength: 1.5, barrelRadius: .065, barrelSpacing: .38, bodySize: [2.1, 1.4, 2.0] as const }),
});
export interface NavalMountDefinition {
  readonly id: string; readonly weapon: NavalWeaponKind; readonly pivot: readonly [number, number, number];
  readonly homeYaw: number; readonly yawHalfArc: number; readonly minElevation: number; readonly maxElevation: number;
  readonly traverseRate: number; readonly elevationRate: number;
}
function mount(id: string, weapon: NavalWeaponKind, pivot: readonly [number, number, number], homeYaw: number): NavalMountDefinition {
  const heavy = weapon === 'heavy-aa', light = weapon === 'light-aa';
  return Object.freeze({ id, weapon, pivot: Object.freeze(pivot), homeYaw,
    yawHalfArc: (heavy || light ? 82 : 140) * RAD,
    minElevation: (light ? -10 : heavy ? -8 : 0) * RAD, maxElevation: (light ? 80 : heavy ? 85 : 45) * RAD,
    traverseRate: (light ? 16 : heavy ? 12 : 2) * RAD, elevationRate: (light ? 12 : heavy ? 10 : 2) * RAD });
}
/** All rendering, muzzle locations and mechanics use this one immutable layout. Bow is local -Z. */
export const NAVAL_MOUNTS: readonly NavalMountDefinition[] = Object.freeze([
  mount('main-fore-1', 'main', [0, 12.5, -80], 0),
  mount('main-fore-2', 'main', [0, 16.5, -55], 0),
  mount('main-aft', 'main', [0, 12.5, 77], Math.PI),
  mount('secondary-fore', 'secondary', [0, 18, -31], 0),
  mount('secondary-aft', 'secondary', [0, 17, 51], Math.PI),
  ...([-1, 1] as const).map(side => mount(`secondary-${side < 0 ? 'port' : 'starboard'}`, 'secondary', [side * 13, 12.5, 2], -side * Math.PI / 2)),
  ...([-1, 1] as const).flatMap(side => [-23, 18, 40].map((z, i) =>
    mount(`heavy-${side < 0 ? 'port' : 'starboard'}-${i + 1}`, 'heavy-aa', [side * 17, 14.5, z], -side * Math.PI / 2))),
  ...([-1, 1] as const).flatMap(side => [-18, -4, 12, 27].map((z, i) =>
    mount(`light-${side < 0 ? 'port' : 'starboard'}-${i + 1}`, 'light-aa', [side * 12, 22, z], -side * Math.PI / 2))),
]);
export interface NavalMountState {
  mountId: string; yaw: number; elevation: number; targetId: number | null;
  cooldown: number; roundsInMagazine: number; salvo: number;
  health: number; maxHealth: number; lastShotTick: number;
}
export interface NavalShip {
  id: number; health: number; position: Vector3; quaternion: Quaternion; velocity: Vector3; guns: NavalMountState[];
}
export interface NavalShot {
  position: Vector3; velocity: Vector3; life: number; damage: number; kind: 'aa'; gravity: number;
  mountId: string; barrelIndex: number;
}
export const MAX_NAVAL_SHOTS_PER_STEP = NAVAL_MOUNTS.reduce((n, m) => n + (m.weapon.endsWith('aa') ? NAVAL_WEAPONS[m.weapon].barrels : 0), 0);
/** Conservative bound ignores firing arcs/reload and includes one boundary volley. */
export const MAX_LIVE_NAVAL_ROUNDS_PER_SHIP = NAVAL_MOUNTS.reduce((n, m) => {
  const w = NAVAL_WEAPONS[m.weapon];
  return n + (w.life > 0 ? w.barrels * (Math.ceil(w.life * w.roundsPerMinute / 60) + 1) : 0);
}, 0);
export function createNavalMounts(shipId: number): NavalMountState[] {
  return NAVAL_MOUNTS.map((definition, i) => ({ mountId: definition.id, yaw: definition.homeYaw,
    elevation: (definition.weapon.endsWith('aa') ? 20 : 4) * RAD, targetId: null,
    // Readiness stagger is across mounts, never across the barrels of a ready mount.
    cooldown: .6 + ((shipId * 7 + i * 3) % 13) * .09,
    health: definition.weapon === 'light-aa' ? 60 : definition.weapon === 'heavy-aa' ? 120 : 400,
    maxHealth: definition.weapon === 'light-aa' ? 60 : definition.weapon === 'heavy-aa' ? 120 : 400, lastShotTick: -10000,
    roundsInMagazine: NAVAL_WEAPONS[definition.weapon].magazine, salvo: 0 }));
}
export function wrapNavalAngle(angle: number): number { return Math.atan2(Math.sin(angle), Math.cos(angle)); }
export function navalDirection(yaw: number, elevation: number): Vector3 {
  const horizontal = Math.cos(elevation);
  return new Vector3(-Math.sin(yaw) * horizontal, Math.sin(elevation), -Math.cos(yaw) * horizontal);
}
export function navalBarrelOffset(definition: NavalMountDefinition, barrelIndex: number): number {
  const weapon = NAVAL_WEAPONS[definition.weapon];
  return (barrelIndex - (weapon.barrels - 1) / 2) * weapon.barrelSpacing;
}
export function navalMuzzleLocal(definition: NavalMountDefinition, state: Pick<NavalMountState, 'yaw' | 'elevation'>, barrelIndex: number): Vector3 {
  const offset = navalBarrelOffset(definition, barrelIndex);
  return new Vector3(...definition.pivot).add(new Vector3(Math.cos(state.yaw) * offset, 0, -Math.sin(state.yaw) * offset))
    .addScaledVector(navalDirection(state.yaw, state.elevation), NAVAL_WEAPONS[definition.weapon].barrelLength);
}
export function navalAnglesAllowed(definition: NavalMountDefinition, yaw: number, elevation: number): boolean {
  return Number.isFinite(yaw) && Number.isFinite(elevation) && Math.abs(wrapNavalAngle(yaw - definition.homeYaw)) <= definition.yawHalfArc + EPS &&
    elevation >= definition.minElevation - EPS && elevation <= definition.maxElevation + EPS;
}
export interface NavalPlatformPart {
  readonly shape: 'box' | 'cylinder';
  readonly position: readonly [number, number, number];
  /** Box: full XYZ dimensions. Cylinder: X/Z radii and full Y height, matching Three.js. */
  readonly size: readonly [number, number, number];
}
function platform(shape: NavalPlatformPart['shape'], position: NavalPlatformPart['position'], size: NavalPlatformPart['size']): NavalPlatformPart {
  return Object.freeze({ shape, position: Object.freeze(position), size: Object.freeze(size) });
}
/** Platform/support geometry shared with rendering; these are obstacles, not decorative-only fittings. */
export const NAVAL_PLATFORM_PARTS: readonly NavalPlatformPart[] = Object.freeze(([-1, 1] as const).flatMap(side => [
  ...[-23, 18, 40].flatMap(z => [
    platform('cylinder', [side * 17, 11.9, z], [3, 2.7, 3]),
    platform('box', [side * 12.5, 12, z], [10, 1, 5]),
  ]),
  ...[-18, -4, 12, 27].flatMap(z => [
    platform('cylinder', [side * 12, 20.3, z], [2.2, .7, 2.2]),
    platform('box', [side * 9.5, 19.7, z], [5, .7, 3.3]),
    platform('cylinder', [side * 12, 15, z], [.38, 10.3, .38]),
  ]),
]));
type NavalBox = readonly [readonly [number, number, number], readonly [number, number, number]];
const PLATFORM_SAFETY_BOXES: readonly NavalBox[] = NAVAL_PLATFORM_PARTS.map(({ shape, position: [x, y, z], size: [sx, sy, sz] }) => {
  const hx = shape === 'cylinder' ? sx : sx / 2, hz = shape === 'cylinder' ? sz : sz / 2;
  return [[x - hx, y - sy / 2, z - hz], [x + hx, y + sy / 2, z + hz]] as const;
});
/** Conservative safety boxes for visible deckhouse, bridge, funnel and AA platforms/supports. */
export const NAVAL_OCCLUDERS: readonly (readonly [readonly [number, number, number], readonly [number, number, number]])[] = Object.freeze([
  [[-9, 9, -25], [9, 18, 42]],
  [[-7, 18, -24], [7, 37, -8]],
  [[-10.5, 29, -21], [10.5, 33, -11]],
  [[-5, 18, 0], [5, 30, 16]],
  [[-4, 18, 29], [4, 28, 36]],
  ...PLATFORM_SAFETY_BOXES,
]);
/** Broad phase encloses every physical platform and turret yaw, not only the hull beam. */
export const NAVAL_COLLISION_BOUNDS = (() => {
  const min = [-CAPITAL_SHIP.width / 2, NAVAL_HULL_BOTTOM, -CAPITAL_SHIP.length / 2];
  const max = [CAPITAL_SHIP.width / 2, CAPITAL_SHIP.height, CAPITAL_SHIP.length / 2];
  for (const [a, b] of NAVAL_OCCLUDERS) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], a[i]); max[i] = Math.max(max[i], b[i]); }
  for (const mount of NAVAL_MOUNTS) {
    const size = NAVAL_WEAPONS[mount.weapon].bodySize, radius = Math.hypot(size[0], size[2]) / 2;
    const extent = [radius, size[1] / 2, radius], center = [mount.pivot[0], mount.pivot[1] - 1, mount.pivot[2]];
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], center[i] - extent[i]); max[i] = Math.max(max[i], center[i] + extent[i]); }
  }
  return Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) });
})();
// Compiled once: no per-bullet geometry/plane arrays or square roots in the narrow phase.
const HULL_SPANS = NAVAL_HULL_SECTIONS.slice(0, -1).map(([a, aw], i) => {
  const [b, bw] = NAVAL_HULL_SECTIONS[i + 1], zA = a * CAPITAL_SHIP.length, zB = b * CAPITAL_SHIP.length;
  const slopeY = NAVAL_HULL_BOTTOM_INSET / (CAPITAL_SHIP.deckHeight - NAVAL_HULL_BOTTOM);
  const slopeZ = (bw - aw) * CAPITAL_SHIP.width / (zB - zA);
  const limit = aw * CAPITAL_SHIP.width - slopeZ * zA - slopeY * CAPITAL_SHIP.deckHeight;
  return [
    [0, 1, 0, CAPITAL_SHIP.deckHeight, 1], [0, -1, 0, -NAVAL_HULL_BOTTOM, 1],
    [0, 0, 1, zB, 1], [0, 0, -1, -zA, 1],
    [1, -slopeY, -slopeZ, limit, Math.hypot(1, slopeY, slopeZ)],
    [-1, -slopeY, -slopeZ, limit, Math.hypot(1, slopeY, slopeZ)],
  ] as const;
});
/** Earliest segment entry into the union of the hull's exactly planar tapered spans.
 * Plane inflation is a conservative radius/padding envelope, not a widened visible hull.
 */
export function segmentNavalHullEntry(start: Vector3, end: Vector3, padding = 0): number | null {
  if (!Number.isFinite(padding) || padding < 0 || !Number.isFinite(start.x + start.y + start.z + end.x + end.y + end.z)) return null;
  if (Math.min(start.y, end.y) > CAPITAL_SHIP.deckHeight + padding || Math.max(start.y, end.y) < NAVAL_HULL_BOTTOM - padding ||
      Math.min(start.x, end.x) > CAPITAL_SHIP.width / 2 + padding || Math.max(start.x, end.x) < -CAPITAL_SHIP.width / 2 - padding ||
      Math.min(start.z, end.z) > CAPITAL_SHIP.length / 2 + padding || Math.max(start.z, end.z) < -CAPITAL_SHIP.length / 2 - padding) return null;
  let first: number | null = null;
  for (const planes of HULL_SPANS) {
    let enter = 0, exit = 1;
    for (const [nx, ny, nz, limit, normalLength] of planes) {
      const inflated = limit + padding * normalLength;
      const from = nx * start.x + ny * start.y + nz * start.z - inflated;
      const to = nx * end.x + ny * end.y + nz * end.z - inflated;
      if (from > 0 && to > 0) { enter = 2; break; }
      if (from <= 0 && to <= 0) continue;
      const time = from / (from - to);
      if (from > 0) enter = Math.max(enter, time); else exit = Math.min(exit, time);
      if (enter > exit) break;
    }
    if (enter <= exit && enter <= 1 && (first === null || enter < first)) first = enter;
  }
  return first;
}
export function shipCollisionBoxes(ship: { length: number; width: number; height: number; guns?: NavalMountState[] }): { min: Vector3; max: Vector3 }[] {
  const scale = new Vector3(ship.width / CAPITAL_SHIP.width, ship.height / CAPITAL_SHIP.height, ship.length / CAPITAL_SHIP.length);
  const boxes = NAVAL_OCCLUDERS.map(([min, max]) => ({ min: new Vector3(...min).multiply(scale), max: new Vector3(...max).multiply(scale) }));
  NAVAL_MOUNTS.forEach((definition, index) => {
    if (definition.weapon.endsWith('aa')) return;
    const size = NAVAL_WEAPONS[definition.weapon].bodySize, yaw = ship.guns?.[index]?.yaw ?? definition.homeYaw;
    const x = (Math.abs(Math.cos(yaw)) * size[0] + Math.abs(Math.sin(yaw)) * size[2]) / 2;
    const z = (Math.abs(Math.sin(yaw)) * size[0] + Math.abs(Math.cos(yaw)) * size[2]) / 2;
    const [px, py, pz] = definition.pivot;
    boxes.push({ min: new Vector3(px - x, py - 1 - size[1] / 2, pz - z).multiply(scale), max: new Vector3(px + x, py - 1 + size[1] / 2, pz + z).multiply(scale) });
  });
  return boxes;
}
function hitsBox(a: Vector3, b: Vector3, box: (typeof NAVAL_OCCLUDERS)[number]): boolean {
  let enter = 0, exit = 1;
  for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
    const delta = b[axis] - a[axis], min = box[0][i] - .1, max = box[1][i] + .1;
    if (Math.abs(delta) < EPS) { if (a[axis] < min || a[axis] > max) return false; continue; }
    let near = (min - a[axis]) / delta, far = (max - a[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near); exit = Math.min(exit, far);
    if (enter > exit) return false;
  }
  return true;
}
/** Check the physical barrel and first 320m of the ballistic path, not just target bearing. */
export function navalBarrelClear(definition: NavalMountDefinition, state: Pick<NavalMountState, 'yaw' | 'elevation'>, barrelIndex: number): boolean {
  const muzzle = navalMuzzleLocal(definition, state, barrelIndex), direction = navalDirection(state.yaw, state.elevation);
  const pivot = muzzle.clone().addScaledVector(direction, -NAVAL_WEAPONS[definition.weapon].barrelLength);
  if (segmentNavalHullEntry(pivot, muzzle, .1) !== null || NAVAL_OCCLUDERS.some(box => hitsBox(pivot, muzzle, box))) return false;
  const w = NAVAL_WEAPONS[definition.weapon];
  let start = muzzle;
  for (let step = 1; step <= 4; step++) {
    const t = (step * 80) / Math.max(w.muzzleSpeed, 1);
    const end = muzzle.clone().addScaledVector(direction, step * 80); end.y -= .5 * NAVAL_GRAVITY * t * t;
    if (segmentNavalHullEntry(start, end, .1) !== null || NAVAL_OCCLUDERS.some(box => hitsBox(start, end, box))) return false;
    start = end;
  }
  return true;
}
export interface NavalAim { direction: Vector3; time: number; }
/** Short-flight vacuum trajectory for this game's projectiles; no drag/fire-control model. */
export function solveNavalAim(origin: Vector3, target: Vector3, targetVelocity: Vector3, inheritedVelocity: Vector3, speed: number, maxTime: number): NavalAim | null {
  if (!(speed > 0 && maxTime > 0) || ![...origin.toArray(), ...target.toArray(), ...targetVelocity.toArray(), ...inheritedVelocity.toArray(), speed, maxTime].every(Number.isFinite)) return null;
  const r = target.clone().sub(origin), v = targetVelocity.clone().sub(inheritedVelocity);
  if (r.lengthSq() < 1) return null;
  const residual = (t: number) => Math.hypot(r.x + v.x * t, r.y + v.y * t + .5 * NAVAL_GRAVITY * t * t, r.z + v.z * t) - speed * t;
  if (residual(maxTime) > 0) return null;
  let lo = 0, hi = maxTime;
  for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (residual(mid) > 0) lo = mid; else hi = mid; }
  const time = (lo + hi) / 2;
  const direction = r.addScaledVector(v, time); direction.y += .5 * NAVAL_GRAVITY * time * time;
  return { direction: direction.normalize(), time };
}
function approachAngle(current: number, target: number, amount: number): number {
  return current + Math.max(-amount, Math.min(amount, wrapNavalAngle(target - current)));
}
function aimFor(ship: NavalShip, definition: NavalMountDefinition, gun: NavalMountState, target: Aircraft): { yaw: number; elevation: number } | null {
  const weapon = NAVAL_WEAPONS[definition.weapon];
  if (target.health <= 0 || target.team !== 'friendly' || target.position.y - ship.position.y > weapon.maxTargetAltitude || target.position.distanceToSquared(ship.position) > weapon.range ** 2) return null;
  const origin = navalMuzzleLocal(definition, gun, (weapon.barrels - 1) / 2).applyQuaternion(ship.quaternion).add(ship.position);
  const velocity = new Vector3(0, 0, -target.speed).applyQuaternion(target.quaternion);
  const solution = solveNavalAim(origin, target.position, velocity, ship.velocity, weapon.muzzleSpeed, weapon.life);
  if (!solution) return null;
  const local = solution.direction.applyQuaternion(ship.quaternion.clone().invert());
  const yaw = Math.atan2(-local.x, -local.z), elevation = Math.asin(Math.max(-1, Math.min(1, local.y)));
  return navalAnglesAllowed(definition, yaw, elevation) ? { yaw, elevation } : null;
}
/** Fixed-tick mutation of mount state only. Returns one distinct projectile per real barrel. */
export function stepNavalGuns(ship: NavalShip, friendlies: readonly Aircraft[], tick: number, dt: number): NavalShot[] {
  if (ship.health <= 0 || !Number.isFinite(dt) || dt <= 0 || dt > 1 / 30 || !Number.isFinite(tick)) return [];
  const shots: NavalShot[] = [];
  for (let index = 0; index < NAVAL_MOUNTS.length; index++) {
    const definition = NAVAL_MOUNTS[index], gun = ship.guns[index], weapon = NAVAL_WEAPONS[definition.weapon];
    if (!gun || gun.mountId !== definition.id || !definition.weapon.endsWith('aa')) continue;
    if (gun.health <= 0) { gun.targetId = null; continue; }
    gun.cooldown = Math.max(-dt, gun.cooldown - dt);
    let target = friendlies.find(p => p.id === gun.targetId), aim = target ? aimFor(ship, definition, gun, target) : null;
    if (!aim || (tick + index) % 12 === 0) {
      const currentTarget = target, currentAim = aim;
      const candidates = friendlies.filter(p => p.health > 0).slice().sort((a, b) =>
        a.position.distanceToSquared(ship.position) - b.position.distanceToSquared(ship.position) || a.id - b.id);
      target = undefined; aim = null;
      for (const candidate of candidates) { const solution = aimFor(ship, definition, gun, candidate); if (solution) { target = candidate; aim = solution; break; } }
      // Keep a legal firing solution through small distance crossings. Re-aim only
      // when another target is at least 20% closer; invalid targets release immediately.
      if (currentTarget && currentAim && target && target.id !== currentTarget.id &&
          target.position.distanceToSquared(ship.position) > .8 ** 2 * currentTarget.position.distanceToSquared(ship.position)) {
        target = currentTarget; aim = currentAim;
      }
      gun.targetId = target?.id ?? null;
    }
    if (!aim || !target) continue;
    // Keep yaw in the mount's outboard interval, so crossing ±PI never turns through the ship.
    const phase = ship.id * 1.79 + index * 2.31 + gun.salvo * .87;
    const desiredYaw = definition.homeYaw + wrapNavalAngle(aim.yaw - definition.homeYaw) + Math.sin(phase) * weapon.dispersion;
    const desiredElevation = aim.elevation + Math.cos(phase * 1.17) * weapon.dispersion;
    if (!navalAnglesAllowed(definition, desiredYaw, desiredElevation)) continue;
    gun.yaw = approachAngle(gun.yaw, desiredYaw, definition.traverseRate * dt);
    gun.elevation += Math.max(-definition.elevationRate * dt, Math.min(definition.elevationRate * dt, desiredElevation - gun.elevation));
    if (gun.cooldown > EPS || Math.abs(wrapNavalAngle(gun.yaw - desiredYaw)) > .8 * RAD || Math.abs(gun.elevation - desiredElevation) > .8 * RAD) continue;
    // The error is in the desired bearing; the real barrels still traverse at the finite rates.
    if (!Array.from({ length: weapon.barrels }, (_, barrel) => navalBarrelClear(definition, gun, barrel)).every(Boolean)) continue;
    for (let barrel = 0; barrel < weapon.barrels; barrel++) {
      const position = navalMuzzleLocal(definition, gun, barrel).applyQuaternion(ship.quaternion).add(ship.position);
      const direction = navalDirection(gun.yaw, gun.elevation).applyQuaternion(ship.quaternion);
      shots.push({ position, velocity: direction.multiplyScalar(weapon.muzzleSpeed).add(ship.velocity), life: weapon.life,
        damage: weapon.damage, kind: 'aa', gravity: NAVAL_GRAVITY, mountId: definition.id, barrelIndex: barrel });
    }
    gun.salvo++; gun.lastShotTick = tick;
    gun.cooldown += 60 / weapon.roundsPerMinute;
    if (weapon.magazine > 0) {
      gun.roundsInMagazine--;
      if (gun.roundsInMagazine === 0) { gun.cooldown += weapon.reloadSeconds; gun.roundsInMagazine = weapon.magazine; }
    }
  }
  return shots;
}
