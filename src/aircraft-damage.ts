/** Game tuning shared with FightFlight; not historical weapon performance. */
export const AIRCRAFT_HEALTH = 80;
export type AircraftWeaponKind = 'mg' | 'cannon';
export const AIRCRAFT_BASE_DAMAGE = Object.freeze({
  player: Object.freeze({ mg: 4, cannon: 20 }),
  ally: Object.freeze({ mg: 2.4, cannon: 9.6 }),
  enemy: Object.freeze({ mg: 0.32, cannon: 0.64 }),
});
export const AIRCRAFT_DAMAGE_BANDS = Object.freeze([
  Object.freeze({ fromMetres: 0, mg: 1, cannon: 1 }),
  Object.freeze({ fromMetres: 200, mg: 0.75, cannon: 0.9 }),
  Object.freeze({ fromMetres: 500, mg: 0.5, cannon: 0.8 }),
  Object.freeze({ fromMetres: 800, mg: 0.25, cannon: 0.7 }),
]);

/** Cumulative muzzle-to-impact flight path, including the swept impact fraction.
 * Each boundary belongs to the farther band. Apply exactly once at impact.
 * Shooter movement after firing cannot alter a round's effective damage.
 */
export function aircraftDamageMultiplier(kind: AircraftWeaponKind, distanceMetres: number): number {
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0) {
    throw new RangeError('Aircraft round distance must be finite and nonnegative');
  }
  for (let i = AIRCRAFT_DAMAGE_BANDS.length - 1; i >= 0; i--) {
    if (distanceMetres >= AIRCRAFT_DAMAGE_BANDS[i].fromMetres) return AIRCRAFT_DAMAGE_BANDS[i][kind];
  }
  return 1;
}
