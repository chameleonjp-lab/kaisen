import test from "node:test";
import assert from "node:assert/strict";
import { KaisenScene } from "../src/scene";

test("late shader completion cannot revive a disposed renderer", async () => {
  let complete!: () => void;
  const compilation = new Promise<void>((resolve) => { complete = resolve; });
  let releases = 0, draws = 0;
  const resource = () => ({ dispose() { releases++; } });
  // Exercise the real lifecycle methods without requiring a GL driver in Node.
  const scene: any = Object.create(KaisenScene.prototype);
  Object.assign(scene, {
    renderQueue: { dispose() { releases++; } },
    disposed: false, planes: new Map(), scene: { remove() {} }, camera: {},
    renderer: { compileAsync: () => compilation, render() { draws++; }, dispose() { releases++; } },
    ordnanceView: resource(), aircraftTracers: resource(), aircraftBatches: resource(), aircraft: resource(), teamBandGeometry: resource(),
    teamMaterials: { friendly: resource(), enemy: resource() }, ships: resource(),
    sea: { geometry: resource() }, seaMaterial: resource(),
    sky: { geometry: resource(), material: resource() },
    tracersGeometry: resource(), tracers: { material: resource() },
    particleGeometry: resource(), points: { material: resource() },
  });
  const preparing = scene.prepare();
  scene.dispose();
  const firstReleaseCount = releases;
  assert.ok(firstReleaseCount > 0);
  complete();
  await preparing;
  assert.equal(draws, 0);
  scene.dispose();
  await scene.prepare();
  assert.equal(releases, firstReleaseCount, "duplicate disposal is harmless");
});

test("a queued old view cannot retain event ownership after replay", () => {
  const oldMission = {}, newMission = {};
  const order: string[] = [];
  const scene: any = Object.create(KaisenScene.prototype);
  Object.assign(scene, {
    disposed: false, current: oldMission,
    reset(state: object) { this.current = state; order.push("bind"); },
    pollRender() { order.push("poll"); return "pending"; },
  });
  assert.equal(scene.render(newMission, true), false);
  assert.equal(scene.current, newMission);
  assert.deepEqual(order, ["bind", "poll"]);
});

test("a completed paused pose is reused until its mission, HUD, or layout key changes", () => {
  const state: any = { phase: "paused", tick: 42 };
  const queueState: any = {
    status: "ready", failure: null, submittedCount: 9, completedCount: 9,
  };
  let draws = 0, submissions = 0;
  const scene: any = Object.create(KaisenScene.prototype);
  Object.assign(scene, {
    disposed: false, prepared: true, current: state, missionId: 3,
    layoutRevision: 5, width: 393, height: 852,
    canvas: { width: 393, height: 852 }, overlay: { width: 393, height: 852 },
    renderer: { render() { draws++; } },
    renderQueue: {
      poll() { return queueState.status; },
      diagnostics() { return { ...queueState }; },
      submit() { submissions++; },
      reset() { queueState.submittedCount = queueState.completedCount = 0; },
    },
    pausedView: {
      missionId: 3, phase: "paused", tick: 42, showHUD: true, layoutRevision: 5,
      cssWidth: 393, cssHeight: 852, bufferWidth: 393, bufferHeight: 852,
      overlayBufferWidth: 393, overlayBufferHeight: 852, submittedCount: 9,
    },
  });

  assert.equal(scene.pausedViewReady(state, true, 10), true);
  assert.equal(scene.render(state, true), true);
  assert.equal(draws, 0, "an identical completed pause pose does not redraw");
  assert.equal(submissions, 0, "an identical completed pause pose does not queue another fence");

  queueState.status = "pending";
  assert.equal(scene.pausedViewReady(state, true, 10), false);
  queueState.status = "ready";
  queueState.completedCount = 8;
  assert.equal(scene.pausedViewReady(state, true, 10), false,
    "a ready queue cannot certify a submission that has not completed");
  queueState.completedCount = 9;

  const changedState = { ...state, tick: 43 };
  assert.equal(scene.pausedViewReady(changedState, true, 10), false);
  assert.equal(scene.pausedViewReady(state, false, 10), false);
  scene.layoutRevision++;
  assert.equal(scene.pausedViewReady(state, true, 10), false);
});

test("resize and render-queue recovery invalidate a paused view stamp", () => {
  const state: any = { phase: "paused", tick: 12 };
  const queueState: any = { status: "ready", failure: null, submittedCount: 4, completedCount: 4 };
  const scene: any = Object.create(KaisenScene.prototype);
  Object.assign(scene, {
    current: state, missionId: 1, layoutRevision: 1, width: 393, height: 852,
    canvas: { width: 393, height: 852, getBoundingClientRect: () => ({ width: 400, height: 700 }) },
    overlay: { width: 393, height: 852 },
    renderer: { setSize(width: number, height: number) {
      scene.canvas.width = width; scene.canvas.height = height;
    } },
    camera: { aspect: 1, updateProjectionMatrix() {} },
    renderQueue: {
      diagnostics() { return { ...queueState }; },
      reset() { queueState.submittedCount = queueState.completedCount = 0; },
    },
    pausedView: {
      missionId: 1, phase: "paused", tick: 12, showHUD: true, layoutRevision: 1,
      cssWidth: 393, cssHeight: 852, bufferWidth: 393, bufferHeight: 852,
      overlayBufferWidth: 393, overlayBufferHeight: 852, submittedCount: 4,
    },
  });

  assert.equal(scene.pausedViewReady(state, true), true);
  scene.resize();
  assert.equal(scene.pausedViewReady(state, true), false);
  assert.equal(scene.layoutRevision, 2);
  assert.deepEqual([scene.width, scene.height], [400, 700]);

  scene.pausedView = {
    missionId: 1, phase: "paused", tick: 12, showHUD: true, layoutRevision: 2,
    cssWidth: 400, cssHeight: 700, bufferWidth: 400, bufferHeight: 700,
    overlayBufferWidth: 400, overlayBufferHeight: 700, submittedCount: 4,
  };
  assert.equal(scene.pausedViewReady(state, true), true);
  scene.resetRenderQueue();
  assert.equal(scene.pausedView, null);
  assert.equal(scene.pausedViewReady(state, true), false);
});
