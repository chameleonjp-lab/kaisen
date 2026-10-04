import { Quaternion, Vector3 } from 'three';
import { CAPITAL_SHIP, createNavalMounts } from './naval';
import type { Aircraft, GameMode, MissionConfig, Ship, Team } from './types';
import { CRUISE_SPEED, updateQuaternion } from './flight';
import { AIRCRAFT_HEALTH, AIRCRAFT_BASE_DAMAGE } from './aircraft-damage';
export { AIRCRAFT_HEALTH } from './aircraft-damage';

/** Provisional rules. Changing balance or fleet size separates local records. */
export const RULES_VERSION = 'kaisen-air-sea-11';
export const FIXED_DT = 1 / 60;
export const AIRCRAFT_BULLET_LIFETIME = 1.5;
export const DEFAULT_MISSION_CONFIG: Readonly<MissionConfig> = Object.freeze({ shipCount: 4, mode: 'easy' });
export const MAX_BULLETS = 2048;
export const MAX_EVENTS_PER_STEP = 1024;
export const LOW_ALTITUDE_WARNING = 65;
/** Normal sea-attack staging altitude; its original camera and entry remain unchanged. */
export const INITIAL_FLIGHT_ALTITUDE = 220;
/** Easy starts 80m higher to leave more room to plan a sea approach. */
export const EASY_INITIAL_FLIGHT_ALTITUDE = 300;
export const AI_DECISION_TICKS = 6;
/** Tunable gameplay load, equivalent to 12 seconds at the inherited firing rates. */
export const PLAYER_MG_CAPACITY = 288;
export const PLAYER_CANNON_CAPACITY = 96;
export const PLAYER_RELOAD_TICKS = 6 * 60;
export const PLAYER_BOMB_CAPACITY = 2;
export const PLAYER_TORPEDO_CAPACITY = 1;
export const PAYLOAD_RELOAD_TICKS = 6 * 60;
export const MAX_ORDNANCE = 24;
export const REINFORCEMENT_TICK = 40 * 60;
export const REINFORCEMENT_COUNT = 5;
/** Provisional bonus: player's own reinforcement kills heal 15 HP, capped at maxHealth. */
export const REINFORCEMENT_HEAL = 15;
export const ALLY_RESPAWN_TICKS = 40 * 60;
/** Proposed penalty per actual friendly HP; destruction adds the requested fixed 1500. */
export const FRIENDLY_DAMAGE_PENALTY = 10;
export const FRIENDLY_KILL_PENALTY = 1500;
/** Enemy airborne rounds are weaker than the 0.8 HP light naval round. */
export const ENEMY_MG_DAMAGE = AIRCRAFT_BASE_DAMAGE.enemy.mg;
export const ENEMY_CANNON_DAMAGE = AIRCRAFT_BASE_DAMAGE.enemy.cannon;

export function resolveMissionConfig(config: Partial<MissionConfig> | GameMode = {}): Readonly<MissionConfig> {
  const supplied = typeof config === 'string' ? { mode: config } : config;
  const shipCount = supplied.shipCount ?? DEFAULT_MISSION_CONFIG.shipCount;
  if (shipCount !== 3 && shipCount !== 4 && shipCount !== 5 && shipCount !== 7) throw new RangeError('Fleet size must be 3, 4, 5, or 7');
  const mode = supplied.mode ?? DEFAULT_MISSION_CONFIG.mode;
  if (mode !== 'easy' && mode !== 'normal') throw new RangeError('Unknown flight control mode');
  return Object.freeze({ shipCount, mode });
}

export function makeAircraft(id: number, team: Team, position: Vector3, yaw = 0, role: Aircraft['role'] = 'interceptor'): Aircraft {
  const aircraft: Aircraft = {
    kind: 'aircraft', id, team, role, position, previous: position.clone(), quaternion: new Quaternion(),
    yaw, pitch: 0, bank: 0, speed: CRUISE_SPEED, health: AIRCRAFT_HEALTH, maxHealth: AIRCRAFT_HEALTH,
    mg: PLAYER_MG_CAPACITY, cannon: PLAYER_CANNON_CAPACITY, reloadTicksRemaining: 0, generation: 'initial', fireClock: 0, cannonClock: 0, bombs: PLAYER_BOMB_CAPACITY, torpedoes: PLAYER_TORPEDO_CAPACITY, bombReloadTicks: 0, torpedoReloadTicks: 0, payloadCooldown: 0, aiBomb: false, loopProgress: 0, loopCooldown: 0,
    mode: 'pursue', age: 0, targetId: null, aiPhase: 'approach', aiPhaseTime: 0,
    aiWaypoint: position.clone(), aiTurn: 0, aiClimb: 0, aiFire: false,
  };
  updateQuaternion(aircraft);
  return aircraft;
}

export function makeFleet(count: 3 | 4 | 5 | 7): Ship[] {
  return Array.from({ length: count }, (_, index) => {
    const flagship = index === 0;
    const rank = Math.ceil(index / 2);
    const x = index === 0 ? 0 : (index % 2 === 1 ? -1 : 1) * (230 + (rank - 1) * 200);
    // A foreground broadside capital ship establishes scale before the deeper fleet.
    // All hulls use the Iowa dimensions shared with geometry; no aircraft/camera scaling.
    const foregroundFleet = [[0, -220], [-360, -650], [360, -700], [0, -1050]];
    const position = count === 4
      ? new Vector3(foregroundFleet[index][0], 0, foregroundFleet[index][1])
      : new Vector3(x, 0, -1040 - rank * 130);
    const yaw = count === 4 ? 1.15 : -0.28;
    const velocity = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), yaw).multiplyScalar(6);
    return {
      kind: 'ship', id: 100 + index, team: 'enemy', variant: flagship ? 'flagship' : 'escort',
      position, previous: position.clone(), yaw, quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), previousQuaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw),
      velocity, health: flagship ? 4000 : 2400, maxHealth: flagship ? 4000 : 2400,
      length: CAPITAL_SHIP.length, width: CAPITAL_SHIP.width, height: CAPITAL_SHIP.height,
      guns: createNavalMounts(100 + index),
      wreck: null, age: 0, superstructureHealth: 240, maxSuperstructureHealth: 240,
    };
  });
}
