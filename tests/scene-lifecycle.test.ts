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
    aircraftBatches: resource(), aircraft: resource(), teamBandGeometry: resource(),
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
