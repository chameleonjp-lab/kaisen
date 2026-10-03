import type { GameState } from './types';

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
