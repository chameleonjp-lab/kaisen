import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Mesh, Quaternion, Vector3 } from 'three';
import { createGame } from '../src/simulation';
import { ShipFactory } from '../src/ships';
import { AIRFRAME_CONTACT_VERTICES } from '../src/sea-contact';
import { projectFlightTarget } from '../src/flight-view';
test('real hull is 270.43m by 32.97m against 12m source wings; broadside approach increases normal-camera projected width',()=>{
 const s=createGame(),factory=new ShipFactory();try {
  const root=factory.create(s.ships[0]);
  const hull=root.children.find(o=>o instanceof Mesh && !o.geometry.getAttribute('uv')) as Mesh;
  hull.geometry.computeBoundingBox();const size=hull.geometry.boundingBox!.getSize(new Vector3());
  assert.ok(Math.abs(size.z-270.43)<.00002);assert.ok(Math.abs(size.x-32.97)<.00001);
  const points=[];for(let i=0;i<AIRFRAME_CONTACT_VERTICES.length;i+=3)points.push(new Vector3(...AIRFRAME_CONTACT_VERTICES.slice(i,i+3)));
  assert.equal(new Box3().setFromPoints(points).getSize(new Vector3()).x,12);
  const span=(position:Vector3,yaw:number)=>{
   const q=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),yaw),xs:number[]=[];
   for(const x of [-16.485,16.485])for(const y of [0,42])for(const z of [-135.215,135.215]){
    const p=projectFlightTarget(s.player,new Vector3(x,y,z).applyQuaternion(q).add(position),393/852,'easy');xs.push((p.x*.5+.5)*393);
   }
   return Math.max(...xs)-Math.min(...xs);
  };
  const before=span(new Vector3(0,0,-1040),-.28),after=span(s.ships[2].position,s.ships[2].yaw);
  assert.ok(after>before*2.5);assert.ok(after>150);
 }finally{factory.dispose();}
});

test('foreground capital ship has a larger visible footprint with unchanged aircraft-relative camera and true meters', context=>{
 const s=createGame(), oldPlayer={...s.player,position:s.player.position.clone().set(0,350,240)};
 const hullSpan=(player:typeof s.player,position:Vector3)=>{
  const xs:number[]=[],ys:number[]=[];const q=s.ships[0].quaternion;
  for(const x of [-16.485,16.485])for(const y of [9,42])for(const z of [-135.215,135.215]) {
   const p=projectFlightTarget(player,new Vector3(x,y,z).applyQuaternion(q).add(position),393/852,'easy');
   xs.push((p.x*.5+.5)*393);ys.push((-p.y*.5+.5)*852);
  }
  return {width:Math.max(0,Math.min(393,Math.max(...xs))-Math.max(0,Math.min(...xs))),top:Math.min(...ys),bottom:Math.max(...ys)};
 };
 const before=hullSpan(oldPlayer,new Vector3(160,0,-760)),after=hullSpan(s.player,s.ships[0].position);
 context.diagnostic(JSON.stringify({before,after,oldAltitude:350,newAltitude:s.player.position.y}));
 assert.ok(after.width>before.width*1.5);assert.ok(after.width>280);assert.ok(after.top<852&&after.bottom>0);
 assert.equal(s.ships[0].length,270.43);assert.equal(s.player.position.y,300);
});
