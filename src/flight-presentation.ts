import { Quaternion, Vector3 } from 'three';
import { FIXED_DT } from './mission';
import { normalizeAngle } from './flight';
import type { Aircraft, CombatTarget, GameState } from './types';

interface Pose { position: Vector3; quaternion: Quaternion; bank: number; pitch: number; yaw: number; health: number; }

/** Previous/current fixed poses are presentation data only. Never feed this view to stepGame or release checks. */
export class FlightPresentation {
  private state: GameState | null = null;
  private tick = -1;
  private poses = new Map<number, Pose>();

  capture(state: GameState): void {
    if (state.mode !== 'normal') return;
    if (this.state !== state) this.poses.clear();
    this.state = state; this.tick = state.tick;
    const live = new Set<number>();
    for (const target of [state.player, ...state.allies, ...state.enemies, ...state.ships]) {
      live.add(target.id);
      const pose = this.poses.get(target.id) ?? { position: new Vector3(), quaternion: new Quaternion(), bank: 0, pitch: 0, yaw: 0, health: 0 };
      pose.position.copy(target.position); pose.quaternion.copy(target.quaternion);
      pose.bank = target.kind === 'aircraft' ? target.bank : 0;
      pose.pitch = target.kind === 'aircraft' ? target.pitch : 0;
      pose.yaw = target.yaw; pose.health = target.health;
      this.poses.set(target.id, pose);
    }
    for (const id of this.poses.keys()) if (!live.has(id)) this.poses.delete(id);
  }

  sample(state: GameState, alpha: number): GameState {
    if (state.phase !== 'playing') { this.state = null; return state; }
    if (state.mode !== 'normal' || this.state !== state || this.tick !== state.tick - 1) return state;
    const fraction = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    const pose = <T extends CombatTarget>(target: T): T => {
      const previous = this.poses.get(target.id);
      // Birth/death/terminal collision must show the real current pose, never blend from another entity.
      if (!previous || target.health <= 0 || previous.health <= 0) return target;
      const sampled = { ...target, position: previous.position.clone().lerp(target.position, fraction),
        quaternion: previous.quaternion.clone().slerp(target.quaternion, fraction),
        yaw: previous.yaw + normalizeAngle(target.yaw - previous.yaw) * fraction };
      if (sampled.kind === 'aircraft') {
        sampled.bank = previous.bank + normalizeAngle(target.kind === 'aircraft' ? target.bank - previous.bank : 0) * fraction;
        sampled.pitch = previous.pitch + normalizeAngle((target as Aircraft).pitch - previous.pitch) * fraction;
      }
      return sampled;
    };
    const projectile = <T extends { position: Vector3; previous: Vector3 }>(round: T): T =>
      ({ ...round, position: round.previous.clone().lerp(round.position, fraction) });
    return { ...state, player: pose(state.player), allies: state.allies.map(pose), enemies: state.enemies.map(pose),
      ships: state.ships.map(pose), bullets: state.bullets.map(projectile), ordnance: state.ordnance.map(projectile),
      elapsed: state.elapsed - FIXED_DT * (1 - fraction) };
  }
}
