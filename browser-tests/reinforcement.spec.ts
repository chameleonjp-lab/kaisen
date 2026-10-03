import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
// This route really flies across two 40-second replenishment boundaries. No clock/state injection or product test controls.
test.use({ trace: 'off' });
test('repeated 40-second replenishment stays bounded and pause freezes its clock', async ({page, context}) => {
  test.setTimeout(140000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const read = () => page.evaluate(() => (window as any).__kaisenReadState());
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').tap();
  const cdp = await context.newCDPSession(page);
  const origin = { x: 95, y: 650 };
  const climb = async () => {
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{...origin,id:1}]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:origin.x,y:origin.y-36,id:1}]});
  };
  await climb();
  await expect.poll(async () => {
    const s = await read(); expect(s.phase).toBe('playing'); return s.tick;
  }, { timeout: 55000, intervals: [250] }).toBeGreaterThanOrEqual(60 * 38);
  await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  await page.locator('#pause').tap();
  const paused = await read();
  expect(paused.tick).toBeLessThan(2400); expect(paused.enemies).toHaveLength(5);
  await page.waitForTimeout(1200);
  expect((await read()).tick).toBe(paused.tick);
  await page.locator('#resume').tap(); await climb();
  await expect.poll(async () => (await read()).reinforcementsSpawned, {timeout:10000}).toBe(true);
  await expect.poll(async () => (await read()).render.planes).toBe(10);
  const wave = await read();
  expect(wave.enemies).toHaveLength(5);
  expect(wave.enemies.some((e:any) => e.generation === 'reinforcement')).toBe(true);
  expect(new Set(wave.enemies.map((e:any) => e.id)).size).toBe(5);
  await expect(page.locator('#enemy-total')).toHaveText('/ 5');
  await expect(page.locator('#announcement')).toContainText('機が復活');
  await mkdir('test-results/evidence', {recursive:true});
  await writeFile('test-results/evidence/reinforcement-real-flight.json', JSON.stringify({note:'Actual 40-second touch flight; no clock or world injection', paused, wave},null,2));
  await page.screenshot({path:'test-results/evidence/reinforcement-real-flight.png'});
  await expect.poll(async () => (await read()).tick, {timeout:55000,intervals:[250]}).toBeGreaterThan(60 * 80);
  expect((await read()).render.planes).toBeLessThanOrEqual(10);
  expect((await read()).allies).toHaveLength(4);
  expect((await read()).enemies).toHaveLength(5);
  await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  await page.locator('#pause').tap(); await page.locator('#pause-restart').tap();
  const retry = await read(); expect(retry.enemies).toHaveLength(5); expect(retry.reinforcementsSpawned).toBe(false);
  expect(errors).toEqual([]);
});
