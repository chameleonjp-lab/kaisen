import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// This route exercises the real DOM adapter in both engines without claiming WebKit WebGL hardware coverage.
for (const viewport of [{width:320,height:568},{width:393,height:852},{width:568,height:320},{width:852,height:393}]) {
  test(`lever settings preserve legacy raw, rectangular preview and repeated saves ${viewport.width}x${viewport.height}`, async ({page,browserName})=>{
    await page.setViewportSize(viewport);
    const raw=JSON.stringify({version:1,controls:{fire:{x:.83,y:.84,size:96,opacity:.9},loop:{x:.83,y:.66,size:72,opacity:.78},accelerate:{x:.17,y:.84,size:76,opacity:.82},brake:{x:.17,y:.66,size:76,opacity:.82},bomb:{x:.39,y:.94,size:52,opacity:.88},torpedo:{x:.59,y:.94,size:52,opacity:.88}}});
    await page.addInitScript(raw=>{if(!localStorage.getItem('throttle-qa-seeded')){localStorage.setItem('kaisen-controls-v1',raw);localStorage.setItem('throttle-qa-seeded','yes');}},raw);
    await page.goto('/');await page.locator('#home-controls').tap();await page.locator('#control-mode').selectOption('normal');await page.locator('#control-target').selectOption('throttle');
    await expect(page.locator('#control-target option')).toHaveCount(5);await expect(page.locator('#control-target option[value="throttle"]')).toHaveText('速度レバー');
    await page.locator('#control-preview').scrollIntoViewIfNeeded();const rect=await page.locator('[data-control="throttle"]').boundingBox();expect(rect!.height).toBeGreaterThan(rect!.width*1.8);
    await page.locator('#control-cancel').tap();expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-v2'))).toBeNull();
    for(let i=0;i<2;i++){
      await page.locator('#home-controls').tap();await page.locator('#control-mode').selectOption('normal');await page.locator('#control-target').selectOption('throttle');
      await page.locator('#control-opacity').focus();await page.keyboard.press('ArrowLeft');await page.locator('#control-save').tap();await expect(page.locator('#control-settings')).toBeHidden();
    }
    expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-v1'))).toBe(raw);expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('kaisen-controls-v2')!).version)).toBe(2);
    await page.reload();await page.locator('#home-controls').tap();await page.locator('#control-mode').selectOption('normal');await page.locator('#control-target').selectOption('throttle');
    await page.evaluate(()=>document.documentElement.style.fontSize='200%');
    for(const id of ['control-x','control-y','control-size','control-opacity']){await page.locator('#'+id).scrollIntoViewIfNeeded();await expect(page.locator('#'+id)).toBeInViewport();}
    await expect(page.locator('#control-save')).toBeInViewport();await expect(page.locator('#control-close')).toBeInViewport();
    await mkdir('test-results/evidence',{recursive:true});await page.screenshot({path:`test-results/evidence/throttle-settings-${browserName}-${viewport.width}x${viewport.height}-200.png`});
    await page.locator('#control-cancel').tap();expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-v1'))).toBe(raw);
  });
}

test('native lever pointer capture, focused short keys and independent releases use shared DOM adapter',async({page,browserName})=>{
  await page.goto('/');
  await page.evaluate(async()=>{
    // Separate test-owned element; no mutation of live game state or production debug API.
    const {ThrottleControl}=await import('/src/throttle-control.ts');
    const element=document.createElement('div');element.id='qa-lever';element.role='slider';element.tabIndex=0;element.setAttribute('aria-label','検査用速度レバー');element.setAttribute('aria-valuemin','-100');element.setAttribute('aria-valuemax','100');
    Object.assign(element.style,{position:'fixed',left:'20px',top:'100px',width:'72px',height:'144px',zIndex:'99999',background:'#315667',touchAction:'none'});document.body.append(element);
    (window as any).__qaLever=new ThrottleControl(element,()=>true,()=>true);
  });
  const lever=page.locator('#qa-lever');await lever.focus();await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(()=>(window as any).__qaLever.sample(false))).toBe(1);
  expect(await page.evaluate(()=>(window as any).__qaLever.sample())).toBe(1);
  expect(await page.evaluate(()=>(window as any).__qaLever.sample())).toBe(0);
  await page.mouse.move(56,122);await page.mouse.down();await expect(lever).toHaveAttribute('aria-valuenow','100');
  await page.mouse.move(56,310);await expect(lever).toHaveAttribute('aria-valuenow','-100');await page.mouse.up();await expect(lever).toHaveAttribute('aria-valuenow','0');
  await page.keyboard.down('ArrowDown');await page.mouse.move(56,122);await page.mouse.down();await page.mouse.up();
  expect(await page.evaluate(()=>(window as any).__qaLever.sample())).toBe(-1);await page.keyboard.up('ArrowDown');expect(await page.evaluate(()=>(window as any).__qaLever.sample())).toBe(0);
  await page.keyboard.press('ArrowUp');await page.evaluate(()=>(window as any).__qaLever.clear());expect(await page.evaluate(()=>(window as any).__qaLever.sample())).toBe(0);
  await page.evaluate(()=>(window as any).__qaLever.dispose());
});

test('pending rollback is visible after reload and unchanged Save restores it without touching legacy',async({page})=>{
  const legacy='{"version":1,"controls":{"accelerate":{"x":0.17,"y":0.84,"size":76,"opacity":0.82}}}';
  const previous=JSON.stringify({version:2,controls:{fire:{x:.83,y:.84,size:96,opacity:.9},loop:{x:.83,y:.66,size:72,opacity:.78},throttle:{x:.17,y:.75,size:64,opacity:.82},bomb:{x:.39,y:.94,size:52,opacity:.88},torpedo:{x:.59,y:.94,size:52,opacity:.88}}});
  await page.addInitScript(({legacy,previous})=>{localStorage.setItem('kaisen-controls-v1',legacy);localStorage.setItem('kaisen-controls-v2','partial');localStorage.setItem('kaisen-controls-recovery-v1',JSON.stringify({version:1,previous:[{key:'kaisen-controls-v2',value:previous,next:'partial'}]}));},{legacy,previous});
  await page.goto('/');await page.locator('#home-controls').tap();await expect(page.locator('#control-storage-note')).toContainText('復元する必要');
  expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-v2'))).toBe('partial');
  await page.locator('#control-save').tap();await expect(page.locator('#control-settings')).toBeHidden();
  expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-v2'))).toBe(previous);expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-recovery-v1'))).toBeNull();expect(await page.evaluate(()=>localStorage.getItem('kaisen-controls-v1'))).toBe(legacy);
});

test('settings footer and close remain reachable at 200 percent CSS zoom',async({page},info)=>{
 await page.goto('/');await page.locator('#home-controls').click();await page.locator('#control-editor-touch').click();await page.locator('#control-mode').selectOption('normal');
 await page.addStyleTag({content:'html { zoom: 2; }'});
 await page.locator('#control-opacity').scrollIntoViewIfNeeded();await expect(page.locator('#control-opacity')).toBeInViewport();
 await page.locator('#control-save').scrollIntoViewIfNeeded();await expect(page.locator('#control-save')).toBeInViewport({ratio:1});
 const dialog=await page.locator('#control-settings').boundingBox(),viewport=page.viewportSize()!;expect(dialog!.x).toBeGreaterThanOrEqual(0);expect(dialog!.x+dialog!.width).toBeLessThanOrEqual(viewport.width);
 await page.screenshot({path:info.outputPath('lever-settings-css-zoom-200.png')});
 await page.locator('#control-cancel').click();await expect(page.locator('#control-settings')).toBeHidden();
});
