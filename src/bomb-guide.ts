import { CAPITAL_SHIP, NAVAL_COLLISION_BOUNDS } from './naval';
import { OCEAN_MAX_HEIGHT } from './ocean';
import { releaseBomb, predictBombImpact, stepOrdnance, type OrdnanceOutcome } from './ordnance';
import { advanceShipMotion } from './ship-motion';
import { isShipObstacle } from './ship-wreck';
import { FIXED_DT, MAX_ORDNANCE } from './mission';
import type { GameState, Ship } from './types';
import type { Vector3 } from 'three';

export interface BombGuide {
  position: Vector3; time: number;
  kind: 'direct' | 'blast' | 'water' | 'dud' | 'wreck';
  affected: { shipId: number; damage: number }[];
}
function copyShip(ship: Ship): Ship {
  return { ...ship, position: ship.position.clone(), previous: ship.position.clone(), quaternion: ship.quaternion.clone(),
    previousQuaternion: ship.quaternion.clone(), velocity: ship.velocity.clone(), guns: ship.guns.map(gun => ({...gun})),
    wreck: ship.wreck ? { ...ship.wreck, position: ship.wreck.position.clone(), rotation: ship.wreck.rotation.clone(), velocity: ship.wreck.velocity.clone() } : null };
}

/** Read-only forecast: actual gravity/fuse/first-contact/waves and shared future ship poses.
 * Aircraft may manoeuvre before release, and future combat can destroy/turn a gun house.
 * Those future decisions are deliberately not claimed as a guaranteed hit.
 */
export function predictBombEffect(state: Pick<GameState,'player'|'ships'|'elapsed'>): BombGuide | null {
  const round = releaseBomb(-1, state.player);
  if (!round || !Number.isFinite(state.elapsed)) return null;
  // A conservative all-orientation height bound avoids simulating an expired
  // high-altitude drop that cannot reach any surface within the 30-second life.
  const ceiling = Math.max(OCEAN_MAX_HEIGHT, ...state.ships.filter(ship=>isShipObstacle(ship,state.elapsed)).map(ship => {
    const scale=[ship.width/CAPITAL_SHIP.width,ship.height/CAPITAL_SHIP.height,ship.length/CAPITAL_SHIP.length];
    return ship.position.y+Math.hypot(...scale.map((v,i)=>v*Math.max(Math.abs(NAVAL_COLLISION_BOUNDS.min[i]),Math.abs(NAVAL_COLLISION_BOUNDS.max[i]))));
  }));
  if (round.position.y > ceiling && !predictBombImpact(state.player,ceiling)) return null;
  const ships = state.ships.map(copyShip);
  for (let tick = 0; round.life > 0 && tick < 1800; tick++) {
    const time = state.elapsed + tick * FIXED_DT;
    for (const ship of ships) advanceShipMotion(ship, time + FIXED_DT, FIXED_DT);
    const obstacles = ships.filter(ship => isShipObstacle(ship, time + FIXED_DT));
    const result = stepOrdnance(round, obstacles.map(ship => ({...ship,collisionActive:true})), time, FIXED_DT);
    if (result.active) continue;
    if (!result.outcomes.length) return null;
    const impacts = result.outcomes.filter((outcome): outcome is Extract<OrdnanceOutcome,{type:'impact'}> => outcome.type === 'impact');
    const affected = impacts.filter(outcome => ships.some(ship => ship.id === outcome.shipId && ship.health > 0 && ship.team !== round.team))
      .map(outcome => ({shipId:outcome.shipId,damage:outcome.damage}));
    const kind = affected.length ? (impacts.some(outcome => outcome.blast) ? 'blast' : 'direct') :
      impacts.length ? 'wreck' : result.outcomes.some(outcome => outcome.type === 'dud') || round.age < .25 ? 'dud' : 'water';
    return { position: round.position.clone(), time: round.age, kind, affected };
  }
  return null;
}

const cache = new WeakMap<GameState,{tick:number;guide:BombGuide|null;lastMs:number;peakMs:number;calculations:number}>();
/** HUD/canvas share one forecast of the current simulation tick, never a 100ms-old green cue. */
export function currentBombGuide(state: GameState): BombGuide | null {
  if ((state.phase !== 'playing' && state.phase !== 'paused') || state.player.bombs <= 0 || state.player.bombReloadTicks > 0) return null;
  const previous = cache.get(state);
  if (previous?.tick === state.tick) return previous.guide;
  const started = performance.now(), guide = predictBombEffect(state), lastMs = performance.now() - started;
  cache.set(state,{tick:state.tick,guide,lastMs,peakMs:Math.max(previous?.peakMs??0,lastMs),calculations:(previous?.calculations??0)+1}); return guide;
}

export function bombReleaseCue(state: GameState, guide: BombGuide | null) {
  const player = state.player;
  const reason = state.phase !== 'playing' ? '停止中' : player.health <= 0 ? '投下不可' :
    player.bombReloadTicks > 0 ? '装填中' : player.bombs <= 0 ? '残弾なし' : player.payloadCooldown > 0 ? '投下待ち' :
    state.ordnance.length >= MAX_ORDNANCE ? '投下待ち' : !guide ? '予測範囲外' : guide.kind === 'dud' ? '不発見込み' :
    guide.kind === 'wreck' ? '残骸に接触' : guide.kind === 'direct' ? '命中見込み' : guide.kind === 'blast' ? '至近弾圏内' : '有効圏外';
  const ready = reason === '命中見込み' || reason === '至近弾圏内';
  return {ready,text:reason};
}

/** Presentation-only measurement, outside the authoritative combat update timer. */
export function bombForecastTiming(state: GameState) {
  const entry=cache.get(state);return {lastMs:entry?.lastMs??0,peakMs:entry?.peakMs??0,calculations:entry?.calculations??0};
}
