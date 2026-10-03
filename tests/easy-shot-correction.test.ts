import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { applyEasyShotCorrection, predictedShotDirection } from '../src/flight-assist';
import { makeAircraft } from '../src/mission';
import { updateQuaternion } from '../src/flight';
import { createGame, startGame, stepGame } from '../src/simulation';

test('shared Easy projectile correction is 25 percent capped at .02 radians with original .16 gate',()=>{
  const forward=new Vector3(0,0,-1);
  for(const a of [0,.004,.04,.079,.08,.1,.159,.161,.5]) {
    const prediction=forward.clone().applyAxisAngle(new Vector3(0,1,0),a),before=prediction.toArray();
    const actual=applyEasyShotCorrection(forward,prediction);
    const expected=a>.16?0:Math.min(a*.25,.02);
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
  assert.ok(Math.abs(forward.angleTo(playerDirection)-.02)<1e-10);
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
