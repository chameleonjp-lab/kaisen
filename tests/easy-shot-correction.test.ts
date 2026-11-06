import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { predictedShotDirection } from '../src/flight-assist';
import { makeAircraft } from '../src/mission';
import { updateQuaternion } from '../src/flight';
import { createGame, startGame, stepGame } from '../src/simulation';

test('AI retains its original full straight-intercept solution',()=>{
  const plane=makeAircraft(10,'enemy',new Vector3(0,500,-650));plane.yaw=-Math.PI/2;updateQuaternion(plane);
  const origin=new Vector3(0,500,0),forward=new Vector3(0,0,-1);
  const predicted=predictedShotDirection(origin,forward,plane,930,1.5);
  assert.ok(forward.angleTo(predicted)>.1);
});
