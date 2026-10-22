import { createFlightTargetLock, type FlightTargetLock } from './flight-target';
// Flight equations and loop recovery extracted from the source commit in docs/PLAN.md.
import { Euler, Quaternion, Vector3 } from 'three';
import { resolveThrottleAxis } from './throttle-lever';
import { PLAYER_MAX_PITCH } from './flight-assist';
import { EASY_CAMERA_LOOK_ANGLE, NORMAL_CAMERA_LOOK_ANGLE } from './flight-view';
import type { Aircraft, FlightInput, GameMode } from './types';

export const CRUISE_SPEED = 110;
export const MAX_SPEED = 141;
export const STALL_SPEED = 65;
export const LOOP_DURATION = 5;
export const LOOP_COOLDOWN = 2;
export const THROTTLE_ADJUST_RATE = 18;
export const ENEMY_MAX_PITCH = 0.62;
const MIN_SPEED = STALL_SPEED;
const LOOP_MIN_SPEED = STALL_SPEED;
const MAX_YAW_RATE = 0.82;
const MAX_BANK = 0.72;
const EPSILON = 1e-8;
const WORLD_FORWARD = new Vector3(0, 0, -1);

export interface FlightController {
  targetLock: FlightTargetLock;
  playerTargetSpeed: number; loopHeld: boolean; playerLoopActive: boolean;
  loopStartYaw: number; loopStartPitch: number; loopStartSteeringRevision: number | undefined;
  loopStartTurn: number; loopStartClimb: number;
  assistTurn: number; assistClimb: number; responseMultiplier: number;
}
export function createFlightController(player: Aircraft): FlightController {
  return { targetLock: createFlightTargetLock(), playerTargetSpeed: CRUISE_SPEED, loopHeld: false, playerLoopActive: false,
    loopStartYaw: player.yaw, loopStartPitch: player.pitch, loopStartSteeringRevision: undefined,
    loopStartTurn: 0, loopStartClimb: 0, assistTurn: 0, assistClimb: 0, responseMultiplier: 1 };
}
export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function normalizeAngle(angle: number): number {
  let wrapped = (angle + Math.PI) % (Math.PI * 2);
  if (wrapped < 0) wrapped += Math.PI * 2;
  return wrapped - Math.PI;
}

function quaternionFor(aircraft: Aircraft): Quaternion {
  // Positive bank means a right turn with the right wing down. In local
  // coordinates that is a negative rotation about +Z (the nose points -Z).
  return new Quaternion().setFromEuler(
    new Euler(aircraft.pitch, aircraft.yaw, -aircraft.bank, 'YXZ'),
  );
}

export function updateQuaternion(aircraft: Aircraft): void {
  aircraft.quaternion.copy(quaternionFor(aircraft));
}

export function forwardOf(aircraft: Aircraft): Vector3 {
  return WORLD_FORWARD.clone().applyQuaternion(aircraft.quaternion).normalize();
}

export function updateAircraftMotion(
  aircraft: Aircraft,
  turnInput: number,
  climbInput: number,
  dt: number,
  preferredSpeed: number,
  looping = false,
  speedCeiling = MAX_SPEED,
  maxPitch = ENEMY_MAX_PITCH,
  responseMultiplier = 1,
  manualSteering = false,
  cameraLookAngle = NORMAL_CAMERA_LOOK_ANGLE,
  holdNeutralPitch = false,
): void {
  let turn = clamp(turnInput, -1, 1);
  let climb = clamp(climbInput, -1, 1);
  if (manualSteering) {
    // Touch already has a circular range; keyboard diagonals must share it.
    const magnitude = Math.hypot(turn, climb);
    if (magnitude > 1) { turn /= magnitude; climb /= magnitude; }
  }
  const lowSpeedAuthority = aircraft.speed <= STALL_SPEED + 20
    ? 0.92 + ((aircraft.speed - STALL_SPEED) / 20) * 0.23
    : aircraft.speed <= CRUISE_SPEED
      ? 1.15 - ((aircraft.speed - (STALL_SPEED + 20)) / (CRUISE_SPEED - (STALL_SPEED + 20))) * 0.15
      : 1;
  // A lightweight load penalty gives the faster end a heavier feel without
  // claiming an exact historical turn-rate curve.
  const highSpeedLoad = clamp(1 - Math.max(0, aircraft.speed - 115) * 0.008, 0.78, 1);
  const authority = lowSpeedAuthority * highSpeedLoad;

  if (!looping) {
    const targetPitch = climb * maxPitch;
    const pitchBlend = 1 - Math.exp(-dt * 4.2);
    // The off-screen response ramp is the source's yaw-only turn aid. Keep it
    // out of pitch so it cannot reintroduce an up/down speed asymmetry.
    const angularStep = MAX_YAW_RATE * authority * dt;
    let yawStep = angularStep * responseMultiplier;
    if (manualSteering) {
      // Manual pitch and yaw are rates, in radians per second per stick unit.
      // Auto-target/AI pitch remains an absolute attitude command below.
      const pitchBefore = aircraft.pitch;
      if (Math.abs(aircraft.pitch) > maxPitch) {
        aircraft.pitch += clamp(clamp(aircraft.pitch, -maxPitch, maxPitch) - aircraft.pitch, -angularStep, angularStep);
      } else if (Math.abs(climb) > EPSILON) {
        aircraft.pitch = clamp(aircraft.pitch + climb * angularStep, -maxPitch, maxPitch);
      } else if (!holdNeutralPitch) {
        // Retain neutral levelling, with no faster vertical camera snap.
        aircraft.pitch += clamp(-aircraft.pitch * pitchBlend, -angularStep, angularStep);
      }
      if (Math.abs(turn) > EPSILON
        && Math.abs(pitchBefore) <= maxPitch && Math.abs(aircraft.pitch) <= maxPitch) {
        // Yaw moves the optical axis by cos(camera pitch) times its Euler
        // angle. Solve the spherical cosine relation at both pitch endpoints
        // so combined stick input has the exact finite forward-angle budget.
        // A zero-climb yaw is measured against the neutral-level baseline, so
        // its level-return motion must not be charged to the horizontal rate.
        const hasManualPitch = Math.abs(climb) > EPSILON;
        const pitchDelta = hasManualPitch ? aircraft.pitch - pitchBefore : 0;
        const desiredHorizontal = Math.abs(turn) * angularStep * responseMultiplier;
        const desiredTotal = Math.hypot(pitchDelta, desiredHorizontal);
        const cameraPitchBefore = (hasManualPitch ? pitchBefore : aircraft.pitch) + cameraLookAngle;
        const cameraPitchAfter = aircraft.pitch + cameraLookAngle;
        const cosProduct = Math.cos(cameraPitchBefore) * Math.cos(cameraPitchAfter);
        if (cosProduct > EPSILON) {
          const sineHalfYaw = Math.sqrt(Math.max(0,
            Math.sin(desiredTotal * 0.5) ** 2 - Math.sin(pitchDelta * 0.5) ** 2,
          ) / cosProduct);
          yawStep = 2 * Math.asin(clamp(sineHalfYaw, 0, 1)) / Math.abs(turn);
        }
      }
    } else {
      aircraft.pitch += (targetPitch - aircraft.pitch) * pitchBlend;
    }
    aircraft.yaw = normalizeAngle(aircraft.yaw - turn * yawStep);
    const targetBank = turn * MAX_BANK;
    const bankBlend = 1 - Math.exp(-dt * 5.5);
    aircraft.bank += (targetBank - aircraft.bank) * bankBlend;
  } else {
    aircraft.bank += (0 - aircraft.bank) * (1 - Math.exp(-dt * 3));
  }

  const turnDrag = Math.abs(turn) * 2.7;
  const climbDrag = Math.max(0, climb) * 2.1;
  const loopDrag = looping ? 4.8 : 0;
  const pitchEnergy = Math.sin(aircraft.pitch) * 2.6;
  const trim = (preferredSpeed - aircraft.speed) * 0.72;
  aircraft.speed = clamp(
    aircraft.speed + (trim - turnDrag - climbDrag - loopDrag - pitchEnergy) * dt,
    MIN_SPEED,
    Math.max(MIN_SPEED, speedCeiling),
  );

  updateQuaternion(aircraft);
  aircraft.position.addScaledVector(forwardOf(aircraft), aircraft.speed * dt);
}

function shortestYawInput(aircraft: Aircraft, direction: Vector3): number {
  const horizontalLength = Math.hypot(direction.x, direction.z);
  if (horizontalLength < EPSILON) return 0;
  const desiredYaw = Math.atan2(-direction.x, -direction.z);
  const error = normalizeAngle(desiredYaw - aircraft.yaw);
  return clamp(-error / 0.7, -1, 1);
}

export function desiredFlightInput(aircraft: Aircraft, target: Vector3): { turn: number; climb: number } {
  const towardTarget = target.clone().sub(aircraft.position);
  const horizontalLength = Math.hypot(towardTarget.x, towardTarget.z);
  if (towardTarget.lengthSq() < EPSILON) return { turn: 0, climb: 0 };
  const desiredPitch = Math.atan2(towardTarget.y, Math.max(horizontalLength, EPSILON));
  return {
    turn: shortestYawInput(aircraft, towardTarget),
    climb: clamp(desiredPitch / ENEMY_MAX_PITCH, -1, 1),
  };
}

export function updatePlayerLoop(
  player: Aircraft,
  meta: FlightController,
  input: FlightInput,
  userInput: FlightInput,
  loopPressed: boolean,
  dt: number,
  preferredSpeed: number,
  speedCeiling: number,
  responseMultiplier: number,
  mode: GameMode = 'normal',
): boolean {
  if (player.loopCooldown > 0) player.loopCooldown = Math.max(0, player.loopCooldown - dt);
  const cameraLookAngle = mode === 'easy' ? EASY_CAMERA_LOOK_ANGLE : NORMAL_CAMERA_LOOK_ANGLE;
  const manualSteering = !!userInput.steeringActive
    || Math.max(Math.abs(userInput.turn), Math.abs(userInput.climb)) > EPSILON
    || Math.max(Math.abs(input.turn), Math.abs(input.climb)) <= EPSILON;
  // Crossing the horizontal axis during a live Normal gesture is a zero
  // pitch-rate command. Level only after release, rather than injecting a
  // full-rate return step between arbitrarily small up/down inputs.
  const holdNeutralPitch = mode === 'normal' && (!!userInput.steeringActive
    || Math.max(Math.abs(userInput.turn), Math.abs(userInput.climb)) > EPSILON);

  const revisionChanged = meta.loopStartSteeringRevision !== undefined
    && userInput.steeringRevision !== undefined
    && userInput.steeringRevision !== meta.loopStartSteeringRevision;
  const commandChanged = Math.abs(userInput.turn - meta.loopStartTurn) > EPSILON
    || Math.abs(userInput.climb - meta.loopStartClimb) > EPSILON;
  const steeringChanged = meta.loopStartSteeringRevision !== undefined && userInput.steeringRevision !== undefined
    ? revisionChanged
    : commandChanged;
  if (player.loopProgress > 0 && steeringChanged) {
    // Preserve the current position and attitude, then let normal flight
    // response recover pitch and bank gradually without a snap.
    player.loopProgress = 0;
    player.loopCooldown = LOOP_COOLDOWN;
    meta.playerLoopActive = false;
    const recoveryPitch = clamp(userInput.climb, -1, 1) * PLAYER_MAX_PITCH;
    const recoveryBank = clamp(userInput.turn, -1, 1) * MAX_BANK;
    // Keep the continuous Euler branch already tracked by the loop state.
    // Extracting a canonical Euler from the quaternion flips yaw/bank by π
    // after the nose passes vertical, producing a camera snap on cancellation.
    player.pitch = recoveryPitch + normalizeAngle(player.pitch - recoveryPitch);
    player.yaw = normalizeAngle(player.yaw);
    player.bank = recoveryBank + normalizeAngle(player.bank - recoveryBank);
    updateAircraftMotion(
      player,
      userInput.turn,
      userInput.climb,
      dt,
      preferredSpeed,
      false,
      speedCeiling,
      PLAYER_MAX_PITCH,
      responseMultiplier,
      true,
      cameraLookAngle,
      holdNeutralPitch,
    );
    return false;
  }

  if (player.loopProgress <= 0 && loopPressed && player.loopCooldown <= EPSILON && player.speed >= LOOP_MIN_SPEED) {
    player.loopProgress = EPSILON;
    meta.playerLoopActive = true;
    meta.loopStartYaw = player.yaw;
    meta.loopStartPitch = player.pitch;
    meta.loopStartSteeringRevision = userInput.steeringRevision;
    meta.loopStartTurn = userInput.turn;
    meta.loopStartClimb = userInput.climb;
  }

  if (player.loopProgress <= 0) {
    updateAircraftMotion(
      player,
      input.turn,
      input.climb,
      dt,
      preferredSpeed,
      false,
      speedCeiling,
      PLAYER_MAX_PITCH,
      responseMultiplier,
      manualSteering,
      cameraLookAngle,
      holdNeutralPitch,
    );
    return false;
  }

  if (!meta.playerLoopActive) {
    meta.playerLoopActive = true;
    meta.loopStartYaw = player.yaw;
    meta.loopStartPitch = player.pitch;
  }

  const progress = clamp(player.loopProgress + dt / LOOP_DURATION, 0, 1);
  player.loopProgress = progress;
  player.yaw = meta.loopStartYaw;
  player.pitch = meta.loopStartPitch + progress * Math.PI * 2;
  const completed = progress >= 1 - EPSILON;
  if (completed) {
    player.yaw = meta.loopStartYaw;
    player.pitch = meta.loopStartPitch;
    player.loopProgress = 0;
    player.loopCooldown = LOOP_COOLDOWN;
    meta.playerLoopActive = false;
  }
  updateAircraftMotion(player, 0, 0, dt, preferredSpeed, true, speedCeiling, PLAYER_MAX_PITCH, responseMultiplier);
  return completed;
}


/** Easy mode keeps the source's fixed cruise throttle; normal retains W/S trim. */
export function advanceThrottle(meta: FlightController, input: FlightInput, mode: GameMode, dt: number): number {
  const direction = mode === 'easy' ? 0 : resolveThrottleAxis(input);
  meta.playerTargetSpeed = clamp(meta.playerTargetSpeed + direction * THROTTLE_ADJUST_RATE * dt, STALL_SPEED, MAX_SPEED);
  return meta.playerTargetSpeed;
}
