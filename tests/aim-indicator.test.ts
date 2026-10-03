import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { aimIndicator, aimRadius } from '../src/aim-indicator';
import { createGame } from '../src/simulation';
import { getFlightCameraPose } from '../src/flight-view';
import { projectGunSight } from '../src/gun-sight';
test('circle uses white/hostile red/friendly blue without mutating the world in both modes', () => {
  for (const mode of ['easy','normal'] as const) {
    const s=createGame(1,mode),width=393,height=852;
    const sight=mode==='normal'?projectGunSight(s.player,[],width,height):{x:width/2,y:height/2};
    const camera=new Vector3(),rotation=new Quaternion();getFlightCameraPose(s.player,mode,camera,rotation);
    const x=sight.x/width*2-1,y=1-sight.y/height*2,depth=500,tan=Math.tan(64*Math.PI/360);
    const point=new Vector3(x*depth*tan*width/height,y*depth*tan,-depth).applyQuaternion(rotation).add(camera);
    const enemy=s.enemies[0],ally=s.allies[0];enemy.position.copy(point);ally.position.copy(point);
    const before=JSON.stringify(s);
    assert.equal(aimIndicator(s,[],sight,width,height),'clear');
    assert.equal(aimIndicator(s,[enemy],sight,width,height),'enemy');
    assert.equal(aimIndicator(s,[enemy,ally],sight,width,height),'friendly');
    assert.equal(JSON.stringify(s),before);
    enemy.position.x+=2000;assert.equal(aimIndicator(s,[enemy],sight,width,height),'clear');
    assert.equal(aimRadius('easy',width,height),393*.135);assert.ok(aimRadius('normal',width,height)>=26);
  }
});
