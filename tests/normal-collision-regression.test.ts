import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGame,startGame,stepGame} from '../src/simulation';
import {createBrowserMissionPilot} from './helpers/mission-browser-pilot';
import type {FlightInput} from '../src/types';
import {updateQuaternion} from '../src/flight';

const trace=JSON.parse(readFileSync(new URL('./fixtures/normal-collision-ci38.json',import.meta.url),'utf8'));
const neutral:FlightInput={turn:0,climb:0,fire:false,loop:false};

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

for(const lateral of [false,true])test(`CI38 consumed inputs preserve the real collision${lateral?' except the verified lateral dodge':''}`,()=>{
  assert.equal(trace.dropped,0);assert.equal(trace.entries.length,763);
  const state=createGame(trace.seed,trace.config),pilot=createBrowserMissionPilot();startGame(state);
  const observations=new Set(trace.observationTicks);
  let index=0,held:FlightInput={...neutral},dodge:FlightInput|null=null,minSeparation=Infinity,minAltitude=Infinity;
  while(state.phase==='playing'&&state.tick<trace.dodgeExpiryTick){
    if(lateral&&observations.has(state.tick)){
      const before=JSON.stringify(state),command=pilot(JSON.parse(before));
      assert.equal(JSON.stringify(state),before,'test pilot can only produce ordinary input');
      if(state.tick===trace.decisionTick){
        dodge=command;assert.equal(command.turn,1);assert.equal(command.climb,0);
        assert.equal(command.fire,false);assert.equal(command.accelerate,true);
        assert.ok(state.player.position.y>273&&state.player.position.y<274);
      }
    }
    while(index<trace.entries.length&&trace.entries[index][0]<=state.tick+1){
      const row=trace.entries[index++];held=Object.fromEntries(trace.columns.slice(1).map((key:string,i:number)=>[key,row[i+1]])) as unknown as FlightInput;
    }
    const steeringReplaced=lateral&&state.tick+1>=trace.steeringTick&&state.tick+1<trace.dodgeExpiryTick;
    // Keep the historical keyboard/fire/throttle delivery. Replace only the
    // two-second steering command chosen from the same observed threat geometry.
    stepGame(state,steeringReplaced?{...held,turn:dodge!.turn,climb:dodge!.climb}:held);
    if(state.tick>=trace.steeringTick){
      minAltitude=Math.min(minAltitude,state.player.position.y);
      for(const enemy of state.enemies)if(enemy.health>0)minSeparation=Math.min(minSeparation,state.player.position.distanceTo(enemy.position));
    }
  }
  if(lateral){
    assert.equal(state.tick,trace.dodgeExpiryTick);assert.equal(state.phase,'playing');assert.ok(state.player.health>50);
    assert.ok(minAltitude>270);assert.ok(minSeparation>60,'clearance must improve beyond the collision envelope');
  }else{
    assert.equal(state.tick,trace.expectedOriginal.tick);assert.equal(state.deathCause,trace.expectedOriginal.cause);
    assert.equal(state.result?.outcome,'defeat');assert.equal(state.result?.score,trace.expectedOriginal.score);
    assert.equal(state.result?.scoreBreakdown.clear,0);
  }
});
