import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { expectScoreResult, inspectScoreResultLayout } from './score-result';

const read = (page: Page) => page.evaluate(() => (window as any).__kaisenReadState());
async function openNormal(page: Page) {
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('input[value="easy"]')).toBeChecked();
  await page.locator('input[value="normal"]').check();
  await expect(page.locator('#mode-guide')).toContainText('手動射撃');
  await page.locator('#start').tap();
  await expect.poll(async () => (await read(page)).phase).toBe('playing');
  expect((await read(page)).mode).toBe('normal');
}
async function center(page: Page, selector: string, id: number) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, id };
}
async function evidence(page: Page, name: string, pausedFlight = false) {
  await mkdir('test-results/evidence', { recursive: true });
  await page.screenshot({ path: `test-results/evidence/${name}.png`,
    ...(pausedFlight ? { style: '#pause-screen { visibility: hidden !important; }' } : {}),
  });
  await writeFile(`test-results/evidence/${name}.json`, JSON.stringify({
    environment: 'Chromium touch viewport emulation, not iPhone hardware',
    note: pausedFlight ? 'Paused through the real menu; waited for a newly completed GPU frame. Only the pause menu is hidden for the screenshot.' : 'Unmodified visible screen',
    viewport: page.viewportSize(), state: await read(page),
  }, null, 2));
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  (page as any).__modeErrors = errors;
});
test.afterEach(async ({ page }) => { expect((page as any).__modeErrors).toEqual([]); });

for (const viewport of [{ width: 393, height: 852 }, { width: 852, height: 393 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
  test(`Normal visible controls and bore sight ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await openNormal(page);
    await expect(page.locator('#hud-mode')).toHaveText('ノーマル');
    // One active-screen read captures actual hit ownership before the modal covers it.
    const boxes = await page.evaluate(() => ['fire', 'loop', 'accelerate', 'brake', 'bomb', 'torpedo', 'game-sound', 'pause'].map(id => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return { id, x: box.x, y: box.y, width: box.width, height: box.height,
        owner: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button')?.id };
    }));
    await page.locator('#pause').tap();
    await expect.poll(async () => (await read(page)).phase).toBe('paused');
    const submittedBefore = (await read(page)).render.queue.submittedCount;
    await expect.poll(async () => (await read(page)).render.queue.completedCount).toBeGreaterThanOrEqual(submittedBefore + 1);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.owner).toBe(box.id);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `${a.id} and ${b.id} do not overlap`).toBe(true);
    }
    const s = await read(page);
    expect(s.stats.shots).toBe(0); expect(s.gunSight.y).toBeLessThan(viewport.height * .45);
    await evidence(page, `normal-${viewport.width}x${viewport.height}`, true);
    await page.locator('#pause-home').tap();
    await expect(page.locator('input[value="normal"]')).toBeChecked();
    await page.locator('input[value="easy"]').check(); await page.locator('#start').tap();
    expect((await read(page)).mode).toBe('easy');
    await expect(page.locator('#fire')).toBeHidden();
    await expect(page.locator('#accelerate')).toBeHidden();
    await expect(page.locator('#brake')).toBeHidden();
    await expect(page.locator('#loop')).toBeVisible();
    await expect(page.locator('#bomb')).toBeVisible();await expect(page.locator('#torpedo')).toBeVisible();
  });
}

test('Normal real simultaneous touch steering, fire and throttle release on pause and cancel', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await openNormal(page);
  const steer = { x: 180, y: 560, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [steer] });
  const moved = { ...steer, x: steer.x + 18 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
  const fire = await center(page, '#fire', 2), accelerate = await center(page, '#accelerate', 3);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, fire] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, fire, accelerate] });
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#accelerate')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await read(page)).stats.shots).toBeGreaterThan(8);
  await expect.poll(async () => (await read(page)).player.speed).toBeGreaterThan(112);
  expect(Math.abs((await read(page)).player.yaw)).toBeGreaterThan(.04);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).phase).toBe('paused');
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#accelerate')).toHaveAttribute('aria-pressed', 'false');
  const frozen = await read(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  expect((await read(page)).tick).toBe(frozen.tick);
  expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
  await page.locator('#resume').tap();
  await expect.poll(async () => (await read(page)).tick).toBeGreaterThan(frozen.tick + 15);
  expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
  expect((await read(page)).player.yaw).toBeCloseTo(frozen.player.yaw, 10);
  const freshFire = await center(page, '#fire', 4);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [freshFire] });
  await expect.poll(async () => (await read(page)).stats.shots).toBeGreaterThan(frozen.stats.shots);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'false');
  const cancelled = await read(page);
  await expect.poll(async () => (await read(page)).tick).toBeGreaterThan(cancelled.tick + 15);
  expect((await read(page)).stats.shots).toBe(cancelled.stats.shots);
  await page.locator('#pause').tap(); await page.locator('#pause-restart').tap();
  expect((await read(page)).mode).toBe('normal');
  await expect(page.locator('#fire')).toBeVisible();
  expect((await read(page)).stats.shots).toBe(0);
});

test('Normal real sea failure labels the result and preserves mode across retry and home', async ({ page }) => {
  await openNormal(page);
  await page.keyboard.down('ArrowDown');
  await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });
  await page.keyboard.up('ArrowDown');
  await expect(page.locator('#result-mode')).toHaveText('ノーマル');
  await expect(page.locator('#result-reason')).toContainText('海面');
  const result = (await read(page)).result;
  expect(result.outcome).toBe('defeat');
  await expectScoreResult(page, result, 'normal', 'defeat');
  await inspectScoreResultLayout(page, result);
  await evidence(page, 'normal-sea-result');
  await page.locator('#retry').tap();
  expect((await read(page)).mode).toBe('normal');
  expect((await read(page)).stats.shots).toBe(0);
  expect((await read(page)).stats.score).toBe(0);
  expect((await read(page)).result).toBeNull();
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#pause').tap(); await page.locator('#pause-home').tap();
  await expect(page.locator('input[value="normal"]')).toBeChecked();
  await page.locator('input[value="easy"]').check(); await page.locator('#start').tap();
  await expect(page.locator('#hud-mode')).toHaveText('イージー');
  expect((await read(page)).config.mode).toBe('easy');
});
