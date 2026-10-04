import { FRIENDLY_DAMAGE_PENALTY, FRIENDLY_KILL_PENALTY } from './mission';
import type { Aircraft, CombatTarget, GameState, Ship } from './types';

export const SCORE_RULES_VERSION = 'kaisen-contribution-1';
export const SCORE_TUNING = Object.freeze({
  initialAircraft: 500, shipHull: 2000, clear: 12000,
  speedMaximum: 12000, speedPerSecond: 20, damageAvoidanceMaximum: 500, damageAllowance: 80,
});

export interface ScoreTargetCredit {
  readonly id: number;
  readonly kind: 'aircraft' | 'ship';
  readonly initialHealth: number;
  readonly maximumPoints: number;
  /** Lowest observed hull/airframe HP: repeated damage reports cannot earn twice. */
  remainingHealth: number;
  playerDamage: number;
}
export interface ScoreLedger { readonly targets: readonly ScoreTargetCredit[]; }
export interface ScoreBreakdown {
  aircraft: number; ships: number; clear: number; speed: number; damageAvoidance: number;
  friendlyDamagePenalty: number; friendlyKillPenalty: number; totalBeforeRounding: number;
}

/** Capture the initial roster and HP once; replacement enemies never acquire a new budget. */
export function createScoreLedger(enemies: readonly Aircraft[], ships: readonly Ship[]): ScoreLedger {
  return { targets: Object.freeze([...enemies.filter(a => a.generation === 'initial'), ...ships].map(target => ({
    id: target.id, kind: target.kind, initialHealth: target.health,
    maximumPoints: target.kind === 'aircraft' ? SCORE_TUNING.initialAircraft : SCORE_TUNING.shipHull,
    remainingHealth: target.health, playerDamage: 0,
  }))) };
}

/** Called only after authoritative hull/airframe HP changes, never from visual events. */
export function recordTargetDamage(ledger: ScoreLedger, target: CombatTarget, actualDamage: number, playerOwned: boolean): void {
  if (target.team !== 'enemy' || (target.kind === 'aircraft' && target.generation !== 'initial') ||
      !Number.isFinite(actualDamage) || actualDamage < 0 || !Number.isFinite(target.health)) return;
  const credit = ledger.targets.find(entry => entry.id === target.id && entry.kind === target.kind);
  if (!credit || !(credit.initialHealth > 0)) return;
  const remaining = Math.max(0, Math.min(credit.remainingHealth, target.health));
  const consumed = credit.remainingHealth - remaining;
  // Ally fire, sea contact and collisions consume HP without crediting the player.
  if (playerOwned && consumed > 0) {
    // HP subtraction can lose a few low bits (80 - .08). Keep the applied
    // damage within that subtraction's precision; never round point values here.
    const tolerance = 2 * Number.EPSILON * Math.max(1, credit.remainingHealth, remaining);
    const creditedDamage = Math.abs(actualDamage - consumed) <= tolerance
      ? actualDamage : Math.min(actualDamage, consumed);
    credit.playerDamage = Math.min(credit.initialHealth, credit.playerDamage + creditedDamage);
  }
  credit.remainingHealth = remaining;
}

export function scoreBreakdown(state: Pick<GameState, 'scoring' | 'stats' | 'elapsed'>, cleared = false): Readonly<ScoreBreakdown> {
  let aircraft = 0, ships = 0;
  for (const entry of state.scoring.targets) {
    const points = entry.maximumPoints * entry.playerDamage / entry.initialHealth;
    if (entry.kind === 'aircraft') aircraft += points; else ships += points;
  }
  const clear = cleared ? SCORE_TUNING.clear : 0;
  const speed = cleared ? Math.max(0, SCORE_TUNING.speedMaximum - SCORE_TUNING.speedPerSecond * state.elapsed) : 0;
  const damageAvoidance = cleared ? SCORE_TUNING.damageAvoidanceMaximum * Math.max(0, 1 - state.stats.damageTaken / SCORE_TUNING.damageAllowance) : 0;
  const friendlyDamagePenalty = -state.stats.friendlyDamage * FRIENDLY_DAMAGE_PENALTY;
  const friendlyKillPenalty = -state.stats.friendlyKills * FRIENDLY_KILL_PENALTY;
  return Object.freeze({ aircraft, ships, clear, speed, damageAvoidance, friendlyDamagePenalty, friendlyKillPenalty,
    totalBeforeRounding: aircraft + ships + clear + speed + damageAvoidance + friendlyDamagePenalty + friendlyKillPenalty });
}

/** Only the authoritative final sum is rounded. Negative scores remain valid. */
export function finalScore(breakdown: Readonly<ScoreBreakdown>): number {
  const rounded = Math.round(breakdown.totalBeforeRounding);
  return rounded === 0 ? 0 : rounded;
}
