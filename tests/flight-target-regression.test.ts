import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, Quaternion } from 'three';
import { getFlightAssist, autoFireTarget } from '../src/flight-assist';
import { FLIGHT_FOV, getFlightCameraPose } from '../src/flight-view';
import { createFlightTargetLock, smoothFlightAssistance } from '../src/flight-target';

const numeric = false, callback = false;
const input = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
function player(): any { return {id:1, kind:'aircraft', team:'friendly', health:80, position:numeric?{x:0,y:300,z:0}:new Vector3(0,300,0),
  previous:new Vector3(0,300,0),quaternion:numeric?{x:0,y:0,z:0,w:1}:new Quaternion(), pitch:0,yaw:0,bank:0,speed:110,loopProgress:0,loopCooldown:0}; }
function target(p:any, id:number, x:number, y:number, depth:number, extra:any = {}): any {
  const position = new Vector3(), rotation = new Quaternion();
  if(numeric) { const c=getFlightCameraPose(p,'easy'); position.set(c.position.x,c.position.y,c.position.z);rotation.set(c.rotation.x,c.rotation.y,c.rotation.z,c.rotation.w); }
  else getFlightCameraPose(p,'easy',position,rotation);
  const tan=Math.tan(FLIGHT_FOV*Math.PI/360), point=new Vector3(x*depth*tan*input.viewAspect,y*depth*tan,-depth).applyQuaternion(rotation).add(position);
  return {id,kind:'aircraft',team:'enemy',health:80,hp:80,generation:1,identityGeneration:1,position:numeric?{x:point.x,y:point.y,z:point.z}:point,
    velocity:numeric?{x:0,y:0,z:0}:new Vector3(),quaternion:numeric?{x:0,y:0,z:0,w:1}:new Quaternion(),speed:0,aimHeight:0,...extra};
}
function assist(p:any, ts:any[], i:any=input, lock:any=createFlightTargetLock()) {
  return callback ? getFlightAssist(p,ts,i,'easy',undefined,lock) : getFlightAssist(p,ts,i,'easy',lock);
}
function fire(p:any,ts:any[],lock:any) { return callback ? autoFireTarget(p,ts,'easy',input.viewAspect,undefined,lock) : autoFireTarget(p,ts,'easy',input.viewAspect,lock); }
test('trigger selection uses current geometry, deterministic ties, and fresh identities',()=>{
  for(const reversed of [false,true]) {
    const p=player(),a=target(p,2,0,0,950),b=target(p,3,.8,.55,400),lock=createFlightTargetLock();
    const ts=reversed?[b,a]:[a,b];assert.equal(fire(p,ts,lock)?.id,2);
    a.position=target(p,2,.8,.55,950).position;b.position=target(p,3,0,0,400).position;
    assert.equal(fire(p,ts,lock)?.id,3,'trigger reselects after motion without prior steering selection');
    b.health=0;assert.equal(fire(p,ts,lock),null);assert.equal(lock.key,null);
  }
  for(const reversed of [false,true]) {
    const p=player(),a=target(p,2,.1,0,500),b=target(p,3,.1,0,500),lock=createFlightTargetLock();
    assert.equal(fire(p,reversed?[b,a]:[a,b],lock)?.id,2);
    a.identityGeneration++;fire(p,[a,b],lock);assert.match(lock.key!,/aircraft:2:2/);
  }
});
test('enemy acquisition and switching never supply steering pull',()=>{
  const p=player(),lock=createFlightTargetLock();
  for(const ts of [[target(p,2,.8,.55,500)],[target(p,3,-.8,-.55,500)],[]])for(const inputCommand of [input,{...input,turn:.1,climb:.02,steeringActive:true}]) {
    const r=assist(p,ts,inputCommand,lock);assert.equal(r.turn,inputCommand.turn);assert.equal(r.climb,inputCommand.climb);assert.equal(r.responseMultiplier,1);assert.equal(lock.key,null);
  }
});

import { makeAircraft, makeFleet } from '../src/mission';
import { flightTargetLineOfSight, sweptShipHitTime } from '../src/simulation';
import { updateQuaternion } from '../src/flight';
test('real capital-ship solids exclude hidden aircraft without excluding the hostile ship itself',()=>{
  const ship=makeFleet(4)[0],worldPoint=(x:number,z:number)=>new Vector3(x,7,z).applyQuaternion(ship.quaternion).add(ship.position);
  const p=makeAircraft(1,'friendly',worldPoint(0,200));p.yaw=ship.yaw;updateQuaternion(p);
  const enemy=makeAircraft(200,'enemy',worldPoint(0,-200));
  const state={player:p,ships:[ship],elapsed:0},lock=createFlightTargetLock(),los=(t:any)=>flightTargetLineOfSight(state,t);
  assert.ok(sweptShipHitTime({previous:p.position,position:enemy.position},ship)!<1);
  assert.equal(los(enemy),false);assert.equal(los(ship),true);
  assert.equal(autoFireTarget(p,[enemy],'easy',input.viewAspect),enemy,'old projection-only gate is open');
  const r=getFlightAssist(p,[enemy],input,'easy',lock,los);assert.equal(r.turn,0);assert.equal(r.climb,0);assert.equal(lock.key,null);
  assert.equal(autoFireTarget(p,[enemy],'easy',input.viewAspect,lock,los),null);
  p.position.y=200;enemy.position.y=200;assert.equal(los(enemy),true);
  getFlightAssist(p,[enemy],input,'easy',lock,los);assert.equal(autoFireTarget(p,[enemy],'easy',input.viewAspect,lock,los)?.id,200);
});
