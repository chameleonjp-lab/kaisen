import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameClock } from '../src/frame-clock';

test('steady display refreshes keep steady motion despite varying callback delays', () => {
  const clock = new FrameClock(), refreshStep = 1000 / 120;
  for (let frame = 0; frame < 40; frame++) {
    const refresh = 100 + frame * refreshStep, execution = refresh + [0, 4, 1, 6][frame % 4];
    const sampled = clock.sample(refresh, execution);
    if (frame > 0) assert.ok(Math.abs(sampled.dt - 1 / 120) < 1e-12,
      `display velocity must not follow callback jitter: ${sampled.dt}`);
  }
});

test('real execution gaps still detect an interruption when the queued refresh timestamp is shorter', () => {
  const clock = new FrameClock(); assert.deepEqual(clock.sample(100, 100), { dt: 0, gap: 0 });
  const delayed = clock.sample(916, 1200);
  assert.equal(delayed.dt, .816); assert.equal(delayed.gap, 1.1);
  clock.reset(); assert.deepEqual(clock.sample(1216, 1220), { dt: 0, gap: 0 });
});
