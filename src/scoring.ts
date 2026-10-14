import { FRIENDLY_DAMAGE_PENALTY, FRIENDLY_KILL_PENALTY } from './mission';
import type { Aircraft, CombatTarget, GameState, Ship } from './types';

export const SCORE_RULES_VERSION = 'kaisen-contribution-2';
export const SCORE_TUNING = Object.freeze({
  aircraftDamagePerTarget: 500, aircraftDamageMaximum: 2500, aircraftKillBonus: 100,
  shipHull: 2000, shipKillBonus: 200, mountDestroyBonus: 25,
  clear: 12000, speedMaximum: 12000, speedPerSecond: 20,
  damageAvoidanceMaximum: 500, damageAllowance: 80,
});

export interface ScoreTargetCredit {
  readonly id: number;
  readonly kind: 'aircraft' | 'ship';
  readonly initialHealth: number;
  readonly maximumPoints: number;
  /** Lowest observed hull/airframe HP: repeated damage reports cannot earn twice. */
  remainingHealth: number;
  /** Damage that contributed points after global aircraft limits were applied. */
  playerDamage: number;
}
export interface ScoreLedger {
  readonly targets: readonly ScoreTargetCredit[];
  /** Initial and generated aircraft stay weakly keyed, so replacing slots adds no retained entity list. */
  readonly aircraftCredits: WeakMap<Aircraft, ScoreTargetCredit>;
  readonly aircraftKillAwards: WeakSet<Aircraft>;
  readonly shipKillAwards: Set<number>;
  readonly mountDestroyAwards: Set<string>;
  aircraftDamagePoints: number;
  aircraftKillBonus: number;
  shipKillBonus: number;
  mountDestroyBonus: number;
}
export interface ScoreBreakdown {
  aircraft: number; ships: number; aircraftKillBonus: number; shipKillBonus: number; mountDestroyBonus: number;
  clear: number; speed: number; damageAvoidance: number;
  friendlyDamagePenalty: number; friendlyKillPenalty: number; totalBeforeRounding: number;
}

function targetCredit(target: CombatTarget): ScoreTargetCredit {
  return { id: target.id, kind: target.kind, initialHealth: target.health,
    maximumPoints: target.kind === 'aircraft' ? SCORE_TUNING.aircraftDamagePerTarget : SCORE_TUNING.shipHull,
    remainingHealth: target.health, playerDamage: 0 };
}

/** Capture the initial roster and HP once; generated aircraft are registered weakly at spawn. */
export function createScoreLedger(enemies: readonly Aircraft[], ships: readonly Ship[]): ScoreLedger {
  const initialAircraft = enemies.filter(a => a.generation === 'initial');
  const targets = [...initialAircraft, ...ships].map(targetCredit);
  const aircraftCredits = new WeakMap<Aircraft, ScoreTargetCredit>();
  for (let index = 0; index < initialAircraft.length; index++) aircraftCredits.set(initialAircraft[index], targets[index]);
  return {
    targets: Object.freeze(targets), aircraftCredits, aircraftKillAwards: new WeakSet(),
    shipKillAwards: new Set(), mountDestroyAwards: new Set(),
    aircraftDamagePoints: 0, aircraftKillBonus: 0, shipKillBonus: 0, mountDestroyBonus: 0,
  };
}

/** Register a generated enemy at its original HP without growing the fixed initial target ledger. */
export function registerAircraftForScoring(ledger: ScoreLedger, aircraft: Aircraft): void {
  if (aircraft.team !== 'enemy' || aircraft.generation !== 'reinforcement' || ledger.aircraftCredits.has(aircraft)) return;
  ledger.aircraftCredits.set(aircraft, targetCredit(aircraft));
}

/** Called only after authoritative hull/airframe HP changes, never from visual events. */
export function recordTargetDamage(
  ledger: ScoreLedger, target: CombatTarget, actualDamage: number, playerOwned: boolean, playerAircraftKills = 0,
): void {
  if (target.team !== 'enemy' || !Number.isFinite(actualDamage) || actualDamage < 0 || !Number.isFinite(target.health)) return;
  const credit = target.kind === 'aircraft'
    ? ledger.aircraftCredits.get(target)
    : ledger.targets.find(entry => entry.id === target.id && entry.kind === target.kind);
  if (!credit || !(credit.initialHealth > 0)) return;
  const remaining = Math.max(0, Math.min(credit.remainingHealth, target.health));
  const consumed = credit.remainingHealth - remaining;
  // Ally fire, sea contact and collisions consume HP without crediting the player.
  if (playerOwned && consumed > 0 && (target.kind !== 'aircraft' || playerAircraftKills < 5)) {
    // HP subtraction can lose a few low bits (80 - .08). Keep the applied
    // damage within that subtraction's precision; never round point values here.
    const tolerance = 2 * Number.EPSILON * Math.max(1, credit.remainingHealth, remaining);
    const actualCreditedDamage = Math.abs(actualDamage - consumed) <= tolerance
      ? actualDamage : Math.min(actualDamage, consumed);
    if (target.kind === 'aircraft') {
      const requestedPoints = credit.maximumPoints * actualCreditedDamage / credit.initialHealth;
      const availablePoints = Math.max(0, SCORE_TUNING.aircraftDamageMaximum - ledger.aircraftDamagePoints);
      const awardedPoints = Math.min(requestedPoints, availablePoints);
      if (awardedPoints > 0 && requestedPoints > 0) {
        const contributingDamage = actualCreditedDamage * (awardedPoints / requestedPoints);
        credit.playerDamage = Math.min(credit.initialHealth, credit.playerDamage + contributingDamage);
        ledger.aircraftDamagePoints = Math.min(SCORE_TUNING.aircraftDamageMaximum, ledger.aircraftDamagePoints + awardedPoints);
      }
    } else {
      credit.playerDamage = Math.min(credit.initialHealth, credit.playerDamage + actualCreditedDamage);
    }
  }
  credit.remainingHealth = remaining;
}

/** Add the small kill award only from a player-owned weapon destruction path. */
export function recordPlayerWeaponKillBonus(ledger: ScoreLedger, target: CombatTarget, playerAircraftKills: number): void {
  if (target.team !== 'enemy') return;
  if (target.kind === 'aircraft') {
    if (ledger.aircraftKillAwards.has(target)) return;
    ledger.aircraftKillAwards.add(target);
    if (playerAircraftKills <= 5) ledger.aircraftKillBonus += SCORE_TUNING.aircraftKillBonus;
  } else {
    if (ledger.shipKillAwards.has(target.id)) return;
    ledger.shipKillAwards.add(target.id);
    ledger.shipKillBonus += SCORE_TUNING.shipKillBonus;
  }
}

/** Called on the authoritative positive-HP to zero-HP mount transition. */
export function recordPlayerMountDestroyBonus(ledger: ScoreLedger, ship: Ship, mountId: string): void {
  if (ship.team !== 'enemy') return;
  const key = `${ship.id}:${mountId}`;
  if (ledger.mountDestroyAwards.has(key)) return;
  ledger.mountDestroyAwards.add(key);
  ledger.mountDestroyBonus += SCORE_TUNING.mountDestroyBonus;
}

export function scoreBreakdown(state: Pick<GameState, 'scoring' | 'stats' | 'elapsed'>, cleared = false): Readonly<ScoreBreakdown> {
  const aircraft = state.scoring.aircraftDamagePoints;
  let ships = 0;
  for (const entry of state.scoring.targets) {
    if (entry.kind === 'ship') ships += entry.maximumPoints * entry.playerDamage / entry.initialHealth;
  }
  const aircraftKillBonus = state.scoring.aircraftKillBonus;
  const shipKillBonus = state.scoring.shipKillBonus;
  const mountDestroyBonus = state.scoring.mountDestroyBonus;
  const clear = cleared ? SCORE_TUNING.clear : 0;
  const speed = cleared ? Math.max(0, SCORE_TUNING.speedMaximum - SCORE_TUNING.speedPerSecond * state.elapsed) : 0;
  const damageAvoidance = cleared ? SCORE_TUNING.damageAvoidanceMaximum * Math.max(0, 1 - state.stats.damageTaken / SCORE_TUNING.damageAllowance) : 0;
  const friendlyDamagePenalty = -state.stats.friendlyDamage * FRIENDLY_DAMAGE_PENALTY;
  const friendlyKillPenalty = -state.stats.friendlyKills * FRIENDLY_KILL_PENALTY;
  return Object.freeze({ aircraft, ships, aircraftKillBonus, shipKillBonus, mountDestroyBonus, clear, speed, damageAvoidance,
    friendlyDamagePenalty, friendlyKillPenalty,
    totalBeforeRounding: aircraft + ships + aircraftKillBonus + shipKillBonus + mountDestroyBonus + clear + speed + damageAvoidance + friendlyDamagePenalty + friendlyKillPenalty });
}

/** Only the authoritative final sum is rounded. Negative scores remain valid. */
export function finalScore(breakdown: Readonly<ScoreBreakdown>): number {
  const rounded = Math.round(breakdown.totalBeforeRounding);
  return rounded === 0 ? 0 : rounded;
}
