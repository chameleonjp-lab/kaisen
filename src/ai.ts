import { Vector3 } from 'three';
import { clamp, desiredFlightInput, forwardOf } from './flight';
import { AI_DECISION_TICKS } from './mission';
import { targetAimPoint } from './flight-assist';
import type { Aircraft, CombatTarget, GameState } from './types';

export function targetFor(state: GameState, id: number | null): CombatTarget | null {
  if (id === null) return null;
  const target = [state.player, ...state.allies, ...state.enemies, ...state.ships].find(item => item.id === id);
  return target && target.health > 0 ? target : null;
}

/** Stable target ownership survives decision ticks; only dead/missing targets are reassigned. */
export function assignTargets(state: GameState): void {
  const aircraft = [...state.allies, ...state.enemies].filter(item => item.health > 0).sort((a, b) => a.id - b.id);
  const loads = new Map<number, number>();
  for (const plane of aircraft) {
    const target = targetFor(state, plane.targetId);
    if (target && target.team !== plane.team) loads.set(target.id, (loads.get(target.id) ?? 0) + 1);
    else plane.targetId = null;
  }
  for (const plane of aircraft) {
    if (plane.targetId !== null) continue;
    let candidates: CombatTarget[] = plane.team === 'enemy'
      ? [state.player, ...state.allies].filter(item => item.health > 0)
      : (plane.role === 'strike' ? state.ships : state.enemies).filter(item => item.health > 0);
    if (!candidates.length && plane.team === 'friendly') candidates = [...state.enemies, ...state.ships].filter(item => item.health > 0);
    candidates.sort((a, b) => {
      const aCost = (loads.get(a.id) ?? 0) * 1800 + plane.position.distanceTo(a.position);
      const bCost = (loads.get(b.id) ?? 0) * 1800 + plane.position.distanceTo(b.position);
      return aCost - bCost || a.id - b.id;
    });
    plane.targetId = candidates[0]?.id ?? null;
    plane.aiPhase = 'approach'; plane.aiPhaseTime = 0;
    if (plane.targetId !== null) loads.set(plane.targetId, (loads.get(plane.targetId) ?? 0) + 1);
  }
}

function beginExtension(plane: Aircraft, target: CombatTarget): void {
  plane.aiPhase = 'extend'; plane.mode = 'evade'; plane.aiPhaseTime = 0;
  const forward = forwardOf(plane); forward.y = 0;
  if (forward.lengthSq() < 0.01) forward.set(0, 0, -1);
  forward.normalize();
  const sideways = new Vector3(-forward.z, 0, forward.x);
  plane.aiWaypoint.copy(plane.position).addScaledVector(forward, target.kind === 'ship' ? 510 : 380)
    .addScaledVector(sideways, plane.id % 2 === 0 ? 85 : -85);
  plane.aiWaypoint.y = Math.max(target.kind === 'ship' ? 210 : 160, Math.min(650, plane.position.y + 65));
}

/** Decisions use only current/past world state. The same flight limits apply to every aircraft. */
export function updateAI(state: GameState, plane: Aircraft, dt: number): void {
  plane.aiPhaseTime += dt;
  const target = targetFor(state, plane.targetId);
  if (!target) { plane.aiTurn = 0; plane.aiClimb = 0; plane.aiFire = false; return; }
  const distance = plane.position.distanceTo(target.position);
  // The low-altitude escape is mandatory and precedes firing; no magic altitude clamp.
  const mustEscape = plane.position.y < (target.kind === 'ship' ? 82 : 50);
  const heading = forwardOf(plane); heading.y = 0;
  const horizontal = target.position.clone().sub(plane.position); horizontal.y = 0;
  const tooCloseToLineUp = target.kind === 'ship' && plane.aiPhase === 'approach'
    && distance < 360 && heading.angleTo(horizontal) > 0.26;
  if (plane.aiPhase !== 'extend' && (mustEscape || tooCloseToLineUp || distance < (target.kind === 'ship' ? 215 : 88))) beginExtension(plane, target);
  if (plane.aiPhase === 'extend' && plane.aiPhaseTime >= (target.kind === 'ship' ? 5 : 3.4)) {
    plane.aiPhase = 'approach'; plane.aiPhaseTime = 0; plane.mode = 'pursue';
  }
  // Inputs are held between bounded 10 Hz planning ticks; weapons re-check alignment every tick.
  if (state.tick % AI_DECISION_TICKS === plane.id % AI_DECISION_TICKS || plane.aiPhaseTime <= dt + 1e-8 || mustEscape) {
    let aim: Vector3;
    if (plane.aiPhase === 'extend') {
      aim = plane.aiWaypoint.clone();
      if (mustEscape) aim.y = Math.max(210, plane.position.y + 180);
    } else if (target.kind === 'ship') {
      aim = target.position.clone().addScaledVector(target.velocity, Math.min(2, distance / 750));
      const heading = forwardOf(plane); heading.y = 0;
      const horizontal = aim.clone().sub(plane.position); horizontal.y = 0;
      const linedUp = heading.angleTo(horizontal) < 0.26;
      // Establish a straight run before descending. Diving throughout a U-turn
      // otherwise traps an aircraft in repeated low-altitude escapes.
      if (plane.aiPhase === 'approach' && linedUp && distance < 980 && distance > 330) plane.aiPhase = 'attack';
      aim.y = plane.aiPhase === 'attack' ? targetAimPoint(target).y : 230;
    } else {
      const lead = Math.min(0.75, distance / 930);
      aim = target.position.clone().addScaledVector(forwardOf(target), target.speed * lead);
      aim.y = Math.max(110, aim.y);
      plane.aiPhase = distance < 700 ? 'attack' : 'approach';
    }
    const controls = desiredFlightInput(plane, aim);
    plane.aiTurn = controls.turn; plane.aiClimb = clamp(controls.climb, -1, 1);
  }
  const targetPoint = targetAimPoint(target);
  const toTarget = targetPoint.sub(plane.position);
  const angle = forwardOf(plane).angleTo(toTarget);
  plane.aiFire = plane.aiPhase !== 'extend' && distance < (target.kind === 'ship' ? 980 : 740)
    && distance > 35 && angle < (target.kind === 'ship' ? 0.10 : 0.09) && !mustEscape;
}
