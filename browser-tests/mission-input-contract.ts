import { expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { releasePayloadAndObserve, steerAndObserve } from './touch-command';
import { waitForPausedView } from './paused-view';

/** Check what ordinary inputs do, independently of a bot's ability to win. */
export async function inspectMissionInputContract(page: Page, context: BrowserContext, mode: 'easy' | 'normal') {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const read = () => page.evaluate(() => (window as any).__kaisenReadState(false));
  const waitTicks = (tick: number) => page.waitForFunction(tick => {
    const s = (window as any).__kaisenReadState('clock');
    return s.phase !== 'playing' || s.tick >= tick;
  }, tick, { polling: 'raf' });
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator(`input[value="${mode}"]`).check();
  await page.locator('#start').tap();
  await expect.poll(async () => (await read()).phase).toBe('playing');
  const cdp = await context.newCDPSession(page), origin = { x: 180, y: 500 };
  let initial: any, steered: any, released: any, paused: any, resumed: any;
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...origin, id: 1 }] });
    const neutral = await steerAndObserve(page, cdp, origin, 0, 0);
    initial = await read();
    expect(initial.mode).toBe(mode);
    expect(initial.result).toBeNull();
    expect(neutral.steerPointer).not.toBeNull();
    const accepted = await steerAndObserve(page, cdp, origin, .3, .15);
    await waitTicks(accepted.tick + 6);
    steered = await read();
    expect(steered.phase).toBe('playing');
    expect(steered.controlsInput.steerPointer).toBe(neutral.steerPointer);
    expect(steered.controlsInput.turn).toBeCloseTo(.3, 5);
    expect(steered.controlsInput.climb).toBeCloseTo(.15, 5);
    const yawDelta = Math.atan2(Math.sin(steered.player.yaw - initial.player.yaw), Math.cos(steered.player.yaw - initial.player.yaw));
    expect(yawDelta).toBeLessThan(0);
    expect(steered.player.pitch).toBeGreaterThan(initial.player.pitch);
    const audit = await page.evaluate(() => (window as any).__kaisenReadState('audit'));
    expect(audit.dropped).toBe(0);
    expect(audit.entries.some((entry: any) => entry.tick > initial.tick && entry.input.steeringActive &&
      Math.abs(entry.input.turn - .3) < 1e-5 && Math.abs(entry.input.climb - .15) < 1e-5)).toBe(true);
    if (mode === 'normal') {
      const beforeFire = await read();
      await page.keyboard.down('Space');
      await expect.poll(async () => (await read()).player.mg).toBeLessThan(beforeFire.player.mg);
      await page.keyboard.up('Space');
    }
    const beforePayload = await read();
    expect(await releasePayloadAndObserve(page, cdp, origin, 'bomb')).toBe(true);
    released = await read();
    expect(released.player.bombs).toBe(beforePayload.player.bombs - 1);
    expect(released.controlsInput.steerPointer).toBe(neutral.steerPointer);
    expect(released.controlsInput.heldPointers.bomb).toEqual([]);
    const payloadAudit = await page.evaluate(() => (window as any).__kaisenReadState('audit'));
    expect(payloadAudit.entries.filter((entry: any) => entry.input.bomb)).toHaveLength(1);
    expect(released.result).toBeNull();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#pause').tap();
    await expect.poll(async () => (await read()).phase).toBe('paused');
    paused = await read();
    await page.waitForTimeout(300);
    const settled = await read();
    expect(settled.tick).toBe(paused.tick);
    expect(settled.elapsed).toBe(paused.elapsed);
    expect(settled.player).toEqual(paused.player);
    expect(settled.ordnance).toEqual(paused.ordnance);
    expect(settled.controlsInput.steerPointer).toBeNull();
    expect(settled.controlsInput.heldPointers.fire).toEqual([]);
    expect(settled.controlsInput.keys).toEqual([]);
    await waitForPausedView(page, { tick: paused.tick });
    await mkdir('test-results/evidence', { recursive: true });
    await page.screenshot({ path: `test-results/evidence/manual-control-contract-${mode}.png` });
    await page.locator('#resume').tap();
    await expect.poll(async () => (await read()).phase).toBe('playing');
    resumed = await read();
    expect(resumed.mode).toBe(mode);
    expect(resumed.controlsInput.steerPointer).toBeNull();
    expect(resumed.controlsInput.keys).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    const final = await read().catch(() => null);
    await page.keyboard.up('Space').catch(() => {});
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
    await mkdir('test-results/evidence', { recursive: true });
    await writeFile(`test-results/evidence/manual-control-contract-${mode}.json`, JSON.stringify({
      note: 'Ordinary trusted touch/keyboard inputs and read-only observations. No world, clock, damage or result injection. Free-play victory is an optional strategy scenario.',
      mode, initial, steered, released, paused, resumed, final, errors,
    }, null, 2));
  }
}
