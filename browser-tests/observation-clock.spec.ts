import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { waitForPausedView } from './paused-view';

test('lightweight clock observation preserves the world and follows real phase transitions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  const clock = () => page.evaluate(() => (window as any).__kaisenReadState('clock'));
  expect(await clock()).toEqual({ phase: 'ready', tick: 0, elapsed: 0 });
  await page.locator('#start').tap();
  await page.waitForFunction(() => (window as any).__kaisenReadState('clock').tick >= 6);
  await page.locator('#pause').tap();
  await waitForPausedView(page);
  const evidence = await page.evaluate(() => {
    const read = (window as any).__kaisenReadState;
    const before = read(false), expected = { phase: before.phase, tick: before.tick, elapsed: before.elapsed };
    const observations = Array.from({ length: 100 }, () => read('clock'));
    const input = read('input');
    const startedFull = performance.now();
    for (let i = 0; i < 100; i++) read(false);
    const fullMs = performance.now() - startedFull;
    const startedClock = performance.now();
    for (let i = 0; i < 100; i++) read('clock');
    const clockMs = performance.now() - startedClock;
    const startedInput = performance.now();
    for (let i = 0; i < 100; i++) read('input');
    const inputMs = performance.now() - startedInput;
    const world = (s: any) => ({ phase: s.phase, tick: s.tick, elapsed: s.elapsed, player: s.player,
      allies: s.allies, enemies: s.enemies, ships: s.ships, stats: s.stats,
      ordnance: s.ordnance, result: s.result, deathCause: s.deathCause });
    return { expected, observations, input, expectedInput: { phase: before.phase, tick: before.tick,
      controlsInput: before.controlsInput, player: { bombs: before.player.bombs, torpedoes: before.player.torpedoes } },
      before: world(before), after: world(read(false)),
      measurements: { iterations: 100, fullMs, clockMs, inputMs,
        fullBytes: new TextEncoder().encode(JSON.stringify(before)).length,
        clockBytes: new TextEncoder().encode(JSON.stringify(expected)).length,
        inputBytes: new TextEncoder().encode(JSON.stringify(input)).length,
        note: 'Same paused world, sequential synchronous reads. Timing is evidence, not a portable performance threshold.' } };
  });
  expect(evidence.observations.every(value => JSON.stringify(value) === JSON.stringify(evidence.expected))).toBe(true);
  expect(evidence.after).toEqual(evidence.before);
  expect(evidence.input).toEqual(evidence.expectedInput);
  await mkdir('test-results/evidence', { recursive: true });
  await writeFile('test-results/evidence/clock-observation.json', JSON.stringify(evidence, null, 2));
  await page.locator('#resume').tap();
  await expect.poll(async () => (await clock()).tick).toBeGreaterThan(evidence.expected.tick);
  expect((await clock()).phase).toBe('playing');
  expect(errors).toEqual([]);
});
