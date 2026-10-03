import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
import { createBrowserMissionPilot } from './helpers/mission-browser-pilot';
import { pointerOffsetForControls } from './helpers/touch-reload-pilot';
import type { FlightInput } from '../src/types';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/browser-input-components-ci28.json',import.meta.url),'utf8'));
for(const scenario of fixture.cases) test(`${scenario.mode} clears with CI28 component delivery timing from a fresh mission`,context=>{
  const state=createGame(scenario.seed,scenario.config),pilot=createBrowserMissionPilot();startGame(state);
  let index=0,next=scenario.startTick;
  let held:FlightInput={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};
  const pending:{tick:number;fields:Partial<FlightInput>}[]=[];
  while(state.phase==='playing'&&state.tick<60*600) {
    if(state.tick>=next) {
      const row=scenario.cycles[index++%scenario.cycles.length];next=state.tick+row[0];
      const before=JSON.stringify(state),request=pilot(JSON.parse(before));assert.equal(JSON.stringify(state),before);
      const {dx,dy}=pointerOffsetForControls(request.turn,request.climb),r=Math.hypot(dx,dy);
      assert.ok(r<=36+1e-9);
      const response=r/36<=.08?0:(r/36-.08)/.92;
      pending.push({tick:state.tick+Math.max(1,row[1]),fields:{turn:r?dx/r*response:0,climb:r?-dy/r*response:0}});
      for(let k=2;k<fixture.columns.length;k++) {
        const name=fixture.columns[k] as keyof FlightInput;
        pending.push({tick:state.tick+Math.max(1,row[k]),fields:{[name]:!!request[name]}});
      }
    }
    pending.sort((a,b)=>a.tick-b.tick);
    while(pending.length&&pending[0].tick<=state.tick+1)held={...held,...pending.shift()!.fields};
    stepGame(state,held);
  }
  context.diagnostic(JSON.stringify({mode:scenario.mode,time:state.elapsed,hp:state.player.health,reason:state.endReason,cause:state.deathCause,stats:state.stats,ships:state.ships.map(s=>s.health)}));
  assert.equal(state.endReason,'all-clear');assert.ok(state.player.health>0);
  assert.ok(state.stats.playerAircraftKills>0&&state.stats.playerShipKills>0);
  assert.ok([...state.enemies,...state.ships].every(target=>target.health<=0));
});
