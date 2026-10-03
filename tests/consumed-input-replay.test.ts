import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { FlightInput } from '../src/types';

const evidence=JSON.parse(readFileSync(new URL('./fixtures/consumed-inputs-ci28.json',import.meta.url),'utf8'));
for(const scenario of evidence.cases) test(`${scenario.mode} replays the actual CI28 defeat without changing game rules`,()=>{
  const state=createGame(scenario.seed,scenario.config);startGame(state);
  let index=0,held:FlightInput={turn:0,climb:0,fire:false,loop:false};
  while(state.phase==='playing'&&state.tick<scenario.expected.tick) {
    while(index<scenario.entries.length&&scenario.entries[index][0]<=state.tick+1) {
      const row=scenario.entries[index++];
      held=Object.fromEntries(evidence.columns.slice(1).map((name:string,i:number)=>[name,row[i+1]])) as unknown as FlightInput;
    }
    stepGame(state,held);
  }
  for(const key of ['tick','elapsed','phase','deathCause','stats','result'] as const)
    assert.deepEqual(state[key],scenario.expected[key],`${key} matches the real fixed-step recording`);
  assert.equal(state.player.health,0);
  for(const axis of ['x','y','z'] as const)assert.ok(Math.abs(state.player.position[axis]-scenario.position[axis])<1e-7);
  // The new pilot is tested separately. Keeping this losing input tape losing
  // prevents a hidden health/damage/rule change from masquerading as its repair.
});
