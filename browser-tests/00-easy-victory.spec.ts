import { steerAndObserve, releasePayloadAndObserve } from './touch-command';
import { createBrowserMissionPilot } from '../tests/helpers/mission-browser-pilot';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';
import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { expectScoreResult, inspectScoreResultLayout } from './score-result';
// This long real-input route avoids video readback. Final screenshots and state
// are saved separately; no product state or result is injected.
test.use({ trace: "off" });
async function state(page: Page) {
  return page.evaluate(() => (window as any).__kaisenReadState());
}
async function pilotState(page: Page) {
  return page.evaluate(() => {
    const snapshot=(window as any).__kaisenReadState(false);
    // CI26's two 3,600-entry histories made each feedback message 156kB.
    // The pilot needs live entities/input, not a repeated performance archive.
    // Full snapshots remain in screenshots/final evidence; no game state changes.
    snapshot.bombButton={ready:document.getElementById('bomb')!.dataset.ready,text:document.getElementById('bomb-hint')!.textContent};
    return snapshot;
  });
}
async function opened(page: Page) {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
}
async function started(page: Page) {
  await page.locator("#start").tap();
  await expect.poll(async () => (await state(page)).phase).toBe("playing");
}
async function capture(page: Page, name: string, inspectPausedScene = false) {
  await mkdir("test-results/evidence", { recursive: true });
  if (inspectPausedScene) {
    const submitted = (await state(page)).render.queue.submittedCount;
    await expect.poll(async () => (await state(page)).render.queue.completedCount)
      .toBeGreaterThanOrEqual(submitted + 1);
  }
  await writeFile(`test-results/evidence/${name}.json`, JSON.stringify({
    note: inspectPausedScene ? "Real-input gameplay, explicitly paused. Only pause menu hidden for this screenshot; camera/world unchanged." : "Unmodified gameplay screen",
    snapshot: await state(page),
  }, null, 2));
  await page.screenshot({ path: `test-results/evidence/${name}.png`,
    ...(inspectPausedScene ? { style: "#pause-screen { visibility: hidden !important; }" } : {}),
  });
}
const errors: string[] = [];
const samples: unknown[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0; samples.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
});
test.afterEach(async ({ page }, info) => {
  await mkdir("test-results/evidence", { recursive: true });
  const snapshot = await state(page).catch(() => null);
  if (info.status !== "passed") {
    console.error('EASY_VICTORY_PAUSE_DIAGNOSTICS ' + JSON.stringify({
      status: info.status, phase: snapshot?.phase, screen: snapshot?.screen, mode: snapshot?.mode,
      tick: snapshot?.tick, elapsed: snapshot?.elapsed, graphicsReady: snapshot?.graphicsReady,
      pauseReasons: snapshot?.pauseReasons, lastInterruption: snapshot?.lastInterruption,
      renderStatus: snapshot?.renderStatus, queue: snapshot?.render?.queue,
      controlsInput: snapshot?.controlsInput, errors,
    }));
  }
  await writeFile(
    "test-results/evidence/touch-victory-state.json",
    JSON.stringify({ status: info.status, errors, snapshot, samples,
      consumedInputs:await page.evaluate(()=>(window as any).__kaisenReadState('audit')).catch(()=>null) }, null, 2),
  );
  if (info.status !== "passed")
    await page
      .screenshot({ path: "test-results/evidence/touch-victory-failure.png" })
      .catch(() => {});
  expect(errors).toEqual([]);
});
test("physical circular-stick inputs reach the victory screen", async ({
  page,
  context,
}) => {
  test.setTimeout(720000);
  await opened(page);
  const cdp = await context.newCDPSession(page);
  await started(page);
  const origin = { x: 90, y: 650 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...origin, id: 1 }],
  });
  let activityCaptured = false, bombCueCaptured = false;
  let fleetCaptured = false, lastSample = -6, payloadPresses = 0;
  const pilot = createBrowserMissionPilot();
  while (true) {
    const s = await pilotState(page);
    if (s.phase === "ended") break;
    expect(s.phase, "Unexpected pause during real touch flight").toBe(
      "playing",
    );
    expect(s.elapsed, "Bounded mission reachability window").toBeLessThan(600);
    if (s.tick - lastSample < 6) {
      await page.waitForTimeout(35);
      continue;
    }
    lastSample = s.tick;
    if(!bombCueCaptured && s.bombButton.ready==='true') {
      expect(s.bombGuide.affected.length).toBeGreaterThan(0);expect(['direct','blast']).toContain(s.bombGuide.kind);
      expect(s.player.bombs).toBeGreaterThan(0);expect(s.player.bombReloadTicks).toBe(0);expect(s.player.payloadCooldown).toBe(0);
      expect(['命中見込み','至近弾圏内']).toContain(s.bombButton.text);
      await mkdir('test-results/evidence',{recursive:true});
      await page.screenshot({path:'test-results/evidence/bomb-ready-easy.png'});
      await writeFile('test-results/evidence/bomb-ready-easy.json',JSON.stringify({note:'Live, unmodified real-input gameplay; green cue sampled just before screenshot. No pause or world injection.',snapshot:s,after:await pilotState(page)},null,2));
      bombCueCaptured=true;
    }

    const player = s.player,
      p = player.position;
    const forward = {
      x: -Math.sin(player.yaw) * Math.cos(player.pitch),
      y: Math.sin(player.pitch),
      z: -Math.cos(player.yaw) * Math.cos(player.pitch),
    };
    const ships = s.ships.filter((t:any) => t.health > 0);
    const distance = (t:any) => Math.hypot(t.position.x-p.x,t.position.y-p.y,t.position.z-p.z);
    const target = ships.sort((a:any,b:any)=>distance(a)-distance(b))[0];
    const d = target ? distance(target) : Infinity;
    const dx = target ? target.position.x-p.x : 0, dz=target ? target.position.z-p.z : 0;
    const angle = Math.acos(Math.max(-1,Math.min(1,(forward.x*dx+forward.z*dz)/Math.max(1e-9,Math.hypot(forward.x,forward.z)*Math.hypot(dx,dz)))));
    if (!fleetCaptured && target && d < 800 && angle < .3) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.locator("#pause").tap();
      await expect.poll(async () => (await state(page)).phase).toBe("paused");
      await capture(page, "fleet-approach-paused", true);
      fleetCaptured = true;
      await page.locator("#resume").tap();
      await expect.poll(async () => (await state(page)).phase).toBe("playing");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...origin, id: 1 }] });
      lastSample = -6;
      continue;
    }
    if (!activityCaptured && s.allyActivity.visible.length > 0) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.locator('#pause').tap();
      await expect.poll(async ()=>(await state(page)).phase).toBe('paused');
      await capture(page,'wingman-activity-paused',true);activityCaptured=true;
      await page.locator('#resume').tap();
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...origin,id:1}]});
      lastSample=-6;continue;
    }
    const request = pilot(s), {dx:stickX,dy:stickY} = pointerOffsetForControls(request.turn,request.climb);
    expect(Math.hypot(stickX,stickY)).toBeLessThanOrEqual(36+1e-9);
    const accepted=await steerAndObserve(page,cdp,origin,request.turn,request.climb);
    lastSample=accepted.tick;
    samples.push({tick:s.tick,acceptedTick:accepted.tick,requested:request,previousInput:s.controlsInput,player:{position:s.player.position,yaw:s.player.yaw,pitch:s.player.pitch,speed:s.player.speed,health:s.player.health,bombs:s.player.bombs},ships:s.ships.map((ship:any)=>({id:ship.id,health:ship.health,position:ship.position}))});
    if(accepted.phase!=='playing')break;
    if(request.bomb) { await releasePayloadAndObserve(page,cdp,origin,request.turn,request.climb,'bomb');payloadPresses++; }

  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const result = await state(page);
  const consumedInputs = await page.evaluate(()=>(window as any).__kaisenReadState('audit'));
  expect(consumedInputs.dropped).toBe(0);expect(consumedInputs.entries[0].tick).toBe(1);
  expect(consumedInputs.entries.every((e:any,i:number,a:any[])=>e.tick<=result.tick&&(!i||e.tick>a[i-1].tick))).toBe(true);
  expect(bombCueCaptured,"Bomb green cue was inspected during a live approach").toBe(true);
  expect(fleetCaptured, "A real approach to a live fleet target was inspected").toBe(true);
  expect(payloadPresses, "Actual touch buttons launch the anti-ship payloads").toBeGreaterThan(0);
  expect(result.result?.outcome).toBe("victory");
  expect(result.enemies.every((t: any) => t.health <= 0)).toBe(true);
  expect(result.ships.every((t: any) => t.health <= 0)).toBe(true);
  await expect(page.locator("#result-title")).toHaveText("作戦成功");
  await expectScoreResult(page, result.result, 'easy', 'victory');
  await inspectScoreResultLayout(page, result.result, { narrow: true });
  await capture(page, "result-victory");
  expect(activityCaptured).toBe(true);
  expect(result.allyActivity.totals.reduce((sum:number,row:any)=>sum+row.victory,0)).toBe(result.stats.allyAircraftKills);
  await expect(page.locator('#ally-report')).toBeVisible();
  await page.locator('#ally-report summary').tap();
  await expect(page.locator('#ally-report-lines')).toContainText('敵機撃墜');
  await page.locator("#result-home").click();
  await expect(page.locator("#start")).toBeVisible();
});
