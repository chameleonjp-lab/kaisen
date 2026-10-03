import {createGame,startGame,stepGame} from '../../src/simulation';
import {desiredFlightInput,forwardOf} from '../../src/flight';
import {targetAimPoint} from '../../src/flight-assist';
import type {GameState} from '../../src/types';

const neutral={turn:0,climb:0,fire:false,loop:false};
const clamp=(n:number,a=-1,b=1)=>Math.max(a,Math.min(b,n));

// Ship approach uses the observed hull's fore/aft axis and genuine flight controls.
export function flyLargeFleetMission(shipCount: 5 | 7, observe?: (state: GameState) => void) {
 const weave = .3, altitude = 650, stageDistance = 1100, airLead = .6;
 const state=createGame(undefined,{shipCount});startGame(state);
 let targetId:number|null=null,extensionTicks=0,waypoint=state.player.position.clone();
 let shipPhase:'stage'|'attack'|'escape'='stage';let escapeUntil=0;
 const changes:any[]=[]; const reloads:any[]=[]; let minAltitude=state.player.position.y;
 for(let i=0;i<60*240 && state.phase==='playing';i++){
  const targets=[...state.enemies,...state.ships].filter(t=>t.health>0);
  const nearest=targets.slice().sort((a,b)=>state.player.position.distanceTo(a.position)-state.player.position.distanceTo(b.position))[0];
  const pick=nearest?.kind==='aircraft'?nearest:targets.filter(t=>t.kind==='ship').sort((a,b)=>a.position.x-b.position.x)[0];
  const target=targets.find(t=>t.id===targetId)??pick;if(!target)break;
  if(targetId!==target.id){shipPhase='stage';changes.push({t:state.elapsed,target:target.id,hp:state.player.health,p:state.player.position.toArray().map(Math.round)});}targetId=target.id;
  let aim=target.position.clone();const distance=state.player.position.distanceTo(aim);let evasive=false;
  if(target.kind==='aircraft'){
   if(airLead)aim.addScaledVector(forwardOf(target),target.speed*airLead);
   if(extensionTicks<=0&&(state.player.position.y<90||distance<(airLead?180:70))){extensionTicks=360;waypoint=state.player.position.clone().addScaledVector(forwardOf(state.player),740);waypoint.y=Math.max(250,state.player.position.y+(airLead?250:100));}
   if(extensionTicks>0){extensionTicks--;aim=waypoint;}
  }else{
   const stern=target.velocity.clone().normalize().negate();
   const stage=target.position.clone().addScaledVector(stern,stageDistance);stage.y=altitude;
   if(state.tick<escapeUntil){aim=waypoint;evasive=true;}
   else{
    if(shipPhase==='escape')shipPhase='stage';
    if(shipPhase==='stage'&&state.player.position.distanceTo(stage)<180)shipPhase='attack';
    if(shipPhase==='attack'&&(distance<240||state.player.position.y<100)){
      shipPhase='escape';escapeUntil=state.tick+360;waypoint=state.player.position.clone().addScaledVector(forwardOf(state.player),800);waypoint.y=Math.max(350,state.player.position.y+220);aim=waypoint;evasive=true;
    }else if(shipPhase==='stage'){aim=stage;evasive=true;}else aim=targetAimPoint(target);
   }
  }
  const controls=desiredFlightInput(state.player,aim);
  const w=evasive?weave:0;
  stepGame(state,{...neutral,turn:clamp(controls.turn+w*Math.sin(state.elapsed*2*Math.PI/2)),climb:clamp(controls.climb*.62/.95+w*.6*Math.cos(state.elapsed*2*Math.PI/2))});
  observe?.(state);
  for (const event of state.events) if (event.type === 'reload-start' || event.type === 'reload-complete') reloads.push({ type:event.type, tick:state.tick, t:state.elapsed, hp:state.player.health, mg:state.player.mg, cannon:state.player.cannon, remaining:state.player.reloadTicksRemaining });
  minAltitude=Math.min(minAltitude,state.player.position.y);
 }
 return { state, diagnostics: { shipCount,reason:state.endReason,t:state.elapsed,hp:state.player.health,kills:state.stats,ships:state.ships.map(s=>s.health),allies:state.allies.map(a=>a.health),minAltitude,reloads,changes } }; 
}
