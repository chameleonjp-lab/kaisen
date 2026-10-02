import { Quaternion, Vector3 } from 'three';
import type { Aircraft, GameMode, MissionConfig, Ship, Team } from './types';
import { CRUISE_SPEED, updateQuaternion } from './flight';

/** Provisional rules. Changing balance or fleet size separates local records. */
export const RULES_VERSION = 'kaisen-prototype-1';
export const FIXED_DT = 1 / 60;
export const DEFAULT_MISSION_CONFIG: Readonly<MissionConfig> = Object.freeze({ shipCount: 3, mode: 'easy' });
export const MAX_BULLETS = 512;
export const MAX_EVENTS_PER_STEP = 1024;
export const SEA_COLLISION_HEIGHT = 2.5;
export const LOW_ALTITUDE_WARNING = 65;
export const AIRCRAFT_HEALTH = 100;
export const AI_DECISION_TICKS = 6;
export const AA_RANGE = 950;
export const AA_MUZZLE_SPEED = 330;
export const AA_COOLDOWN = 2.6;

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
    mg: 1000, cannon: 120, fireClock: 0, cannonClock: 0, loopProgress: 0, loopCooldown: 0,
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
      length: flagship ? 142 : 98, width: flagship ? 23 : 17, height: flagship ? 23 : 17,
      fireClock: 1.2 + index * 0.37, targetId: null, age: 0,
    };
  });
}
