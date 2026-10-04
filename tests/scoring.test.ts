import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createGame, startGame, stepGame, pauseGame, resumeGame } from '../src/simulation';
import { recordTargetDamage, scoreBreakdown, finalScore, SCORE_RULES_VERSION } from '../src/scoring';
import { RULES_VERSION, FIXED_DT } from '../src/mission';
import { releaseBomb } from '../src/ordnance';
import { CAPITAL_SHIP } from '../src/naval';
import { oceanHeight } from '../src/ocean';
import type { Bullet, GameState, GameMode } from '../src/types';

const neutral={turn:0,climb:0,fire:false,loop:false};
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
function credit(state:GameState,kind:'aircraft'|'ship',index:number,fraction:number,own=true) {
  const target=kind==='aircraft'?state.enemies[index]:state.ships[index];
  const actual=Math.min(target.health,target.maxHealth*fraction);target.health-=actual;
  recordTargetDamage(state.scoring,target,actual,own);
}
function shot(owner:number,team:Bullet['team'],position:Vector3,damage:number,kind:Bullet['kind']='cannon'):Bullet {
  return {id:90001,owner,team,position,previous:position.clone(),velocity:new Vector3(0,0,-12000),life:1,damage,kind};
}
function quiet(mode:GameMode='normal') {
  const state=createGame(73,mode);
  for(const target of [...state.allies,...state.enemies,...state.ships])target.health=0;
  state.player.position.set(1000,1000,1000);state.player.previous.copy(state.player.position);
  const ship=state.ships[0];ship.health=ship.maxHealth;ship.position.set(30000,0,30000);ship.previous.copy(ship.position);ship.guns.forEach(g=>g.health=0);
  startGame(state);return state;
}
function targetPlane(state:GameState,index=0) {
  const target=state.enemies[index];target.health=target.maxHealth;target.position.set(0,1000,0);target.previous.copy(target.position);return target;
}
function hitPlane(state:GameState,damage:number,owner=1) {
  const target=state.enemies.find(e=>e.health>0)!;
  state.bullets.push(shot(owner,'friendly',target.position.clone().add(new Vector3(0,0,60)),damage));stepGame(state,neutral);
}

test('initial roster budgets total 10500 and do not grow with reinforcements or changed max HP',()=>{
  const state=createGame();assert.equal(state.scoring.targets.length,9);
  close(state.scoring.targets.reduce((sum,t)=>sum+t.maximumPoints,0),10500);
  const enemy=state.enemies[0];enemy.maxHealth=800;enemy.health=0;recordTargetDamage(state.scoring,enemy,800,true);
  close(scoreBreakdown(state).aircraft,500);
  enemy.id=4000;enemy.generation='reinforcement';enemy.health=0;recordTargetDamage(state.scoring,enemy,80,true);
  assert.equal(state.scoring.targets.length,9);close(scoreBreakdown(state).aircraft,500);
});

test('actual damage, ally finishing blows, repeated reports and overkill preserve a finite contribution',()=>{
  const state=createGame(),target=state.enemies[0];
  credit(state,'aircraft',0,.25);close(scoreBreakdown(state).aircraft,125);
  recordTargetDamage(state.scoring,target,20,true);close(scoreBreakdown(state).aircraft,125);
  credit(state,'aircraft',0,1,false);close(scoreBreakdown(state).aircraft,125);
  recordTargetDamage(state.scoring,target,10000,true);close(scoreBreakdown(state).aircraft,125);
  target.health=80;recordTargetDamage(state.scoring,target,0,false);
  target.health=0;recordTargetDamage(state.scoring,target,80,true);close(scoreBreakdown(state).aircraft,125);
  for(const invalid of [-1,NaN,Infinity])recordTargetDamage(state.scoring,state.enemies[1],invalid,true);
  close(scoreBreakdown(state).aircraft,125);
});

test('approved contribution examples keep failure points and combine clear, speed and cumulative damage',()=>{
  const failed=createGame();for(let i=0;i<3;i++)credit(failed,'aircraft',i,1);
  failed.elapsed=90;assert.equal(finalScore(scoreBreakdown(failed)),1500);
  const state=createGame();credit(state,'aircraft',0,1);credit(state,'aircraft',1,1);credit(state,'aircraft',2,.8);
  credit(state,'ship',0,1);credit(state,'ship',1,1);credit(state,'ship',2,.5);
  state.elapsed=180;state.stats.damageTaken=40;
  assert.deepEqual(scoreBreakdown(state,true),{aircraft:1400,ships:5000,clear:12000,speed:8400,damageAvoidance:250,friendlyDamagePenalty:-0,friendlyKillPenalty:-0,totalBeforeRounding:27050});
  state.stats.friendlyDamage=20;state.stats.friendlyKills=1;assert.equal(finalScore(scoreBreakdown(state,true)),25350);
  state.stats.friendlyDamage=state.stats.friendlyKills=0;state.elapsed=600;assert.equal(finalScore(scoreBreakdown(state,true)),18650);
});

test('speed and cumulative damage boundaries clamp only bonuses, and time is not absolute priority',()=>{
  const state=createGame();
  for(const [time,expected]of [[0,12000],[180,8400],[599.95,1],[600,0],[601,0]]){state.elapsed=time;close(scoreBreakdown(state,true).speed,expected);}
  for(const [damage,expected]of [[0,500],[40,250],[79.92,.5],[80,0],[100,0]]){state.stats.damageTaken=damage;close(scoreBreakdown(state,true).damageAvoidance,expected);}
  state.player.health=80;assert.equal(scoreBreakdown(state,true).damageAvoidance,0,'healing is not counted as undoing damage');
  const fast=createGame(),slow=createGame();fast.elapsed=100;slow.elapsed=150;credit(slow,'ship',0,1);
  assert.ok(finalScore(scoreBreakdown(slow,true))>finalScore(scoreBreakdown(fast,true)),'50 seconds of speed is worth less than one full hull contribution');
  const max=createGame();for(let i=0;i<5;i++)credit(max,'aircraft',i,1);for(let i=0;i<4;i++)credit(max,'ship',i,1);
  assert.equal(finalScore(scoreBreakdown(max,true)),35000);
});

test('fractions accumulate without per-hit rounding and final negative scores are retained',()=>{
  const state=createGame();credit(state,'aircraft',0,.0005);credit(state,'aircraft',1,.0005);
  close(scoreBreakdown(state).totalBeforeRounding,.5);assert.equal(finalScore(scoreBreakdown(state)),1);
  state.stats.friendlyDamage=12;state.stats.friendlyKills=1;assert.equal(finalScore(scoreBreakdown(state)),-1619);
  const penalty=createGame();penalty.stats.friendlyDamage=12;penalty.stats.friendlyKills=1;assert.equal(finalScore(scoreBreakdown(penalty)),-1620);
});

test('HP subtraction precision preserves true half-point totals without promoting a below-half score',()=>{
  for(const [kind,index,damage]of [['aircraft',0,.08],['ship',1,.6]] as const){
    const state=createGame(),target=kind==='aircraft'?state.enemies[index]:state.ships[index];
    target.health-=damage;recordTargetDamage(state.scoring,target,damage,true);
    assert.equal(state.scoring.targets.find(t=>t.id===target.id)!.playerDamage,damage);
    assert.equal(scoreBreakdown(state).totalBeforeRounding,.5);assert.equal(finalScore(scoreBreakdown(state)),1);
    recordTargetDamage(state.scoring,target,damage,true);assert.equal(scoreBreakdown(state).totalBeforeRounding,.5);
  }
  const below=createGame(),enemy=below.enemies[0],damage=.079999999999;
  enemy.health-=damage;recordTargetDamage(below.scoring,enemy,damage,true);
  assert.ok(scoreBreakdown(below).totalBeforeRounding<.5);assert.equal(finalScore(scoreBreakdown(below)),0);
  const mixed=createGame();credit(mixed,'aircraft',0,.04/80);credit(mixed,'ship',1,.3/2400);
  assert.equal(scoreBreakdown(mixed).totalBeforeRounding,.5);assert.equal(finalScore(scoreBreakdown(mixed)),1);
  const negative=createGame();credit(negative,'aircraft',0,.08/80);negative.stats.friendlyDamage=.2;
  assert.equal(scoreBreakdown(negative).totalBeforeRounding,-1.5);assert.equal(finalScore(scoreBreakdown(negative)),-1);
});

test('real shots credit initial aircraft, preserve own damage after ally kill, and cannot duplicate the kill',()=>{
  for(const mode of ['easy','normal'] as const){
    const state=quiet(mode),enemy=targetPlane(state);
    hitPlane(state,20);close(enemy.health,60);close(state.stats.score,125);
    hitPlane(state,10000,state.allies[0].id);assert.equal(enemy.health,0);assert.equal(state.stats.allyAircraftKills,1);close(state.stats.score,125);
    stepGame(state,neutral);close(state.stats.score,125);assert.equal(state.stats.allyAircraftKills,1);
  }
});

test('real bomb hull damage uses each ship initial HP and ally finishing damage cannot consume player credit',()=>{
  for(const hpIndex of [0,1]){
    const state=quiet(),ship=state.ships[hpIndex];state.ships[0].health=hpIndex===0?4000:0;
    ship.health=ship.maxHealth;ship.position.set(0,0,0);ship.previous.copy(ship.position);ship.velocity.set(0,0,0);ship.yaw=0;ship.quaternion.identity();ship.previousQuaternion.identity();ship.guns.forEach(g=>g.health=0);
    const bomb=(owner:number,damage:number)=>{const b=releaseBomb(9900,state.player)!;b.owner=owner;b.damage=damage;b.age=1;b.position.set(10,10,0);b.previous.copy(b.position);b.velocity.set(0,-500,0);return b;};
    state.ordnance.push(bomb(1,1800));stepGame(state,neutral);close(scoreBreakdown(state).ships,1800/ship.maxHealth*2000);
    const last=bomb(state.allies[0].id,10000);state.ordnance.push(last,last);stepGame(state,neutral);
    assert.equal(ship.health,0);assert.equal(state.stats.allyShipKills,1);close(state.result!.scoreBreakdown.ships,1800/ship.maxHealth*2000);
    assert.equal(state.result!.scoreBreakdown.aircraft,0);
  }
});

test('reinforcement damage and kill earn no points, while real healing never restores the damage bonus',()=>{
  const state=quiet();state.player.position.set(1000,1000,1000);state.player.previous.copy(state.player.position);
  state.bullets.push(shot(44,'enemy',state.player.position.clone().add(new Vector3(0,0,60)),40));stepGame(state,neutral);
  close(state.stats.damageTaken,40);close(state.player.health,40);
  const enemy=targetPlane(state);enemy.id=8888;enemy.generation='reinforcement';hitPlane(state,10000);
  assert.equal(state.player.health,55);close(state.stats.damageTaken,40);assert.equal(state.stats.score,0);
  assert.ok(state.events.some(e=>e.type==='heal'&&e.amount===15));state.ships[0].health=0;stepGame(state,neutral);
  assert.equal(state.result!.scoreBreakdown.damageAvoidance,250);assert.equal(state.result!.scoreBreakdown.aircraft,0);
});

test('armed torpedoes and water near misses earn only their actual armored hull fraction',()=>{
  for(const weapon of ['torpedo','blast'] as const){
    const state=quiet(),ship=state.ships[0];ship.position.set(0,0,0);ship.previous.copy(ship.position);ship.velocity.set(0,0,0);
    ship.yaw=0;ship.quaternion.identity();ship.previousQuaternion.identity();
    const round=releaseBomb(9901,state.player)!;round.age=1;
    if(weapon==='torpedo'){
      round.kind='torpedo';round.phase='water';round.waterDistance=80;round.damage=2000;round.life=70;
      round.position.set(-CAPITAL_SHIP.width/2-1,-1.5,0);round.velocity.set(24,0,0);
    }else{
      const x=CAPITAL_SHIP.width/2+10;round.position.set(x,oceanHeight(x,0,state.elapsed)+.05,0);round.velocity.set(0,-100,0);
    }
    round.previous.copy(round.position);state.ordnance.push(round);
    for(let i=0;i<10&&state.ordnance.length;i++)stepGame(state,neutral);
    const actual=ship.maxHealth-ship.health;
    if(weapon==='torpedo')assert.equal(actual,2000);else assert.ok(actual>200&&actual<260);
    close(state.stats.score,2000*actual/4000);
    const points=state.stats.score;stepGame(state,neutral);close(state.stats.score,points);
  }
});

test('ramming and sea contact give no extra contribution, but earlier weapon damage survives defeat',()=>{
  const state=quiet(),enemy=targetPlane(state);hitPlane(state,20);
  state.player.position.copy(enemy.position);state.player.previous.copy(state.player.position);stepGame(state,neutral);
  assert.equal(state.result?.outcome,'defeat');assert.equal(state.stats.playerAircraftKills,1);assert.equal(state.result?.score,125);
  assert.equal(state.result?.scoreBreakdown.clear,0);
  const sea=quiet();targetPlane(sea);hitPlane(sea,80);sea.player.position.y=0;sea.player.previous.copy(sea.player.position);stepGame(sea,neutral);
  assert.equal(sea.deathCause,'sea');assert.equal(sea.result?.score,500);
});

test('simultaneous final kill and death retains contribution without awarding victory bonuses',()=>{
  const state=quiet(),enemy=targetPlane(state);state.ships[0].health=0;
  state.bullets.push(shot(1,'friendly',new Vector3(0,1000,60),10000));
  state.bullets.push(shot(enemy.id,'enemy',state.player.position.clone().add(new Vector3(0,0,60)),10000,'aa'));
  stepGame(state,neutral);assert.equal(state.result?.outcome,'defeat');assert.equal(state.result?.score,500);
  assert.equal(state.result?.scoreBreakdown.clear,0);assert.equal(state.result?.scoreBreakdown.speed,0);assert.equal(state.result?.scoreBreakdown.damageAvoidance,0);
  assert.equal(state.deathCause,'naval-fire');close(state.stats.damageTaken,80);
});

test('pause, repeated end inputs and replay preserve one frozen result with mode and scoring revision',()=>{
  for(const mode of ['easy','normal'] as const){
    const state=quiet(mode);targetPlane(state);hitPlane(state,20);pauseGame(state);
    const paused=JSON.stringify(state);stepGame(state,{...neutral,fire:true},.25);assert.equal(JSON.stringify(state),paused);resumeGame(state);
    state.player.position.y=0;state.player.previous.copy(state.player.position);stepGame(state,neutral);
    const result=state.result!;assert.equal(result.mode,mode);assert.equal(result.rulesVersion,RULES_VERSION);assert.equal(result.scoreRulesVersion,SCORE_RULES_VERSION);
    assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.scoreBreakdown));
    const ended=JSON.stringify(state);for(let n=0;n<3;n++){startGame(state);resumeGame(state);stepGame(state,{...neutral,fire:true},FIXED_DT);}
    assert.equal(JSON.stringify(state),ended);assert.equal(state.result,result);assert.equal(result.score,125);
    const replay=createGame(73,mode);assert.equal(replay.stats.score,0);assert.equal(replay.result,null);assert.ok(replay.scoring.targets.every(t=>t.playerDamage===0));
  }
});
