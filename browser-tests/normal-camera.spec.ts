import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { steerAndObserve } from './touch-command';
import { waitForPausedView } from './paused-view';

test('Normal real touch holds pitch through horizontal and neutral drag, then levels on release', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const read = () => page.evaluate(() => (window as any).__kaisenReadState(false));
  const waitTicks = (tick: number) => page.waitForFunction(tick => {
    const s = (window as any).__kaisenReadState('clock');
    return s.phase !== 'playing' || s.tick >= tick;
  }, tick, { polling: 'raf' });
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('input[value="normal"]').check();
  await page.locator('#start').tap();
  const cdp = await context.newCDPSession(page), origin = { x: 180, y: 500 };
  const observations: any[] = [];
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...origin, id: 1 }] });
    const climb = await steerAndObserve(page, cdp, origin, 0, .45);
    await waitTicks(climb.tick + 18);
    const raised = await read();
    expect(raised.phase).toBe('playing');
    expect(raised.player.pitch).toBeGreaterThan(.05);
    let heldPitch: number | undefined;
    for (const turn of [.3, 0]) {
      const accepted = await steerAndObserve(page, cdp, origin, turn, 0);
      const before = await read();
      heldPitch ??= before.player.pitch;
      await waitTicks(before.tick + 8);
      const after = await read();
      observations.push({ turn, accepted, before, after });
      expect(after.phase).toBe('playing');
      expect(after.controlsInput.steerPointer).toBe(climb.steerPointer);
      expect(after.controlsInput.climb).toBe(0);
      expect(after.player.pitch).toBe(before.player.pitch);
      expect(after.player.pitch).toBe(heldPitch);
      if (turn !== 0) expect(Math.abs(after.player.yaw - before.player.yaw)).toBeGreaterThan(0);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => (window as any).__kaisenReadState('input').controlsInput.steerPointer === null);
    const released = await read();
    await waitTicks(released.tick + 8);
    const levelled = await read();
    observations.push({ released, levelled });
    expect(levelled.phase).toBe('playing');
    expect(Math.abs(levelled.player.pitch)).toBeLessThan(Math.abs(released.player.pitch));
    expect(levelled.stats.shots).toBe(0);
    await page.locator('#pause').tap();
    await waitForPausedView(page);
    await mkdir('test-results/evidence', { recursive: true });
    await page.screenshot({ path: 'test-results/evidence/normal-camera.png', style: '#pause-screen {visibility:hidden!important}' });
    expect(errors).toEqual([]);
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
    await mkdir('test-results/evidence', { recursive: true });
    await writeFile('test-results/evidence/normal-camera.json', JSON.stringify({ observations, errors }, null, 2));
  }
});
