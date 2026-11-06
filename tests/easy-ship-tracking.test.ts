import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, startGame, stepGame } from '../src/simulation';
import { getFlightAssist, targetAimPoint } from '../src/flight-assist';
import { updateQuaternion } from '../src/flight';
import { getFlightCameraPose, projectFlightTarget, FLIGHT_FOV } from '../src/flight-view';
import { Quaternion, Vector3 } from 'three';
const neutral={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};

test('Easy begins 80m higher with coherent formation poses; Normal retains its entry',()=>{
 for(const mode of ['easy','normal'] as const)for(const shipCount of [3,4,5,7] as const){
  const s=createGame(73,{mode,shipCount}),altitude=mode==='easy'?300:220;
  assert.deepEqual(s.player.position.toArray(),[0,altitude,240]);
  for(const [i,p] of [s.player,...s.allies].entries()){
   assert.equal(p.position.y,altitude+(i? (i-1)*13:0));
   assert.deepEqual(p.previous,p.position);assert.deepEqual(p.aiWaypoint,p.position);
  }
 }
});

test('aircraft and ships cannot add any Easy steering or response gain',()=>{
 for(const aspect of [393/852,393/648,852/393])for(const bank of [-.72,0,.72])for(const x of [-120,120]){
  const s=createGame(73,'easy'),ship=s.ships[0],air=s.enemies[0];
  s.player.position.set(0,300,0);s.player.bank=bank;updateQuaternion(s.player);
  ship.position.set(x,0,-900);air.position.copy(targetAimPoint(ship));
  for(const targets of [[air],[ship],[air,ship],[]])assert.deepEqual(getFlightAssist(s.player,targets,{...neutral,viewAspect:aspect},'easy'),
    {turn:0,climb:0,responseMultiplier:1,hasVisibleTarget:false});
 }
});

test('manual commands keep authority over ship pull and Normal stays fully manual',()=>{
 const s=createGame(73,'easy'),ship=s.ships[0];
 ship.position.set(100,0,-600);
 for(const mode of ['easy','normal'] as const)for(const input of [{...neutral,turn:.6,climb:.4},{...neutral,turn:-.6,climb:-.4}]){
  const a=getFlightAssist(s.player,[ship],input,mode);
  assert.equal(a.turn,input.turn);assert.equal(a.climb,input.climb);
 }
 const up=getFlightAssist(s.player,[ship],{...neutral,climb:.2},'easy');
 assert.equal(up.climb,.2,'small upward command defeats the downward ship correction');
 const left=getFlightAssist(s.player,[ship],{...neutral,turn:-.2},'easy');
 assert.equal(left.turn,-.2,'small opposite turn is not scaled or resisted');
});

test('mixed target selection respects circle priority while retaining each target tracking strength',()=>{
 const s=createGame(73,'easy'),ship=s.ships[0],air=s.enemies[0];
 ship.position.set(80,0,-400);air.position.set(-80,300,-900);
 assert.deepEqual(getFlightAssist(s.player,[air,ship],neutral,'easy'),getFlightAssist(s.player,[air],neutral,'easy'));
 ship.position.z=-1000;air.position.set(-80,300,-350);
 assert.deepEqual(getFlightAssist(s.player,[air,ship],neutral,'easy'),getFlightAssist(s.player,[air],neutral,'easy'));
 air.health=0;
 assert.deepEqual(getFlightAssist(s.player,[air,ship],neutral,'easy'),getFlightAssist(s.player,[ship],neutral,'easy'));
});

test('the real Easy opening keeps level cruise without target steering',()=>{
 for(const seed of [1,73,0x4b414953])for(const aspect of [393/852,393/648,852/393]){
  const s=createGame(seed,'easy');startGame(s);let minAltitude=300,minPitch=0;
  const cameraPosition=new Vector3(),cameraRotation=new Quaternion();
  assert.ok(projectFlightTarget(s.player,targetAimPoint(s.ships[0]),aspect,'easy').visible);
  for(let i=0;i<360;i++){
   stepGame(s,{...neutral,viewAspect:aspect});minAltitude=Math.min(minAltitude,s.player.position.y);minPitch=Math.min(minPitch,s.player.pitch);
   getFlightCameraPose(s.player,'easy',cameraPosition,cameraRotation);
   assert.ok(cameraPosition.toArray().every(Number.isFinite));
  }
  assert.equal(s.phase,'playing');assert.ok(minAltitude>250);assert.ok(minPitch>-.22,'less than 12.6 degrees automatic nose-down');
 }
});
