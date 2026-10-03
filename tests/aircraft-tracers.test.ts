import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Vector4 } from 'three';
import { AircraftTracers } from '../src/aircraft-tracers';
import { AIRCRAFT_BULLET_LIFETIME } from '../src/mission';
import type { Bullet } from '../src/types';
function bullet(kind:Bullet['kind']='mg',life=1.5,team:Bullet['team']='friendly'):Bullet {
  return {id:1,owner:1,team,kind,position:new Vector3(0,0,-20),previous:new Vector3(),velocity:new Vector3(0,0,-1000),life,damage:1};
}
test('aircraft tracers share bounded two-pass geometry, keep ally colors and exclude naval rounds',()=>{
  const view=new AircraftTracers(2),air=bullet('mg',1.4),enemy=bullet('cannon',1.4,'enemy');
  const before=JSON.stringify([air,enemy]);
  view.update([bullet('aa',4),air,enemy,bullet()]);
  assert.equal(view.geometry.instanceCount,2);
  assert.equal(view.core.geometry,view.outline.geometry);
  assert.equal(view.positions.length,12);
  assert.ok(Math.abs(view.colors[1]-.7)<1e-6 && Math.abs(view.colors[7]-.24)<1e-6);
  assert.equal(JSON.stringify([air,enemy]),before,'display cannot mutate ballistics');
  view.update([]);assert.equal(view.geometry.instanceCount,0);
  view.dispose();
});
test('tail never precedes muzzle birth and is capped at 45ms independently of render rate',()=>{
  const view=new AircraftTracers(1);
  for(const age of [0,1/240,1/60,.045,.3]) {
    view.update([bullet('mg',AIRCRAFT_BULLET_LIFETIME-age)]);
    assert.ok(Math.abs(view.positions[2]-(-20+1000*Math.min(age,.045)))<1e-5);
    assert.equal(view.positions[5],-20);
  }
  view.update([bullet('mg',0)]);assert.equal(view.geometry.instanceCount,0);
  view.dispose();
});
test('core and outline stay screen-width, depth-occluded, shader-warmed and released once',()=>{
  const view=new AircraftTracers(1);let disposed=0;
  for(const material of [view.coreMaterial,view.outlineMaterial]) {
    assert.equal(material.worldUnits,false);assert.equal(material.depthTest,true);
    assert.equal(material.depthWrite,false);assert.equal(material.toneMapped,false);assert.equal(material.fog,false);
    material.addEventListener('dispose',()=>disposed++);
  }
  view.geometry.addEventListener('dispose',()=>disposed++);
  assert.equal(view.coreMaterial.linewidth,1.5);assert.equal(view.outlineMaterial.linewidth,2.5);
  const gl:any={getViewport:(v:Vector4)=>v.set(0,0,393,852)};
  (view.core.onBeforeRender as any)(gl);
  assert.deepEqual(view.coreMaterial.resolution.toArray(),[393,852]);
  gl.getViewport=(v:Vector4)=>v.set(0,0,852,393);(view.core.onBeforeRender as any)(gl);
  assert.deepEqual(view.coreMaterial.resolution.toArray(),[852,393]);
  view.prime(new Vector3(0,0,-80));assert.equal(view.geometry.instanceCount,1);
  view.update([]);assert.equal(view.geometry.instanceCount,0);
  view.dispose();view.dispose();assert.equal(disposed,3);
});
