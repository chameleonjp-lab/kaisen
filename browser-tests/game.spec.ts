import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const records: unknown[] = [];
async function state(page: Page) {
  return page.evaluate(() => (window as any).__kaisenReadState());
}
async function capture(page: Page, name: string) {
  await mkdir("test-results/evidence", { recursive: true });
  await page.screenshot({
    path: `test-results/evidence/${name}.png`,
    fullPage: false,
  });
  records.push({
    name,
    viewport: page.viewportSize(),
    state: await state(page),
  });
}
async function opened(page: Page) {
  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await expect
    .poll(async () =>
      Boolean(
        await page.evaluate(
          () => typeof (window as any).__kaisenReadState === "function",
        ),
      ),
    )
    .toBe(true);
}
async function started(page: Page) {
  await page.locator("#start").tap();
  await expect.poll(async () => (await state(page)).phase).toBe("playing");
}
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:4176") &&
      !r.url().startsWith("data:")
    )
      external.push(r.url());
  });
  (page as any).__testErrors = errors;
  (page as any).__external = external;
});
test.afterEach(async ({ page }, info) => {
  await mkdir("test-results/evidence", { recursive: true });
  const name = info.title.replace(/\W+/g, "-");
  const snapshot = await state(page).catch(() => null);
  await writeFile(
    `test-results/evidence/state-${name}.json`,
    JSON.stringify({ name, status: info.status, snapshot }, null, 2),
  );
  if (info.status !== "passed")
    await page
      .screenshot({
        path: `test-results/evidence/failure-${info.title.replace(/\W+/g, "-")}.png`,
      })
      .catch(() => {});
  expect(
    (page as any).__external,
    "No external rankings, analytics, fonts, or source-game calls",
  ).toEqual([]);
  expect((page as any).__testErrors, "No runtime or shader errors").toEqual([]);
});
test.afterAll(async () => {
  await mkdir("test-results/evidence", { recursive: true });
  const hashes: Record<string, string> = {};
  for (const p of [
    "src/main.ts",
    "src/scene.ts",
    "src/ships.ts",
    "src/simulation.ts",
    "src/flight.ts",
    "src/ai.ts",
    "src/mission.ts",
    "src/naval.ts",
    "src/ammunition.ts",
    "src/ocean.ts",
    "src/sea-contact.ts",
    "src/input.ts",
    "src/aircraft.ts",
    "src/style.css",
    "package-lock.json",
  ])
    hashes[p] = createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
  await writeFile(
    `test-results/evidence/observations-worker-${process.pid}.json`,
    JSON.stringify(
      {
        environment:
          "GitHub Actions Chromium / SwiftShader, touch viewport emulation; not iPhone hardware",
        hashes,
        records,
      },
      null,
      2,
    ),
  );
});

for (const viewport of [
  { width: 393, height: 852 },
  { width: 320, height: 568 },
  { width: 852, height: 393 },
])
  test(`home and flight ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await opened(page);
    await capture(page, `home-${viewport.width}x${viewport.height}`);
    await expect(page.locator("#home")).toBeVisible();
    await expect(page.locator("#start")).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await started(page);
    const s = await state(page);
    expect(s.allies).toHaveLength(4);
    expect(s.enemies).toHaveLength(5);
    expect(s.ships).toHaveLength(4);
    expect(s.player.kind).toBe("aircraft");
    for (const id of ["pause", "loop", "game-sound"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.01);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 0.01);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await capture(page, `flight-${viewport.width}x${viewport.height}`);
    await page.locator("#pause").click();
    const tick = (await state(page)).tick;
    await page.waitForTimeout(300);
    expect((await state(page)).tick).toBe(tick);
    await expect(page.locator("#resume")).toBeVisible();
    await page.locator("#pause-home").click();
    await expect(page.locator("#start")).toBeVisible();
  });
test("touch steering, two-finger release, loop and explicit resume", async ({
  page,
  context,
}) => {
  await opened(page);
  const cdp = await context.newCDPSession(page);
  await started(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 100, y: 600, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 132, y: 597, id: 1 }],
  });
  await expect
    .poll(async () => Math.abs((await state(page)).player.yaw))
    .toBeGreaterThan(0.03);
  const loop = await page.locator("#loop").boundingBox();
  expect(loop).not.toBeNull();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 132, y: 597, id: 1 },
      { x: loop!.x + loop!.width / 2, y: loop!.y + loop!.height / 2, id: 2 },
    ],
  });
  // CDP ends the gesture with an empty point list. Per-finger ownership
  // is separately covered by the input unit regression.
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(page.locator("#loop")).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(async () => (await state(page)).player.loopProgress)
    .toBeGreaterThan(0);
  await capture(page, "touch-loop");
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 100, y: 600, id: 3 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 90, y: 630, id: 3 }],
  });
  await expect
    .poll(async () => (await state(page)).player.loopProgress)
    .toBe(0);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  await page.locator("#pause").click();
  const before = await state(page);
  await page.keyboard.press("ArrowDown");
  expect((await state(page)).tick).toBe(before.tick);
  await page.locator("#resume").click();
  await expect
    .poll(async () => (await state(page)).tick)
    .toBeGreaterThan(before.tick);
  await page.locator("#pause").click();
  await capture(page, "paused");
});
test("real flight to sea failure, result, replay, and home", async ({
  page,
}) => {
  await opened(page);
  await started(page);
  await page.keyboard.down("ArrowDown");
  await expect
    .poll(async () => (await state(page)).player.pitch)
    .toBeLessThan(-0.2);
  await expect
    .poll(async () => (await state(page)).player.position.y)
    .toBeLessThan(300);
  await expect(page.locator("#result")).toBeVisible({ timeout: 30000 });
  await page.keyboard.up("ArrowDown");
  const s = await state(page);
  expect(s.result.outcome).toBe("defeat");
  expect(s.player.position.y).toBeLessThan(8); // Oriented airframe can touch while its origin is above water.
  expect(s.player.health).toBe(0);
  await expect(page.locator("#result-reason")).toContainText("海面");
  expect(s.result.time).toBeGreaterThan(0);
  expect(s.elapsed).toBe(s.result.time);
  await capture(page, "result-sea");
  await page.locator("#retry").click();
  await expect.poll(async () => (await state(page)).phase).toBe("playing");
  expect((await state(page)).player.health).toBe(100);
  await page.locator("#pause").click();
  await page.locator("#pause-home").click();
  await expect(page.locator("#start")).toBeVisible();
});
test("ten replays keep renderer resources bounded", async ({ page }) => {
  await opened(page);
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await started(page);
    await page.locator("#pause").click();
    await expect.poll(async () => (await state(page)).phase).toBe("paused");
    const submittedBefore = (await state(page)).render.queue.submittedCount;
    // Wait beyond every already-submitted frame so at least one frame of this
    // paused mission is fully uploaded/rendered. Never mix pre-upload counts.
    await expect.poll(async () => (await state(page)).render.queue.completedCount)
      .toBeGreaterThanOrEqual(submittedBefore + 1);
    const s = await state(page);
    samples.push({ ...s.render, tick: s.tick, phase: s.phase });
    await page.locator("#pause-home").click();
  }
  // Preserve all measurements even when an assertion fails.
  records.push({ name: "ten-replay-resources", samples });
  expect(
    Math.max(...samples.map((s) => s.geometries)) -
      Math.min(...samples.map((s) => s.geometries)),
  ).toBeLessThanOrEqual(3);
  expect(
    Math.max(...samples.map((s) => s.textures)) -
      Math.min(...samples.map((s) => s.textures)),
  ).toBeLessThanOrEqual(1);
});
test("200 percent text remains reachable on a short screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await opened(page);
  await page.evaluate(() => {
    const original = [
      ...document.querySelectorAll<HTMLElement>(
        "button,p,h1,h2,span,small,em,strong,dt,dd",
      ),
    ].map((e) => ({ e, size: parseFloat(getComputedStyle(e).fontSize) }));
    for (const { e, size } of original) e.style.fontSize = `${size * 2}px`;
  });
  await page.locator("#start").scrollIntoViewIfNeeded();
  await expect(page.locator("#start")).toBeInViewport();
  await capture(page, "home-200-percent");
  await page.locator("#start").click();
  await page.locator("#pause").click();
  await page.locator("#pause-home").scrollIntoViewIfNeeded();
  await expect(page.locator("#pause-home")).toBeInViewport();
  await page.locator("#pause-home").click();
  await expect(page.locator("#home")).toBeVisible();
});
test("production build omits the observation hook and includes no remote destination", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir("dist/assets");
  const js = (
    await Promise.all(
      files
        .filter((f) => f.endsWith(".js"))
        .map((f) => readFile(`dist/assets/${f}`, "utf8")),
    )
  ).join("\n");
  expect(js).not.toContain("__kaisenReadState");
  expect(js).not.toMatch(
    /supabase\.co|faitofuraito_(?:easy|normal)|beginPlay\(/,
  );
});

test("long interruption pauses explicitly and audio mute releases sources", async ({
  page,
}) => {
  await opened(page);
  await page.locator("#home-sound").click();
  await expect(page.locator("#home-sound")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await started(page);
  await expect
    .poll(async () => (await state(page)).elapsed)
    .toBeGreaterThan(0.5);
  const playing = await state(page);
  expect(playing.audio.sources).toBeLessThanOrEqual(10);
  await page.locator("#game-sound").click();
  await expect.poll(async () => (await state(page)).audio.sources).toBe(0);
  await page.evaluate(() => {
    const end = performance.now() + 1100;
    while (performance.now() < end) {
      /* Deliberate isolated stall. */
    }
  });
  await expect.poll(async () => (await state(page)).phase).toBe("paused");
  expect((await state(page)).pauseReasons).toContain("frame");
  const tick = (await state(page)).tick;
  await page.waitForTimeout(200);
  expect((await state(page)).tick).toBe(tick);
  await page.locator("#resume").click();
  await expect.poll(async () => (await state(page)).tick).toBeGreaterThan(tick);
  expect((await state(page)).audio.enabled).toBe(false);
});
