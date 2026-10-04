import { test, expect } from '@playwright/test';
import { steerAndObserve, releasePayloadAndObserve } from './touch-command';
import { mkdir, writeFile } from 'node:fs/promises';
import { createBrowserMissionPilot } from '../tests/helpers/mission-browser-pilot';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';

// This route verifies mixed real input: CDP touch steering plus the ordinary
// Space key for manual fire and W/S throttle. Three-finger button ownership has a separate test.
// Observation is read-only; no product world, time, health or outcome injection.
test.use({ trace: 'off' });
test('Normal mixed real touch and keyboard inputs reach the victory screen', async ({ page, context }) => {
  test.setTimeout(720000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const read = () => page.evaluate(() => (window as any).__kaisenReadState());
  const observePilot = () => page.evaluate(() => {const s=(window as any).__kaisenReadState(false);s.bombButton={ready:document.getElementById('bomb')!.dataset.ready,text:document.getElementById('bomb-hint')!.textContent};return s;});
  const cdp = await context.newCDPSession(page), pilot = createBrowserMissionPilot();
  const origin = { x: 180, y: 500 };
  let payloadPresses = 0, bombCueCaptured = false;
  let consumedInputs: any = null;
  let fireHeld = false, accelerateHeld = false, brakeHeld = false, lastSample = -6, sawReload = false, completedReload = false, won = false;
  const samples: unknown[] = [];
  const renderRecoveries: unknown[] = [];
  await page.goto('/');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('input[value="normal"]').check();
  await page.locator('#start').tap();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...origin, id: 1 }] });
  try {
    while (true) {
      if (lastSample >= 0) await page.waitForFunction(next => {
        const state = (window as any).__kaisenReadState(false);
        return state.phase !== 'playing' || state.tick >= next;
      }, lastSample + 6, { polling: 'raf' });
      const state = await observePilot();
      expect(state.mode).toBe('normal');
      if (state.player.reloadTicksRemaining > 0) sawReload = true;
      else if (sawReload) completedReload = true;
      if (state.phase === 'ended') break;
      if (state.phase === 'paused') {
        // The software GPU may cross the existing 1s watchdog once. Verify the
        // user-visible recovery and frozen world, then use only ordinary input.
        // Repeated stalls, other pause causes, GL failure or no recovery fail.
        expect(renderRecoveries.length, 'Repeated render stalls remain a failure').toBe(0);
        expect(state.pauseReasons).toEqual(['render']);
        expect(state.render.queue.failure).toBeNull();
        expect(state.lastInterruption?.reason).toBe('stalled');
        const emptyInput = {turn:0,climb:0,steerPointer:null,
          heldPointers:{fire:[],loop:[],accelerate:[],brake:[],bomb:[],torpedo:[]},keys:[]};
        expect(state.controlsInput, 'Product must clear input before driver cleanup').toEqual(emptyInput);
        await page.keyboard.up('Space'); await page.keyboard.up('w'); await page.keyboard.up('s');
        fireHeld = accelerateHeld = brakeHeld = false;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect(page.locator('#pause-reason')).toHaveText('描画が復帰しました。操作して再開できます');
        await expect(page.locator('#resume')).toBeEnabled();
        const frozen = await read();
        const world = (s: any) => ({tick:s.tick,elapsed:s.elapsed,player:s.player,
          allies:s.allies,enemies:s.enemies,ships:s.ships,stats:s.stats,bullets:s.bullets,
          ordnance:s.ordnance,allyRespawnAt:s.allyRespawnAt,result:s.result,deathCause:s.deathCause});
        expect(world(frozen)).toEqual(world(state));
        expect(frozen.render.queue.completedCount).toBeGreaterThanOrEqual(state.lastInterruption.render.queue.submittedCount);
        await page.waitForTimeout(150);
        const settled = await read();
        expect(settled.phase).toBe('paused');
        expect(settled.pauseReasons).toEqual(['render']);
        expect(world(settled)).toEqual(world(frozen));
        expect(settled.controlsInput).toEqual(emptyInput);
        renderRecoveries.push({observed:state,frozen,settled});
        await page.locator('#resume').tap();
        await expect.poll(async () => (await observePilot()).phase).toBe('playing');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...origin, id: 1 }] });
        lastSample = -6;
        continue;
      }
      expect(state.phase, 'Unrecognized flight phase').toBe('playing');
      expect(state.elapsed, 'Bounded real-input completion window').toBeLessThan(600);
      lastSample = state.tick;
    if(!bombCueCaptured && state.bombButton.ready==='true') {
      expect(state.bombGuide.affected.length).toBeGreaterThan(0);expect(['direct','blast']).toContain(state.bombGuide.kind);
      expect(state.player.bombs).toBeGreaterThan(0);expect(state.player.bombReloadTicks).toBe(0);expect(state.player.payloadCooldown).toBe(0);
      expect(['命中見込み','至近弾圏内']).toContain(state.bombButton.text);
      await mkdir('test-results/evidence',{recursive:true});
      await page.screenshot({path:'test-results/evidence/bomb-ready-normal.png'});
      await writeFile('test-results/evidence/bomb-ready-normal.json',JSON.stringify({note:'Live, unmodified real-input gameplay; green cue sampled just before screenshot. No pause or world injection.',snapshot:state,after:await observePilot()},null,2));
      bombCueCaptured=true;
    }

      const input = pilot(state), { dx, dy } = pointerOffsetForControls(input.turn, input.climb);
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(36 + 1e-9);
      const accepted = await steerAndObserve(page,cdp,origin,input.turn,input.climb);
      const acceptedTick = accepted.tick;
      lastSample = acceptedTick;
      // Do not send Space to the result screen's newly focused retry button.
      if (accepted.phase === 'ended') break;
      if (accepted.phase !== 'playing') continue;
      if (input.fire !== fireHeld) {
        if (input.fire) await page.keyboard.down('Space');
        else await page.keyboard.up('Space');
        fireHeld = input.fire;
      }
      if (Boolean(input.accelerate) !== accelerateHeld) {
        if (input.accelerate) await page.keyboard.down('w'); else await page.keyboard.up('w');
        accelerateHeld = Boolean(input.accelerate);
      }
      if (Boolean(input.brake) !== brakeHeld) {
        if (input.brake) await page.keyboard.down('s'); else await page.keyboard.up('s');
        brakeHeld = Boolean(input.brake);
      }
      if(input.bomb) { await releasePayloadAndObserve(page,cdp,origin,input.turn,input.climb,'bomb');payloadPresses++; }
      samples.push({ tick: state.tick, acceptedTick, requested: input, previousInput: state.controlsInput, player: {position:state.player.position,yaw:state.player.yaw,pitch:state.player.pitch,speed:state.player.speed,health:state.player.health} });
    }
    await page.keyboard.up('Space'); fireHeld = false; await page.keyboard.up('w'); await page.keyboard.up('s'); accelerateHeld = brakeHeld = false;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const result = await read();
    consumedInputs = await page.evaluate(()=>(window as any).__kaisenReadState('audit'));
    expect(consumedInputs.dropped).toBe(0);
    expect(consumedInputs.entries[0].tick).toBe(1);
    expect(consumedInputs.entries.every((e:any,i:number,a:any[])=>e.tick<=result.tick&&(!i||e.tick>a[i-1].tick))).toBe(true);
    expect(bombCueCaptured,"Bomb green cue was inspected during a live approach").toBe(true);
    expect(payloadPresses).toBeGreaterThan(0);
    expect(result.result?.outcome).toBe('victory');
    expect(result.enemies.every((target: any) => target.health <= 0)).toBe(true);
    expect(result.ships.every((target: any) => target.health <= 0)).toBe(true);
    expect(result.player.health).toBeGreaterThan(0);
    expect(result.stats.playerAircraftKills).toBeGreaterThan(0);
    expect(result.stats.playerShipKills).toBeGreaterThan(0);
    // Reload evidence is recorded, but a genuine early all-clear need not wait
    // for ammunition. The Node route separately requires a complete 360-tick reload.
    await expect(page.locator('#result-title')).toHaveText('作戦成功');
    await expect(page.locator('#result-mode')).toHaveText('ノーマル');
    const submitted = result.render.queue.submittedCount;
    await expect.poll(async () => (await read()).render.queue.completedCount).toBeGreaterThanOrEqual(submitted + 1);
    await mkdir('test-results/evidence', { recursive: true });
    await page.screenshot({ path: 'test-results/evidence/normal-result-victory.png' });
    await writeFile('test-results/evidence/normal-result-victory.json', JSON.stringify({
      note: 'Chromium touch emulation plus ordinary Space-key manual fire, W/S throttle, and simultaneous touch bomb-button input. Read-only snapshots, no world/health/time injection. Not iPhone hardware or human playability evidence.',
      snapshot: await read(), samples, sawReload, completedReload, payloadPresses, consumedInputs, renderRecoveries,
    }, null, 2));
    won = true;
    await page.locator('#retry').tap();
    expect((await read()).mode).toBe('normal');
    await page.locator('#pause').tap();
    await page.locator('#pause-home').tap();
    await expect(page.locator('input[value="normal"]')).toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    if (fireHeld) await page.keyboard.up('Space').catch(() => {});
    if (accelerateHeld) await page.keyboard.up('w').catch(() => {});
    if (brakeHeld) await page.keyboard.up('s').catch(() => {});
    await mkdir('test-results/evidence', { recursive: true });
    await writeFile('test-results/evidence/normal-victory-route-state.json', JSON.stringify({
      won, sawReload, completedReload, errors, samples, renderRecoveries, snapshot: await read().catch(() => null),
      consumedInputs: consumedInputs ?? await page.evaluate(()=>(window as any).__kaisenReadState('audit')).catch(()=>null),
    }, null, 2));
    if (!won) await page.screenshot({ path: 'test-results/evidence/normal-victory-route-failure.png' }).catch(() => {});
  }
});
