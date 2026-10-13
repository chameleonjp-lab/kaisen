import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { waitForPausedView } from './paused-view';
import { steerAndObserve } from './touch-command';

// A short, straight approach gives the image check its own live cue window.
// Long victory routes must not wait for screenshot readback before releasing a
// payload. This route uses only the ordinary stick and the product's real RAF.
async function captureLiveBombCue(page: Page, cdp: CDPSession, mode: string) {
  const origin = {x:100,y:420};
  const read = () => page.evaluate(() => (window as any).__kaisenReadState(false));
  await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{...origin,id:1}]});
  let lastTick = -6;
  let targetId: number | null = null;
  try {
    while (true) {
      if (lastTick >= 0) await page.waitForFunction(next => {
        const s = (window as any).__kaisenReadState('clock');
        return s.phase !== 'playing' || s.tick >= next;
      },lastTick+6,{polling:'raf'});
      const s = await read();
      expect(s.phase, 'The image approach uses uninterrupted live flight').toBe('playing');
      expect(s.elapsed, 'The straight approach is a short UI route').toBeLessThan(12);
      const ship = targetId === null
        ? s.ships.filter((candidate:any) => candidate.health > 0).sort((a:any,b:any) => a.position.z-b.position.z)[0]
        : s.ships.find((candidate:any) => candidate.id === targetId);
      expect(ship?.health).toBeGreaterThan(0);
      targetId = ship.id;
      // A horizontal intercept selects a heading for the moving last hull.
      // The initial altitude is retained, and no game state is written.
      const dx = ship.position.x-s.player.position.x, dz = ship.position.z-s.player.position.z;
      const vx = ship.velocity.x, vz = ship.velocity.z, speed = s.player.speed;
      const a = vx*vx+vz*vz-speed*speed, b = 2*(dx*vx+dz*vz), c = dx*dx+dz*dz;
      const intercept = (-b-Math.sqrt(b*b-4*a*c))/(2*a);
      expect(Number.isFinite(intercept) && intercept > 0).toBe(true);
      const heading = Math.atan2(-(dx+vx*intercept),-(dz+vz*intercept));
      const error = Math.atan2(Math.sin(heading-s.player.yaw),Math.cos(heading-s.player.yaw));
      if (Math.abs(error) < .0015) break;
      const turn = Math.max(-.15,Math.min(.15,-error*2/.82));
      const accepted = await steerAndObserve(page,cdp,origin,turn,0);
      expect(accepted.phase).toBe('playing');
      lastTick = accepted.tick;
    }
    const neutral = await steerAndObserve(page,cdp,origin,0,0);
    expect(neutral.phase).toBe('playing');
    const before = await page.evaluate(target => new Promise<any>((resolve,reject) => {
      let frame = 0;
      const timeout = setTimeout(() => {cancelAnimationFrame(frame);reject(new Error('No live green cue in the short straight approach'));},15000);
      const world = (s:any) => ({phase:s.phase,tick:s.tick,elapsed:s.elapsed,player:s.player,
        allies:s.allies,enemies:s.enemies,ships:s.ships,stats:s.stats,ordnance:s.ordnance,
        result:s.result,deathCause:s.deathCause,allyRespawnAt:s.allyRespawnAt});
      const poll = () => {
        const readState = (window as any).__kaisenReadState;
        const first = readState(false), button = document.getElementById('bomb')!;
        const ready = button.dataset.ready === 'true' &&
          (first.bombGuide?.kind === 'direct' || first.bombGuide?.kind === 'blast') &&
          first.bombGuide.affected.some((hit:any) => hit.shipId === target && hit.damage > 0);
        if (first.phase !== 'playing' || first.elapsed >= 12) {
          clearTimeout(timeout);reject(new Error(`Straight image approach ended without a cue at tick ${first.tick}`));return;
        }
        if (!ready) {frame=requestAnimationFrame(poll);return;}
        const capture = {lostGreen:false,changes:[] as {tick:number;ready:string|undefined}[],observer:null as MutationObserver|null};
        capture.observer = new MutationObserver(() => {
          const clock = readState('clock');
          capture.changes.push({tick:clock.tick,ready:button.dataset.ready});
          if (button.dataset.ready !== 'true') capture.lostGreen = true;
        });
        capture.observer.observe(button,{attributes:true,attributeFilter:['data-ready']});
        (window as any).__qaBombCueCapture = capture;
        const second = readState(false);
        clearTimeout(timeout);
        resolve({snapshot:first,ready:button.dataset.ready,text:document.getElementById('bomb-hint')!.textContent,
          observationPreservesWorld:JSON.stringify(world(first)) === JSON.stringify(world(second))});
      };
      poll();
    }),targetId);
    expect(before.observationPreservesWorld).toBe(true);
    expect(before.ready).toBe('true');
    expect(['命中見込み','至近弾圏内']).toContain(before.text);
    expect(before.snapshot.controlsInput.steerPointer).toBe(neutral.steerPointer);
    expect(before.snapshot.controlsInput.turn).toBe(0);
    expect(before.snapshot.controlsInput.climb).toBe(0);
    expect(before.snapshot.player.bombs).toBe(2);
    let capture: {data:string};
    let after: any;
    try {
      // One native screenshot request; no hidden pause, DOM recoloring, scene
      // replacement or clock override. File I/O follows the live capture.
      capture = await cdp.send('Page.captureScreenshot', {format:'png',fromSurface:true,captureBeyondViewport:false});
    } finally {
      after = await page.evaluate(() => {
        const readState = (window as any).__kaisenReadState;
        const first = readState(false), second = readState(false);
        const world = (s:any) => ({phase:s.phase,tick:s.tick,elapsed:s.elapsed,player:s.player,
          allies:s.allies,enemies:s.enemies,ships:s.ships,stats:s.stats,ordnance:s.ordnance,
          result:s.result,deathCause:s.deathCause,allyRespawnAt:s.allyRespawnAt});
        const capture = (window as any).__qaBombCueCapture;
        capture?.observer.disconnect();delete (window as any).__qaBombCueCapture;
        return {snapshot:first,ready:document.getElementById('bomb')!.dataset.ready,
          text:document.getElementById('bomb-hint')!.textContent,lostGreen:capture?.lostGreen ?? true,
          changes:capture?.changes ?? [],observationPreservesWorld:JSON.stringify(world(first)) === JSON.stringify(world(second))};
      });
    }
    await page.waitForFunction(next => {
      const clock = (window as any).__kaisenReadState('clock');
      return clock.phase !== 'playing' || clock.tick > next;
    },after.snapshot.tick,{polling:'raf'});
    const clock = await page.evaluate(() => (window as any).__kaisenReadState('clock'));
    await mkdir('test-results/evidence',{recursive:true});
    await writeFile(`test-results/evidence/bomb-ready-${mode}.png`,Buffer.from(capture!.data,'base64'));
    await writeFile(`test-results/evidence/bomb-ready-${mode}.json`,JSON.stringify({
      note:'Short live straight approach with ordinary CDP touch input and native PNG capture. Green-window validity is asserted from the recorded before/after observations and DOM changes. No pause, world/clock/result injection, or green-DOM substitution. Image review is separate from JSON validation.',
      mode,viewport:page.viewportSize(),targetId,neutral,before,after,clock,
    },null,2));
    expect(after.observationPreservesWorld).toBe(true);
    expect(after.lostGreen, 'The actual DOM cue remains green throughout image capture').toBe(false);
    expect(after.ready).toBe('true');
    expect(['命中見込み','至近弾圏内']).toContain(after.text);
    expect(after.snapshot.phase).toBe('playing');
    expect(after.snapshot.bombGuide.affected.some((hit:any) => hit.shipId === targetId && hit.damage > 0)).toBe(true);
    expect(after.snapshot.controlsInput.steerPointer).toBe(neutral.steerPointer);
    expect(after.snapshot.controlsInput.turn).toBe(0);expect(after.snapshot.controlsInput.climb).toBe(0);
    expect(after.snapshot.player.bombs).toBe(2);
    expect(after.snapshot.tick).toBeGreaterThanOrEqual(before.snapshot.tick);
    expect(after.snapshot.elapsed).toBeCloseTo(after.snapshot.tick/60,9);
    expect(clock.phase).toBe('playing');expect(clock.tick).toBeGreaterThan(after.snapshot.tick);
    expect(clock.elapsed).toBeCloseTo(clock.tick/60,9);
  } finally {
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
}

for (const mode of ['easy','normal']) test(`${mode} bomb cue keeps ammo/reload and pause state legible through actual buttons`,async({page,context})=>{
  await page.setViewportSize({width:393,height:648});
  const read=()=>page.evaluate(()=>(window as any).__kaisenReadState(false));
  await page.goto('/');await expect(page.locator('#start')).toBeEnabled();
  await page.locator(`input[value="${mode}"]`).check();await page.locator('#start').tap();
  await expect(page.locator('#bomb-ammo')).toHaveText('残り2発');
  const reach=await page.locator('#bomb').evaluate(el=>{const r=el.getBoundingClientRect();return {height:r.height,reachable:el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),textFits:el.scrollHeight<=el.clientHeight+1};});
  expect(reach.height).toBeGreaterThanOrEqual(44);expect(reach.reachable).toBe(true);expect(reach.textFits).toBe(true);
  const cdp = await context.newCDPSession(page);
  await captureLiveBombCue(page,cdp,mode);
  await page.locator('#bomb').tap();await expect(page.locator('#bomb-ammo')).toHaveText('残り1発');
  await expect.poll(async()=>(await read()).player.payloadCooldown).toBe(0);
  await page.locator('#bomb').tap();await expect(page.locator('#bomb-ammo')).toContainText('装填');
  await expect(page.locator('#bomb-hint')).toHaveText('装填中');await expect(page.locator('#bomb')).toHaveAttribute('data-ready','false');
  await page.locator('#pause').tap();await expect(page.locator('#bomb-hint')).toHaveText('停止中');
  await expect(page.locator('#bomb')).toHaveAttribute('data-ready','false');
  const paused=await read();await page.waitForTimeout(300);const settled=await read();
  expect(settled.tick).toBe(paused.tick);expect(settled.player.bombReloadTicks).toBe(paused.player.bombReloadTicks);expect(settled.ordnance).toEqual(paused.ordnance);
  await waitForPausedView(page,{tick:paused.tick,cssWidth:393,cssHeight:648});
  await mkdir('test-results/evidence',{recursive:true});
  await page.screenshot({path:`test-results/evidence/bomb-reload-${mode}.png`,style:'#pause-screen {visibility:hidden!important}'});
  await writeFile(`test-results/evidence/bomb-reload-${mode}.json`,JSON.stringify({note:'Actual UI drops and pause. Only pause menu hidden for screenshot; no game-state changes.',reach,paused,settled},null,2));
  await page.locator('#resume').tap();await expect(page.locator('#bomb-hint')).toHaveText('装填中');
  await expect(page.locator('#bomb')).toHaveAttribute('data-ready','false');
});
