// Flight assistance adapted from the pinned source listed in docs/PLAN.md.
import type { Aircraft, CombatTarget, FlightInput, GameMode } from './types';
import { Vector3 } from 'three';
import { EASY_AIM_RADIUS, FLIGHT_CAMERA_BANK_FACTOR, FLIGHT_FOV, projectFlightTarget } from './flight-view';

export const PLAYER_MAX_PITCH = 0.95;
export const EASY_AUTO_FIRE_RANGE = 1200;
export const OFFSCREEN_RESPONSE_MULTIPLIER = 1.65;

/** Authoritative aim/marker point. Returns a copy so consumers cannot move entities. */
export function targetAimPoint(target: CombatTarget): Vector3 {
  const point = target.position.clone();
  // Above the hull, inside the central superstructure collision box.
  if (target.kind === 'ship') point.y += target.height * 0.4;
  return point;
}

export interface FlightAssistResult {
  turn: number;
  climb: number;
  responseMultiplier: number;
  hasVisibleTarget: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function normalizedAspect(aspect: number | undefined): number {
  return Number.isFinite(aspect) && (aspect ?? 0) > 0 ? aspect! : 393 / 852;
}

function closestVisibleTarget(player: Aircraft, enemies: readonly CombatTarget[], aspect: number, mode: GameMode) {
  let closest: { enemy: CombatTarget; projection: ReturnType<typeof projectFlightTarget> } | null = null;
  for (const enemy of enemies) {
    if (enemy.health <= 0) continue;
    const projection = projectFlightTarget(player, targetAimPoint(enemy), aspect, mode);
    if (!projection.visible) continue;
    if (!closest || projection.distance < closest.projection.distance) closest = { enemy, projection };
  }
  return closest;
}

/**
 * Adds an easy-mode steering pull toward visible enemies outside the firing
 * circle. The returned climb is still an absolute pitch command, matching the
 * aircraft controller's existing input contract.
 */
export function getFlightAssist(
  player: Aircraft,
  enemies: readonly CombatTarget[],
  input: FlightInput,
  mode: GameMode,
): FlightAssistResult {
  const manualTurn = clamp(input.turn, -1, 1);
  const manualClimb = clamp(input.climb, -1, 1);
  const aspect = normalizedAspect(input.viewAspect);
  const target = closestVisibleTarget(player, enemies, aspect, mode);
  const hasVisibleTarget = target !== null;
  const responseMultiplier = enemies.some((enemy) => enemy.health > 0) && !hasVisibleTarget
    ? OFFSCREEN_RESPONSE_MULTIPLIER
    : 1;

  if (mode !== 'easy') {
    return { turn: manualTurn, climb: manualClimb, responseMultiplier, hasVisibleTarget };
  }

  if (!target) {
    return {
      turn: manualTurn,
      climb: manualClimb,
      responseMultiplier,
      hasVisibleTarget: false,
    };
  }

  const { projection } = target;
  const shortEdgeX = projection.x * Math.max(1, aspect);
  const shortEdgeY = projection.y * Math.max(1, 1 / aspect);
  const screenRadius = Math.hypot(shortEdgeX, shortEdgeY) / 2;
  const manualWeight = clamp(Math.max(Math.abs(manualTurn), Math.abs(manualClimb)) / 0.35, 0, 1);
  const assistFade = clamp((screenRadius - EASY_AIM_RADIUS) / (EASY_AIM_RADIUS * 2), 0, 1) * (1 - manualWeight);
  if (assistFade <= 0) {
    return { turn: manualTurn, climb: manualClimb, responseMultiplier, hasVisibleTarget: true };
  }

  const tanVerticalHalf = Math.tan((FLIGHT_FOV * Math.PI) / 360);
  const horizontalHalfFov = Math.atan(aspect * tanVerticalHalf);
  const screenHorizontal = projection.x * Math.tan(horizontalHalfFov);
  const screenVertical = projection.y * tanVerticalHalf;
  const bankCos = Math.cos(player.bank * FLIGHT_CAMERA_BANK_FACTOR);
  const bankSin = Math.sin(player.bank * FLIGHT_CAMERA_BANK_FACTOR);
  const viewYaw = Math.atan(screenHorizontal * bankCos + screenVertical * bankSin);
  const viewPitch = Math.atan(-screenHorizontal * bankSin + screenVertical * bankCos);
  const requestedTurn = clamp(viewYaw / 0.18, -1, 1) * assistFade;
  // Stick input opposes a screen-space correction only when it asks for a
  // different direction. In that case the pilot's requested turn wins intact.
  const turnOpposes = manualTurn * requestedTurn < 0;
  const turn = turnOpposes ? manualTurn : clamp(manualTurn + requestedTurn, -1, 1);

  const manualAbsolutePitch = manualClimb * PLAYER_MAX_PITCH;
  const assistedAbsolutePitch = player.pitch + viewPitch;
  const pitchOpposes = Math.abs(manualClimb) > 0.05 && manualClimb * viewPitch < 0;
  const absolutePitch = pitchOpposes
    ? manualAbsolutePitch
    : manualAbsolutePitch + (assistedAbsolutePitch - manualAbsolutePitch) * assistFade;

  return {
    turn,
    climb: clamp(absolutePitch / PLAYER_MAX_PITCH, -1, 1),
    responseMultiplier,
    hasVisibleTarget: true,
  };
}

/** Re-checks the live world immediately before firing; it does not use render state. */
export function shouldAutoFire(
  player: Aircraft,
  enemies: readonly CombatTarget[],
  mode: GameMode,
  aspect: number | undefined,
): boolean {
  return autoFireTarget(player, enemies, mode, aspect) !== null;
}

export function autoFireTarget(player: Aircraft, enemies: readonly CombatTarget[], mode: GameMode, aspect: number | undefined): CombatTarget | null {
  if (mode !== 'easy') return null;
  const safeAspect = normalizedAspect(aspect);
  let best: CombatTarget | null = null;
  let bestRadius = Infinity;
  for (const enemy of enemies) {
    if (enemy.health <= 0) continue;
    const projection = projectFlightTarget(player, targetAimPoint(enemy), safeAspect, mode);
    const radius = Math.hypot(projection.x * Math.max(1, safeAspect), projection.y * Math.max(1, 1 / safeAspect));
    if (projection.inCircle && projection.distance <= EASY_AUTO_FIRE_RANGE && radius < bestRadius) {
      best = enemy;
      bestRadius = radius;
    }
  }
  return best;
}

/** Straight flight prediction; maneuvers after launch can still evade the shot. */
export function predictedShotDirection(origin: Vector3, forward: Vector3, target: CombatTarget, bulletSpeed: number, lifetime: number): Vector3 {
  const velocity = target.kind === 'ship' ? target.velocity.clone() : new Vector3(0, 0, -1).applyQuaternion(target.quaternion).multiplyScalar(target.speed);
  const relative = targetAimPoint(target).sub(origin);
  const a = velocity.lengthSq() - bulletSpeed * bulletSpeed;
  const b = 2 * relative.dot(velocity);
  const c = relative.lengthSq();
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || Math.abs(a) < 1e-8) return forward.clone();
  const root = Math.sqrt(discriminant);
  const times = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter(t => t > 0 && t <= lifetime);
  if (!times.length) return forward.clone();
  const direction = relative.addScaledVector(velocity, Math.min(...times)).normalize();
  // A small firing gate plus this limit prevents wide-angle automatic hits.
  return forward.angleTo(direction) <= 0.16 ? direction : forward.clone();
}

