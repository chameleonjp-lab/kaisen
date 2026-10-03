/** Fixed-seed no-input measurement. A comparison, not a promise about all seeds. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
const cases=[];
for(const seed of [0x4b414953,1,7,42,73,12345]) for(const [width,height] of [[393,852],[852,393]]) {
  const s=createGame(seed,'easy');startGame(s);let projectileKills=0,collisionKills=0;
  for(let i=0;i<120*60&&s.phase==='playing';i++) {
    stepGame(s,{turn:0,climb:0,fire:false,loop:false,viewAspect:width/height});
    for(const e of s.events) if(e.type==='kill'&&e.owner===s.player.id&&e.targetTeam==='enemy'&&e.targetKind==='aircraft') {
      if(s.events.some(hit=>hit.id<e.id&&hit.type==='hit'&&hit.owner===e.owner&&hit.target===e.target&&(hit.weapon==='mg'||hit.weapon==='cannon')))projectileKills++;else collisionKills++;
    }
  }
  cases.push({seed,width,height,time:s.elapsed,result:s.endReason,playerAirKills:s.stats.playerAircraftKills,projectileKills,collisionKills,shots:s.stats.shots,hits:s.stats.hits,hp:s.player.health});
}
const sources=Object.fromEntries(['src/flight-assist.ts','src/simulation.ts','src/flight-view.ts','src/flight.ts'].map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
console.log(JSON.stringify({generatedAt:new Date().toISOString(),duration:120,description:'12 ordinary Kaisen missions, no-input Easy, fixed60Hz. All fleet/ally/respawn/damage systems active. No human/iPhone/performance claim.',sources,cases},null,2));
