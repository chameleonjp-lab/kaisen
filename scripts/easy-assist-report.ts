import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GameMode } from '../src/types';
type Scenario = 'ordinary-idle' | 'airborne-idle' | 'manual' | 'normal-held-fire';
// Optional source directory enables the same read-only report against a baseline checkout.
const sourceRoot=resolve(process.argv[2]??fileURLToPath(new URL('../src',import.meta.url)));
const {createGame,startGame,stepGame}=await import(pathToFileURL(resolve(sourceRoot,'simulation.ts')).href);
const {updateQuaternion}=await import(pathToFileURL(resolve(sourceRoot,'flight.ts')).href);
const seeds=[0x4b414953,1,7,42,73,12345];
const sizes=[[393,852],[852,393]];
function run(seed: number,mode: GameMode,scenario: Scenario,width: number,height: number,offset=90,range=450){
 const s=createGame(seed,mode);
 if(scenario==='airborne-idle') for(const p of [s.player,...s.allies,...s.enemies]) {p.position.y+=1280;p.previous.copy(p.position);}
 if(scenario==='manual'){
  s.player.position.set(0,1500,0);s.player.previous.copy(s.player.position);
  for(const p of [...s.allies,...s.enemies.slice(1)])p.health=0;
  for(const ship of s.ships){ship.position.set(10000,0,-10000);ship.previous.copy(ship.position);}
  const e=s.enemies[0];e.position.set(offset,1500,-range);e.previous.copy(e.position);e.yaw=0;updateQuaternion(e);
 }
 startGame(s);let projectileKills=0,collisionKills=0,playerAircraftHits=0,playerOtherHits=0;const shots={mg:0,cannon:0};const hits={mg:0,cannon:0};const trajectory=createHash('sha256');
 const duration=scenario==='manual'?4:120;
 for(let tick=0;tick<duration*60&&s.phase==='playing';tick++){
  stepGame(s,{turn:scenario==='manual'&&tick<20?.6:0,climb:0,fire:mode==='normal',loop:false,viewAspect:width/height});
  trajectory.update(JSON.stringify({p:s.player.position.toArray(),q:s.player.quaternion.toArray(),speed:s.player.speed}));
  for(const e of s.events){
   if(e.owner!==s.player.id)continue;
   if(e.type==='shot'&&(e.weapon==='mg'||e.weapon==='cannon'))shots[e.weapon]++;
   if(e.type==='hit'&&(e.weapon==='mg'||e.weapon==='cannon')){hits[e.weapon]++;if(e.targetKind==='aircraft'&&e.targetTeam==='enemy')playerAircraftHits++;else playerOtherHits++;}
   if(e.type==='kill'&&e.targetTeam==='enemy'&&e.targetKind==='aircraft'){
    if(s.events.some(hit=>hit.id<e.id&&hit.type==='hit'&&hit.owner===e.owner&&hit.target===e.target&&(hit.weapon==='mg'||hit.weapon==='cannon')))projectileKills++;else collisionKills++;
   }
  }
 }
 return {seed,mode,scenario,width,height,...(scenario==='manual'?{offset,range}:{}),time:s.elapsed,result:s.endReason,projectileKills,collisionKills,playerAircraftHits,playerOtherHits,shots,hits,hp:s.player.health,enemyHp:s.enemies[0].health,trajectory:trajectory.digest('hex')};
}
const cases=[];
for(const seed of seeds)for(const [w,h]of sizes)for(const scenario of ['ordinary-idle','airborne-idle'] as const)cases.push(run(seed,'easy',scenario,w,h));
for(const offset of [60,90,120])for(const range of [300,450,650])for(const [w,h]of sizes)cases.push(run(73,'easy','manual',w,h,offset,range));
for(const seed of seeds)for(const [w,h]of sizes)cases.push(run(seed,'normal','normal-held-fire',w,h));
console.log(JSON.stringify({generatedAt:new Date().toISOString(),description:'Fixed 60Hz source-level measurement. No production state overrides after Start; isolated manual fixtures and altitude-shifted idle fixtures are not default missions or human/iPhone play.',cases},null,2));
