import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const read = (page:any) => page.evaluate(() => (window as any).__kaisenReadState(false));

test('both modes show zero-based tallies, clear payloads and paused rules without resuming', async ({ page }) => {
  test.setTimeout(60000); await page.setViewportSize({ width:393, height:648 });
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  for (const mode of ['easy','normal']) {
    await page.locator(`input[value="${mode}"]`).check(); await page.locator('#start').tap();
    await expect(page.locator('#enemy-count')).toHaveText('0'); await expect(page.locator('#ship-count')).toHaveText('0');
    await expect(page.locator('#bomb-ammo')).toHaveText('残り2発'); await expect(page.locator('#torpedo-ammo')).toHaveText('残り1発');
    const rects = await page.evaluate(() => Object.fromEntries(['enemy-count','game-sound','pause','ship-count','bomb','torpedo'].map(id => { const r=document.getElementById(id)!.getBoundingClientRect(); return [id,{x:r.x,y:r.y,w:r.width,h:r.height}]; })));
    expect(rects['enemy-count'].x).toBeLessThan(rects['game-sound'].x);
    expect(rects['game-sound'].x+rects['game-sound'].w).toBeLessThanOrEqual(rects.pause.x);
    expect(rects.pause.x+rects.pause.w).toBeLessThanOrEqual(rects['ship-count'].x);
    for (const name of ['bomb','torpedo']) { expect(rects[name].y).toBeGreaterThan(648*.8); expect(rects[name].w).toBeGreaterThanOrEqual(44); }
    await page.locator('#pause').tap(); const frozen = await read(page);
    await page.locator('#pause-rules').tap(); await expect(page.locator('#rules-guide')).toBeVisible();
    await page.locator('#rules-content').focus();
    await page.keyboard.press('Space'); await page.keyboard.press('KeyZ');
    await page.waitForTimeout(100); const after = await read(page);
    await expect(page.locator('#rules-guide')).toBeVisible();
    expect(after.tick).toBe(frozen.tick); expect(after.stats).toEqual(frozen.stats); expect(after.player.bombs).toBe(2);
    await page.keyboard.press('Escape'); await expect(page.locator('#pause-screen')).toBeVisible();
    expect((await read(page)).phase).toBe('paused'); await expect(page.locator('#pause-rules')).toBeFocused();
    await mkdir('test-results/evidence',{recursive:true});
    await page.screenshot({path:`test-results/evidence/feedback-${mode}-393x648.png`,style:'#pause-screen {visibility:hidden!important}'});
    await page.locator('#pause-home').tap();
  }
});

test.describe('custom desktop input', () => {
  test.use({isMobile:false,hasTouch:false,viewport:{width:1280,height:800}});
  test('committed custom keys fire and pause, old keys stop firing, rules own their keys', async ({page}) => {
    await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#home-controls').click();
    await page.locator('[data-key-action="fire"]').click(); await page.keyboard.press('KeyF');
    await page.locator('[data-key-action="pause"]').click(); await page.keyboard.press('KeyP');
    await page.locator('#control-save').click(); await page.locator('input[value="normal"]').check();
    await page.locator('#start').click(); await page.keyboard.down('KeyF');
    await expect.poll(async()=>(await read(page)).stats.shots).toBeGreaterThan(0);
    await page.keyboard.up('KeyF'); await page.keyboard.press('KeyP');
    await expect(page.locator('#pause-screen')).toBeVisible(); const frozen=await read(page);
    await page.locator('#pause-rules').click(); await page.keyboard.press('KeyP'); await page.keyboard.press('KeyF');
    expect((await read(page)).tick).toBe(frozen.tick); expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
    await page.keyboard.press('Escape'); await page.keyboard.press('KeyP');
    await expect.poll(async()=>(await read(page)).phase).toBe('playing');
    await page.keyboard.down('Space'); await expect.poll(async()=>(await read(page)).tick).toBeGreaterThan(frozen.tick+12);
    await page.keyboard.up('Space'); expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
    await page.keyboard.press('KeyP'); await page.locator('#pause-home').click();
  });
});
