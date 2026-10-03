import { Quaternion, Vector3 } from 'three';
import type { Ship } from './types';

export const SHIP_SINK_SECONDS = 28;
export interface ShipWreck {
  since: number; position: Vector3; rotation: Quaternion; velocity: Vector3; listSide: number;
}
const rollAxis = new Vector3(0, 0, 1);

export function beginShipWreck(ship: Ship, elapsed: number): void {
  if (ship.wreck) return;
  ship.wreck = { since: elapsed, position: ship.position.clone(), rotation: ship.quaternion.clone(),
    velocity: ship.velocity.clone(), listSide: ship.id % 2 === 0 ? 1 : -1 };
}

/** Shared by combat collision and presentation. The frozen death origin is never moved. */
export function shipWreckPose(wreck: ShipWreck, elapsed: number, position: Vector3, rotation: Quaternion): void {
  const age = Math.max(0, Math.min(SHIP_SINK_SECONDS, elapsed - wreck.since));
  position.copy(wreck.position).addScaledVector(wreck.velocity, 8 * (1 - Math.exp(-age / 8)));
  position.y -= 55 * Math.pow(age / SHIP_SINK_SECONDS, 1.3);
  rotation.copy(wreck.rotation).multiply(new Quaternion().setFromAxisAngle(rollAxis, wreck.listSide * Math.min(.5, age * .018)));
}

export function isShipObstacle(ship: Ship, elapsed: number): boolean {
  return ship.health > 0 || (ship.wreck !== null && elapsed - ship.wreck.since < SHIP_SINK_SECONDS);
}
