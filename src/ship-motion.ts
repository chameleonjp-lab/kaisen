import { Quaternion, Vector3 } from 'three';
import type { Ship } from './types';
import { shipWreckPose } from './ship-wreck';

/** One shared fixed-step pose update for combat and bomb forecasts. No targeting or damage. */
export function advanceShipMotion(ship: Ship, elapsed: number, dt: number): void {
  if (ship.health <= 0) {
    if (ship.wreck) {
      ship.previous.copy(ship.position); ship.previousQuaternion.copy(ship.quaternion);
      shipWreckPose(ship.wreck, elapsed, ship.position, ship.quaternion);
      ship.velocity.copy(ship.wreck.velocity).multiplyScalar(Math.exp(-Math.max(0, elapsed - ship.wreck.since) / 8));
    }
    return;
  }
  ship.previous.copy(ship.position); ship.previousQuaternion.copy(ship.quaternion); ship.age += dt;
  ship.yaw += Math.sin(ship.age * .04 + ship.id) * .0035 * dt;
  const roll = Math.sin(ship.age * .39 + ship.id) * .008;
  const pitch = Math.sin(ship.age * .29 + ship.id * .7) * .004;
  ship.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), ship.yaw)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll));
  const speed = ship.velocity.length();
  ship.velocity.set(-Math.sin(ship.yaw) * speed, 0, -Math.cos(ship.yaw) * speed);
  ship.position.addScaledVector(ship.velocity, dt);
}
