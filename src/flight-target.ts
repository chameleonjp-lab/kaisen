/** Selection uses only fixed-tick world facts; no renderer or wall clock. */
export interface FlightTargetLock { key: string | null; manual: boolean; changed: boolean }
export function createFlightTargetLock(): FlightTargetLock { return { key: null, manual: false, changed: false }; }
/** Proposed margin: 1.5% of the short viewport edge, about 6px at 393px. */
export const TARGET_SWITCH_RADIUS_MARGIN = .015;
export interface ProjectedTarget<T> {
  key: string; enemy: T;
  projection: { x: number; y: number; distance: number; visible: boolean; inCircle: boolean };
}
export function flightTargetKey(target: { id?: string | number; kind?: string; generation?: string | number; identityGeneration?: number; position?: { x: number; y: number; z: number } }): string {
  // Runtime adapters supply IDs and generations. Position is for legacy fixtures only.
  return `${target.kind ?? 'target'}:${target.id ?? `${target.position?.x},${target.position?.y},${target.position?.z}`}:${target.identityGeneration ?? target.generation ?? 0}`;
}
export function selectProjectedTarget<T>(candidates: readonly ProjectedTarget<T>[], aspect: number, range: number,
  lock?: FlightTargetLock, manual = lock?.manual ?? false): ProjectedTarget<T> | null {
  const ranked = candidates.filter(c => c.projection.visible).map(candidate => ({ candidate,
    tier: candidate.projection.inCircle ? (candidate.projection.distance <= range ? 0 : 1) : 2,
    radius: Math.hypot(candidate.projection.x * Math.max(1, aspect), candidate.projection.y * Math.max(1, 1 / aspect)) / 2,
  })).sort((a, b) => a.tier - b.tier || a.radius - b.radius || a.candidate.projection.distance - b.candidate.projection.distance
    || (a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0));
  let best = ranked[0];
  const held = lock && ranked.find(c => c.candidate.key === lock.key);
  if (held && best && held.tier === best.tier
    && (manual || held.radius - best.radius <= TARGET_SWITCH_RADIUS_MARGIN + 1e-12)) best = held;
  if (lock) { const key = best?.candidate.key ?? null; lock.changed ||= key !== lock.key; lock.key = key; lock.manual = manual; }
  return best?.candidate ?? null;
}
/** A tick's fire phase may validate its selected ID, but never steer/fire at different IDs. */
export function revalidateProjectedTarget<T>(candidates: readonly ProjectedTarget<T>[], lock: FlightTargetLock): ProjectedTarget<T> | null {
  return candidates.find(c => c.key === lock.key && c.projection.visible) ?? null;
}
export interface FlightAssistanceState { assistTurn: number; assistClimb: number; assistClimbMode?: 'absolute' | 'relative'; responseMultiplier: number; targetLock: FlightTargetLock }
export function clearFlightAssistance(state: FlightAssistanceState): void {
  state.targetLock.key = null; state.targetLock.manual = false; state.targetLock.changed = false;
  state.assistTurn = 0; state.assistClimb = 0; state.assistClimbMode = undefined; state.responseMultiplier = 1;
}
/** New pull is bounded; release/invalid target/neutral aim cancels stale pull. */
export function smoothFlightAssistance(state: FlightAssistanceState, input: { turn: number; climb: number },
  assist: { turn: number; climb: number; responseMultiplier: number; hasVisibleTarget: boolean }, dt: number, pitchOrigin?: number) {
  const slew = (current: number, target: number, rate: number) => current + Math.max(-rate * dt, Math.min(rate * dt, target - current));
  const manual = Math.max(Math.abs(input.turn), Math.abs(input.climb)) >= .35;
  if (state.targetLock.changed) { state.assistTurn = 0; state.assistClimb = 0; state.assistClimbMode = undefined; state.targetLock.changed = false; }
  const turn = assist.turn - input.turn, climb = assist.climb - input.climb;
  state.assistTurn = manual || !assist.hasVisibleTarget || Math.abs(turn) < 1e-12 || turn * input.turn < 0
    ? 0 : slew(state.assistTurn, turn, 2.5);
  const climbActive = !(manual || !assist.hasVisibleTarget || Math.abs(climb) < 1e-12 || climb * input.climb < 0);
  const climbMode = pitchOrigin === undefined ? 'relative' : 'absolute';
  // Easy climb is an absolute attitude command. A new pull must start at
  // the live attitude; zero would command horizontal and briefly pitch away
  // from a new target. Inactive/neutral assistance still clears immediately.
  state.assistClimb = climbActive
    ? slew(state.assistClimbMode === climbMode ? state.assistClimb : (pitchOrigin ?? 0), climb, 1.5) : 0;
  state.assistClimbMode = climbActive ? climbMode : undefined;
  // Do not carry a previous opposite-direction pull into a new selection.
  if (state.assistTurn * input.turn < 0) state.assistTurn = 0;
  if (state.assistClimb * input.climb < 0) state.assistClimb = 0;
  state.responseMultiplier = slew(state.responseMultiplier, assist.responseMultiplier, 2.5);
  return { ...input, turn: input.turn + state.assistTurn, climb: input.climb + state.assistClimb };
}
