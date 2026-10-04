import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
import { RULES_VERSION } from '../src/mission';
import type { FlightInput } from '../src/types';

const evidence=JSON.parse(readFileSync(new URL('./fixtures/consumed-inputs-ci28.json',import.meta.url),'utf8'));
for(const scenario of evidence.cases) test(`${scenario.mode} replays historical CI28 input deterministically under the explicit Iowa rules revision`,()=>{
  // The original expected results stay in the fixture. They describe air-sea-7,
  // whose hull, light-AA volley and Easy correction were intentionally replaced
  // by user-requested Iowa/aim changes. Do not regenerate those historical facts
  // or assert old numeric outcomes against a different rules revision.
  assert.equal(RULES_VERSION,'kaisen-air-sea-10');
  const replay=()=>{
  const state=createGame(scenario.seed,scenario.config);startGame(state);
  let index=0,held:FlightInput={turn:0,climb:0,fire:false,loop:false};
  while(state.phase==='playing'&&state.tick<scenario.expected.tick) {
    while(index<scenario.entries.length&&scenario.entries[index][0]<=state.tick+1) {
      const row=scenario.entries[index++];
      held=Object.fromEntries(evidence.columns.slice(1).map((name:string,i:number)=>[name,row[i+1]])) as unknown as FlightInput;
    }
    stepGame(state,held);
  }
  return state;
  };
  const state=replay(),again=replay();
  assert.deepEqual(JSON.parse(JSON.stringify(state)),JSON.parse(JSON.stringify(again)), 'same actual consumed inputs remain deterministic');
  assert.ok(Math.abs(state.elapsed-state.tick/60)<1e-9);assert.ok(state.tick<=scenario.expected.tick);
  for(const plane of [state.player,...state.allies,...state.enemies]) {
    for(const value of [plane.position.x,plane.position.y,plane.position.z,plane.health,plane.speed])assert.ok(Number.isFinite(value));
    assert.ok(plane.health>=0&&plane.health<=plane.maxHealth);
  }
  if(state.result?.outcome==='victory') assert.ok([...state.enemies,...state.ships].every(target=>target.health===0));
  if(state.result?.outcome==='defeat') assert.equal(state.player.health,0);
  assert.ok(Math.abs(state.stats.score-(-state.stats.friendlyDamage*10-state.stats.friendlyKills*1500))<1e-7);
});
