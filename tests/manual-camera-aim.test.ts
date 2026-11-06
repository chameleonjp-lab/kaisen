import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { autoFireTarget, getFlightAssist } from '../src/flight-assist';
import { createFlightController, forwardOf, updatePlayerLoop, updateQuaternion } from '../src/flight';
import { getFlightCameraPose } from '../src/flight-view';
import { createGame, startGame, pauseGame, resumeGame, stepGame } from '../src/simulation';
import type { FlightInput, GameMode } from '../src/types';
const neutral: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 402 / 874 };
function encounter(mode: GameMode, x = 0, depth = 500) {
  const state = createGame(73, mode);
  state.player.position.set(0, 1500, 0); state.player.previous.copy(state.player.position);
  for (const t of [...state.allies, ...state.enemies, ...state.ships]) t.health = 0;
  // A distant live ship prevents victory while the foreground target disappears.
  const ship=state.ships.at(-1)!;ship.health=ship.maxHealth;ship.position.set(30000,0,30000);ship.previous.copy(ship.position);
  const target = state.enemies[0]; target.health = target.maxHealth;
  const p = new Vector3(), q = new Quaternion(); getFlightCameraPose(state.player, mode, p, q);
  target.position.set(x, 0, -depth).applyQuaternion(q).add(p); target.previous.copy(target.position);
  target.yaw = -Math.PI / 2; updateQuaternion(target);
  startGame(state); return state;
}
for (const mode of ['easy', 'normal'] as const) {
  test(`${mode}: enemy layouts and target loss cannot change flight or camera`, () => {
    for (const command of [neutral, {...neutral, turn:.1, climb:.08}, {...neutral,turn:-.3,climb:0,steeringActive:true}, {...neutral,turn:.2,climb:-.2,fire:true}]) {
      let expected: unknown;
      for (const kind of ['aircraft','ship'] as const) for (const location of ['none','front','circle-edge','screen-edge','behind','crossing'] as const) {
        const s=encounter(mode, location==='circle-edge'?45:location==='screen-edge'?105:0, location==='behind'?-500:500);
        if(kind==='ship') { s.enemies[0].health=0;const ship=s.ships[0];ship.health=ship.maxHealth;ship.position.copy(s.enemies[0].position);ship.previous.copy(ship.position); }
        if(location==='none') {s.enemies[0].health=0;s.ships[0].health=0;}
        const crossingTargets=location==='crossing' ? kind==='ship' ? [s.ships[0],s.ships[1]] : [s.enemies[0],s.enemies[1]] : [];
        if(crossingTargets.length)for(const t of crossingTargets) {t.health=t.maxHealth;t.position.copy(crossingTargets[0].position);t.previous.copy(t.position);}
        const trace=[];
        for(let tick=0;tick<12;tick++) {
          for(const [index,crossing] of crossingTargets.entries()) {
            const x=(tick<6?105:-105)*(index===0?1:-1);crossing.position.x=x;
            if(tick===9)crossing.health=0;
            assert.equal(crossing.position.x,x,`${kind}: both live targets actually cross`);
            assert.equal(crossing.health>0,tick<9,`${kind}: both targets disappear at tick 9`);
          }
          stepGame(s,command);
          const p=new Vector3(),q=new Quaternion();getFlightCameraPose(s.player,mode,p,q);
          trace.push([s.player.position.toArray(),s.player.quaternion.toArray(),s.player.speed,p.toArray(),q.toArray()]);
          if(tick===5) {pauseGame(s);resumeGame(s);}
        }
        expected??=trace;assert.deepEqual(trace,expected,`${kind}/${location}`);
      }
    }
  });
  test(`${mode}: steering queries no targets and always has gain one`,()=>{
    const s=encounter(mode,105),c=createFlightController(s.player);
    const a=getFlightAssist(s.player,[...s.enemies,...s.ships],{...neutral,turn:.1},mode,c.targetLock,()=>assert.fail('steering must not query visibility'));
    assert.deepEqual(a,{turn:.1,climb:0,responseMultiplier:1,hasVisibleTarget:false});assert.equal(c.targetLock.key,null);
  });
  test(`${mode}: held neutral pitch lasts 0.2 seconds; release returns gradually`,()=>{
    const s=encounter(mode,105);s.player.pitch=20*Math.PI/180;updateQuaternion(s.player);const c=createFlightController(s.player),held={...neutral,steeringActive:true};
    for(let i=0;i<12;i++)updatePlayerLoop(s.player,c,held,held,false,1/60,110,141,1,mode);
    assert.equal(s.player.pitch,20*Math.PI/180);
    updatePlayerLoop(s.player,c,neutral,neutral,false,1/60,110,141,1,mode);
    assert.ok(s.player.pitch<20*Math.PI/180 && s.player.pitch>19*Math.PI/180);
  });
  test(`${mode}: both gun pairs launch on the bore line through target switch and trigger release`,()=>{
    const s=encounter(mode);const target=s.enemies[0];
    for(const fire of [true,false,true]) {
      s.player.fireClock=s.player.cannonClock=0;s.bullets=[];stepGame(s,{...neutral,fire});
      const rounds=s.bullets.filter(b=>b.owner===s.player.id);
      assert.equal(rounds.length,mode==='easy'||fire?4:0);
      assert.deepEqual(rounds.map(b=>b.kind), rounds.length?['mg','mg','cannon','cannon']:[]);
      for(const b of rounds)assert.ok(b.velocity.clone().normalize().distanceTo(forwardOf(s.player))<1e-12);
      target.id++;
    }
  });
}
test('Easy trigger uses current circle, aspect, range, team, life and visibility without a steering selection',()=>{
  const s=encounter('easy'),t=s.enemies[0],lock=createFlightController(s.player).targetLock;
  assert.equal(autoFireTarget(s.player,[t],'easy',402/874,lock),t);
  t.id++;assert.equal(autoFireTarget(s.player,[t],'easy',402/874,lock),t);
  assert.equal(autoFireTarget(s.player,[t],'easy',402/874,lock,()=>false),null);
  t.health=0;assert.equal(autoFireTarget(s.player,[t],'easy',402/874,lock),null);t.health=80;
  t.team='friendly';assert.equal(autoFireTarget(s.player,[t],'easy',402/874,lock),null);t.team='enemy';
  const p=new Vector3(),q=new Quaternion();getFlightCameraPose(s.player,'easy',p,q);
  for(const [x,depth,expected] of [[0,1300,false],[55,500,false],[55,500,true],[500,500,false]] as const) {
    t.position.set(x,0,-depth).applyQuaternion(q).add(p);
    const aspect=x===55&&expected?874/402:402/874;
    assert.equal(autoFireTarget(s.player,[t],'easy',aspect,lock)!==null,expected);
  }
});
