import { createBrowserMissionPilot } from '../tests/helpers/mission-browser-pilot';
import { steerAndObserve } from './touch-command';
import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';

test.use({ trace: 'off' });
test('real touch flight shows a filling reload ring, freezes it, then refills or clears all targets', async ({page, context}) => {
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
  const cdp = await context.newCDPSession(page), pilot = createBrowserMissionPilot();
  const origin = {x:90,y:650};
  const touchStart = () => cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...origin,id:1}]});
  const touchEnd = () => cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.locator('#start').tap(); await touchStart();
  let lastSample = -6, captured = false, completed = false, clearDuringReload = false;
  let capturedRemaining = 360, progressAdvanced = false;
  try {
    while (true) {
      if (lastSample >= 0) await page.waitForFunction(next => {
        const s=(window as any).__kaisenReadState(); return s.phase !== 'playing' || s.tick >= next;
      },lastSample+6,{polling:'raf'});
      const s = await read();
      if (captured && s.player.reloadTicksRemaining < capturedRemaining) progressAdvanced = true;
      if (captured && s.phase === 'playing' && s.player.reloadTicksRemaining > 0) {
        const shown = Number(await page.locator('#reload-status').getAttribute('data-progress'));
        expect(shown).toBeGreaterThanOrEqual(1 - s.player.reloadTicksRemaining / 360);
        expect(shown).toBeLessThanOrEqual(1);
      }
      if (captured && s.phase === 'ended') {
        // All-clear has priority over waiting for ammunition. An ally can land
        // the final hit while reloading, which is a valid mission completion.
        expect(s.result?.outcome).toBe('victory');
        expect([...s.enemies,...s.ships].every(t => t.health <= 0)).toBe(true);
        await expect(page.locator('#result-title')).toHaveText('作戦成功');
        if (s.player.reloadTicksRemaining > 0) {
          expect(s.player.mg).toBe(0); expect(s.player.cannon).toBe(0);
          await capture('all-clear-during-reload');
          await page.waitForTimeout(650);
          const frozen = await read();
          expect(frozen.tick).toBe(s.tick); expect(frozen.elapsed).toBe(s.elapsed);
          expect(frozen.player.mg).toBe(0); expect(frozen.player.cannon).toBe(0);
          expect(frozen.player.reloadTicksRemaining).toBe(s.player.reloadTicksRemaining);
          expect(frozen.stats.shots).toBe(s.stats.shots);
          clearDuringReload = true;
        } else {
          expect(s.player.mg + s.player.cannon).toBeGreaterThan(0);
          await capture('reload-completed-result'); completed = true;
        }
        break;
      }
      expect(s.phase, 'Legal reload route stays in active flight').toBe('playing');
      expect(s.elapsed).toBeLessThan(145);
      if (!captured && s.player.reloadTicksRemaining > 0) {
        await touchEnd(); await page.locator('#pause').tap();
        const frozen = await read();
        capturedRemaining = frozen.player.reloadTicksRemaining;
        // Require a completed rendering of this paused state, not a previous
        // GPU frame whose canvas may predate the reload event.
        const submittedBefore = frozen.render.queue.submittedCount;
        await expect.poll(async () => (await read()).render.queue.completedCount)
          .toBeGreaterThanOrEqual(submittedBefore + 1);
        await expect(page.locator('#reload-status')).toContainText('再装填中 あと');
        const progress = Number(await page.locator('#reload-status').getAttribute('data-progress'));
        expect(progress).toBeGreaterThanOrEqual(0); expect(progress).toBeLessThan(1);
        expect(progress).toBeCloseTo(1 - capturedRemaining / 360, 8);
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
      // Empty magazines are a reason to disengage: climb and bank using the
      // same legal stick instead of pursuing a reinforcement head-on unarmed.
      const request = s.player.reloadTicksRemaining > 0
        ? {turn:.45,climb:.8} : pilot(s);
      const {dx,dy} = pointerOffsetForControls(request.turn,request.climb);
      expect(Math.hypot(dx,dy)).toBeLessThanOrEqual(36+1e-9);
      lastSample = (await steerAndObserve(page,cdp,origin,request.turn,request.climb)).tick;
    }
    expect(captured).toBe(true); expect(progressAdvanced).toBe(true);
    expect(completed || clearDuringReload).toBe(true);
    const end = await read();
    await page.locator(end.phase === 'ended' ? '#result-home' : '#pause-home').tap();
    await expect(page.locator('#start')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await mkdir('test-results/evidence',{recursive:true});
    await writeFile('test-results/evidence/reload-route-state.json',JSON.stringify({captured,completed,clearDuringReload,capturedRemaining,progressAdvanced,errors,snapshot:await read()},null,2));
    if (!completed && !clearDuringReload) await page.screenshot({path:'test-results/evidence/reload-route-failure.png'});
  }
});
