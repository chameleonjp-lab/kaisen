import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createGame, startGame, stepGame, pauseGame, resumeGame } from '../src/simulation';
import { recordTargetDamage, registerAircraftForScoring, scoreBreakdown, finalScore, SCORE_RULES_VERSION } from '../src/scoring';
import { RULES_VERSION, FIXED_DT, REINFORCEMENT_TICK } from '../src/mission';
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

  const allyFirst=createGame(),shared=allyFirst.enemies[0];
  shared.health=40;recordTargetDamage(allyFirst.scoring,shared,40,false);
  shared.health=20;recordTargetDamage(allyFirst.scoring,shared,20,true);
  shared.health=0;recordTargetDamage(allyFirst.scoring,shared,20,false);
  close(scoreBreakdown(allyFirst).aircraft,125,'player damage after an ally has already reduced HP uses the original airframe HP');
});

test('approved contribution examples keep failure points and combine clear, speed and cumulative damage',()=>{
  const failed=createGame();for(let i=0;i<3;i++)credit(failed,'aircraft',i,1);
  failed.elapsed=90;assert.equal(finalScore(scoreBreakdown(failed)),1500);
  const state=createGame();credit(state,'aircraft',0,1);credit(state,'aircraft',1,1);credit(state,'aircraft',2,.8);
  credit(state,'ship',0,1);credit(state,'ship',1,1);credit(state,'ship',2,.5);
  state.elapsed=180;state.stats.damageTaken=40;
  assert.deepEqual(scoreBreakdown(state,true),{aircraft:1400,ships:5000,aircraftKillBonus:0,shipKillBonus:0,mountDestroyBonus:0,
    clear:12000,speed:8400,damageAvoidance:250,friendlyDamagePenalty:-0,friendlyKillPenalty:-0,totalBeforeRounding:27050});
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

test('spawned reinforcement damage and weapon kill score once, while healing never restores damage avoidance',()=>{
  const state=quiet();state.player.position.set(1000,1000,1000);state.player.previous.copy(state.player.position);
  state.bullets.push(shot(44,'enemy',state.player.position.clone().add(new Vector3(0,0,60)),40));stepGame(state,neutral);
  close(state.stats.damageTaken,40);close(state.player.health,40);
  state.tick=REINFORCEMENT_TICK-1;state.elapsed=state.tick*FIXED_DT;stepGame(state,neutral);
  const enemy=state.enemies[0];assert.equal(enemy.generation,'reinforcement');
  enemy.health=enemy.maxHealth;enemy.position.set(0,1000,0);enemy.previous.copy(enemy.position);
  hitPlane(state,20);close(enemy.health,60);close(state.stats.score,125);
  hitPlane(state,10000);assert.equal(enemy.health,0);assert.equal(state.stats.playerAircraftKills,1);close(state.stats.score,600);
  assert.equal(state.player.health,55);close(state.stats.damageTaken,40);
  assert.ok(state.events.some(e=>e.type==='heal'&&e.amount===15));state.ships[0].health=0;stepGame(state,neutral);
  for(const target of state.enemies)target.health=0;
  stepGame(state,neutral);
  assert.equal(state.result!.scoreBreakdown.damageAvoidance,250);assert.equal(state.result!.scoreBreakdown.aircraft,500);
  assert.equal(state.result!.scoreBreakdown.aircraftKillBonus,100);
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
  assert.equal(sea.deathCause,'sea');assert.equal(sea.result?.score,600);assert.equal(sea.result?.scoreBreakdown.aircraftKillBonus,100);
});

test('a lethal round resolved first still preserves the later fired aircraft kill bonus on defeat',()=>{
  const state=quiet(),enemy=targetPlane(state);state.ships[0].health=0;
  state.bullets.push(shot(enemy.id,'enemy',state.player.position.clone().add(new Vector3(0,0,60)),10000,'aa'));
  // The lethal enemy round resolves first; the player's already-fired shot still resolves afterward.
  state.bullets.push(shot(1,'friendly',new Vector3(0,1000,60),10000));
  stepGame(state,neutral);assert.equal(state.result?.outcome,'defeat');assert.equal(state.result?.score,600);
  assert.equal(state.result?.scoreBreakdown.aircraftKillBonus,100);
  assert.equal(state.result?.scoreBreakdown.clear,0);assert.equal(state.result?.scoreBreakdown.speed,0);assert.equal(state.result?.scoreBreakdown.damageAvoidance,0);
  assert.equal(state.deathCause,'naval-fire');close(state.stats.damageTaken,80);
  const frozen=JSON.stringify(state);stepGame(state,neutral);assert.equal(JSON.stringify(state),frozen,'the terminal score and bonus remain frozen after a simultaneous defeat');
});

test('pause, repeated end inputs and replay preserve one frozen result with mode and scoring revision',()=>{
  for(const mode of ['easy','normal'] as const){
    const state=quiet(mode);targetPlane(state);hitPlane(state,10000);pauseGame(state);
    const paused=JSON.stringify(state);stepGame(state,{...neutral,fire:true},.25);assert.equal(JSON.stringify(state),paused);resumeGame(state);
    state.player.position.y=0;state.player.previous.copy(state.player.position);stepGame(state,neutral);
    const result=state.result!;assert.equal(result.mode,mode);assert.equal(result.rulesVersion,RULES_VERSION);assert.equal(result.scoreRulesVersion,SCORE_RULES_VERSION);
    assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.scoreBreakdown));
    const ended=JSON.stringify(state);for(let n=0;n<3;n++){startGame(state);resumeGame(state);stepGame(state,{...neutral,fire:true},FIXED_DT);}
    assert.equal(JSON.stringify(state),ended);assert.equal(state.result,result);assert.equal(result.score,600);
    assert.equal(result.scoreBreakdown.aircraftKillBonus,100);
    const replay=createGame(73,mode);assert.equal(replay.stats.score,0);assert.equal(replay.result,null);
    assert.equal(replay.scoring.aircraftKillBonus,0);assert.equal(replay.scoring.shipKillBonus,0);assert.equal(replay.scoring.mountDestroyBonus,0);
    assert.ok(replay.scoring.targets.every(t=>t.playerDamage===0));
  }
});

test('approved clear examples commit through the fixed-step result path in both modes',()=>{
  const cases=[
    {mode:'easy' as const,friendlyDamage:0,friendlyKills:0,expected:27050},
    {mode:'normal' as const,friendlyDamage:0,friendlyKills:0,expected:27050},
    {mode:'normal' as const,friendlyDamage:20,friendlyKills:1,expected:25350},
  ];
  for(const example of cases){
    const state=quiet(example.mode);
    for(const target of [...state.enemies,...state.ships])target.health=target.maxHealth;
    credit(state,'aircraft',0,1);credit(state,'aircraft',1,1);credit(state,'aircraft',2,.8);
    credit(state,'ship',0,1);credit(state,'ship',1,1);credit(state,'ship',2,.5);
    state.stats.damageTaken=40;state.stats.friendlyDamage=example.friendlyDamage;state.stats.friendlyKills=example.friendlyKills;
    for(const target of [...state.enemies,...state.ships])target.health=0;
    state.tick=180*60-1;state.elapsed=state.tick*FIXED_DT;
    stepGame(state,neutral,FIXED_DT);
    assert.equal(state.endReason,'all-clear');assert.equal(state.result?.outcome,'victory');assert.equal(state.result?.time,180);
    assert.deepEqual(state.result?.scoreBreakdown,{aircraft:1400,ships:5000,aircraftKillBonus:0,shipKillBonus:0,mountDestroyBonus:0,clear:12000,speed:8400,damageAvoidance:250,
      friendlyDamagePenalty:-example.friendlyDamage*10,friendlyKillPenalty:-example.friendlyKills*1500,
      totalBeforeRounding:example.expected});
    assert.equal(state.stats.score,example.expected);assert.equal(state.result?.score,example.expected);
    assert.ok(Object.isFrozen(state.result)&&Object.isFrozen(state.result?.scoreBreakdown));
  }
});

test('a surviving mission remains active with its score at 599.9833, 600, and 600.0167 seconds',()=>{
  const state=quiet('normal');
  const target=targetPlane(state);
  target.position.set(30000,1200,-30000);target.previous.copy(target.position);target.speed=0;target.aiFire=false;
  for(const [index,enemy]of state.enemies.entries()){
    if(enemy===target)continue;
    enemy.health=enemy.maxHealth;enemy.position.set(32000+index*1000,1200,-32000);enemy.previous.copy(enemy.position);enemy.speed=0;enemy.aiFire=false;
  }
  credit(state,'aircraft',0,.25);
  state.tick=35998;state.elapsed=state.tick*FIXED_DT;
  for(const [expectedTick,expectedTime]of [[35999,599.9833333333333],[36000,600],[36001,600.0166666666667]] as const){
    stepGame(state,neutral,FIXED_DT);
    assert.equal(state.tick,expectedTick);close(state.elapsed,expectedTime);
    assert.equal(state.phase,'playing');assert.equal(state.endReason,null);assert.equal(state.result,null);
    assert.ok(state.enemies.some(enemy=>enemy.health>0),'the mission still has living enemy aircraft');
    close(state.stats.score,125);
  }
});

test('all-clear still commits at and beyond 600 seconds with the fixed no-speed-bonus total',()=>{
  const cases=[
    {mode:'easy' as const,startTick:35999,expectedTime:600},
    {mode:'normal' as const,startTick:36000,expectedTime:600+FIXED_DT},
  ];
  for(const example of cases){
    const state=quiet(example.mode);
    for(const target of [...state.enemies,...state.ships])target.health=target.maxHealth;
    credit(state,'aircraft',0,.5);credit(state,'ship',0,.25);state.stats.damageTaken=20;
    for(const target of [...state.enemies,...state.ships])target.health=0;
    state.tick=example.startTick;state.elapsed=state.tick*FIXED_DT;
    stepGame(state,neutral,FIXED_DT);
    assert.equal(state.endReason,'all-clear');assert.equal(state.result?.outcome,'victory');close(state.result!.time,example.expectedTime);
    assert.deepEqual(state.result?.scoreBreakdown,{aircraft:250,ships:500,aircraftKillBonus:0,shipKillBonus:0,mountDestroyBonus:0,clear:12000,speed:0,damageAvoidance:375,
      friendlyDamagePenalty:-0,friendlyKillPenalty:-0,totalBeforeRounding:13125});
    assert.equal(state.result?.score,13125);assert.equal(state.stats.score,13125);
  }
});

test('a lethal enemy round does not cancel final-tick damage or friendly kill before freezing a Normal defeat score',()=>{
  const state=quiet('normal'),enemy=targetPlane(state),ally=state.allies[0];
  enemy.position.set(0,1000,0);enemy.previous.copy(enemy.position);enemy.aiFire=false;
  credit(state,'aircraft',0,.0005); // 0.04 HP = 0.25 points before the terminal tick.
  ally.health=.2;ally.position.set(10000,1000,10000);ally.previous.copy(ally.position);
  const ownShot=shot(state.player.id,'friendly',enemy.position.clone().add(new Vector3(0,0,60)),.04,'mg');ownShot.id=91001;
  const friendlyShot=shot(state.player.id,'friendly',ally.position.clone().add(new Vector3(0,0,60)),.2,'mg');friendlyShot.id=91002;
  const lethalRound=shot(90000,'enemy',state.player.position.clone().add(new Vector3(0,0,60)),100,'mg');lethalRound.id=91003;
  const pendingRound=shot(state.player.id,'friendly',new Vector3(90000,1000,90000),.1,'mg');pendingRound.id=91004;
  pendingRound.velocity.set(0,0,0);pendingRound.life=1;
  state.bullets.push(lethalRound,ownShot,friendlyShot,pendingRound);
  state.player.health=1;
  stepGame(state,neutral,FIXED_DT);

  assert.equal(state.endReason,'shot-down');assert.equal(state.deathCause,'enemy-aircraft');assert.equal(state.result?.outcome,'defeat');
  assert.equal(state.stats.friendlyDamage,.2);assert.equal(state.stats.friendlyKills,1);
  assert.equal(state.result?.scoreBreakdown.aircraft,.5);assert.equal(state.result?.scoreBreakdown.clear,0);
  assert.equal(state.result?.scoreBreakdown.speed,0);assert.equal(state.result?.scoreBreakdown.damageAvoidance,0);
  assert.equal(state.result?.scoreBreakdown.friendlyDamagePenalty,-2);assert.equal(state.result?.scoreBreakdown.friendlyKillPenalty,-1500);
  close(state.result!.scoreBreakdown.totalBeforeRounding,-1501.5);assert.equal(state.result?.score,-1501);assert.equal(state.stats.score,-1501);
  assert.equal(state.bullets.length,1,'the other fired round survives the terminal tick');assert.equal(state.bullets[0].id,91004);
  const result=state.result,ended=JSON.stringify(state),remainingLife=state.bullets[0].life;
  stepGame(state,{...neutral,fire:true},FIXED_DT);
  assert.equal(state.result,result);assert.equal(state.bullets[0].life,remainingLife);assert.equal(JSON.stringify(state),ended);
});

test('the fifth own kill scores across the initial/reinforcement boundary, then blocks a sixth in the same tick',()=>{
  const state=quiet(),fifth=targetPlane(state);
  for(const enemy of state.enemies.slice(1)){enemy.health=0;enemy.aiFire=false;}
  fifth.aiFire=false;
  state.tick=REINFORCEMENT_TICK-1;state.elapsed=state.tick*FIXED_DT;
  stepGame(state,neutral);
  const sixth=state.enemies[1];assert.equal(fifth.generation,'initial');assert.equal(sixth.generation,'reinforcement');
  for(const enemy of state.enemies.slice(2))enemy.health=0;
  fifth.health=80;fifth.position.set(0,1000,0);fifth.previous.copy(fifth.position);
  sixth.health=80;sixth.position.set(500,1000,0);sixth.previous.copy(sixth.position);
  state.stats.playerAircraftKills=4;
  const aimed=(target:typeof fifth,damage:number,id:number)=>{const b=shot(state.player.id,'friendly',target.position.clone().add(new Vector3(0,0,60)),damage,'mg');b.id=id;return b;};
  state.bullets.push(aimed(fifth,20,92001),aimed(fifth,60,92002),aimed(sixth,80,92003));
  stepGame(state,neutral);
  assert.equal(state.stats.playerAircraftKills,6);
  assert.equal(state.scoring.aircraftDamagePoints,500);
  assert.equal(state.result,null);
  assert.equal(scoreBreakdown(state).aircraft,500);assert.equal(scoreBreakdown(state).aircraftKillBonus,100);
  assert.equal(state.scoring.aircraftKillBonus,100,'the fifth kill gets the award; the sixth does not');
});

test('reinforcement healing continues after the fifth kill even when its damage and kill bonus are capped',()=>{
  const state=quiet();state.player.health=50;state.stats.playerAircraftKills=5;
  for(const enemy of state.enemies)enemy.health=0;
  state.tick=REINFORCEMENT_TICK-1;state.elapsed=state.tick*FIXED_DT;stepGame(state,neutral);
  const reinforcement=state.enemies[0];assert.equal(reinforcement.generation,'reinforcement');
  reinforcement.position.set(0,1000,0);reinforcement.previous.copy(reinforcement.position);reinforcement.aiFire=false;
  hitPlane(state,10000);
  assert.equal(state.stats.playerAircraftKills,6);assert.equal(state.player.health,65);
  assert.equal(state.events.filter(event=>event.type==='heal'&&event.amount===15).length,1);
  assert.equal(state.scoring.aircraftDamagePoints,0);assert.equal(state.scoring.aircraftKillBonus,0);
});

test('a collision still consumes a player aircraft kill but grants no weapon kill bonus',()=>{
  const state=quiet(),enemy=targetPlane(state);
  state.player.speed=0;enemy.speed=0;enemy.aiFire=false;
  state.player.position.copy(enemy.position);state.player.previous.copy(enemy.previous);
  stepGame(state,neutral);
  assert.equal(state.stats.playerAircraftKills,1);assert.equal(enemy.health,0);assert.equal(state.player.health,0);
  assert.equal(state.scoring.aircraftDamagePoints,0);assert.equal(state.scoring.aircraftKillBonus,0);
  assert.equal(state.result?.scoreBreakdown.aircraftKillBonus,0);
});

test('aircraft damage has one 2500-point cap across initial and registered reinforcement targets',()=>{
  const state=createGame();
  for(const target of state.enemies){target.health=0;recordTargetDamage(state.scoring,target,target.maxHealth,true,state.stats.playerAircraftKills);}
  assert.equal(state.scoring.aircraftDamagePoints,2500);
  const reinforcement={...state.enemies[0],id:9999,generation:'reinforcement' as const,health:80};
  registerAircraftForScoring(state.scoring,reinforcement);
  reinforcement.health=0;recordTargetDamage(state.scoring,reinforcement,80,true,state.stats.playerAircraftKills);
  assert.equal(state.scoring.aircraftDamagePoints,2500);
  assert.equal(scoreBreakdown(state).aircraft,2500);
  assert.equal(state.scoring.targets.length,9,'generated aircraft do not extend the fixed initial target ledger');
});

test('partial damage survives allied finishes across a replenishment wave but cannot farm past 2500',()=>{
  const state=quiet();
  const aimed=(target:typeof state.enemies[number],damage:number,id:number,owner=state.player.id)=>{
    const b=shot(owner,'friendly',target.position.clone().add(new Vector3(0,0,60)),damage,'mg');b.id=id;return b;
  };
  for(const [index,target]of state.enemies.entries()){
    target.health=80;target.position.set(index*1000,1000,0);target.previous.copy(target.position);
  }
  state.bullets.push(...state.enemies.map((target,index)=>aimed(target,79.99,94000+index)));
  stepGame(state,neutral);
  assert.ok(state.scoring.aircraftDamagePoints>2499.6&&state.scoring.aircraftDamagePoints<2500);
  state.tick=REINFORCEMENT_TICK-1;state.elapsed=state.tick*FIXED_DT;
  state.bullets.push(...state.enemies.map((target,index)=>aimed(target,10000,94100+index,state.allies[index%state.allies.length].id)));
  stepGame(state,neutral);
  assert.equal(state.stats.playerAircraftKills,0);assert.equal(state.stats.allyAircraftKills,5);
  close(state.scoring.targets.filter(target=>target.kind==='aircraft').reduce((sum,target)=>sum+target.playerDamage,0),399.95);
  assert.equal(state.enemies.filter(target=>target.generation==='reinforcement').length,5);

  for(const [index,target]of state.enemies.entries()){
    target.position.set(index*1000,1000,0);target.previous.copy(target.position);target.aiFire=false;
  }
  state.bullets.push(aimed(state.enemies[0],.05,94200),aimed(state.enemies[1],79.999,94201));
  state.bullets.push(aimed(state.enemies[0],10000,94202,state.allies[0].id),aimed(state.enemies[1],10000,94203,state.allies[1].id));
  stepGame(state,neutral);
  assert.equal(state.stats.playerAircraftKills,0);assert.equal(state.stats.allyAircraftKills,7);
  assert.equal(state.scoring.aircraftDamagePoints,2500);assert.equal(scoreBreakdown(state).aircraft,2500);
  close(state.scoring.aircraftCredits.get(state.enemies[0])!.playerDamage,.05);
  assert.equal(state.scoring.aircraftCredits.get(state.enemies[1])!.playerDamage,0,'damage after the shared cap earns no contribution');
  assert.equal(state.scoring.aircraftKillBonus,0);
});

test('new kill bonus rows freeze into the result and fresh replays start at zero',()=>{
  const state=quiet(),enemy=targetPlane(state);hitPlane(state,10000);
  assert.equal(state.scoring.aircraftKillBonus,100);
  for(const target of [...state.enemies,...state.ships])target.health=0;
  stepGame(state,neutral);
  const result=state.result!;
  assert.equal(result.scoreBreakdown.aircraftKillBonus,100);
  assert.equal(result.scoreBreakdown.shipKillBonus,0);assert.equal(result.scoreBreakdown.mountDestroyBonus,0);
  assert.ok(Object.isFrozen(result.scoreBreakdown));
  const replay=createGame(73);
  assert.equal(replay.scoring.aircraftDamagePoints,0);assert.equal(replay.scoring.aircraftKillBonus,0);
  assert.equal(replay.scoring.shipKillBonus,0);assert.equal(replay.scoring.mountDestroyBonus,0);
  assert.ok(replay.scoring.targets.every(entry=>entry.playerDamage===0));
  assert.equal(enemy.health,0);
});
