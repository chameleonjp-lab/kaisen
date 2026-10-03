import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { steerAndObserve, releasePayloadAndObserve } from './touch-command';
const read=(page:any)=>page.evaluate(()=>(window as any).__kaisenReadState());

test.afterEach(async({page},info)=>{
  await mkdir('test-results/evidence',{recursive:true});
  await writeFile('test-results/evidence/naval-payload-final-state.json',JSON.stringify({status:info.status,snapshot:await read(page).catch(()=>null)},null,2));
});


test('payload controls preserve steering, reject unsafe torpedo release, and rearm on the real paused clock',async({page,context})=>{
  test.setTimeout(90000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.locator('#start')).toBeEnabled();
  await page.locator('input[value="normal"]').check();await page.locator('#start').tap();
  for(const id of ['fire','loop','accelerate','brake','bomb','torpedo']) {
    const hit=await page.locator(`#${id}`).evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
    expect(hit,`${id} center is physically reachable`).toBe(true);
  }
  await page.locator('#torpedo').tap();
  await expect(page.locator('#announcement')).toContainText('魚雷');
  expect((await read(page)).player.torpedoes).toBe(1);
  const cdp=await context.newCDPSession(page),origin={x:180,y:500};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...origin,id:1}]});
  await steerAndObserve(page,cdp,origin,0,0);
  expect(await releasePayloadAndObserve(page,cdp,origin,0,0,'bomb')).toBe(true);
  await page.waitForFunction(()=>{const s=(window as any).__kaisenReadState();return s.player.payloadCooldown<=0;});
  expect(await releasePayloadAndObserve(page,cdp,origin,0,0,'bomb')).toBe(true);
  await expect.poll(async()=>(await read(page)).player.bombReloadTicks).toBeGreaterThan(0);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.locator('#pause').tap();const paused=await read(page);
  await page.waitForTimeout(600);expect((await read(page)).player.bombReloadTicks).toBe(paused.player.bombReloadTicks);
  expect((await read(page)).ordnance).toEqual(paused.ordnance);
  await page.locator('#resume').tap();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...origin,id:1}]});
  let last=-6;
  while(true) {
    const s=await read(page);expect(s.phase).toBe('playing');expect(s.elapsed).toBeLessThan(30);
    if(s.player.position.y<80&&Math.abs(s.player.pitch)<.2)break;
    if(s.tick-last<6){await page.waitForTimeout(30);continue;}last=s.tick;
    const climb=Math.max(-.65,Math.min(.3,(65-s.player.position.y)/180));
    await steerAndObserve(page,cdp,origin,0,climb);
  }
  await steerAndObserve(page,cdp,origin,0,0);
  await expect(page.locator('#torpedo')).toHaveAttribute('data-ready','true');
  expect(await releasePayloadAndObserve(page,cdp,origin,0,0,'torpedo')).toBe(true);
  await expect.poll(async()=>(await read(page)).ordnance.some((o:any)=>o.owner===1&&o.kind==='torpedo'&&o.phase==='water'),{timeout:12000}).toBe(true);
  const water=await read(page);
  expect(water.player.health).toBeGreaterThan(0);expect(water.player.bombs).toBe(2);
  expect(water.controlsInput.steerPointer).not.toBeNull();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.locator('#pause').tap();
  await mkdir('test-results/evidence',{recursive:true});
  await page.screenshot({path:'test-results/evidence/torpedo-water-flight.png',style:'#pause-screen {visibility:hidden!important}'});
  await writeFile('test-results/evidence/naval-payload-route.json',JSON.stringify({note:'Actual touch controls and real simulation clock. Screenshot is explicitly paused with only pause menu hidden. No game-state injection.',paused,water},null,2));
  await page.locator('#pause-restart').tap();const retry=await read(page);
  expect(retry.player.bombs).toBe(2);expect(retry.player.torpedoes).toBe(1);expect(retry.ordnance).toHaveLength(0);
  expect(errors).toEqual([]);
});
