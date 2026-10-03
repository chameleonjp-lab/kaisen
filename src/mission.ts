import { Quaternion, Vector3 } from 'three';
import { createNavalMounts } from './naval';
import type { Aircraft, GameMode, MissionConfig, Ship, Team } from './types';
import { CRUISE_SPEED, updateQuaternion } from './flight';

/** Provisional rules. Changing balance or fleet size separates local records. */
export const RULES_VERSION = 'kaisen-modes-3';
export const FIXED_DT = 1 / 60;
export const DEFAULT_MISSION_CONFIG: Readonly<MissionConfig> = Object.freeze({ shipCount: 3, mode: 'easy' });
export const MAX_BULLETS = 2048;
export const MAX_EVENTS_PER_STEP = 1024;
export const LOW_ALTITUDE_WARNING = 65;
export const AIRCRAFT_HEALTH = 100;
export const AI_DECISION_TICKS = 6;
/** Tunable gameplay load, equivalent to 12 seconds at the inherited firing rates. */
export const PLAYER_MG_CAPACITY = 288;
export const PLAYER_CANNON_CAPACITY = 96;
export const PLAYER_RELOAD_TICKS = 6 * 60;
export const REINFORCEMENT_TICK = 180 * 60;
export const REINFORCEMENT_COUNT = 3;
/** Provisional bonus: player's own reinforcement kills heal 15 HP, capped at maxHealth. */
export const REINFORCEMENT_HEAL = 15;

export function resolveMissionConfig(config: Partial<MissionConfig> | GameMode = {}): Readonly<MissionConfig> {
  const supplied = typeof config === 'string' ? { mode: config } : config;
  const shipCount = supplied.shipCount ?? DEFAULT_MISSION_CONFIG.shipCount;
  if (shipCount !== 3 && shipCount !== 5 && shipCount !== 7) throw new RangeError('Fleet size must be 3, 5, or 7');
  const mode = supplied.mode ?? DEFAULT_MISSION_CONFIG.mode;
  if (mode !== 'easy' && mode !== 'normal') throw new RangeError('Unknown flight control mode');
  return Object.freeze({ shipCount, mode });
}

export function makeAircraft(id: number, team: Team, position: Vector3, yaw = 0, role: Aircraft['role'] = 'interceptor'): Aircraft {
  const aircraft: Aircraft = {
    kind: 'aircraft', id, team, role, position, previous: position.clone(), quaternion: new Quaternion(),
    yaw, pitch: 0, bank: 0, speed: CRUISE_SPEED, health: AIRCRAFT_HEALTH, maxHealth: AIRCRAFT_HEALTH,
    mg: PLAYER_MG_CAPACITY, cannon: PLAYER_CANNON_CAPACITY, reloadTicksRemaining: 0, generation: 'initial', fireClock: 0, cannonClock: 0, loopProgress: 0, loopCooldown: 0,
    mode: 'pursue', age: 0, targetId: null, aiPhase: 'approach', aiPhaseTime: 0,
    aiWaypoint: position.clone(), aiTurn: 0, aiClimb: 0, aiFire: false,
  };
  updateQuaternion(aircraft);
  return aircraft;
}

export function makeFleet(count: 3 | 5 | 7): Ship[] {
  return Array.from({ length: count }, (_, index) => {
    const flagship = index === 0;
    const rank = Math.ceil(index / 2);
    const x = index === 0 ? 0 : (index % 2 === 1 ? -1 : 1) * (230 + (rank - 1) * 200);
    const position = new Vector3(x, 0, -1040 - rank * 130);
    const yaw = -0.28;
    const velocity = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), yaw).multiplyScalar(6);
    return {
      kind: 'ship', id: 100 + index, team: 'enemy', variant: flagship ? 'flagship' : 'escort',
      position, previous: position.clone(), yaw, quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
      velocity, health: flagship ? 1000 : 600, maxHealth: flagship ? 1000 : 600,
      length: 263, width: 38.9, height: 42,
      guns: createNavalMounts(100 + index),
      age: 0,
    };
  });
}
