import type { GameState } from './types';
import { MAX_ORDNANCE } from './mission';
import { checkTorpedoRelease, ORDNANCE_TUNING } from './ordnance';

/** The tally is credited to the whole friendly formation and never rolls back on a wave. */
export function missionProgress(state: GameState) {
  return {
    aircraftDestroyed: state.stats.playerAircraftKills + state.stats.allyAircraftKills,
    shipsDestroyed: state.stats.playerShipKills + state.stats.allyShipKills,
    aircraftRemaining: state.enemies.filter(plane => plane.health > 0).length,
    shipsRemaining: state.ships.filter(ship => ship.health > 0).length,
  };
}

export function payloadReadout(rounds: number, reloadTicks: number): string {
  return reloadTicks > 0 ? `装填 ${(Math.ceil(reloadTicks / 6) / 10).toFixed(1)}秒` : `残り${rounds}発`;
}

/** The HUD follows firePayload's rejection order without changing any launch rule. */
export function torpedoReleaseCue(state: GameState): { ready: boolean; short: string; text: string } {
  const p = state.player;
  const blocked = (short: string, text: string) => ({ ready: false, short, text });
  if (p.health <= 0) return blocked('投下不可', '魚雷：投下できません');
  if (state.phase !== 'playing') return blocked('停止中', '魚雷：再開すると操作できます');
  if (p.torpedoes <= 0 || p.torpedoReloadTicks > 0) return blocked('装填中', `魚雷：${payloadReadout(p.torpedoes, p.torpedoReloadTicks)}`);
  if (p.payloadCooldown > 0) return blocked('投下待ち', `魚雷：あと${(Math.ceil(p.payloadCooldown * 10) / 10).toFixed(1)}秒`);
  if (state.ordnance.length >= MAX_ORDNANCE) return blocked('投下待ち', '魚雷：飛翔中の兵装が多いため待機');
  const check = checkTorpedoRelease(p, state.elapsed);
  if (!check.allowed) {
    if (check.reason === 'altitude') return blocked(check.altitude > ORDNANCE_TUNING.torpedo.maxReleaseAltitude ? '高度↓' : '高度↑', '魚雷：高度20〜80mを目安に');
    if (check.reason === 'speed') return blocked('減速', '魚雷：450km/h以下に減速');
    if (check.reason === 'pitch') return blocked('機首水平', '魚雷：機首を水平に');
    if (check.reason === 'bank') return blocked('翼を水平', '魚雷：翼を水平に');
    return blocked('投下不可', '魚雷：この姿勢では投下できません');
  }
  return { ready: true, short: '投下可能', text: '魚雷：投下可能' };
}

export type HudRect = { x: number; y: number; width: number; height: number };
/** Display-pixel geometry only. Candidate edges leave a gap to measured HUD/input bounds. */
export function placeHudNotice(bounds: HudRect, size: { width: number; height: number }, obstacles: readonly HudRect[], preferred: { x: number; y: number }, gap = 6): HudRect | null {
  const maxX = bounds.x + bounds.width - size.width, maxY = bounds.y + bounds.height - size.height;
  if (size.width <= 0 || size.height <= 0 || maxX < bounds.x || maxY < bounds.y) return null;
  const clampX = (x: number) => Math.max(bounds.x, Math.min(maxX, x));
  const clampY = (y: number) => Math.max(bounds.y, Math.min(maxY, y));
  const xs = [...new Set([preferred.x, bounds.x, maxX, ...obstacles.flatMap(o => [o.x - size.width - gap, o.x + o.width + gap])].map(clampX))];
  const ys = [...new Set([preferred.y, bounds.y, maxY, ...obstacles.flatMap(o => [o.y - size.height - gap, o.y + o.height + gap])].map(clampY))];
  let best: HudRect | null = null, score = Infinity;
  for (const x of xs) for (const y of ys) {
    if (obstacles.some(o => x < o.x + o.width + gap && x + size.width + gap > o.x && y < o.y + o.height + gap && y + size.height + gap > o.y)) continue;
    const distance = Math.abs(x - preferred.x) + Math.abs(y - preferred.y);
    if (distance < score) { score = distance; best = { x, y, width: size.width, height: size.height }; }
  }
  return best;
}
