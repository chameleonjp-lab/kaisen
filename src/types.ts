import type { Quaternion, Vector3 } from 'three';
import type { NavalMountState } from './naval';

export type Team = 'friendly' | 'enemy';
export type GameMode = 'normal' | 'easy';
export type AIPhase = 'approach' | 'attack' | 'extend';
export interface Aircraft {
  kind: 'aircraft'; id: number; team: Team; role: 'player' | 'interceptor' | 'strike';
  position: Vector3; previous: Vector3; quaternion: Quaternion;
  yaw: number; pitch: number; bank: number; speed: number; health: number; maxHealth: number;
  /** Player magazines and reload use authoritative fixed ticks; AI retains its own cadence. */
  mg: number; cannon: number; reloadTicksRemaining: number; generation: 'initial' | 'reinforcement'; fireClock: number; cannonClock: number;
  loopProgress: number; loopCooldown: number; mode: 'pursue' | 'evade' | 'flee'; age: number;
  targetId: number | null; aiPhase: AIPhase; aiPhaseTime: number;
  aiWaypoint: Vector3; aiTurn: number; aiClimb: number; aiFire: boolean;
}
export interface Ship {
  kind: 'ship'; id: number; team: 'enemy'; variant: 'flagship' | 'escort';
  position: Vector3; previous: Vector3; quaternion: Quaternion; velocity: Vector3;
  yaw: number; health: number; maxHealth: number; length: number; width: number; height: number;
  age: number; guns: NavalMountState[];
}
export type CombatTarget = Aircraft | Ship;
export interface Bullet {
  id: number; owner: number; team: Team; position: Vector3; previous: Vector3;
  velocity: Vector3; life: number; damage: number; kind: 'mg' | 'cannon' | 'aa';
  gravity?: number; mountId?: string; barrelIndex?: number;
}
export interface GameEvent {
  /** Fixed simulation tick of the event, so deferred rendering cannot replay old muzzle flashes. */
  tick?: number;
  id: number; type: 'shot' | 'hit' | 'kill' | 'damage' | 'loop' | 'end' | 'splash' | 'reload-start' | 'reload-complete' | 'reinforcement' | 'ally-respawn' | 'heal';
  position: Vector3; owner: number; target?: number; targetKind?: 'aircraft' | 'ship'; team?: Team; amount?: number;
}
export interface FlightInput {
  turn: number; climb: number; fire: boolean; loop: boolean;
  accelerate?: boolean; brake?: boolean; viewAspect?: number; steeringRevision?: number;
}
export interface MissionConfig { shipCount: 3 | 4 | 5 | 7; mode: GameMode; }
export interface MissionStats {
  playerAircraftKills: number; playerShipKills: number; allyAircraftKills: number; allyShipKills: number;
  shots: number; hits: number; loops: number; damageTaken: number; friendlyDamage: number; friendlyKills: number; score: number;
}
export interface GameResult {
  outcome: 'victory' | 'defeat'; time: number; playerAircraftKills: number; playerShipKills: number;
  allyAircraftKills: number; allyShipKills: number; alliesSurvived: number; score: number; friendlyDamage: number; friendlyKills: number;
}
export type EndReason = 'all-clear' | 'shot-down' | 'collision' | 'sea';
export type DeathCause = 'enemy-aircraft' | 'naval-fire' | 'aircraft-collision' | 'ship-collision' | 'sea' | null;
export interface GameState {
  phase: 'ready' | 'playing' | 'paused' | 'ended'; mode: GameMode;
  reinforcementsSpawned: boolean;
  player: Aircraft; allies: Aircraft[]; enemies: Aircraft[]; ships: Ship[];
  bullets: Bullet[]; events: GameEvent[]; elapsed: number; tick: number; seed: number;
  deathCause: DeathCause; allyRespawnAt: Record<number, number>; config: Readonly<MissionConfig>; stats: MissionStats; result: GameResult | null; endReason: EndReason | null;
}
