import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, startGame, stepGame } from '../src/simulation';
import { getFlightAssist, targetAimPoint, EASY_SHIP_TRACKING_STRENGTH, EASY_SHOT_CORRECTION_STRENGTH, EASY_SHOT_MAX_ANGLE } from '../src/flight-assist';
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

test('only the ship correction is quarter-strength at identical target geometry',()=>{
 for(const aspect of [393/852,393/648,852/393])for(const bank of [-.72,0,.72])for(const x of [-120,120]){
  const s=createGame(73,'easy'),ship=s.ships[0],air=s.enemies[0];
  s.player.position.set(0,300,0);s.player.bank=bank;updateQuaternion(s.player);
  ship.position.set(x,0,-900);air.position.copy(targetAimPoint(ship));
  const input={...neutral,viewAspect:aspect};
  const full=getFlightAssist(s.player,[air],input,'easy'),gentle=getFlightAssist(s.player,[ship],input,'easy');
  assert.ok(full.hasVisibleTarget&&gentle.hasVisibleTarget);
  assert.ok(Math.abs(gentle.turn-full.turn*.25)<1e-12);
  assert.ok(Math.abs(gentle.climb-full.climb*.25)<1e-12);
  assert.equal(gentle.responseMultiplier,full.responseMultiplier);
 }
 assert.equal(EASY_SHIP_TRACKING_STRENGTH,.25);
 assert.equal(EASY_SHOT_CORRECTION_STRENGTH,.35);assert.equal(EASY_SHOT_MAX_ANGLE,.028);
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

test('mixed target selection still follows the closest visible target regardless of its assist strength',()=>{
 const s=createGame(73,'easy'),ship=s.ships[0],air=s.enemies[0];
 ship.position.set(80,0,-400);air.position.set(-80,300,-900);
 assert.deepEqual(getFlightAssist(s.player,[air,ship],neutral,'easy'),getFlightAssist(s.player,[ship],neutral,'easy'));
 ship.position.z=-1000;air.position.set(-80,300,-350);
 assert.deepEqual(getFlightAssist(s.player,[air,ship],neutral,'easy'),getFlightAssist(s.player,[air],neutral,'easy'));
 air.health=0;
 assert.deepEqual(getFlightAssist(s.player,[air,ship],neutral,'easy'),getFlightAssist(s.player,[ship],neutral,'easy'));
});

test('air-to-ship switching keeps the existing smooth response and manual climb clears residual pull',()=>{
 const s=createGame(73,'easy');s.player.position.set(0,1000,0);s.player.previous.copy(s.player.position);
 for(const t of [...s.allies,...s.enemies,...s.ships])t.health=0;
 const air=s.enemies[0],ship=s.ships[0];air.health=80;
 const cameraPosition=new Vector3(),cameraRotation=new Quaternion();
 const point=(x:number,y:number)=>{
  getFlightCameraPose(s.player,'easy',cameraPosition,cameraRotation);
  const scale=500*Math.tan(FLIGHT_FOV*Math.PI/360);
  return new Vector3(x*scale*neutral.viewAspect,y*scale,-500).applyQuaternion(cameraRotation).add(cameraPosition);
 };
 startGame(s);
 for(let i=0;i<30;i++){air.position.copy(point(.65,-.45));air.previous.copy(air.position);stepGame(s,neutral);}
 const before=s.player.pitch;assert.ok(before<-.1,'aircraft correction has built up');
 air.health=0;ship.health=ship.maxHealth;
 ship.position.copy(point(-.65,.45)).add(new Vector3(0,-ship.height*.4,0));ship.previous.copy(ship.position);
 for(const gun of ship.guns)gun.health=0;
 stepGame(s,neutral);
 assert.ok(Math.abs(s.player.pitch-before)<.05,'target switch must not snap the camera/aircraft');
 for(const climb of [.2,.6]){
  const prior=s.player.pitch,expected=prior+(climb*.95-prior)*(1-Math.exp(-4.2/60));
  stepGame(s,{...neutral,climb});assert.ok(Math.abs(s.player.pitch-expected)<1e-12,'manual climb owns the command even with prior downward residue');
 }
 // Rebuild actual ship assistance after the manual reset, then lose that target.
 for(let i=0;i<30;i++){
  ship.position.copy(point(.65,-.45)).add(new Vector3(0,-ship.height*.4,0));ship.previous.copy(ship.position);
  stepGame(s,neutral);
 }
 assert.ok(s.player.pitch<-.02);
 ship.position.set(10000,0,-10000);ship.previous.copy(ship.position);
 const prior=s.player.pitch,withoutResidue=prior+(0-prior)*(1-Math.exp(-4.2/60));
 stepGame(s,neutral);assert.ok(Number.isFinite(s.player.pitch));assert.ok(Math.abs(s.player.pitch-prior)<.05);
 assert.ok(s.player.pitch<withoutResidue-1e-6,'loss slews the existing pull down instead of abruptly resetting it');
 air.health=80;air.position.copy(point(-.65,.45));air.previous.copy(air.position);
 const beforeAircraft=s.player.pitch;stepGame(s,neutral);
 assert.ok(Math.abs(s.player.pitch-beforeAircraft)<.05,'reacquiring an aircraft also preserves smooth response');
});

test('the real Easy opening no longer dives steeply into the foreground hull without input',()=>{
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
