import { Vector3 } from 'three';
import { projectFlightTarget } from './flight-view';
import type { Aircraft, CombatTarget } from './types';

/** Normal bore sight fixed at 500 m: targets never change its projection.
 * Source: faitofuraito@025cad49 src/scene.ts updateCamera. Kaisen fixes the convergence plane to remove target-depth jumps.
 */
export function projectGunSight(player: Aircraft, _targets: readonly CombatTarget[], width: number, height: number) {
  const forward = new Vector3(0, 0, -1).applyQuaternion(player.quaternion);
  const depth = 500;
  const aim = new Vector3(0, 0, -4.5).applyQuaternion(player.quaternion)
    .add(player.position).addScaledVector(forward, depth);
  const projection = projectFlightTarget(player, aim, width / height, 'normal');
  return { x: (projection.x * .5 + .5) * width, y: (.5 - projection.y * .5) * height, depth };
}
