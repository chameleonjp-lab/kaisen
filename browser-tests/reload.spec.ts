import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTouchReloadPilot, pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';

test.use({ trace: 'off' });
test('real touch flight exhausts magazines and shows a frozen then completed filling reload ring', async ({page, context}) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const read = () => page.evaluate(() => (window as any).__kaisenReadState());
  const capture = async (name: string) => {
    await mkdir('test-results/evidence', {recursive:true});
    await writeFile(`test-results/evidence/${name}.json`, JSON.stringify({note:'Real clock and CDP touch input, no world/clock injection. Pause menu hidden only for screenshot.', snapshot:await read()},null,2));
    await page.screenshot({path:`test-results/evidence/${name}.png`,style:'#pause-screen { visibility: hidden !important; }'});
  };
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  const cdp = await context.newCDPSession(page), pilot = createTouchReloadPilot();
  const origin = {x:90,y:650};
  const touchStart = () => cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...origin,id:1}]});
  const touchEnd = () => cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.locator('#start').tap(); await touchStart();
  let lastSample = -6, captured = false, completed = false;
  try {
    while (true) {
      if (lastSample >= 0) await page.waitForFunction(next => {
        const s=(window as any).__kaisenReadState(); return s.phase !== 'playing' || s.tick >= next;
      },lastSample+6,{polling:'raf'});
      const s = await read();
      if (captured && s.phase === 'ended' && s.player.reloadTicksRemaining === 0 && s.stats.shots > 384) {
        await capture('reload-completed-result'); completed = true; break;
      }
      expect(s.phase, 'Legal reload route stays in active flight').toBe('playing');
      expect(s.elapsed).toBeLessThan(145);
      if (!captured && s.player.reloadTicksRemaining > 0 && s.player.reloadTicksRemaining <= 240) {
        await touchEnd(); await page.locator('#pause').tap();
        const frozen = await read();
        await expect(page.locator('#reload-status')).toContainText('再装填中 あと');
        const progress = Number(await page.locator('#reload-status').getAttribute('data-progress'));
        expect(progress).toBeGreaterThanOrEqual(1/3); expect(progress).toBeLessThan(1);
        await capture('reload-paused'); await page.waitForTimeout(650);
        const still = await read();
        expect(still.tick).toBe(frozen.tick); expect(still.stats.shots).toBe(frozen.stats.shots);
        expect(still.player.reloadTicksRemaining).toBe(frozen.player.reloadTicksRemaining);
        expect(still.player.mg).toBe(0); expect(still.player.cannon).toBe(0);
        expect(Number(await page.locator('#reload-status').getAttribute('data-progress'))).toBe(progress);
        captured = true; await page.locator('#resume').tap(); await touchStart(); lastSample=-6; continue;
      }
      if (captured && s.player.reloadTicksRemaining === 0) {
        expect(s.player.mg+s.player.cannon).toBeGreaterThan(0);
        await expect(page.locator('#reload-status')).toBeHidden();
        await touchEnd(); await page.locator('#pause').tap(); await capture('reload-completed');
        completed = true; break;
      }
      lastSample = s.tick;
      const request = pilot(s), {dx,dy} = pointerOffsetForControls(request.turn,request.climb);
      expect(Math.hypot(dx,dy)).toBeLessThanOrEqual(36+1e-9);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x+dx,y:origin.y+dy,id:1}]});
    }
    expect(captured).toBe(true); expect(completed).toBe(true);
    const end = await read();
    await page.locator(end.phase === 'ended' ? '#result-home' : '#pause-home').tap();
    await expect(page.locator('#start')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await mkdir('test-results/evidence',{recursive:true});
    await writeFile('test-results/evidence/reload-route-state.json',JSON.stringify({captured,completed,errors,snapshot:await read()},null,2));
    if (!completed) await page.screenshot({path:'test-results/evidence/reload-route-failure.png'});
  }
});
