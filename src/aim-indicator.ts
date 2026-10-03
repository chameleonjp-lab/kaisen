import { targetAimPoint } from './flight-assist';
import { projectFlightTarget } from './flight-view';
import type { CombatTarget, GameState } from './types';

export const AIM_COLORS = { clear: '#ffffff', enemy: '#ff645b', friendly: '#6cb8ff' } as const;
export function aimRadius(mode: GameState['mode'], width: number, height: number): number {
  return mode === 'normal' ? Math.max(26, Math.min(38, Math.min(width, height) * .085)) : Math.min(width, height) * .135;
}
/** Display only. A friendly inside the circle takes priority to warn before manual fire. */
export function aimIndicator(state: Pick<GameState, 'player' | 'mode'>, targets: readonly CombatTarget[], sight: { x: number; y: number }, width: number, height: number): keyof typeof AIM_COLORS {
  const radius = aimRadius(state.mode, width, height);
  let indicator: keyof typeof AIM_COLORS = 'clear';
  for (const target of targets) {
    if (target.health <= 0) continue;
    const p = projectFlightTarget(state.player, targetAimPoint(target), width / height, state.mode);
    if (p.depth <= 0 || p.distance > (target.kind === 'ship' ? 6000 : 1500)) continue;
    if (Math.hypot((p.x * .5 + .5) * width - sight.x, (.5 - p.y * .5) * height - sight.y) > radius) continue;
    if (target.team === 'friendly') return 'friendly';
    indicator = 'enemy';
  }
  return indicator;
}
