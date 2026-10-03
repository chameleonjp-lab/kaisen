import { Vector3 } from 'three';
import { targetAimPoint } from './flight-assist';
import { projectFlightTarget } from './flight-view';
import type { Aircraft, CombatTarget } from './types';

/** Source Normal bore sight: adjust depth only, never point the guns at a target.
 * Source: faitofuraito@025cad49 src/scene.ts updateCamera. Kaisen additionally
 * considers the existing ship aim point, so the sight works over air and sea.
 */
export function projectGunSight(player: Aircraft, targets: readonly CombatTarget[], width: number, height: number) {
  const forward = new Vector3(0, 0, -1).applyQuaternion(player.quaternion);
  let depth = 500;
  let bestAlignment = -1;
  for (const target of targets) {
    if (target.health <= 0) continue;
    const relative = targetAimPoint(target).sub(player.position);
    const candidateDepth = relative.dot(forward);
    if (candidateDepth < 24 || candidateDepth > 1200) continue;
    const alignment = candidateDepth / Math.max(1e-4, relative.length());
    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      depth = candidateDepth;
    }
  }
  const aim = new Vector3(0, 0, -4.5).applyQuaternion(player.quaternion)
    .add(player.position).addScaledVector(forward, depth);
  const projection = projectFlightTarget(player, aim, width / height, 'normal');
  return { x: (projection.x * .5 + .5) * width, y: (.5 - projection.y * .5) * height, depth };
}
