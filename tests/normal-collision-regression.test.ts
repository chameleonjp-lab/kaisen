import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createGame,startGame,stepGame} from '../src/simulation';
import {createBrowserMissionPilot} from './helpers/mission-browser-pilot';
import type {Aircraft,FlightInput,GameState} from '../src/types';
import {updateQuaternion} from '../src/flight';

type VectorSnapshot={x:number;y:number;z:number};
type AircraftSnapshot=Omit<Aircraft,'position'|'previous'|'quaternion'|'aiWaypoint'> & {
  position:VectorSnapshot;previous:VectorSnapshot;quaternion:[number,number,number,number];aiWaypoint:VectorSnapshot;
};
type CollisionTrace={
  sourceHead:string;sourceRun:string;dropped:number;seed:number;config:{shipCount:3|4|5|7;mode:'normal'|'easy'};
  columns:string[];entries:(number|boolean)[][];observationTicks:number[];decisionTick:number;steeringTick:number;dodgeExpiryTick:number;
  expectedOriginal:{tick:number;cause:string;score:number};
};
type DecisionPose={
  sourceHead:string;sourceRun:string;sourceFixtureSha256:string;decisionTick:number;steeringTick:number;dodgeExpiryTick:number;
  elapsed:number;player:AircraftSnapshot;threat:AircraftSnapshot;
};

const traceBytes=readFileSync(new URL('./fixtures/normal-collision-ci38.json',import.meta.url));
const trace=JSON.parse(traceBytes.toString('utf8')) as CollisionTrace;
const pose=JSON.parse(readFileSync(new URL('./fixtures/normal-collision-ci38-decision.json',import.meta.url),'utf8')) as DecisionPose;
const neutral:FlightInput={turn:0,climb:0,fire:false,loop:false};

function assertFiniteState(state:GameState){
  assert.ok(Number.isFinite(state.elapsed)&&Number.isFinite(state.tick));
  assert.ok(Number.isFinite(state.stats.score));
  for(const aircraft of [state.player,...state.allies,...state.enemies]){
    assert.ok([aircraft.position.x,aircraft.position.y,aircraft.position.z,aircraft.yaw,aircraft.pitch,
      aircraft.bank,aircraft.speed,aircraft.health].every(Number.isFinite),`finite aircraft state ${aircraft.id}`);
  }
  for(const ship of state.ships){
    assert.ok([ship.position.x,ship.position.y,ship.position.z,ship.yaw,ship.health].every(Number.isFinite),`finite ship state ${ship.id}`);
  }
  if(state.result){assert.ok(Number.isFinite(state.result.time)&&Number.isFinite(state.result.score));}
}

function replayFullTrace(){
  const state=createGame(trace.seed,trace.config),pilot=createBrowserMissionPilot();startGame(state);
  const observations=new Set(trace.observationTicks);
  let index=0,observedSamples=0,held:FlightInput={...neutral};
  while(state.phase==='playing'&&state.tick<trace.dodgeExpiryTick){
    if(observations.has(state.tick)){
      const before=JSON.stringify(state),snapshot=JSON.parse(before);
      pilot(snapshot);
      assert.equal(JSON.stringify(snapshot),before,'observed historical snapshots stay read-only');
      assert.equal(JSON.stringify(state),before,'the observer does not alter the live replay');
      observedSamples++;
    }
    while(index<trace.entries.length&&trace.entries[index][0]<=state.tick+1){
      const row=trace.entries[index++];
      held=Object.fromEntries(trace.columns.slice(1).map((key:string,i:number)=>[key,row[i+1]])) as unknown as FlightInput;
    }
    stepGame(state,held);
    assertFiniteState(state);
  }
  if(state.phase==='ended'){
    assert.ok(state.result,'an ended replay has its final result');
    assert.equal(state.result.outcome,state.endReason==='all-clear'?'victory':'defeat');
    assert.equal(state.result.time,state.elapsed);
  }else{
    assert.equal(state.result,null,'an unfinished replay has no provisional result');
  }
  return {tick:state.tick,phase:state.phase,deathCause:state.deathCause,endReason:state.endReason,
    result:state.result&&{outcome:state.result.outcome,score:state.result.score,time:state.result.time},
    rowsConsumed:index,observedSamples,player:{position:state.player.position.toArray(),health:state.player.health}};
}

function restoreAircraft(target:Aircraft,source:AircraftSnapshot){
  target.position.set(source.position.x,source.position.y,source.position.z);
  target.previous.set(source.previous.x,source.previous.y,source.previous.z);
  target.aiWaypoint.set(source.aiWaypoint.x,source.aiWaypoint.y,source.aiWaypoint.z);
  target.quaternion.fromArray(source.quaternion);
  for(const [key,value] of Object.entries(source)){
    if(key==='position'||key==='previous'||key==='aiWaypoint'||key==='quaternion')continue;
    (target as unknown as Record<string,unknown>)[key]=value;
  }
}

function createDecisionState(){
  const state=createGame(trace.seed,trace.config);startGame(state);
  restoreAircraft(state.player,pose.player);
  for(const enemy of state.enemies)enemy.health=0;
  restoreAircraft(state.enemies[0],pose.threat);
  for(const ally of state.allies)ally.health=0;
  for(const ship of state.ships)ship.health=0;
  state.tick=pose.decisionTick;state.elapsed=pose.elapsed;
  return state;
}

function replayDecisionTail(lateral:boolean){
  const state=createDecisionState(),pilot=createBrowserMissionPilot();
  const before=JSON.stringify(state),snapshot=JSON.parse(before),snapshotBefore=JSON.stringify(snapshot),command=pilot(snapshot);
  assert.equal(JSON.stringify(snapshot),snapshotBefore,'the captured decision snapshot stays read-only');
  assert.equal(JSON.stringify(state),before,'the decision pilot only observes the captured collision state');
  let index=0,held:FlightInput={...neutral},minSeparation=Infinity,minAltitude=Infinity;
  const lateralCommands:FlightInput[]=[];
  while(index<trace.entries.length&&trace.entries[index][0]<=state.tick+1){
    const row=trace.entries[index++];
    held=Object.fromEntries(trace.columns.slice(1).map((key:string,i:number)=>[key,row[i+1]])) as unknown as FlightInput;
  }
  while(state.phase==='playing'&&state.tick<pose.dodgeExpiryTick){
    while(index<trace.entries.length&&trace.entries[index][0]<=state.tick+1){
      const row=trace.entries[index++];
      held=Object.fromEntries(trace.columns.slice(1).map((key:string,i:number)=>[key,row[i+1]])) as unknown as FlightInput;
    }
    const steeringReplaced=lateral&&state.tick+1>=pose.steeringTick&&state.tick+1<pose.dodgeExpiryTick;
    // The held Normal stick now preserves pitch. Re-observe and explicitly
    // level through ordinary rate commands instead of relying on the removed
    // automatic settling during a two-second frozen horizontal command.
    const currentCommand=steeringReplaced?observePilotReadOnly(state,pilot):null;
    if(currentCommand)lateralCommands.push(currentCommand);
    stepGame(state,currentCommand?{...held,turn:currentCommand.turn,climb:currentCommand.climb}:held);
    if(state.tick>=pose.steeringTick){
      minAltitude=Math.min(minAltitude,state.player.position.y);
      for(const enemy of state.enemies)if(enemy.health>0)minSeparation=Math.min(minSeparation,state.player.position.distanceTo(enemy.position));
    }
    assertFiniteState(state);
  }
  return {state,command,minSeparation,minAltitude,lateralCommands};
}

test('lateral fallback keeps the low-altitude ascent, safe descent and Easy pilot branches',()=>{
  for(const [mode,height,climb,turnMagnitude]of [['normal',230,1,0],['normal',230.01,0,1],['normal',401,-1,0],['easy',260,1,0],['easy',401,-1,0]] as const){
    const state=createGame(73,mode);for(const ship of state.ships)ship.health=0;for(const enemy of state.enemies.slice(1))enemy.health=0;
    state.player.position.set(0,height,0);state.player.pitch=state.player.yaw=state.player.bank=0;updateQuaternion(state.player);
    const enemy=state.enemies[0];enemy.position.set(0,height+30,-100);enemy.yaw=Math.PI;enemy.pitch=-.1;updateQuaternion(enemy);
    const input=createBrowserMissionPilot()(state);
    assert.equal(input.climb,climb);assert.equal(Math.abs(input.turn),turnMagnitude);
    assert.ok(Math.hypot(input.turn,input.climb)<=1);assert.equal(input.fire,false);
  }
});

test('CI38 full consumed-input replay is deterministic under the new rate contract; legacy outcome stays separate',()=>{
  const traceSha256=createHash('sha256').update(traceBytes).digest('hex');
  assert.equal(traceSha256,pose.sourceFixtureSha256,'the original seed, raw inputs, observations and outcome record remain unchanged');
  assert.equal(pose.sourceHead,trace.sourceHead);assert.equal(pose.sourceRun,trace.sourceRun);
  assert.equal(pose.decisionTick,trace.decisionTick);assert.equal(pose.steeringTick,trace.steeringTick);
  assert.equal(pose.dodgeExpiryTick,trace.dodgeExpiryTick);
  assert.equal(trace.dropped,0);assert.equal(trace.entries.length,763);
  assert.deepEqual(trace.expectedOriginal,{tick:7895,cause:'aircraft-collision',score:7050},'these remain the recorded legacy-rule outcome only');
  const first=replayFullTrace(),second=replayFullTrace();
  assert.deepEqual(first,second,'all recorded inputs replay deterministically under the current manual-rate contract');
  assert.equal(first.rowsConsumed,trace.entries.length,'the current replay consumes every recorded input row');
  assert.ok(first.observedSamples>0,'the recorded observation schedule is also exercised');
});

test('CI38 decision pose detects the collision on original steering and clears with the current legal lateral pilot command',()=>{
  const original=replayDecisionTail(false);
  assert.equal(original.state.phase,'ended');
  assert.equal(original.state.deathCause,'aircraft-collision');
  assert.equal(original.state.result?.outcome,'defeat');
  assert.equal(original.state.result?.scoreBreakdown.clear,0);
  assert.ok(original.minSeparation<40,'the unchanged steering enters the historical collision envelope');

  const lateral=replayDecisionTail(true);
  assert.ok(lateral.command.climb<0,'the pilot explicitly levels the captured nose-up attitude');
  assert.ok(lateral.lateralCommands.some(input=>Math.abs(input.turn)>.9),'the leveled maneuver uses its lateral authority');
  for(const input of lateral.lateralCommands)assert.ok(Math.hypot(input.turn,input.climb)<=1+1e-12,'every live command stays inside the circular stick');
  assert.equal(lateral.command.fire,false);assert.equal(lateral.command.accelerate,true);
  assert.equal(lateral.state.tick,pose.dodgeExpiryTick);
  assert.equal(lateral.state.phase,'playing');assert.equal(lateral.state.result,null);
  assert.ok(lateral.state.player.health>50,'the maneuver keeps the existing HP outcome intact');
  assert.ok(lateral.minAltitude>270,'the low-altitude safety margin remains intact');
  assert.ok(lateral.minSeparation>60,'the legal lateral input clears the collision envelope');
});

function observePilotReadOnly(state:GameState,pilot:(snapshot:GameState)=>FlightInput){
  const liveBefore=JSON.stringify(state),snapshot=JSON.parse(liveBefore),snapshotBefore=JSON.stringify(snapshot);
  const command=pilot(snapshot);
  assert.equal(JSON.stringify(snapshot),snapshotBefore,'the pilot leaves its observed snapshot unchanged');
  assert.equal(JSON.stringify(state),liveBefore,'the pilot leaves the live game state unchanged');
  return command;
}

function observeNewThreatDuringDodge(reverseThreatOrder:boolean){
  const state=createGame(73,'normal');startGame(state);
  const player=state.player;
  player.position.set(0,300,0);player.previous.copy(player.position);
  player.yaw=player.pitch=player.bank=0;player.speed=110;updateQuaternion(player);
  for(const enemy of state.enemies)enemy.health=0;
  for(const ally of state.allies)ally.health=0;
  for(const ship of state.ships)ship.health=0;

  const [first,second]=state.enemies;
  const a=reverseThreatOrder?second:first,b=reverseThreatOrder?first:second;
  // A is 220m ahead and 30m below on a 1s head-on collision course.
  a.health=a.maxHealth;a.position.set(0,270,-220);a.previous.copy(a.position);
  a.yaw=Math.PI;a.pitch=a.bank=0;a.speed=110;updateQuaternion(a);
  // B is staged inactive 100m ahead and 30m above. It becomes a live 0.45s
  // threat after one actual fixed step, while A's original dodge is active.
  b.health=0;b.position.set(10,330,-100);b.previous.copy(b.position);
  b.yaw=Math.PI;b.pitch=b.bank=0;b.speed=110;updateQuaternion(b);

  const pilot=createBrowserMissionPilot();
  const firstCommand=observePilotReadOnly(state,pilot);
  assert.equal(firstCommand.climb,1,'the below-player threat starts a climb dodge');
  assert.equal(firstCommand.turn,0);
  stepGame(state,{...firstCommand,steeringActive:true});
  assert.equal(state.tick,1,'the second observation follows one real simulation tick');
  assert.equal(state.phase,'playing');
  b.health=b.maxHealth;
  const secondCommand=observePilotReadOnly(state,pilot);
  assert.ok(secondCommand.climb<0,'the newly active above-player threat replaces the climb with explicit leveling');
  assert.ok(Math.abs(secondCommand.turn)>0,'the new threat selects a lateral dodge');
  assert.ok(Math.abs(Math.hypot(secondCommand.turn,secondCommand.climb)-1)<1e-12,'leveling and lateral dodge share the full legal stick budget');
  assert.equal(secondCommand.fire,false);
  return {firstCommand,secondCommand};
}

test('active dodge rechecks a newly imminent threat independent of enemy array order',()=>{
  const normalOrder=observeNewThreatDuringDodge(false);
  const reverseOrder=observeNewThreatDuringDodge(true);
  assert.deepEqual(normalOrder.firstCommand,reverseOrder.firstCommand);
  assert.deepEqual(normalOrder.secondCommand,reverseOrder.secondCommand);
});
