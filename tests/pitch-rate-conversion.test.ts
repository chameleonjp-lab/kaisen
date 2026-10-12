import assert from 'node:assert/strict';
import test from 'node:test';
import { absolutePitchTargetToRateCommand } from './helpers/pitch-rate-conversion';

function authority(speed: number): number {
  const low = speed <= 85 ? .92 + ((speed - 65) / 20) * .23
    : speed <= 110 ? 1.15 - ((speed - 85) / 25) * .15 : 1;
  return low * Math.max(.78, Math.min(1, 1 - Math.max(0, speed - 115) * .008));
}

test('legacy absolute-pitch test commands map to the exact old one-tick delta until the new rate limit binds', () => {
  const dt = 1 / 60, alpha = 1 - Math.exp(-4.2 * dt);
  for (const [command, pitch, speed] of [[.25, .2, 110], [-.5, -.3, 65], [1, -.95, 141], [-1, .95, 110]] as const) {
    const oldDelta = (command * .95 - pitch) * alpha;
    const maxRateDelta = .82 * authority(speed) * dt;
    const actualDelta = absolutePitchTargetToRateCommand(command, pitch, speed, dt) * maxRateDelta;
    const expected = Math.max(-maxRateDelta, Math.min(maxRateDelta, oldDelta));
    assert.ok(Math.abs(actualDelta - expected) < 1e-12,
      `command=${command}, pitch=${pitch}, speed=${speed}: exact legacy step or explicit rate saturation`);
  }
});
