import { Quaternion, Vector3 } from 'three';
import { CAPITAL_SHIP, NAVAL_GUN_HOUSE_PLANES, NAVAL_MOUNTS, NAVAL_WEAPONS, segmentNavalHullEntry, shipCollisionBoxes } from './naval';
import type { Ship } from './types';

export interface MountContact { index: number; fraction: number; }

function intersectsBox(a: Vector3, b: Vector3, min: Vector3, max: Vector3): boolean {
  let enter = 0, exit = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) { if (a[axis] < min[axis] || a[axis] > max[axis]) return false; continue; }
    const x = (min[axis] - a[axis]) / delta, y = (max[axis] - a[axis]) / delta;
    enter = Math.max(enter, Math.min(x, y)); exit = Math.min(exit, Math.max(x, y));
    if (enter > exit) return false;
  }
  return enter < .999;
}

/** Target choice only inside the existing ship firing gate/cone. Never changes
 * aircraft assistance, Normal manual direction, or fires through the hull.
 */
export function exposedNavalMountPoint(ship: Ship, observer: Vector3): Vector3 | undefined {
  const inverse = ship.quaternion.clone().invert(), local = observer.clone().sub(ship.position).applyQuaternion(inverse);
  const boxes = shipCollisionBoxes(ship);
  const mounts = NAVAL_MOUNTS.map((definition, index) => ({ definition, index,
    point: new Vector3(...definition.pivot).add(new Vector3(0, -1, 0)) }))
    .filter(item => item.definition.weapon.endsWith('aa') && ship.guns[item.index]?.health > 0)
    .sort((a, b) => local.distanceToSquared(a.point) - local.distanceToSquared(b.point));
  for (const { point, index } of mounts) {
    if (segmentNavalHullEntry(local, point) !== null || boxes.some(box => intersectsBox(local, point, box.min, box.max))) continue;
    if (segmentMountContact(local, point, ship)?.index !== index) continue;
    return point.applyQuaternion(ship.quaternion).add(ship.position);
  }
  return undefined;
}
/** The same angular/sloped gun house as ShipFactory, in hull-local space. */
export function segmentMountContact(start: Vector3, end: Vector3, ship: Pick<Ship, 'guns'>): MountContact | null {
  let first: MountContact | null = null;
  for (let index = 0; index < NAVAL_MOUNTS.length; index++) {
    const definition = NAVAL_MOUNTS[index], gun = ship.guns[index]; if (!gun) continue;
    const [width, height, length] = NAVAL_WEAPONS[definition.weapon].bodySize;
    const center = new Vector3(...definition.pivot); center.y -= 1;
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -gun.yaw);
    const size = new Vector3(width, height, length);
    const a = start.clone().sub(center).applyQuaternion(rotation).divide(size), b = end.clone().sub(center).applyQuaternion(rotation).divide(size);
    let enter = 0, exit = 1;
    for (const [x, y, z, limit] of NAVAL_GUN_HOUSE_PLANES) {
      const from = x * a.x + y * a.y + z * a.z - limit, to = x * b.x + y * b.y + z * b.z - limit;
      if (from > 0 && to > 0) { enter = 2; break; }
      if (from <= 0 && to <= 0) continue;
      const fraction = from / (from - to);
      if (from > 0) enter = Math.max(enter, fraction); else exit = Math.min(exit, fraction);
      if (enter > exit) break;
    }
    if (enter <= exit && enter <= 1 && (!first || enter < first.fraction)) first = { index, fraction: enter };
  }
  return first;
}

/** Guns suppress exposed parts; armored hull HP is reserved for anti-ship ordnance. */
export function applyAircraftRoundToShip(ship: Ship, damage: number, localImpact: Vector3, mountIndex: number | null) {
  if (!(damage > 0) || !Number.isFinite(damage)) return { partDamage: 0, mountDestroyed: false, armor: true };
  const gun = mountIndex === null ? undefined : ship.guns[mountIndex];
  if (gun) {
    const actual = damage >= gun.health - 1e-8 ? gun.health : damage; gun.health -= actual;
    return { partDamage: actual, mountDestroyed: actual > 0 && gun.health <= 0, armor: false };
  }
  if (localImpact.y > CAPITAL_SHIP.deckHeight + .05) {
    const actual = damage >= ship.superstructureHealth - 1e-8 ? ship.superstructureHealth : damage; ship.superstructureHealth -= actual;
    return { partDamage: actual, mountDestroyed: false, armor: false };
  }
  return { partDamage: 0, mountDestroyed: false, armor: true };
}
