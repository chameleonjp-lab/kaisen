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
  test.setTimeout(180000);
  await opened(page);
  const cdp = await context.newCDPSession(page);
  await started(page);
  const origin = { x: 90, y: 650 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...origin, id: 1 }],
  });
  let fleetCaptured = false;
  let targetId: number | null = null,
    attackingShip = false,
    extendUntil = 0,
    lastSample = -6;
  let waypoint = { x: 0, y: 250, z: 0 };

  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
  const wrap = (v: number) =>
    ((((v + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  while (true) {
    const s = await state(page);
    if (s.phase === "ended") break;
    expect(s.phase, "Unexpected pause during real touch flight").toBe(
      "playing",
    );
    expect(s.elapsed, "Bounded mission reachability window").toBeLessThan(150);
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
    const targets = [...s.enemies, ...s.ships].filter((t) => t.health > 0);
    const distance = (t: any) =>
      Math.hypot(t.position.x - p.x, t.position.y - p.y, t.position.z - p.z);
    const target =
      targets.find((t) => t.id === targetId) ??
      targets.sort((a, b) => distance(a) - distance(b))[0];
    if (!target) break;
    if (targetId !== target.id) attackingShip = false;
    targetId = target.id;
    let aim = { ...target.position };
    const d = distance(target);
    const dx = aim.x - p.x,
      dz = aim.z - p.z;
    const angle = Math.acos(
      clamp(
        (forward.x * dx + forward.z * dz) /
          Math.max(1e-9, Math.hypot(forward.x, forward.z) * Math.hypot(dx, dz)),
        -1,
        1,
      ),
    );
    if (!fleetCaptured && target.kind === "ship" && d < 700 && angle < .3) {
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
    const tooClose =
      target.kind === "ship" && !attackingShip && d < 360 && angle > 0.25;
    if (
      s.tick >= extendUntil &&
      (tooClose || p.y < 90 || d < (target.kind === "ship" ? 210 : 70))
    ) {
      extendUntil = s.tick + 360;
      attackingShip = false;
      waypoint = {
        x: p.x + forward.x * 740,
        y: Math.max(250, p.y + 100),
        z: p.z + forward.z * 740,
      };
    }
    if (s.tick < extendUntil) aim = waypoint;
    else if (target.kind === "ship") {
      if (angle < 0.25 && d > 330) attackingShip = true;
      aim.y = attackingShip ? target.position.y + target.height * 0.4 : 250;
    }
    const ax = aim.x - p.x,
      ay = aim.y - p.y,
      az = aim.z - p.z;
    let turn = clamp(-wrap(Math.atan2(-ax, -az) - player.yaw) / 0.7, -1, 1);
    let climb =
      (clamp(Math.atan2(ay, Math.hypot(ax, az)) / 0.62, -1, 1) * 0.62) / 0.95;
    const norm = Math.hypot(turn, climb);
    if (norm > 1) {
      turn /= norm;
      climb /= norm;
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: origin.x + 36 * turn, y: origin.y - 36 * climb, id: 1 },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const result = await state(page);
  expect(fleetCaptured, "A real approach to a live fleet target was inspected").toBe(true);
  expect(result.result?.outcome).toBe("victory");
  expect(result.enemies.every((t: any) => t.health <= 0)).toBe(true);
  expect(result.ships.every((t: any) => t.health <= 0)).toBe(true);
  await expect(page.locator("#result-title")).toHaveText("作戦成功");
  await capture(page, "result-victory");
  await page.locator("#result-home").click();
  await expect(page.locator("#start")).toBeVisible();
});
