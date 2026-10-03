import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3 } from 'three';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';
import { ALLY_RESPAWN_TICKS, FIXED_DT, ENEMY_MG_DAMAGE, ENEMY_CANNON_DAMAGE } from '../src/mission';
import { NAVAL_WEAPONS } from '../src/naval';
import type { Bullet } from '../src/types';
const neutral = {turn:0,climb:0,fire:false,loop:false};
function quiet(mode: 'normal' | 'easy' = 'normal') {
  const s = createGame(123, mode); for(const t of [...s.allies,...s.enemies,...s.ships]) t.health=0;
  s.player.position.set(1000,1000,1000);s.player.previous.copy(s.player.position);
  s.ships[0].health=s.ships[0].maxHealth;s.ships[0].position.set(30000,0,30000);s.ships[0].previous.copy(s.ships[0].position);
  startGame(s);return s;
}
function shot(owner:number,team:Bullet['team'],x:number,damage:number,kind:Bullet['kind']='mg'):Bullet {
  const position=new Vector3(x,1000,60);
  return {id:90000+x,owner,team,position,previous:position.clone(),velocity:new Vector3(0,0,-12000),life:1,damage,kind};
}
test('standard fleet has four real-size ships and exactly four times the previous HP',()=>{
  const s=createGame();assert.equal(s.ships.length,4);assert.deepEqual(s.ships.map(s=>s.maxHealth),[4000,2400,2400,2400]);
  for(const ship of s.ships)assert.deepEqual([ship.length,ship.width,ship.height],[263,38.9,42]);
  assert.ok(ENEMY_MG_DAMAGE < NAVAL_WEAPONS['light-aa'].damage);
  assert.ok(ENEMY_CANNON_DAMAGE < NAVAL_WEAPONS['light-aa'].damage);
});
test('Normal friendly fire uses actual lost HP, a single kill penalty, and Easy ignores it',()=>{
  for(const mode of ['normal','easy'] as const){
    const s=quiet(mode),ally=s.allies[0];ally.health=12;ally.position.set(0,1000,0);ally.previous.copy(ally.position);
    s.bullets.push(shot(1,'friendly',0,5));stepGame(s,neutral);
    assert.equal(ally.health,mode==='normal'?7:12);assert.equal(s.stats.score,mode==='normal'?-50:0);
    s.bullets.push(shot(1,'friendly',0,100),shot(1,'friendly',0,100));stepGame(s,neutral);
    assert.equal(s.stats.friendlyKills,mode==='normal'?1:0);assert.equal(s.stats.score,mode==='normal'?-1620:0);
    assert.equal(s.stats.playerAircraftKills,0);assert.equal(s.stats.hits,0);
  }
});
test('each allied slot returns 40 seconds after its own destruction with fresh identity, never the player',()=>{
  const s=quiet();const a=s.allies[0],b=s.allies[1];
  a.health=b.health=1;a.position.set(0,1000,0);b.position.set(100,1000,0);a.previous.copy(a.position);b.previous.copy(b.position);
  s.bullets.push(shot(1,'friendly',0,2));stepGame(s,neutral);const firstTick=s.tick;
  s.tick+=30;s.elapsed=s.tick*FIXED_DT;s.bullets.push(shot(1,'friendly',100,2));stepGame(s,neutral);const secondTick=s.tick;
  assert.equal(s.allyRespawnAt[a.id],firstTick+ALLY_RESPAWN_TICKS);assert.equal(s.allyRespawnAt[b.id],secondTick+ALLY_RESPAWN_TICKS);
  s.tick=firstTick+ALLY_RESPAWN_TICKS-2;s.elapsed=s.tick*FIXED_DT;stepGame(s,neutral);assert.equal(s.allies[0],a);
  pauseGame(s);const frozen=JSON.stringify(s);stepGame(s,neutral,.25);assert.equal(JSON.stringify(s),frozen);resumeGame(s);
  stepGame(s,neutral);assert.notEqual(s.allies[0].id,a.id);assert.equal(s.allies[0].health,100);assert.equal(s.allies[1],b);
  s.tick=secondTick+ALLY_RESPAWN_TICKS-1;s.elapsed=s.tick*FIXED_DT;stepGame(s,neutral);assert.notEqual(s.allies[1].id,b.id);
  assert.equal(s.allies.length,4);assert.equal(Object.keys(s.allyRespawnAt).length,0);assert.equal(s.player.id,1);
  s.player.health=0;stepGame(s,neutral);const ended=JSON.stringify(s);stepGame(s,neutral,.25);assert.equal(JSON.stringify(s),ended);
});
test('fatal real bullet source identifies aircraft, naval and friendly fire',()=>{
  for(const [team,kind,cause] of [['enemy','mg','enemy-aircraft'],['enemy','aa','naval-fire'],['friendly','mg','friendly-fire']] as const){
    const s=quiet();s.player.position.set(0,1000,0);s.player.previous.copy(s.player.position);s.player.health=1;
    s.bullets.push(shot(44,team,0,2,kind));stepGame(s,neutral);
    assert.equal(s.endReason,'shot-down');assert.equal(s.deathCause,cause);assert.equal(s.result?.outcome,'defeat');
  }
});
