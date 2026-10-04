import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createGame, startGame, pauseGame, resumeGame, stepGame } from '../src/simulation';
import { predictBombEffect, bombReleaseCue, currentBombGuide } from '../src/bomb-guide';
import { BOMB_BLAST, closestBombHullPoint, bombBlastDamage } from '../src/bomb-blast';
import { CAPITAL_SHIP, NAVAL_GRAVITY } from '../src/naval';
import { releaseBomb, stepOrdnance, ORDNANCE_TUNING } from '../src/ordnance';
import { advanceShipMotion } from '../src/ship-motion';
import { beginShipWreck, isShipObstacle } from '../src/ship-wreck';
import { oceanHeight } from '../src/ocean';
import { FIXED_DT, MAX_ORDNANCE } from '../src/mission';
import type { GameMode, GameState } from '../src/types';

const neutral = {turn:0,climb:0,fire:false,loop:false};
const close = (a:number,b:number,t=1e-7) => assert.ok(Math.abs(a-b)<t,`${a} vs ${b}`);
function fixture(mode:GameMode='normal') {
  const state=createGame(73,mode),ship=state.ships[0];
  state.ships=state.ships.slice(0,1); ship.position.set(0,0,0);ship.previous.copy(ship.position);
  ship.yaw=0;ship.quaternion.identity();ship.previousQuaternion.identity();ship.velocity.set(0,0,0);
  state.player.position.set(10,201.2,110*Math.sqrt(400/NAVAL_GRAVITY));state.player.previous.copy(state.player.position);
  state.player.pitch=state.player.yaw=state.player.bank=0;state.player.quaternion.identity();state.player.speed=110;
  startGame(state);return state;
}
function waterBomb(state:GameState,x:number,z=0) {
  const bomb=releaseBomb(9900,state.player)!;bomb.age=1;
  bomb.position.set(x,oceanHeight(x,z,state.elapsed)+.05,z);bomb.previous.copy(bomb.position);bomb.velocity.set(0,-100,0);return bomb;
}
function fly(state:GameState) {
  const bomb=releaseBomb(9901,state.player)!;
  for(let tick=0;tick<1800;tick++) {
    const time=state.elapsed+tick*FIXED_DT;
    for(const ship of state.ships)advanceShipMotion(ship,time+FIXED_DT,FIXED_DT);
    const result=stepOrdnance(bomb,state.ships.filter(s=>isShipObstacle(s,time+FIXED_DT)).map(s=>({...s,collisionActive:true})),time,FIXED_DT);
    if(!result.active)return {bomb,result};
  }
  throw Error('Bomb did not terminate');
}

test('closest hull surface uses the tapered bow and real scaled sloped sides',()=>{
  const side=new Vector3(CAPITAL_SHIP.width/2+10,0,0),unit=new Vector3(1,1,1);
  close(side.distanceTo(closestBombHullPoint(side,unit)),10.24,.01);
  const bow=new Vector3(26,0,-132),nearest=closestBombHullPoint(bow,unit);
  assert.ok(bow.distanceTo(nearest)>20,'empty water beside the tapered bow is outside blast range');
  const inside=new Vector3(0,3,0);assert.deepEqual(closestBombHullPoint(inside,unit),inside);
  close(side.clone().multiplyScalar(.5).distanceTo(closestBombHullPoint(side.clone().multiplyScalar(.5),new Vector3(.5,.5,.5))),5.12,.01);
});

test('bounded water blast is weaker than direct damage, with a strict 20m boundary',()=>{
  assert.equal(BOMB_BLAST.radius,20);
  assert.equal(BOMB_BLAST.maximumDamage,500);
  for(const [distance,damage] of [[0,500],[4,400],[10,250],[19.9,2.5],[20,0],[30,0]])close(bombBlastDamage(500,distance),damage);
  for(const d of [-1,NaN,Infinity])assert.equal(bombBlastDamage(500,d),0);
  assert.equal(bombBlastDamage(-1,0),0);assert.equal(bombBlastDamage(250,10),125);
});

test('1800 direct bombs sink the flagship in three hits and an escort in two in both modes',()=>{
  for(const mode of ['easy','normal'] as const)for(const [hp,expectedHits] of [[4000,3],[2400,2]]) {
    const state=fixture(mode),ship=state.ships[0];ship.health=ship.maxHealth=hp;
    for(const plane of [...state.allies,...state.enemies])plane.health=0;
    ship.guns.forEach(g=>g.health=0);
    state.player.position.set(10000,900,10000);state.player.previous.copy(state.player.position);
    for(let hit=1;hit<=expectedHits;hit++) {
      const bomb=releaseBomb(9900+hit,state.player)!;bomb.age=1;
      bomb.position.set(10,10,0);bomb.previous.copy(bomb.position);bomb.velocity.set(0,-500,0);
      state.ordnance.push(bomb);stepGame(state,neutral);
      close(ship.health,Math.max(0,hp-1800*hit));
      assert.equal(state.stats.playerShipKills,hit===expectedHits?1:0);
    }
    assert.equal(state.result?.outcome,'victory');assert.equal(state.stats.hits,expectedHits);
  }
});

test('direct damage tuning preserves player and allied water-blast strength and torpedo damage',()=>{
  for(const scale of [1,.5]) {
    const state=fixture(),ship=state.ships[0],bomb=waterBomb(state,CAPITAL_SHIP.width/2+10);
    bomb.damage*=scale;
    const impact=stepOrdnance(bomb,[ship],0,FIXED_DT).outcomes.find(o=>o.type==='impact');
    assert.ok(impact?.type==='impact');
    const distance=bomb.position.distanceTo(closestBombHullPoint(bomb.position,new Vector3(1,1,1)));
    close(impact.damage,500*scale*(1-distance/20));
    assert.equal(bomb.damage,1800*scale);
  }
  assert.equal(ORDNANCE_TUNING.torpedo.damage,2000);
});

test('armed near misses use water contact once, actual surface distance, and stop outside range',()=>{
  const state=fixture(),ship=state.ships[0];
  for(const [x,expected] of [[CAPITAL_SHIP.width/2+10,true],[CAPITAL_SHIP.width/2+20,false],[26,false]] as const) {
    const bomb=waterBomb(state,x,x===26?-132:0);
    const outcomes=stepOrdnance(bomb,[ship],0,FIXED_DT).outcomes;
    assert.equal(outcomes[0].type,'splash');const impact=outcomes.find(o=>o.type==='impact');
    assert.equal(Boolean(impact),expected);if(impact?.type==='impact'){assert.equal(impact.blast,true);assert.ok(impact.damage>200&&impact.damage<260);}
    assert.deepEqual(stepOrdnance(bomb,[ship],FIXED_DT,FIXED_DT).outcomes,[]);
  }
  const unarmed=waterBomb(state,18);unarmed.age=0;
  assert.deepEqual(stepOrdnance(unarmed,[ship],0,FIXED_DT).outcomes.map(o=>o.type),['splash']);
});

test('dead hulls are obstacles but receive no blast and can shield another live hull',()=>{
  const state=fixture(),live=state.ships[0],dead={...live,id:55,health:0,collisionActive:true};
  const bomb=waterBomb(state,18);assert.equal(stepOrdnance(bomb,[dead],0,FIXED_DT).outcomes.some(o=>o.type==='impact'),false);
  const shield={...dead,position:new Vector3(40,0,0),previous:new Vector3(40,0,0),width:2};
  const behind={...live,position:new Vector3(10,0,0),previous:new Vector3(10,0,0)};
  const blocked=waterBomb(state,42);
  assert.equal(stepOrdnance(blocked,[shield,behind],0,FIXED_DT).outcomes.some(o=>o.type==='impact'),false);
});

test('forecast exactly matches actual fixed-step release against moving and turning ships in both modes',()=>{
  for(const mode of ['easy','normal'] as const)for(const cross of [false,true]) {
    const state=fixture(mode),ship=state.ships[0];
    if(cross){ship.yaw=-Math.PI/2;ship.quaternion.setFromAxisAngle(new Vector3(0,1,0),ship.yaw);ship.previousQuaternion.copy(ship.quaternion);ship.velocity.set(6,0,0);state.player.position.x=39;state.player.position.z=110*Math.sqrt(400/NAVAL_GRAVITY);}
    else ship.velocity.set(0,0,-6);
    const before=JSON.stringify(state),prediction=predictBombEffect(state)!;
    assert.equal(JSON.stringify(state),before,'forecast cannot mutate world/clock/guns');
    assert.equal(prediction.kind,'direct');assert.equal(prediction.affected[0].damage,1800);
    const actual=fly(state),impact=actual.result.outcomes.find(o=>o.type==='impact');assert.ok(impact);
    close(prediction.position.distanceTo(actual.bomb.position),0);close(prediction.time,actual.bomb.age);
    if(impact?.type==='impact')assert.deepEqual(prediction.affected,[{shipId:impact.shipId,damage:impact.damage}]);
    if(cross)assert.ok(ship.position.x>30,'target moves more than a hull half-beam during flight');
  }
});

test('forecast distinguishes water, near-miss, unarmed deck contact, and a sinking wreck',()=>{
  for(const [x,kind]of [[27,'blast'],[100,'water']] as const) {
    const state=fixture();state.player.position.x=x;
    const predicted=predictBombEffect(state)!;assert.equal(predicted.kind,kind);
    const actual=fly(state);close(predicted.position.distanceTo(actual.bomb.position),0);
    assert.equal(actual.result.outcomes.some(o=>o.type==='impact'),kind==='blast');
  }
  const low=fixture();low.player.position.set(0,10.21,100);assert.equal(predictBombEffect(low)?.kind,'dud');
  const dead=fixture();dead.player.position.set(0,60,0);dead.player.speed=0;dead.ships[0].health=0;beginShipWreck(dead.ships[0],0);
  assert.equal(predictBombEffect(dead)?.kind,'wreck');
  const invalid=fixture();invalid.player.position.y=NaN;assert.equal(predictBombEffect(invalid),null);
});

test('green bomb cue requires a live damage prediction and every release gate',()=>{
  for(const mode of ['easy','normal'] as const) {
    const state=fixture(mode),guide=predictBombEffect(state)!;
    assert.deepEqual(bombReleaseCue(state,guide),{ready:true,text:'命中見込み'});
    state.player.payloadCooldown=.1;assert.equal(bombReleaseCue(state,guide).text,'投下待ち');state.player.payloadCooldown=0;
    state.player.bombs=0;state.player.bombReloadTicks=360;assert.deepEqual(bombReleaseCue(state,guide),{ready:false,text:'装填中'});
    state.player.bombReloadTicks=0;assert.equal(bombReleaseCue(state,guide).text,'残弾なし');state.player.bombs=2;
    state.ordnance=Array.from({length:MAX_ORDNANCE},(_,i)=>releaseBomb(i,state.player)!);assert.equal(bombReleaseCue(state,guide).ready,false);state.ordnance=[];
    pauseGame(state);assert.deepEqual(bombReleaseCue(state,guide),{ready:false,text:'停止中'});
    const frozen=JSON.stringify(state);stepGame(state,neutral,1);assert.equal(JSON.stringify(state),frozen);
    resumeGame(state);assert.equal(bombReleaseCue(state,guide).ready,true);
    assert.equal(bombReleaseCue(state,null).text,'予測範囲外');
  }
});

test('HUD and canvas share a same-tick forecast; next simulation tick cannot reuse stale green',()=>{
  const state=fixture();const first=currentBombGuide(state);assert.equal(first,currentBombGuide(state));
  state.tick++;state.player.position.x=200;assert.notEqual(currentBombGuide(state),first);
  assert.equal(currentBombGuide(state)?.kind,'water');
});

test('actual stepGame button release matches forecast at the thin blast boundary, not one aircraft tick later',()=>{
  for(const mode of ['easy','normal'] as const)for(const z of [547.5,548,549,550,580,702.5259049183292]) {
    const state=fixture(mode),ship=state.ships[0];state.player.position.set(10,201.2,z);state.player.previous.copy(state.player.position);
    for(const plane of [...state.allies,...state.enemies])plane.health=0;
    ship.guns.forEach(g=>g.health=0);
    const guide=predictBombEffect(state)!,before=ship.health;
    stepGame(state,{...neutral,bomb:true});
    for(let i=0;i<1800&&state.ordnance.length&&state.phase==='playing';i++)stepGame(state,neutral);
    assert.equal(state.player.health>0,true);assert.equal(state.player.bombs,1);
    const predicted=guide.affected.find(effect=>effect.shipId===ship.id)?.damage??0;
    close(before-ship.health,predicted,1e-6);
  }
});

test('one water explosion damages each nearby ship once and credits one shot hit',()=>{
  const state=fixture();for(const plane of [...state.allies,...state.enemies])plane.health=0;
  state.player.position.set(10000,1000,10000);state.player.previous.copy(state.player.position);
  const left=state.ships[0];left.position.x=-30;left.previous.copy(left.position);
  const right={...left,id:56,position:new Vector3(30,0,0),previous:new Vector3(30,0,0),quaternion:left.quaternion.clone(),previousQuaternion:left.quaternion.clone(),velocity:new Vector3(),guns:left.guns.map(g=>({...g}))};
  state.ships.push(right);left.guns.forEach(g=>g.health=0);right.guns.forEach(g=>g.health=0);
  state.ordnance.push(waterBomb(state,0));stepGame(state,neutral);
  assert.equal(state.stats.hits,1);assert.equal(state.events.filter(e=>e.type==='ordnance-impact').length,2);
  for(const ship of state.ships)assert.ok(ship.health<ship.maxHealth&&ship.health>ship.maxHealth-500);
  const health=state.ships.map(s=>s.health);stepGame(state,neutral);assert.deepEqual(state.ships.map(s=>s.health),health);
  assert.equal(ORDNANCE_TUNING.torpedo.damage,2000);
});
