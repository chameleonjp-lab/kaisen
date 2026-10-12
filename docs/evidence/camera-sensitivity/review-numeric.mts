// Independent read-only numerical camera review for Kaisen PR17.
// Run from the Kaisen checkout with: node --import tsx docs/evidence/camera-sensitivity/review-numeric.mts
import { Vector3, Quaternion } from 'three';
import { makeAircraft } from '../../../src/mission.ts';
import { createFlightController, updatePlayerLoop, updateQuaternion } from '../../../src/flight.ts';
import { getFlightCameraPose } from '../../../src/flight-view.ts';

const neutral = { turn: 0, climb: 0, fire: false, loop: false };
const angle = (a: Vector3, b: Vector3) => Math.atan2(new Vector3().crossVectors(a, b).length(), a.dot(b));
const cameraForward = (plane: ReturnType<typeof makeAircraft>, mode: 'easy' | 'normal') => {
  const rotation = new Quaternion();
  getFlightCameraPose(plane, mode, new Vector3(), rotation);
  return new Vector3(0, 0, -1).applyQuaternion(rotation).normalize();
};
const authority = (speed: number) => (speed <= 85 ? .92 + (speed - 65) / 20 * .23
  : speed <= 110 ? 1.15 - (speed - 85) / 25 * .15 : 1)
  * Math.max(.78, Math.min(1, 1 - Math.max(0, speed - 115) * .008));

let maxError = 0, worst: unknown = null, count = 0;
for (const mode of ['easy', 'normal'] as const)
  for (const speed of [65, 85, 110, 141])
    for (const pitch of [-.9, -.3, 0, .3, .9])
      for (const bank of [-.72, 0, .72])
        for (const yaw of [-3.14, 0, 3.14])
          for (const stickAngle of [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI, 5 * Math.PI / 4, 3 * Math.PI / 2, 7 * Math.PI / 4])
            for (const strength of [.01, .3, .6, 1]) {
              const plane = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), yaw, 'player');
              plane.speed = speed; plane.pitch = pitch; plane.bank = bank; updateQuaternion(plane);
              const turn = Math.cos(stickAngle) * strength, climb = Math.sin(stickAngle) * strength;
              const before = cameraForward(plane, mode);
              const input = { ...neutral, turn, climb, steeringActive: true };
              updatePlayerLoop(plane, createFlightController(plane), input, input, false, 1 / 60, 110, 141, 1, mode);
              const baseline = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), yaw, 'player');
              baseline.speed = speed; baseline.pitch = pitch; baseline.bank = bank; updateQuaternion(baseline);
              if (Math.abs(climb) <= 1e-8) updatePlayerLoop(baseline, createFlightController(baseline),
                { ...neutral, steeringActive: true }, { ...neutral, steeringActive: true }, false, 1 / 60, 110, 141, 1, mode);
              const measured = angle(Math.abs(climb) <= 1e-8 ? cameraForward(baseline, mode) : before, cameraForward(plane, mode));
              const expected = .82 * authority(speed) / 60 * strength;
              const error = Math.abs(measured - expected); count++;
              if (error > maxError) { maxError = error; worst = { mode, speed, pitch, bank, yaw, stickAngle, strength, measured, expected }; }
            }

let maxCancelAngle = 0, cancelWorst: unknown = null, maxFirstPitchStep = 0, cancelCount = 0;
for (const mode of ['easy', 'normal'] as const)
  for (const startPitch of [-.95, 0, .95])
    for (const ticks of [1, 25, 50, 75, 90, 100, 125, 150, 175, 200, 225, 250, 275, 299])
      for (const turn of [-1, 0, 1])
        for (const climb of [-1, 0, 1]) {
          const plane = makeAircraft(1, 'friendly', new Vector3(0, 900, 0), .3, 'player');
          plane.pitch = startPitch; updateQuaternion(plane);
          const control = createFlightController(plane), zero = { ...neutral, steeringRevision: 1 };
          for (let i = 0; i < ticks; i++) updatePlayerLoop(plane, control, zero, zero, i === 0, 1 / 60, 110, 141, 1, mode);
          const beforeRotation = new Quaternion(); getFlightCameraPose(plane, mode, new Vector3(), beforeRotation);
          const beforePitch = plane.pitch;
          const input = { ...neutral, turn, climb, steeringActive: true, steeringRevision: 2 };
          updatePlayerLoop(plane, control, input, input, false, 1 / 60, 110, 141, 1, mode);
          const afterRotation = new Quaternion(); getFlightCameraPose(plane, mode, new Vector3(), afterRotation);
          const measured = beforeRotation.angleTo(afterRotation);
          const delta = Math.abs(Math.atan2(Math.sin(plane.pitch - beforePitch), Math.cos(plane.pitch - beforePitch)));
          maxFirstPitchStep = Math.max(maxFirstPitchStep, delta); cancelCount++;
          if (measured > maxCancelAngle) { maxCancelAngle = measured; cancelWorst = { mode, startPitch, ticks, turn, climb, beforePitch, afterPitch: plane.pitch, measured }; }
        }

console.log(JSON.stringify({ cameraRate: { count, maxError, worst }, loopCancellation: { count: cancelCount, maxCancelAngle, cancelWorst, maxFirstPitchStep } }, null, 2));
