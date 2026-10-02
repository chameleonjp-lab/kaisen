import { PLAYER_CANNON_CAPACITY, PLAYER_MG_CAPACITY, PLAYER_RELOAD_TICKS } from './mission';
import type { Aircraft } from './types';

/** Called once at the beginning of each active fixed tick, never by the view. */
export function tickPlayerReload(player: Aircraft): boolean {
  if (player.health <= 0 || player.reloadTicksRemaining <= 0) return false;
  player.reloadTicksRemaining -= 1;
  if (player.reloadTicksRemaining > 0) return false;
  player.mg = PLAYER_MG_CAPACITY;
  player.cannon = PLAYER_CANNON_CAPACITY;
  return true;
}
/** A shared reload starts only after both magazines have actually been emitted. */
export function beginPlayerReload(player: Aircraft): boolean {
  if (player.health <= 0 || player.reloadTicksRemaining > 0 || player.mg > 0 || player.cannon > 0) return false;
  player.reloadTicksRemaining = PLAYER_RELOAD_TICKS;
  return true;
}
