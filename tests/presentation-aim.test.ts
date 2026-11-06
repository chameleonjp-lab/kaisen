import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { AIM_COLORS } from '../src/aim-indicator';
import { FlightPresentation } from '../src/flight-presentation';
import { getFlightCameraPose } from '../src/flight-view';
import { autoFireTarget } from '../src/flight-assist';
import { createFlightController } from '../src/flight';
import { createGame, startGame, stepGame, selectedFlightTargetKey } from '../src/simulation';
import { KaisenScene } from '../src/scene';

const width=402,height=874;
for(const transition of ['enter','exit','switch','new-id'] as const) test(`Easy reticle uses displayed geometry during circle ${transition} at alpha 0/.5/1`,()=>{
  const state=createGame(73,'easy');state.player.position.set(0,1500,0);state.player.bombs=0;state.allies=[];state.ships=[];state.enemies=state.enemies.slice(0,transition==='switch'?2:1);startGame(state);
  const cameraPosition=new Vector3(),cameraRotation=new Quaternion();getFlightCameraPose(state.player,'easy',cameraPosition,cameraRotation);
  const point=(x:number)=>new Vector3(x,0,-500).applyQuaternion(cameraRotation).add(cameraPosition);
  const inside=30,outside=42;
  const first=state.enemies[0];first.position.copy(point(transition==='enter'?outside:inside));
  if(transition==='switch')state.enemies[1].position.copy(point(outside));
  const presentation=new FlightPresentation();presentation.capture(state);
  first.position.copy(point(transition==='enter'?inside:outside));
  if(transition==='switch')state.enemies[1].position.copy(point(inside));
  if(transition==='new-id') { state.enemies[0]={...first,id:first.id+1000,position:point(inside)}; }
  stepGame(state,{turn:0,climb:0,fire:false,loop:false,viewAspect:width/height});
  const lock=createFlightController(state.player).targetLock;
  const trigger=autoFireTarget(state.player,state.enemies,'easy',width/height,lock);
  assert.equal(selectedFlightTargetKey(state),lock.key,'the real fixed-tick trigger selects the current geometry');
  assert.equal(trigger!==null,transition!=='exit','the authoritative trigger keeps current-tick eligibility');
  for(const alpha of [0,.5,1]) {
    const sampled=presentation.sample(state,alpha),strokes:string[]=[];
    const ctx:any=new Proxy({strokeStyle:'',stroke(){strokes.push(this.strokeStyle);},measureText(){return {width:0};}}, {get:(target,key)=>key in target?Reflect.get(target,key):()=>{}});
    const camera=new PerspectiveCamera(64,width/height,.1,100000);getFlightCameraPose(sampled.player,'easy',camera.position,camera.quaternion);camera.updateMatrixWorld(true);
    const scene:any=Object.create(KaisenScene.prototype);Object.assign(scene,{ctx,width,height,camera});
    const before=JSON.stringify(state);
    scene.drawOverlay(sampled,true,state);
    const expected=transition==='enter'&&alpha===0||transition==='exit'&&alpha===1?'clear':'enemy';
    assert.equal(strokes[0],AIM_COLORS[expected],`${transition} alpha=${alpha}: displayed targets determine reticle color`);
    assert.equal(JSON.stringify(state),before,'drawing cannot change the authoritative trigger or flight');
  }
});
