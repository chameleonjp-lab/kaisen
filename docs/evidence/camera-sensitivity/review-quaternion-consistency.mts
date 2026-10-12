// Read-only camera-pose consistency review, including the actual sea-contact step.
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { makeAircraft } from '../../../src/mission.ts';
import { forwardOf, updateQuaternion } from '../../../src/flight.ts';
import { getFlightCameraPose, projectFlightTarget, FLIGHT_FOV, FLIGHT_FAR, FLIGHT_CAMERA_BANK_FACTOR,
  NORMAL_CAMERA_LOOK_ANGLE, EASY_CAMERA_LOOK_ANGLE } from '../../../src/flight-view.ts';
import { projectGunSight } from '../../../src/gun-sight.ts';
import { createGame, startGame, stepGame } from '../../../src/simulation.ts';

const angle = (a: Vector3, b: Vector3) => Math.atan2(new Vector3().crossVectors(a, b).length(), a.dot(b));
const forward = (rotation: Quaternion) => new Vector3(0, 0, -1).applyQuaternion(rotation).normalize();
const axis = new Vector3(0, 0, 1), pitchAxis = new Vector3(1, 0, 0);
let healthyCount = 0, maxQuaternionComponentError = 0, maxForwardAngle = 0, maxPositionError = 0;
for (const mode of ['easy', 'normal'] as const)
  for (const pitch of [-7, -2 * Math.PI, -Math.PI, -Math.PI / 2, -.95, -.1, 0, .1, .95, Math.PI / 2, Math.PI, 2 * Math.PI, 7])
    for (const yaw of [-Math.PI, -1, 0, 1, Math.PI])
      for (const bank of [-.72, 0, .72]) {
        const plane = makeAircraft(1, 'friendly', new Vector3(30, 900, -40), yaw, 'player');
        plane.pitch = pitch; plane.bank = bank; updateQuaternion(plane);
        const actualPosition = new Vector3(), actualRotation = new Quaternion();
        getFlightCameraPose(plane, mode, actualPosition, actualRotation);
        const expectedRotation = new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'))
          .multiply(new Quaternion().setFromAxisAngle(pitchAxis, mode === 'normal' ? NORMAL_CAMERA_LOOK_ANGLE : EASY_CAMERA_LOOK_ANGLE))
          .multiply(new Quaternion().setFromAxisAngle(axis, -bank * FLIGHT_CAMERA_BANK_FACTOR));
        const expectedPosition = new Vector3(0, 11, 29).applyQuaternion(plane.quaternion.clone()
          .multiply(new Quaternion().setFromAxisAngle(axis, bank * (1 - FLIGHT_CAMERA_BANK_FACTOR)))).add(plane.position);
        const sign = actualRotation.dot(expectedRotation) >= 0 ? 1 : -1;
        const componentError = Math.max(...actualRotation.toArray().map((v: number, i: number) => Math.abs(v - sign * expectedRotation.toArray()[i])));
        maxQuaternionComponentError = Math.max(maxQuaternionComponentError, componentError);
        maxForwardAngle = Math.max(maxForwardAngle, angle(forward(actualRotation), forward(expectedRotation)));
        maxPositionError = Math.max(maxPositionError, actualPosition.distanceTo(expectedPosition)); healthyCount++;
      }

const impactResults = [];
for (const mode of ['easy', 'normal'] as const) {
  const state = createGame(73, mode);
  for (const target of [...state.allies, ...state.enemies, ...state.ships]) target.health = 0;
  state.ships[0].health = 1; state.ships[0].position.set(10000, 0, -10000); state.ships[0].previous.copy(state.ships[0].position);
  state.player.position.set(0, 3.6, 0); state.player.previous.copy(state.player.position);
  state.player.pitch = -.5; updateQuaternion(state.player); startGame(state);
  stepGame(state, { turn: .6, climb: -.6, fire: false, loop: false, steeringActive: true });
  if (state.phase !== 'ended' || state.deathCause !== 'sea') throw new Error('The genuine sea-contact fixture did not end at impact');
  const before = JSON.stringify(state.player);
  const actualPosition = new Vector3(), actualRotation = new Quaternion();
  getFlightCameraPose(state.player, mode, actualPosition, actualRotation);
  const lookAngle = mode === 'normal' ? NORMAL_CAMERA_LOOK_ANGLE : EASY_CAMERA_LOOK_ANGLE;
  const bodyCameraAngle = angle(forwardOf(state.player), forward(actualRotation));
  const oldEulerRotation = new Quaternion().setFromEuler(new Euler(state.player.pitch, state.player.yaw, 0, 'YXZ'))
    .multiply(new Quaternion().setFromAxisAngle(pitchAxis, lookAngle))
    .multiply(new Quaternion().setFromAxisAngle(axis, -state.player.bank * FLIGHT_CAMERA_BANK_FACTOR));
  const oldEulerLookError = Math.abs(angle(forwardOf(state.player), forward(oldEulerRotation)) - Math.abs(lookAngle));
  let maxSightPixelError = 0, maxProjectionError = 0;
  for (const [width, height] of [[393, 852], [852, 393], [320, 568]]) {
    const camera = new PerspectiveCamera(FLIGHT_FOV, width / height, .1, FLIGHT_FAR);
    getFlightCameraPose(state.player, mode, camera.position, camera.quaternion); camera.updateMatrixWorld(true);
    const worldPoint = state.player.position.clone().addScaledVector(forwardOf(state.player), 504.5);
    const projected = worldPoint.clone().project(camera);
    const shared = projectFlightTarget(state.player, worldPoint, width / height, mode);
    maxProjectionError = Math.max(maxProjectionError, Math.abs(shared.x - projected.x), Math.abs(shared.y - projected.y));
    if (mode === 'normal') {
      const sight = projectGunSight(state.player, [], width, height);
      maxSightPixelError = Math.max(maxSightPixelError,
        Math.abs(sight.x - (.5 + .5 * projected.x) * width), Math.abs(sight.y - (.5 - .5 * projected.y) * height));
    }
  }
  if (JSON.stringify(state.player) !== before) throw new Error('Projection changed the impact state');
  impactResults.push({ mode, phase: state.phase, deathCause: state.deathCause, bodyCameraAngle,
    lookAngleError: Math.abs(bodyCameraAngle - Math.abs(lookAngle)), oldEulerLookError, maxProjectionError, maxSightPixelError });
}
console.log(JSON.stringify({ healthy: { count: healthyCount, maxQuaternionComponentError, maxForwardAngle, maxPositionError }, impact: impactResults }, null, 2));
