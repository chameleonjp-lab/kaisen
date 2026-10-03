import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGame,startGame,stepGame} from '../src/simulation';
import {createBrowserMissionPilot} from './helpers/mission-browser-pilot';
import {pointerOffsetForControls} from './helpers/touch-reload-pilot';
import type {FlightInput} from '../src/types';
const cadence = JSON.parse(readFileSync(new URL('./fixtures/browser-input-cadence.json',import.meta.url),'utf8'));

for (const mode of ['easy','normal'] as const) test(`${mode} browser pilot clears with recorded uneven sampling plus one-tick delivery lag`, context=>{
  const state=createGame(undefined,mode),pilot=createBrowserMissionPilot();startGame(state);
  let next=cadence.startTick,index=0;
  let held:FlightInput={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};
  let pending:{tick:number;input:FlightInput}|null=null;
  for(let tick=0;tick<60*600&&state.phase==='playing';tick++) {
    if(pending&&tick>=pending.tick){held=pending.input;pending=null;}
    if(tick>=next) {
      next=tick+cadence.intervalTicks[index++%cadence.intervalTicks.length];
      const before=JSON.stringify(state),snapshot=JSON.parse(before),request=pilot(snapshot);
      assert.equal(JSON.stringify(snapshot),before);assert.equal(JSON.stringify(state),before);
      const {dx,dy}=pointerOffsetForControls(request.turn,request.climb),distance=Math.hypot(dx,dy);
      assert.ok(distance<=36+1e-9);
      const response=distance/36<=.08?0:(distance/36-.08)/.92;
      pending={tick:tick+1,input:{...held,...request,turn:distance?dx/distance*response:0,climb:distance?-dy/distance*response:0}};
    }
    stepGame(state,held);
  }
  context.diagnostic(JSON.stringify({mode,time:state.elapsed,hp:state.player.health,reason:state.endReason,stats:state.stats}));
  assert.equal(state.endReason,'all-clear');assert.ok(state.player.health>0);
  assert.ok([...state.enemies,...state.ships].every(t=>t.health<=0));
  assert.ok(state.stats.playerAircraftKills>0&&state.stats.playerShipKills>0);
});

for (const lag of [1,5]) test(`Normal fleet-first pilot clears acceptance-relative CI20 cadence with ${lag}-tick delivery lag`, context=> {
  const timing=JSON.parse(readFileSync(new URL('./fixtures/browser-input-cadence-ci20.json',import.meta.url),'utf8'));
  const state=createGame(undefined,'normal'),pilot=createBrowserMissionPilot();startGame(state);
  let next=timing.startTick,index=0;
  let held:FlightInput={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};
  let pending:{tick:number;input:FlightInput}|null=null;
  for(let tick=0;tick<60*600&&state.phase==='playing';tick++) {
    if(pending&&tick>=pending.tick){held=pending.input;pending=null;}
    if(tick>=next) {
      // The browser waits for handler acceptance, then holds at least six ticks.
      // Recorded excess over six captures observation/keyboard scheduling jitter.
      next=tick+lag+timing.intervalTicks[index++%timing.intervalTicks.length];
      const request=pilot(JSON.parse(JSON.stringify(state)));
      const {dx,dy}=pointerOffsetForControls(request.turn,request.climb),distance=Math.hypot(dx,dy);
      assert.ok(distance<=36+1e-9);
      const response=distance/36<=.08?0:(distance/36-.08)/.92;
      pending={tick:tick+lag,input:{...held,...request,turn:distance?dx/distance*response:0,climb:distance?-dy/distance*response:0}};
    }
    stepGame(state,held);
  }
  context.diagnostic(JSON.stringify({time:state.elapsed,hp:state.player.health,stats:state.stats}));
  assert.equal(state.endReason,'all-clear');assert.ok(state.player.health>0);
  assert.ok([...state.enemies,...state.ships].every(t=>t.health<=0));
  assert.ok(state.stats.playerAircraftKills>0&&state.stats.playerShipKills>0);
});

test('Normal recovery pilot clears actual CI21 observed request/acceptance timings', context=> {
  const timing=JSON.parse(readFileSync(new URL('./fixtures/browser-input-acceptance-ci21.json',import.meta.url),'utf8'));
  const state=createGame(undefined,'normal'),pilot=createBrowserMissionPilot();startGame(state);
  let next=timing.startTick,index=0;
  let held:FlightInput={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};
  let pending:{tick:number;input:FlightInput}|null=null;
  for(let tick=0;tick<60*600&&state.phase==='playing';tick++) {
    if(pending&&tick>=pending.tick){held=pending.input;pending=null;}
    if(tick>=next) {
      const cycle=timing.cycles[index++%timing.cycles.length];
      assert.ok(cycle.cycleTicks>=cycle.deliveryTicks+6);
      next=tick+cycle.cycleTicks;
      const request=pilot(JSON.parse(JSON.stringify(state)));
      const {dx,dy}=pointerOffsetForControls(request.turn,request.climb),distance=Math.hypot(dx,dy);
      assert.ok(distance<=36+1e-9);
      const response=distance/36<=.08?0:(distance/36-.08)/.92;
      pending={tick:tick+cycle.deliveryTicks,input:{...held,...request,turn:distance?dx/distance*response:0,climb:distance?-dy/distance*response:0}};
    }
    stepGame(state,held);
  }
  context.diagnostic(JSON.stringify({time:state.elapsed,hp:state.player.health,stats:state.stats}));
  assert.equal(state.endReason,'all-clear');assert.ok(state.player.health>0);
  assert.ok([...state.enemies,...state.ships].every(t=>t.health<=0));
  assert.ok(state.stats.playerAircraftKills>0&&state.stats.playerShipKills>0);
});
