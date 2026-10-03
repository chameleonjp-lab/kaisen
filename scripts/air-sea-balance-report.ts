/** Read-only numerical route evidence; no browser or device performance claim.
 * Run: node --import tsx scripts/air-sea-balance-report.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createGame, startGame, stepGame } from '../src/simulation';
import { createBrowserMissionPilot } from '../tests/helpers/mission-browser-pilot';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';
import type { FlightInput } from '../src/types';
const sourcePaths=['src/aircraft-damage.ts','src/simulation.ts','src/mission.ts','src/flight.ts','src/flight-assist.ts','src/ai.ts','src/naval.ts','src/naval-damage.ts','src/ordnance.ts','src/ship-wreck.ts','tests/helpers/mission-browser-pilot.ts'];
const sources=Object.fromEntries(sourcePaths.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
const records=[];
for(const mode of ['easy','normal'] as const) {
  const s=createGame(undefined,mode),pilot=createBrowserMissionPilot();startGame(s);
  let held:FlightInput={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};
  const weapons:Record<string,{shots:number;airHits:number;airDamage:number;partHits:number;partDamage:number;armorContacts:number;payloadHits:number;hullDamage:number}>={};
  for(let tick=0;tick<60*600&&s.phase==='playing';tick++) {
    if(tick%6===0) {
      const input=pilot(JSON.parse(JSON.stringify(s))),{dx,dy}=pointerOffsetForControls(input.turn,input.climb);
      const r=Math.hypot(dx,dy),response=r/36<=.08?0:(r/36-.08)/.92;
      held={...input,turn:r?dx/r*response:0,climb:r?-dy/r*response:0,viewAspect:393/852};
    }
    stepGame(s,held);
    for(const e of s.events) {
      if(!e.weapon||!['shot','hit','payload-release','ordnance-impact'].includes(e.type))continue;
      const faction=s.ships.some(ship=>ship.id===e.owner)?'naval':e.owner===s.player.id?'player':e.team==='friendly'?'ally':'enemy';
      const key=`${faction}/${e.weapon}`;
      const row=weapons[key]??(weapons[key]={shots:0,airHits:0,airDamage:0,partHits:0,partDamage:0,armorContacts:0,payloadHits:0,hullDamage:0});
      if(e.type==='shot'||e.type==='payload-release')row.shots++;
      else if(e.type==='ordnance-impact'&&e.detail!=='wreck'){row.payloadHits++;row.hullDamage+=e.amount??0;}
      else if(e.type==='hit'&&e.targetKind==='aircraft'){row.airHits++;row.airDamage+=e.amount??0;}
      else if(e.type==='hit'&&e.targetKind==='ship'&&e.detail!=='wreck') {
        if((e.amount??0)>0){row.partHits++;row.partDamage+=e.amount!;}else row.armorContacts++;
      }
    }
  }
  records.push({mode,seed:s.seed,time:s.elapsed,result:s.endReason,cause:s.deathCause,hp:s.player.health,stats:s.stats,weapons});
}
console.log(JSON.stringify({generatedAt:new Date().toISOString(),note:'Default seed, actual fixed60Hz simulation with legal circular-stick inputs held6ticks. Counts are actual emitted projectiles/contact HP after attenuation; airDamage includes friendly-fire contacts. Dividing by route time includes manoeuvre/reload/nonfiring time and is not theoretical weapon DPS. Not browser/iPhone or human hit-rate evidence.',sources,records},null,2));
