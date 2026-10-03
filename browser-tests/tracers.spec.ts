import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
test.use({deviceScaleFactor:3});
test('aircraft tracers keep CSS width at high DPR and orientation changes in actual flight',async({page})=>{
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const read=()=>page.evaluate(()=>(window as any).__kaisenReadState());
  await page.goto('/');await expect(page.locator('#start')).toBeEnabled();
  await page.locator('input[value="normal"]').check();await page.locator('#start').tap();
  await expect.poll(async()=>(await read()).phase).toBe('playing');
  await page.keyboard.down('Space');
  await expect.poll(async()=>(await read()).render.aircraftTracers.segments).toBeGreaterThanOrEqual(4);
  await page.locator('#pause').tap();await page.keyboard.up('Space');
  await expect.poll(async()=>(await read()).phase).toBe('paused');
  await mkdir('test-results/evidence',{recursive:true});
  const records=[];
  for(const size of [{width:393,height:852},{width:852,height:393}]) {
    await page.setViewportSize(size);
    const submitted=(await read()).render.queue.submittedCount;
    await expect.poll(async()=>(await read()).render.queue.completedCount).toBeGreaterThanOrEqual(submitted+1);
    const s=await read(),tracers=s.render.aircraftTracers;
    expect(tracers.segments).toBeGreaterThan(0);expect(tracers.segments).toBeLessThanOrEqual(tracers.capacity);
    expect(tracers.corePx).toBe(1.5);expect(tracers.outlinePx).toBe(2.5);expect(tracers.depthTest).toBe(true);
    expect(tracers.resolution).toEqual([size.width,size.height]);expect(s.render.pixelRatio).toBe(1.5);
    expect(s.stats.shots).toBeGreaterThan(0);
    const name=`aircraft-tracers-${size.width}x${size.height}`;
    await page.screenshot({path:`test-results/evidence/${name}.png`,style:'#pause-screen{visibility:hidden!important}'});
    records.push({name,viewport:size,state:s});
  }
  await writeFile('test-results/evidence/aircraft-tracers.json',JSON.stringify({note:'Actual player firing followed by real Pause. Only pause menu hidden for screenshots. Chromium DPR3 emulation with renderer cap1.5, not physical iPhone.',records},null,2));
  await page.locator('#resume').tap();await expect.poll(async()=>(await read()).phase).toBe('playing');
  expect(errors).toEqual([]);
});
