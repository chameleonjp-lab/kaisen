import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Mesh, Quaternion, Vector3 } from 'three';
import { createGame } from '../src/simulation';
import { ShipFactory } from '../src/ships';
import { AIRFRAME_CONTACT_VERTICES } from '../src/sea-contact';
import { projectFlightTarget } from '../src/flight-view';
test('real hull is 263m by 38.9m against 12m source wings; broadside approach increases normal-camera projected width',()=>{
 const s=createGame(),factory=new ShipFactory();try {
  const root=factory.create(s.ships[0]);
  const hull=root.children.find(o=>o instanceof Mesh && !o.geometry.getAttribute('uv')) as Mesh;
  hull.geometry.computeBoundingBox();const size=hull.geometry.boundingBox!.getSize(new Vector3());
  assert.equal(size.z,263);assert.ok(Math.abs(size.x-38.9)<.00001);
  const points=[];for(let i=0;i<AIRFRAME_CONTACT_VERTICES.length;i+=3)points.push(new Vector3(...AIRFRAME_CONTACT_VERTICES.slice(i,i+3)));
  assert.equal(new Box3().setFromPoints(points).getSize(new Vector3()).x,12);
  const span=(position:Vector3,yaw:number)=>{
   const q=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),yaw),xs:number[]=[];
   for(const x of [-19.45,19.45])for(const y of [0,42])for(const z of [-131.5,131.5]){
    const p=projectFlightTarget(s.player,new Vector3(x,y,z).applyQuaternion(q).add(position),393/852,'easy');xs.push((p.x*.5+.5)*393);
   }
   return Math.max(...xs)-Math.min(...xs);
  };
  const before=span(new Vector3(0,0,-1040),-.28),after=span(s.ships[2].position,s.ships[2].yaw);
  assert.ok(after>before*2.5);assert.ok(after>150);
 }finally{factory.dispose();}
});
