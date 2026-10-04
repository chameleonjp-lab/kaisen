import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { applyEasyShotCorrection, predictedShotDirection } from '../src/flight-assist';
import { makeAircraft } from '../src/mission';
import { updateQuaternion } from '../src/flight';
import { createGame, startGame, stepGame } from '../src/simulation';

test('Kaisen Easy projectile correction is 35 percent capped at .028 radians with original .16 gate',()=>{
  const forward=new Vector3(0,0,-1);
  for(const a of [0,.004,.04,.079,.08,.1,.159,.160001,.161,.5]) {
    const prediction=forward.clone().applyAxisAngle(new Vector3(0,1,0),a),before=prediction.toArray();
    const actual=applyEasyShotCorrection(forward,prediction);
    const expected=a>.16?0:Math.min(a*.35,.028);
    assert.ok(Math.abs(actual.angleTo(forward)-expected)<1e-7,`${a}: ${actual.angleTo(forward)} vs ${expected}`);
    assert.deepEqual(prediction.toArray(),before);assert.deepEqual(forward.toArray(),[0,0,-1]);
    assert.ok(Math.abs(actual.length()-1)<1e-12);
  }
});
test('AI retains its original full straight-intercept solution',()=>{
  const plane=makeAircraft(10,'enemy',new Vector3(0,500,-650));plane.yaw=-Math.PI/2;updateQuaternion(plane);
  const origin=new Vector3(0,500,0),forward=new Vector3(0,0,-1);
  const predicted=predictedShotDirection(origin,forward,plane,930,1.5);
  assert.ok(forward.angleTo(predicted)>.1);
  const playerDirection=applyEasyShotCorrection(forward,predicted);
  assert.ok(Math.abs(forward.angleTo(playerDirection)-.028)<1e-10);
});

test('a fixed manual turn then release produces real hits in an independent airborne encounter',()=>{
  const s=createGame(73,'easy');s.player.position.set(0,1500,0);s.player.previous.copy(s.player.position);
  for(const p of [...s.allies,...s.enemies.slice(1)])p.health=0;
  for(const ship of s.ships){ship.position.set(10000,0,-10000);ship.previous.copy(ship.position);}
  const enemy=s.enemies[0];enemy.position.set(90,1500,-450);enemy.previous.copy(enemy.position);
  enemy.yaw=0;updateQuaternion(enemy);startGame(s);
  let hits=0;
  // A defined isolated air encounter, not the default mission or an iPhone test.
  // The input sequence never reads a target/physics value after Start.
  for(let tick=0;tick<240&&s.phase==='playing';tick++) {
    stepGame(s,{turn:tick<20?.6:0,climb:0,fire:false,loop:false,viewAspect:393/852});
    hits+=s.events.filter(e=>e.type==='hit'&&e.owner===s.player.id&&e.target===enemy.id).length;
  }
  assert.ok(hits>0);assert.ok(enemy.health<enemy.maxHealth);assert.ok(s.player.health>0);
});

test('the stronger correction preserves most of the aiming error and never reaches a wide-angle target',()=>{
  const rotation = new Vector3(1,2,3).normalize();
  const forward = new Vector3(0,0,-1).applyAxisAngle(rotation,1.1);
  const axis = new Vector3().crossVectors(forward,new Vector3(0,1,0)).normalize();
  for(const angle of [.01,.04,.08,.12,.159]) {
    const prediction = forward.clone().applyAxisAngle(axis,angle);
    const corrected = applyEasyShotCorrection(forward,prediction);
    const residual = corrected.angleTo(prediction);
    assert.ok(residual >= angle*.65-1e-10, 'the pilot still supplies at least 65% of the lead');
    assert.ok(residual < angle-Math.min(angle*.25,.02), 'inside the gate, the residual error is smaller than the previous correction');
    assert.ok(corrected.angleTo(forward) <= .0280000001, 'launch remains inside the bounded bore cone');
  }
  const outside = forward.clone().applyAxisAngle(axis,.17);
  assert.deepEqual(applyEasyShotCorrection(forward,outside).toArray(),forward.toArray());
});

test('a nearby fixed-input airborne pass gains a real hit while an unaligned pass still misses',()=>{
  for(const [width,height,expectedHits] of [[393,852,2],[852,393,0]]) {
    const s=createGame(73,'easy');s.player.position.set(0,1500,0);s.player.previous.copy(s.player.position);
    for(const p of [...s.allies,...s.enemies.slice(1)])p.health=0;
    for(const ship of s.ships){ship.position.set(10000,0,-10000);ship.previous.copy(ship.position);}
    const enemy=s.enemies[0];enemy.position.set(60,1500,-450);enemy.previous.copy(enemy.position);
    enemy.yaw=0;updateQuaternion(enemy);startGame(s);
    let hits=0;
    // The same predeclared turn/release input is used for both screen aspects.
    for(let tick=0;tick<240&&s.phase==='playing';tick++) {
      stepGame(s,{turn:tick<20?.6:0,climb:0,fire:false,loop:false,viewAspect:width/height});
      hits+=s.events.filter(e=>e.type==='hit'&&e.owner===s.player.id&&e.target===enemy.id).length;
    }
    assert.equal(hits,expectedHits);
    assert.equal(s.stats.playerAircraftKills,0);
    assert.ok(s.player.health>0);
  }
});
