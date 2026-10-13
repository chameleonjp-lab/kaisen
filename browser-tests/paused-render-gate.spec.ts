import { expect, test } from "@playwright/test";
import { readPausedState, waitForPausedView } from "./paused-view";

test("Resume waits for the completed frozen pose and resize renders only once", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.addInitScript(() => {
    const probe: any = { armed: false, target: null, captured: false, waitCount: 0, released: false };
    (window as any).__pausedRenderProbe = probe;
    document.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest("#pause")) probe.armed = true;
    }, true);

    const prototype = WebGL2RenderingContext.prototype as any;
    const nativeFenceSync = prototype.fenceSync;
    const nativeClientWaitSync = prototype.clientWaitSync;
    prototype.fenceSync = function (...args: any[]) {
      const sync = nativeFenceSync.apply(this, args);
      if (probe.armed && sync) {
        probe.armed = false;
        probe.target = sync;
        probe.captured = true;
      }
      return sync;
    };
    prototype.clientWaitSync = function (sync: any, flags: number, timeout: number) {
      if (sync === probe.target && !probe.released) {
        probe.waitCount++;
        return this.TIMEOUT_EXPIRED;
      }
      return nativeClientWaitSync.call(this, sync, flags, timeout);
    };
  });

  await page.goto("/");
  await expect(page.locator("#start")).toBeEnabled();
  await page.locator('input[value="normal"]').check();
  await page.locator("#start").click();
  await expect.poll(async () => (await readPausedState(page)).phase).toBe("playing");
  await page.locator("#pause").click();
  await expect.poll(async () => {
    const probe = await page.evaluate(() => {
      const current = (window as any).__pausedRenderProbe;
      return { captured: current.captured, waitCount: current.waitCount };
    });
    return probe.captured && probe.waitCount > 0;
  }).toBe(true);

  // This real DOM assertion is deliberately made while the intercepted fence
  // is pending, before reading any new paused-view diagnostics.
  expect(await page.locator("#resume").isDisabled(),
    "Resume stays disabled on the intercepted pending fence").toBe(true);
  const paused = await readPausedState(page);
  expect(paused.phase).toBe("paused");
  expect(paused.render.queue.status).toBe("pending");
  expect(paused.render.pausedView.phase).toBe("paused");
  expect(paused.render.pausedView.submittedCount).toBe(paused.render.queue.submittedCount);
  const frozenTick = paused.tick;
  await page.keyboard.press("Escape");
  expect((await readPausedState(page)).phase).toBe("paused");
  await expect.poll(async () => (await readPausedState(page)).render.queue.status)
    .toBe("stalled");
  await expect(page.locator("#resume")).toBeDisabled();

  await page.evaluate(() => { (window as any).__pausedRenderProbe.released = true; });
  const completed = await waitForPausedView(page, {
    tick: frozenTick,
    cssWidth: 393,
    cssHeight: 852,
  });
  expect(completed.render.pausedView.submittedCount).toBe(completed.render.queue.submittedCount);
  const world = (state: any) => ({
    tick: state.tick,
    elapsed: state.elapsed,
    player: state.player,
    allies: state.allies,
    enemies: state.enemies,
    ships: state.ships,
    stats: state.stats,
    bullets: state.bullets,
    ordnance: state.ordnance,
    result: state.result,
  });
  await page.waitForTimeout(300);
  const stable = await readPausedState(page);
  expect(world(stable)).toEqual(world(completed));
  expect(stable.render.queue.submittedCount).toBe(completed.render.queue.submittedCount);
  expect(stable.render.pausedView.submittedCount).toBe(completed.render.pausedView.submittedCount);

  await page.evaluate(() => {
    const probe = (window as any).__pausedRenderProbe;
    probe.armed = true;
    probe.target = null;
    probe.captured = false;
    probe.waitCount = 0;
    probe.released = false;
  });
  await page.setViewportSize({ width: 852, height: 393 });
  await expect.poll(async () => {
    const probe = await page.evaluate(() => {
      const current = (window as any).__pausedRenderProbe;
      return { captured: current.captured, waitCount: current.waitCount };
    });
    return probe.captured && probe.waitCount > 0;
  }).toBe(true);
  expect(await page.locator("#resume").isDisabled(),
    "a resized paused view also gates Resume until its fence completes").toBe(true);
  const pendingResize = await readPausedState(page);
  expect(pendingResize.render.queue.status).toBe("pending");
  await page.evaluate(() => { (window as any).__pausedRenderProbe.released = true; });
  const resized = await waitForPausedView(page, {
    tick: frozenTick,
    cssWidth: 852,
    cssHeight: 393,
  });
  expect(resized.render.pausedView.missionId).toBe(completed.render.pausedView.missionId);
  expect(resized.render.pausedView.submittedCount).toBe(stable.render.pausedView.submittedCount + 1);
  await page.waitForTimeout(200);
  const resizedStable = await readPausedState(page);
  expect(resizedStable.render.queue.submittedCount).toBe(resized.render.queue.submittedCount);

  await page.locator("#resume").click();
  await expect.poll(async () => (await readPausedState(page)).phase).toBe("playing");
  await expect.poll(async () => (await readPausedState(page)).tick).toBeGreaterThan(frozenTick);
  expect(errors).toEqual([]);
});
