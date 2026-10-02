// Flight equations and loop recovery extracted from the source commit in docs/PLAN.md.
import { Euler, Quaternion, Vector3 } from 'three';
import { PLAYER_MAX_PITCH } from './flight-assist';
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
  playerTargetSpeed: number; loopHeld: boolean; playerLoopActive: boolean;
  loopStartYaw: number; loopStartPitch: number; loopStartSteeringRevision: number | undefined;
  loopStartTurn: number; loopStartClimb: number;
  assistTurn: number; assistClimb: number; responseMultiplier: number;
}
export function createFlightController(player: Aircraft): FlightController {
  return { playerTargetSpeed: CRUISE_SPEED, loopHeld: false, playerLoopActive: false,
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
): void {
  const turn = clamp(turnInput, -1, 1);
  const climb = clamp(climbInput, -1, 1);
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
    aircraft.pitch += (targetPitch - aircraft.pitch) * pitchBlend;
    aircraft.yaw = normalizeAngle(aircraft.yaw - turn * MAX_YAW_RATE * authority * responseMultiplier * dt);
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
): boolean {
  if (player.loopCooldown > 0) player.loopCooldown = Math.max(0, player.loopCooldown - dt);

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
    const attitude = new Euler().setFromQuaternion(player.quaternion, 'YXZ');
    const recoveryBank = clamp(userInput.turn, -1, 1) * MAX_BANK;
    player.pitch = recoveryPitch + normalizeAngle(attitude.x - recoveryPitch);
    player.yaw = attitude.y;
    player.bank = recoveryBank + normalizeAngle(-attitude.z - recoveryBank);
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
  const direction = mode === 'easy' ? 0 : Number(Boolean(input.accelerate)) - Number(Boolean(input.brake));
  meta.playerTargetSpeed = clamp(meta.playerTargetSpeed + direction * THROTTLE_ADJUST_RATE * dt, STALL_SPEED, MAX_SPEED);
  return meta.playerTargetSpeed;
}
