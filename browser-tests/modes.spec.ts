import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { expectScoreResult, inspectScoreResultLayout } from './score-result';

const read = (page: Page) => page.evaluate(() => (window as any).__kaisenReadState());
async function openNormal(page: Page) {
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('input[value="easy"]')).toBeChecked();
  await page.locator('input[value="normal"]').check();
  await expect(page.locator('#mode-guide')).toContainText('手動射撃');
  await page.locator('#start').tap();
  await expect.poll(async () => (await read(page)).phase).toBe('playing');
  expect((await read(page)).mode).toBe('normal');
}
async function center(page: Page, selector: string, id: number) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, id };
}
async function evidence(page: Page, name: string, pausedFlight = false) {
  await mkdir('test-results/evidence', { recursive: true });
  await page.screenshot({ path: `test-results/evidence/${name}.png`,
    ...(pausedFlight ? { style: '#pause-screen { visibility: hidden !important; }' } : {}),
  });
  await writeFile(`test-results/evidence/${name}.json`, JSON.stringify({
    environment: 'Chromium touch viewport emulation, not iPhone hardware',
    note: pausedFlight ? 'Paused through the real menu; waited for a newly completed GPU frame. Only the pause menu is hidden for the screenshot.' : 'Unmodified visible screen',
    viewport: page.viewportSize(), state: await read(page),
  }, null, 2));
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  (page as any).__modeErrors = errors;
});
test.afterEach(async ({ page }) => { expect((page as any).__modeErrors).toEqual([]); });

for (const viewport of [{ width: 393, height: 852 }, { width: 852, height: 393 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
  test(`Normal visible controls and bore sight ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await openNormal(page);
    await expect(page.locator('#hud-mode')).toHaveText('ノーマル');
    // One active-screen read captures actual hit ownership before the modal covers it.
    const boxes = await page.evaluate(() => ['fire', 'loop', 'throttle', 'bomb', 'torpedo', 'game-sound', 'pause'].map(id => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return { id, x: box.x, y: box.y, width: box.width, height: box.height,
        owner: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[data-flight-control], button')?.id };
    }));
    await page.locator('#pause').tap();
    await expect.poll(async () => (await read(page)).phase).toBe('paused');
    const submittedBefore = (await read(page)).render.queue.submittedCount;
    await expect.poll(async () => (await read(page)).render.queue.completedCount).toBeGreaterThanOrEqual(submittedBefore + 1);
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      if (box.id === 'throttle') expect(box.height).toBeCloseTo(box.width * 2, 1);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.owner).toBe(box.id);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `${a.id} and ${b.id} do not overlap`).toBe(true);
    }
    const s = await read(page);
    expect(s.stats.shots).toBe(0); expect(s.gunSight.y).toBeLessThan(viewport.height * .45);
    await evidence(page, `normal-${viewport.width}x${viewport.height}`, true);
    await page.locator('#pause-home').tap();
    await expect(page.locator('input[value="normal"]')).toBeChecked();
    await page.locator('input[value="easy"]').check(); await page.locator('#start').tap();
    expect((await read(page)).mode).toBe('easy');
    await expect(page.locator('#fire')).toBeHidden();
    await expect(page.locator('#throttle')).toBeHidden();
    await expect(page.locator('#loop')).toBeVisible();
    await expect(page.locator('#bomb')).toBeVisible();await expect(page.locator('#torpedo')).toBeVisible();
  });
}

test('Normal real simultaneous touch steering, fire and throttle release on pause and cancel', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await openNormal(page);
  const steer = { x: 180, y: 560, id: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [steer] });
  const moved = { ...steer, x: steer.x + 18 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
  const fire = await center(page, '#fire', 2), accelerate = await center(page, '#throttle', 3);
  accelerate.y = (await page.locator('#throttle').boundingBox())!.y + 22;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, fire] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, fire, accelerate] });
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#throttle')).toHaveAttribute('aria-valuenow', '100');
  await expect.poll(async () => (await read(page)).stats.shots).toBeGreaterThan(8);
  await expect.poll(async () => (await read(page)).player.speed).toBeGreaterThan(112);
  expect(Math.abs((await read(page)).player.yaw)).toBeGreaterThan(.04);
  const heldSpeed = (await read(page)).player.speed;
  // Same Chromium WebTouch semantics as touch-command.ts: name the ending contact.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [accelerate] });
  await expect(page.locator('#throttle')).toHaveAttribute('aria-valuenow', '0');
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'true');
  expect((await read(page)).controlsInput.steerPointer).not.toBeNull();
  expect((await read(page)).player.speed).toBeGreaterThanOrEqual(heldSpeed - 1);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, fire, {...accelerate,id:6}] });
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await read(page)).phase).toBe('paused');
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#throttle')).toHaveAttribute('aria-valuenow', '0');
  const frozen = await read(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  expect((await read(page)).tick).toBe(frozen.tick);
  expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
  await page.locator('#resume').tap();
  await expect.poll(async () => (await read(page)).tick).toBeGreaterThan(frozen.tick + 15);
  expect((await read(page)).stats.shots).toBe(frozen.stats.shots);
  expect((await read(page)).player.yaw).toBeCloseTo(frozen.player.yaw, 10);
  const freshFire = await center(page, '#fire', 4);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [freshFire] });
  await expect.poll(async () => (await read(page)).stats.shots).toBeGreaterThan(frozen.stats.shots);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(page.locator('#fire')).toHaveAttribute('aria-pressed', 'false');
  const cancelled = await read(page);
  await expect.poll(async () => (await read(page)).tick).toBeGreaterThan(cancelled.tick + 15);
  expect((await read(page)).stats.shots).toBe(cancelled.stats.shots);
  await page.locator('#pause').tap(); await page.locator('#pause-restart').tap();
  expect((await read(page)).mode).toBe('normal');
  await expect(page.locator('#fire')).toBeVisible();
  expect((await read(page)).stats.shots).toBe(0);
});

test('Normal real sea failure labels the result and preserves mode across retry and home', async ({ page }) => {
  await openNormal(page);
  await page.keyboard.down('ArrowDown');
  await expect(page.locator('#result')).toBeVisible({ timeout: 30000 });
  await page.keyboard.up('ArrowDown');
  await expect(page.locator('#result-mode')).toHaveText('ノーマル');
  await expect(page.locator('#result-reason')).toContainText('海面');
  const result = (await read(page)).result;
  expect(result.outcome).toBe('defeat');
  await expectScoreResult(page, result, 'normal', 'defeat');
  await inspectScoreResultLayout(page, result);
  await evidence(page, 'normal-sea-result');
  await page.locator('#retry').tap();
  expect((await read(page)).mode).toBe('normal');
  expect((await read(page)).stats.shots).toBe(0);
  expect((await read(page)).stats.score).toBe(0);
  expect((await read(page)).result).toBeNull();
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#pause').tap(); await page.locator('#pause-home').tap();
  await expect(page.locator('input[value="normal"]')).toBeChecked();
  await page.locator('input[value="easy"]').check(); await page.locator('#start').tap();
  await expect(page.locator('#hud-mode')).toHaveText('イージー');
  expect((await read(page)).config.mode).toBe('easy');
});

for(const viewport of [{width:320,height:568},{width:568,height:320}]) {
 test(`custom legacy lever never covers pause or sound ${viewport.width}x${viewport.height}`,async({page})=>{
  await page.setViewportSize(viewport);await openNormal(page);
  const obstacle=await page.locator('#pause').boundingBox();expect(obstacle).not.toBeNull();
  await page.locator('#pause').tap();await page.locator('#pause-home').tap();
  await page.evaluate(({x,y})=>{const placement={x,y,size:100,opacity:.9};localStorage.setItem('kaisen-controls-v1',JSON.stringify({version:1,controls:{accelerate:placement,brake:placement}}));},{x:(obstacle!.x+obstacle!.width/2)/viewport.width,y:(obstacle!.y+obstacle!.height/2)/viewport.height});
  await page.reload();await page.locator('input[value="normal"]').check();await expect(page.locator('#start')).toBeEnabled();await page.locator('#start').tap();
  const lever=await page.locator('#throttle').boundingBox();expect(lever).not.toBeNull();
  for(const id of ['pause','game-sound']) {
   const box=await page.locator('#'+id).boundingBox();expect(box).not.toBeNull();
   expect(lever!.x+lever!.width<=box!.x||box!.x+box!.width<=lever!.x||lever!.y+lever!.height<=box!.y||box!.y+box!.height<=lever!.y).toBe(true);
   expect(await page.locator('#'+id).evaluate(element=>{const r=element.getBoundingClientRect();return element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  }
  await page.locator('#pause').tap();await page.locator('#pause-controls').tap();await page.locator('#control-target').selectOption('throttle');
  // Layout CSS-pixel sizing uses offsetWidth; boundingBox retains fractional
  // borders and must not be substituted as the layout scaling denominator.
  const ratio=await page.locator('#control-preview').evaluate(element=>(element as HTMLElement).offsetWidth/document.getElementById('app')!.offsetWidth);
  const miniature=await page.locator('[data-control="throttle"]').boundingBox();
  expect(miniature!.height).toBeCloseTo(lever!.height*ratio,1);
  expect(miniature!.height/miniature!.width).toBeCloseTo(lever!.height/lever!.width,1);
 });
}

// Presentation-only stress fixtures: the live flight is paused through its real UI.
// We change notification text/font and HUD visibility, never simulation state.
for (const viewport of [{width:393,height:648},{width:320,height:568},{width:568,height:320},{width:852,height:393}]) {
  test(`notices avoid sight, radar, HUD and controls with long text ${viewport.width}x${viewport.height}`,async({page},info)=>{
    await page.setViewportSize(viewport);await openNormal(page);
    for(const mode of ['normal','easy'] as const){
      if(mode==='easy'){
        await page.locator('#pause-home').tap();await page.locator('input[value="easy"]').check();await page.locator('#start').tap();
      }
      await page.locator('#pause').tap();await expect.poll(async()=>(await read(page)).phase).toBe('paused');
      for(const fontScale of [1,2]){
        await page.evaluate(scale=>{
          const ally=document.getElementById('ally-announcements')!;
          ally.textContent='僚機1 戦闘不能（復帰40秒） ×12\n僚機2 戦闘不能（復帰40秒） ×12';
          ally.dataset.fullText=ally.textContent;
          ally.style.fontSize=`${11*scale}px`;
          document.getElementById('payload-status')!.style.fontSize=`${10*scale}px`;
        },fontScale);
        await expect(page.locator('#ally-announcements')).toHaveAttribute('data-layout',/clear|summary/);
        await expect(page.locator('#payload-status')).toHaveAttribute('data-layout',/clear|summary/);
        if(fontScale===1)await expect(page.locator('#ally-announcements')).toHaveAttribute('data-layout','clear');
        // ResizeObserver runs after frame callbacks; the next two paints include its relayout.
        await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
        const geometry=await page.evaluate(()=>{
          const state=(window as any).__kaisenReadState(false),f=document.getElementById('flight')!.getBoundingClientRect();
          const rect=(e:Element)=>{const r=e.getBoundingClientRect();return {id:e.id||e.className,x:r.x,y:r.y,width:r.width,height:r.height};};
          const obstacles=[...document.querySelectorAll('#hud [data-flight-control], .hud-top, .flight-data, #announcement, #warning, #reload-status, #flight-tip, #throttle-layout-note')]
            .filter(e=>!e.closest('[hidden]')&&e.textContent?.trim()&&e.getBoundingClientRect().width>0).map(rect);
          const sight=state.mode==='normal'?state.gunSight:{x:f.width/2,y:f.height/2};
          const radius=(state.mode==='normal'?Math.max(26,Math.min(38,Math.min(f.width,f.height)*.085)):Math.min(f.width,f.height)*.135)+7;
          obstacles.push({id:'sight-and-reload-ring',x:f.x+sight.x-radius,y:f.y+sight.y-radius,width:radius*2,height:radius*2});
          const r=f.width<360?42:49;
          obstacles.push({id:'radar-and-label',x:f.right-18-r*2,y:f.y+Math.min(f.height*.33,180)-r,width:r*2,height:r*2+18});
          const notices=['ally-announcements','payload-status'].map(id=>({...rect(document.getElementById(id)!),layout:document.getElementById(id)!.dataset.layout}));
          return {notices,obstacles,viewport:{width:innerWidth,height:innerHeight},note:'Paused real flight; notification text and font are a presentation fixture only'};
        });
        if(geometry.notices.some(n=>n.id==='ally-announcements'&&n.layout==='summary')){
          await expect(page.locator('#pause-ally-news')).toContainText('僚機1 戦闘不能（復帰40秒） ×12');
          await expect(page.locator('#pause-ally-news')).toContainText('僚機2 戦闘不能（復帰40秒） ×12');
        }
        for(const n of geometry.notices){
          expect(n.x,`${mode} ${n.id} left`).toBeGreaterThanOrEqual(0);expect(n.y).toBeGreaterThanOrEqual(0);
          expect(n.x+n.width).toBeLessThanOrEqual(viewport.width+.5);expect(n.y+n.height).toBeLessThanOrEqual(viewport.height+.5);
          for(const o of [...geometry.obstacles,...geometry.notices.filter(other=>other.id!==n.id)]){
            expect(n.x+n.width<=o.x+.5||o.x+o.width<=n.x+.5||n.y+n.height<=o.y+.5||o.y+o.height<=n.y+.5,`${mode} text ${fontScale}: ${n.id} avoids ${o.id}`).toBe(true);
          }
        }
        await mkdir('test-results/evidence',{recursive:true});
        const label=`notices-${mode}-${viewport.width}x${viewport.height}-text${fontScale}`;
        await page.screenshot({path:`test-results/evidence/${label}.png`,style:'#pause-screen {visibility:hidden!important}'});
        await writeFile(`test-results/evidence/${label}.json`,JSON.stringify(geometry,null,2));
      }
    }
  });
}
