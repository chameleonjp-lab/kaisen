import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

for (const mode of ['easy','normal']) test(`${mode} bomb cue keeps ammo/reload and pause state legible through actual buttons`,async({page})=>{
  await page.setViewportSize({width:393,height:648});
  const read=()=>page.evaluate(()=>(window as any).__kaisenReadState(false));
  await page.goto('/');await expect(page.locator('#start')).toBeEnabled();
  await page.locator(`input[value="${mode}"]`).check();await page.locator('#start').tap();
  await expect(page.locator('#bomb-ammo')).toHaveText('残り2発');
  const reach=await page.locator('#bomb').evaluate(el=>{const r=el.getBoundingClientRect();return {height:r.height,reachable:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),textFits:el.scrollHeight<=el.clientHeight+1};});
  expect(reach.height).toBeGreaterThanOrEqual(44);expect(reach.reachable).toBe(true);expect(reach.textFits).toBe(true);
  await page.locator('#bomb').tap();await expect(page.locator('#bomb-ammo')).toHaveText('残り1発');
  await expect.poll(async()=>(await read()).player.payloadCooldown).toBe(0);
  await page.locator('#bomb').tap();await expect(page.locator('#bomb-ammo')).toContainText('装填');
  await expect(page.locator('#bomb-hint')).toHaveText('装填中');await expect(page.locator('#bomb')).toHaveAttribute('data-ready','false');
  await page.locator('#pause').tap();await expect(page.locator('#bomb-hint')).toHaveText('停止中');
  await expect(page.locator('#bomb')).toHaveAttribute('data-ready','false');
  const paused=await read();await page.waitForTimeout(300);const settled=await read();
  expect(settled.tick).toBe(paused.tick);expect(settled.player.bombReloadTicks).toBe(paused.player.bombReloadTicks);expect(settled.ordnance).toEqual(paused.ordnance);
  await mkdir('test-results/evidence',{recursive:true});
  await page.screenshot({path:`test-results/evidence/bomb-reload-${mode}.png`,style:'#pause-screen {visibility:hidden!important}'});
  await writeFile(`test-results/evidence/bomb-reload-${mode}.json`,JSON.stringify({note:'Actual UI drops and pause. Only pause menu hidden for screenshot; no game-state changes.',reach,paused,settled},null,2));
  await page.locator('#resume').tap();await expect(page.locator('#bomb-hint')).toHaveText('装填中');
  await expect(page.locator('#bomb')).toHaveAttribute('data-ready','false');
});
