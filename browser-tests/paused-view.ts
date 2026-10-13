import { expect, type Page } from "@playwright/test";

export interface PausedViewExpectation {
  tick?: number;
  cssWidth?: number;
  cssHeight?: number;
}

export async function readPausedState(page: Page) {
  return page.evaluate(() => (window as any).__kaisenReadState());
}

/** Wait for the submitted frozen pose itself, rather than a later arbitrary fence. */
export async function waitForPausedView(
  page: Page,
  expected: PausedViewExpectation = {},
) {
  await expect.poll(async () => {
    const state = await readPausedState(page);
    const view = state?.render?.pausedView;
    const queue = state?.render?.queue;
    return state?.phase === "paused" &&
      view?.ready === true &&
      view.phase === "paused" &&
      view.tick === state.tick &&
      view.showHUD === true &&
      Number.isInteger(view.missionId) &&
      view.missionId > 0 &&
      view.bufferWidth > 0 && view.bufferHeight > 0 &&
      view.overlayBufferWidth > 0 && view.overlayBufferHeight > 0 &&
      view.submittedCount > 0 &&
      view.completedCount >= view.submittedCount &&
      queue.status === "ready" && queue.failure === null &&
      (expected.tick === undefined || view.tick === expected.tick) &&
      (expected.cssWidth === undefined || Math.abs(view.cssWidth - expected.cssWidth) < 0.01) &&
      (expected.cssHeight === undefined || Math.abs(view.cssHeight - expected.cssHeight) < 0.01);
  }).toBe(true);

  const state = await readPausedState(page);
  expect(state.phase).toBe("paused");
  expect(state.render.pausedView.tick).toBe(state.tick);
  expect(state.render.pausedView.ready).toBe(true);
  expect(state.render.queue.status).toBe("ready");
  expect(state.render.pausedView.completedCount)
    .toBeGreaterThanOrEqual(state.render.pausedView.submittedCount);
  return state;
}
