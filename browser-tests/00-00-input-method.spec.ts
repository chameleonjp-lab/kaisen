import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const read = (page:any) => page.evaluate(() => (window as any).__kaisenReadState(false));

test('changing from touch to mouse or back cannot move a pressed home control', async ({page}) => {
  await page.goto('/'); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#app')).toHaveAttribute('data-input','touch');
  const radio=page.locator('input[value="normal"]'); const before=await radio.boundingBox(); expect(before).not.toBeNull();
  await page.mouse.move(before!.x+before!.width/2,before!.y+before!.height/2); await page.mouse.down();
  await expect(page.locator('#app')).toHaveAttribute('data-input','touch');
  expect(await radio.boundingBox()).toEqual(before);
  await page.mouse.up(); await expect(radio).toBeChecked();
  await expect(page.locator('#app')).toHaveAttribute('data-input','keyboard');
  await page.locator('#home-controls').click(); await expect(page.locator('#control-editor-keyboard')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#control-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('#control-save')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#control-close')).toBeFocused();
  await page.locator('#control-close').click();
  await page.locator('#home-rules').click(); await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#rules-back')).toBeFocused(); await page.keyboard.press('Escape');
  await page.locator('#start').tap();
  await expect.poll(async()=>page.evaluate(()=>(window as any).__kaisenReadState(false).phase)).toBe('playing');
  await expect(page.locator('#app')).toHaveAttribute('data-input','touch');
  await page.locator('#pause').click(); await page.locator('#pause-home').click();
  await page.locator('#start').tap();
  await expect.poll(async()=>page.evaluate(()=>(window as any).__kaisenReadState(false).phase)).toBe('playing');
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
    const recoveries:unknown[]=[];
    await page.keyboard.down('Space');
    try {
      const deadline=Date.now()+15000;
      while(Date.now()<deadline) {
        const snapshot=await read(page);
        if(snapshot.tick>frozen.tick+12)break;
        if(snapshot.phase==='paused') {
          // CI32 shows the deliberate GPU watchdog pause recovered at tick17.
          // A paused clock cannot advance until a real resume action is sent.
          expect(snapshot.pauseReasons).toEqual(['render']); expect(recoveries.length).toBe(0);
          await page.keyboard.up('Space');
          await expect(page.locator('#pause-reason')).toHaveText('描画が復帰しました。操作して再開できます');
          await expect(page.locator('#resume')).toBeEnabled();
          const tick=(await read(page)).tick; await page.waitForTimeout(100);expect((await read(page)).tick).toBe(tick);
          recoveries.push({tick,snapshot}); await page.keyboard.press('KeyP');
          await expect.poll(async()=>(await read(page)).phase).toBe('playing');
          await page.keyboard.down('Space');
        } else expect(snapshot.phase).toBe('playing');
        await page.waitForTimeout(25);
      }
      expect((await read(page)).tick).toBeGreaterThan(frozen.tick+12);
    } finally {
      await page.keyboard.up('Space');
      await mkdir('test-results/evidence',{recursive:true});
      await writeFile('test-results/evidence/custom-key-flight.json',JSON.stringify({recoveries,frozen,snapshot:await read(page)},null,2));
    }
    await page.keyboard.up('Space'); expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
    await page.keyboard.press('KeyP'); await page.locator('#pause-home').click();
  });
});
