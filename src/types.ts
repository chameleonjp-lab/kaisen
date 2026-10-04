import type { Quaternion, Vector3 } from 'three';
import type { NavalMountState } from './naval';
import type { OrdnanceRound } from './ordnance';
import type { ShipWreck } from './ship-wreck';
import type { ScoreBreakdown, ScoreLedger } from './scoring';

export type Team = 'friendly' | 'enemy';
export type GameMode = 'normal' | 'easy';
export type AIPhase = 'approach' | 'attack' | 'extend';
export interface Aircraft {
  kind: 'aircraft'; id: number; team: Team; role: 'player' | 'interceptor' | 'strike';
  position: Vector3; previous: Vector3; quaternion: Quaternion;
  yaw: number; pitch: number; bank: number; speed: number; health: number; maxHealth: number;
  /** Player magazines and reload use authoritative fixed ticks; AI retains its own cadence. */
  mg: number; cannon: number; reloadTicksRemaining: number; generation: 'initial' | 'reinforcement'; fireClock: number; cannonClock: number;
  bombs: number; torpedoes: number; bombReloadTicks: number; torpedoReloadTicks: number;
  payloadCooldown: number; aiBomb: boolean;
  loopProgress: number; loopCooldown: number; mode: 'pursue' | 'evade' | 'flee'; age: number;
  targetId: number | null; aiPhase: AIPhase; aiPhaseTime: number;
  aiWaypoint: Vector3; aiTurn: number; aiClimb: number; aiFire: boolean;
}
export interface Ship {
  kind: 'ship'; id: number; team: 'enemy'; variant: 'flagship' | 'escort';
  position: Vector3; previous: Vector3; quaternion: Quaternion; previousQuaternion: Quaternion; velocity: Vector3;
  yaw: number; health: number; maxHealth: number; length: number; width: number; height: number;
  wreck: ShipWreck | null;
  age: number; superstructureHealth: number; maxSuperstructureHealth: number; guns: NavalMountState[];
}
export type CombatTarget = Aircraft | Ship;
export interface Bullet {
  id: number; owner: number; team: Team; position: Vector3; previous: Vector3;
  velocity: Vector3; life: number; damage: number; kind: 'mg' | 'cannon' | 'aa';
  /** Accumulated world-space flight path from muzzle; undefined is a fresh legacy test round. */
  distanceTravelled?: number;
  gravity?: number; mountId?: string; barrelIndex?: number;
}
export interface GameEvent {
  /** Fixed simulation tick of the event, so deferred rendering cannot replay old muzzle flashes. */
  tick?: number;
  id: number; type: 'shot' | 'hit' | 'kill' | 'damage' | 'loop' | 'end' | 'splash' | 'reload-start' | 'reload-complete' | 'reinforcement' | 'ally-respawn' | 'heal' | 'payload-release' | 'payload-rejected' | 'payload-reload' | 'ordnance-impact' | 'ordnance-dud' | 'mount-destroyed';
  position: Vector3; owner: number; target?: number; targetKind?: 'aircraft' | 'ship'; team?: Team; amount?: number;
  /** Captured when emitted, before a slot can be replaced with a new entity ID. */
  localPosition?: Vector3;
  targetTeam?: Team; ownerAllySlot?: number; targetAllySlot?: number;
  weapon?: 'mg' | 'cannon' | 'aa' | 'bomb' | 'torpedo'; detail?: string; mountId?: string; armor?: boolean;
}
export interface FlightInput {
  turn: number; climb: number; fire: boolean; loop: boolean;
  bomb?: boolean; torpedo?: boolean;
  accelerate?: boolean; brake?: boolean; viewAspect?: number; steeringRevision?: number;
}
export interface MissionConfig { shipCount: 3 | 4 | 5 | 7; mode: GameMode; }
export interface MissionStats {
  playerAircraftKills: number; playerShipKills: number; allyAircraftKills: number; allyShipKills: number;
  shots: number; hits: number; loops: number; damageTaken: number; friendlyDamage: number; friendlyKills: number; score: number;
}
export interface GameResult {
  mode: GameMode; scoreRulesVersion: string; rulesVersion: string; scoreBreakdown: Readonly<ScoreBreakdown>;
  outcome: 'victory' | 'defeat'; time: number; playerAircraftKills: number; playerShipKills: number;
  allyAircraftKills: number; allyShipKills: number; alliesSurvived: number; score: number; friendlyDamage: number; friendlyKills: number;
}
export type EndReason = 'all-clear' | 'shot-down' | 'collision' | 'sea';
export type DeathCause = 'enemy-aircraft' | 'naval-fire' | 'aircraft-collision' | 'ship-collision' | 'ship-wreck-collision' | 'sea' | null;
export interface GameState {
  scoring: ScoreLedger;
  phase: 'ready' | 'playing' | 'paused' | 'ended'; mode: GameMode;
  reinforcementsSpawned: boolean;
  player: Aircraft; allies: Aircraft[]; enemies: Aircraft[]; ships: Ship[];
  bullets: Bullet[]; ordnance: OrdnanceRound[]; events: GameEvent[]; elapsed: number; tick: number; seed: number;
  deathCause: DeathCause; allyRespawnAt: Record<number, number>; config: Readonly<MissionConfig>; stats: MissionStats; result: GameResult | null; endReason: EndReason | null;
}
