/** Replay inputs actually consumed by fixed steps in a browser evidence file.
 * This reconstructs a recorded run; it is not a fresh pilot or a human-play test.
 * node --import tsx scripts/replay-consumed-inputs.ts evidence.json
 */
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { FlightInput } from '../src/types';
const evidence = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const audit = evidence.consumedInputs;
if (!audit || audit.dropped !== 0 || !audit.entries.length) throw new Error('Complete consumed-input audit required');
const expected = evidence.snapshot;
const state = createGame(audit.seed, audit.config); startGame(state);
let index = 0;
let held: FlightInput = { turn:0,climb:0,fire:false,loop:false };
const damage:Record<string,{hits:number;hp:number}> = {};
const milestones:unknown[] = [], playerHits:unknown[] = [];
while (state.phase === 'playing' && state.tick < expected.tick) {
  while(index < audit.entries.length && audit.entries[index].tick <= state.tick+1) held = audit.entries[index++].input;
  stepGame(state,held);
  for(const event of state.events) if(event.type==='hit' && event.target===state.player.id) {
    const key=event.weapon??'unknown', row=damage[key]??(damage[key]={hits:0,hp:0});
    row.hits++; row.hp+=event.amount??0;
    playerHits.push({tick:state.tick,owner:event.owner,weapon:key,amount:event.amount,hp:state.player.health});
  }
  if(state.tick%1800===0 || state.phase==='ended') milestones.push({tick:state.tick,hp:state.player.health,
    altitude:state.player.position.y,closestLiveShip:Math.min(...state.ships.filter(s=>s.health>0).map(s=>s.position.distanceTo(state.player.position))),
    ships:state.ships.map(s=>s.health),enemies:state.enemies.map(e=>e.health),stats:{...state.stats}});
}
const actual=JSON.parse(JSON.stringify(state));
const keys=['phase','mode','tick','elapsed','player','allies','enemies','ships','stats','result','deathCause','allyRespawnAt'];
const matches=Object.fromEntries(keys.map(key=>[key,JSON.stringify(actual[key])===JSON.stringify(expected[key])]));
const differences:{path:string;actual:unknown;expected:unknown}[]=[];
function compare(a:any,b:any,path:string) {
  if(a===b)return;
  if(a&&b&&typeof a==='object'&&typeof b==='object') {
    for(const key of new Set([...Object.keys(a),...Object.keys(b)]))compare(a[key],b[key],`${path}.${key}`);
  } else differences.push({path,actual:a,expected:b});
}
for(const key of keys)compare(actual[key],expected[key],key);
const materiallyDifferent=differences.filter(d=>!(typeof d.actual==='number'&&typeof d.expected==='number'&&Math.abs(d.actual-d.expected)<1e-7));
console.log(JSON.stringify({source:process.argv[2],recordedTick:expected.tick,replayedTick:state.tick,allFieldsExact:Object.values(matches).every(Boolean),matches,
  numericTolerance:1e-7,maxNumericDifference:Math.max(0,...differences.filter(d=>typeof d.actual==='number'&&typeof d.expected==='number').map(d=>Math.abs(Number(d.actual)-Number(d.expected)))),
  differences:differences.slice(0,20),materiallyDifferent:materiallyDifferent.slice(0,20),
  outcome:state.endReason,cause:state.deathCause,hp:state.player.health,stats:state.stats,damage,milestones,playerHits},null,2));
if(materiallyDifferent.length)process.exitCode=1;
