import { steerAndObserve, releasePayloadAndObserve } from './touch-command';
import { createBrowserMissionPilot } from '../tests/helpers/mission-browser-pilot';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';
import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
// This long real-input route avoids video readback. Final screenshots and state
// are saved separately; no product state or result is injected.
test.use({ trace: "off" });
async function state(page: Page) {
  return page.evaluate(() => (window as any).__kaisenReadState());
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
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
});
test.afterEach(async ({ page }, info) => {
  await mkdir("test-results/evidence", { recursive: true });
  const snapshot = await state(page).catch(() => null);
  await writeFile(
    "test-results/evidence/touch-victory-state.json",
    JSON.stringify({ status: info.status, errors, snapshot }, null, 2),
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
  let activityCaptured = false;
  let fleetCaptured = false, lastSample = -6, payloadPresses = 0;
  const pilot = createBrowserMissionPilot();
  while (true) {
    const s = await state(page);
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
    if(accepted.phase!=='playing')break;
    if(request.bomb) { await releasePayloadAndObserve(page,cdp,origin,request.turn,request.climb,'bomb');payloadPresses++; }

  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const result = await state(page);
  expect(fleetCaptured, "A real approach to a live fleet target was inspected").toBe(true);
  expect(payloadPresses, "Actual touch buttons launch the anti-ship payloads").toBeGreaterThan(0);
  expect(result.result?.outcome).toBe("victory");
  expect(result.enemies.every((t: any) => t.health <= 0)).toBe(true);
  expect(result.ships.every((t: any) => t.health <= 0)).toBe(true);
  await expect(page.locator("#result-title")).toHaveText("作戦成功");
  await capture(page, "result-victory");
  expect(activityCaptured).toBe(true);
  expect(result.allyActivity.totals.reduce((sum:number,row:any)=>sum+row.victory,0)).toBe(result.stats.allyAircraftKills);
  await expect(page.locator('#ally-report')).toBeVisible();
  await page.locator('#ally-report summary').tap();
  await expect(page.locator('#ally-report-lines')).toContainText('敵機撃墜');
  await page.locator("#result-home").click();
  await expect(page.locator("#start")).toBeVisible();
});
