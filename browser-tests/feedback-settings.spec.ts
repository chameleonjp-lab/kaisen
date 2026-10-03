import { test, expect } from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const read=(page:any)=>page.evaluate(()=>(window as any).__kaisenReadState());

async function reachSeaResult(page:any, viewport:{width:number;height:number}) {
  const recoveries:unknown[]=[];
  const deadline=Date.now()+45000;
  await page.keyboard.down('ArrowDown');
  try {
    while(Date.now()<deadline) {
      const s=await page.evaluate(()=>(window as any).__kaisenReadState(false));
      if(s.phase==='ended')break;
      if(s.phase==='paused') {
        // CI28 reached the visible recovered-GPU dialog. The held key was
        // correctly cleared by Pause; continuing to wait cannot fly the plane.
        // Exercise the actual recovery button once, without changing the game.
        expect(s.pauseReasons).toEqual(['render']);
        expect(recoveries.length,'Repeated render interruptions remain a failure').toBe(0);
        await page.keyboard.up('ArrowDown');
        await expect(page.locator('#pause-reason')).toHaveText('描画が復帰しました。操作して再開できます');
        await expect(page.locator('#resume')).toBeEnabled();
        const frozen=(await read(page)).tick;
        await page.waitForTimeout(100);expect((await read(page)).tick).toBe(frozen);
        recoveries.push({tick:frozen,snapshot:await read(page)});
        await page.locator('#resume').tap();
        await expect.poll(async()=>(await read(page)).phase).toBe('playing');
        await page.keyboard.down('ArrowDown');
      } else expect(s.phase).toBe('playing');
      await page.waitForTimeout(50);
    }
    await expect(page.locator('#result')).toBeVisible();
  } finally {
    await page.keyboard.up('ArrowDown');
    await mkdir('test-results/evidence',{recursive:true});
    await writeFile(`test-results/evidence/settings-flight-${viewport.width}x${viewport.height}.json`,JSON.stringify({recoveries,snapshot:await read(page).catch(()=>null)},null,2));
  }
}

for(const viewport of [{width:393,height:852},{width:568,height:320}]) {
 test(`control layout settings save cancel and restore across screens ${viewport.width}x${viewport.height}`,async({page})=>{
  test.setTimeout(90000);await page.setViewportSize(viewport);await page.goto('/');await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#home-controls').tap();await expect(page.locator('#control-settings')).toBeVisible();
  await page.locator('#control-mode').selectOption('normal');
  await expect(page.locator('#control-target option')).toHaveCount(6);
  await expect(page.locator('#control-target option[value="bomb"]')).toHaveText('爆弾');
  await expect(page.locator('#control-target option[value="torpedo"]')).toHaveText('魚雷');
  await page.locator('#control-target').selectOption('fire');
  await page.locator('#control-x').focus();await page.keyboard.press('ArrowLeft');
  const wanted=await page.locator('#control-x').inputValue();await page.locator('#control-save').tap();
  await expect(page.locator('#control-settings')).not.toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('kaisen-controls-v1')!).controls.fire.x)).toBe(Number(wanted)/100);
  await page.locator('input[value="normal"]').check();await page.locator('#start').tap();await page.locator('#pause').tap();
  const paused=await read(page);await page.locator('#pause-controls').tap();
  await expect(page.locator('#control-mode')).toBeDisabled();await expect(page.locator('#control-mode')).toHaveValue('normal');
  await expect(page.locator('#control-x')).toHaveValue(wanted);
  await page.locator('#control-reset').tap();await page.locator('#control-cancel').tap();
  expect((await read(page)).tick).toBe(paused.tick);await expect(page.locator('#pause-screen')).toBeVisible();
  await page.locator('#pause-controls').tap();await expect(page.locator('#control-x')).toHaveValue(wanted);
  await mkdir('test-results/evidence',{recursive:true});
  const submitted=(await read(page)).render.queue.submittedCount;
  await expect.poll(async()=>(await read(page)).render.queue.completedCount).toBeGreaterThanOrEqual(submitted+1);
  await page.screenshot({path:`test-results/evidence/settings-${viewport.width}x${viewport.height}.png`});
  await page.locator('#control-close').tap();await page.locator('#resume').tap();
  await reachSeaResult(page,viewport);
  await expect(page.locator('#result-reason')).toContainText('海面');await page.locator('#result-controls').tap();
  await expect(page.locator('#control-mode')).toBeEnabled();await page.locator('#control-close').tap();
  await page.locator('#result-home').tap();await page.reload();await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#home-controls').tap();await page.locator('#control-mode').selectOption('normal');
  await expect(page.locator('#control-x')).toHaveValue(wanted);
 });
}

test('capture failure and release over another control recover without restarting flight',async({page})=>{
 await page.goto('/');await expect(page.locator('#start')).toBeEnabled();await page.locator('input[value="normal"]').check();await page.locator('#start').tap();
 // Fault injection is confined to the browser capture API, not the game world.
 await page.evaluate(()=>{document.querySelector<HTMLCanvasElement>('#flight')!.setPointerCapture=()=>{throw new DOMException('capture unavailable','InvalidStateError');};});
 await page.mouse.move(180,500);await page.mouse.down();await page.mouse.move(210,500);
 expect((await read(page)).controlsInput.turn).toBeGreaterThan(.7);
 const box=await page.locator('#fire').boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.up();
 expect((await read(page)).controlsInput.steerPointer).toBe(null);expect((await read(page)).controlsInput.turn).toBe(0);
 await page.evaluate(()=>{delete (document.querySelector('#flight') as any).setPointerCapture;});
 await page.mouse.move(180,500);await page.mouse.down();await page.mouse.move(150,500);
 expect((await read(page)).controlsInput.turn).toBeLessThan(-.7);await page.mouse.up();
 await page.locator('#pause').tap();await page.locator('#pause-controls').tap();
 const frozen=await read(page);await expect(page.locator('#control-cancel')).toBeFocused();
 await page.keyboard.press('Space');expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
 // Space activates the focused native Cancel button; it must not fire the aircraft.
 await expect(page.locator('#control-settings')).not.toBeVisible();await page.locator('#resume').tap();
 expect((await read(page)).controlsInput.steerPointer).toBe(null);
 await mkdir('test-results/evidence',{recursive:true});await writeFile('test-results/evidence/input-recovery.json',JSON.stringify({note:'Actual mouse path with simulated capture API failure; no world mutation; Safari cause remains unconfirmed',state:await read(page)},null,2));
});
