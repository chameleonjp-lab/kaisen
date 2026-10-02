import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Euler, Mesh, Quaternion, Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { AircraftFactory } from '../src/aircraft';
import {
  aircraftSeaContact, AIRFRAME_CONTACT_RADIUS, AIRFRAME_CONTACT_VERTICES,
  AIRFRAME_SOURCE_SHA256, SEA_CONTACT_TOLERANCE,
} from '../src/sea-contact';
import {
  createOceanGeometry, oceanAnchor, oceanHeight, OCEAN_GLSL, OCEAN_GRID_STEP,
  OCEAN_MAX_CURVATURE, OCEAN_MAX_HEIGHT, OCEAN_NEAR_RADIUS, OCEAN_WAVES,
} from '../src/ocean';

const q = (pitch = 0, bank = 0, yaw = 0) => new Quaternion().setFromEuler(new Euler(pitch, yaw, bank, 'YXZ'));
function plane(y: number, rotation = new Quaternion(), x = 0, z = 0) {
  return { previous: new Vector3(x, y, z), position: new Vector3(x, y, z), quaternion: rotation };
}
function staticContact(y: number, rotation = new Quaternion(), x = 0, z = 0, time = 0) {
  const p = plane(y, rotation, x, z);
  return aircraftSeaContact(p, rotation, time, time);
}
function clearance(p: ReturnType<typeof plane>, rotation: Quaternion, time: number) {
  let min = Infinity;
  for (let i = 0; i < AIRFRAME_CONTACT_VERTICES.length; i += 3) {
    const point = new Vector3(...AIRFRAME_CONTACT_VERTICES.slice(i, i + 3)).applyQuaternion(rotation).add(p.position);
    min = Math.min(min, point.y - oceanHeight(point.x, point.z, time));
  }
  return min;
}

/** Reproduce the support extraction from the real, immutable visual geometry. */
function modelSupportVertices(): number[] {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const noop = () => {};
  // Paint operations are irrelevant to geometry. No renderer/browser is faked.
  const context = new Proxy({}, {
    get: (_, key) => key === 'createLinearGradient' || key === 'createRadialGradient'
      ? () => ({ addColorStop: noop }) : noop,
    set: () => true,
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  const factory = new AircraftFactory();
  try {
    const points: Vector3[] = [], rings = new Map<number, number>();
    for (const detail of ['hero', 'enemy'] as const) {
      const visual = factory.create(detail);
      for (let sample = 0; sample <= 8; sample++) {
        const delta = -1 + sample / 4;
        visual.ailerons[0].rotation.x = delta * .3;
        visual.ailerons[1].rotation.x = -delta * .3;
        visual.elevator.rotation.x = delta * .26;
        visual.root.updateMatrixWorld(true);
        visual.root.traverse(object => {
          if (!(object instanceof Mesh)) return;
          const prop = object.parent === visual.propeller;
          if (prop && !Array.isArray(object.material) && object.material.transparent) return;
          const positions = object.geometry.getAttribute('position');
          for (let i = 0; i < positions.count; i++) {
            const point = new Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
            if (prop) rings.set(point.z, Math.max(rings.get(point.z) ?? 0, Math.hypot(point.x, point.y)));
            else points.push(point);
          }
        });
      }
    }
    for (const [z, radius] of rings) for (let i = 0; i < 64; i++) {
      const a = i * Math.PI * 2 / 64, r = radius / Math.cos(Math.PI / 64);
      points.push(new Vector3(Math.cos(a) * r, Math.sin(a) * r, z));
    }
    const hull = new ConvexHull().setFromPoints(points), unique = new Set<string>();
    for (const face of hull.faces) {
      let edge = face.edge;
      do {
        unique.add(edge.head().point.toArray().map(n => n.toFixed(6)).join(','));
        edge = edge.next;
      } while (edge !== face.edge);
    }
    return [...unique].sort().flatMap(point => point.split(',').map(Number));
  } finally {
    factory.dispose();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('contact hull reproduces actual hero/enemy geometry; preserved aircraft source is byte-identical', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('../src/aircraft.ts', import.meta.url))).digest('hex'), AIRFRAME_SOURCE_SHA256);
  assert.deepEqual(AIRFRAME_CONTACT_VERTICES, modelSupportVertices());
  assert.equal(AIRFRAME_CONTACT_VERTICES.length / 3, 310);
  let radius = 0;
  for (let i = 0; i < AIRFRAME_CONTACT_VERTICES.length; i += 3)
    radius = Math.max(radius, Math.hypot(...AIRFRAME_CONTACT_VERTICES.slice(i, i + 3)));
  assert.ok(radius <= AIRFRAME_CONTACT_RADIUS);
  assert.ok(AIRFRAME_CONTACT_RADIUS - radius < .001);
});

test('level flight below the old 2.5 m origin threshold is safe; rotating prop contact is fatal', () => {
  assert.equal(staticContact(2), null);
  assert.equal(staticContact(1.5), null);
  const hit = staticContact(1.4);
  assert.ok(hit);
  assert.ok(hit.point.z < -4.6, 'rotating prop reaches water before fuselage');
  assert.equal(hit.fraction, 0);
});

test('both banked wingtips hit while an equally high level aircraft clears the sea', () => {
  for (const sign of [-1, 1]) {
    assert.equal(staticContact(5), null);
    const hit = staticContact(5, q(0, sign * Math.PI / 2));
    assert.ok(hit);
    assert.ok(Math.abs(hit.point.z) < 3, 'wing, not a spherical/origin proxy');
    assert.equal(staticContact(6.1, q(0, sign * Math.PI / 2)), null);
  }
});

test('nose, tail and inverted fin extents participate in pose-aware sea contact', () => {
  assert.ok(staticContact(4.7, q(-Math.PI / 2)), 'nose-down spinner/prop touch');
  assert.equal(staticContact(5, q(-Math.PI / 2)), null);
  assert.ok(staticContact(4.4, q(Math.PI / 2)), 'tail-down contact');
  assert.equal(staticContact(4.9, q(Math.PI / 2)), null);
  const inverted = staticContact(1.8, q(0, Math.PI));
  assert.ok(inverted);
  assert.ok(inverted.point.z > 3, 'inverted fin touches before lower prop envelope');
  assert.equal(staticContact(2, q(0, Math.PI)), null);
});

test('fast descent returns the earliest contact time and exact water-surface point', () => {
  const p = plane(-10); p.previous.y = 20;
  const hit = aircraftSeaContact(p, new Quaternion(), 3, 3 + 1 / 60);
  assert.ok(hit);
  assert.ok(hit.fraction > .5 && hit.fraction < .7);
  assert.equal(hit.time, 3 + hit.fraction / 60);
  assert.equal(hit.point.y, oceanHeight(hit.point.x, hit.point.z, hit.time));
  const before = { ...p, position: p.previous.clone().lerp(p.position, hit.fraction - .0001) };
  assert.ok(clearance(before, p.quaternion, hit.time - .0001 / 60) > SEA_CONTACT_TOLERANCE);
});

test('swept roll catches wing contact even with clear starting and ending poses', () => {
  const p = plane(5, q(0, Math.PI));
  assert.equal(staticContact(5, new Quaternion()), null);
  assert.equal(staticContact(5, p.quaternion), null);
  const hit = aircraftSeaContact(p, new Quaternion(), 0, 1 / 60);
  assert.ok(hit);
  assert.ok(hit.fraction > .25 && hit.fraction < .4);
  assert.equal(aircraftSeaContact(plane(6.5, p.quaternion), new Quaternion(), 0, 1 / 60), null);
});

test('swept pitch catches nose contact between two clear poses', () => {
  const p = plane(4.5, q(-Math.PI));
  assert.equal(staticContact(4.5, new Quaternion()), null);
  assert.equal(staticContact(4.5, p.quaternion), null);
  const hit = aircraftSeaContact(p, new Quaternion(), 0, 1 / 60);
  assert.ok(hit);
  // The swept prop rim reaches water before the spinner/nose tip.
  assert.ok(hit.fraction > .25 && hit.fraction < .3);
});

test('contact uses wave height and simulation time, including a safe wave trough', () => {
  const p = plane(2);
  let crestTime = 0, troughTime = 0;
  for (let i = 0; i < 1000; i++) {
    const t = i / 20;
    if (oceanHeight(0, -4.7, t) > oceanHeight(0, -4.7, crestTime)) crestTime = t;
    if (oceanHeight(0, -4.7, t) < oceanHeight(0, -4.7, troughTime)) troughTime = t;
  }
  assert.ok(staticContact(2, p.quaternion, 0, 0, crestTime));
  assert.equal(staticContact(2, p.quaternion, 0, 0, troughTime), null);
  assert.ok(oceanHeight(0, -4.7, crestTime) > .9);
  assert.ok(oceanHeight(0, -4.7, troughTime) < -.9);
});

test('repeat/paused queries are deterministic, side-effect free, and quaternion sign invariant', () => {
  const p = plane(5, q(0, Math.PI));
  const saved = JSON.stringify(p);
  const hit = aircraftSeaContact(p, new Quaternion(), 10, 10 + 1 / 60);
  for (let i = 0; i < 20; i++) assert.deepEqual(aircraftSeaContact(p, new Quaternion(), 10, 10 + 1 / 60), hit);
  assert.equal(JSON.stringify(p), saved);
  const opposite = { ...p, quaternion: new Quaternion(...p.quaternion.toArray().map(x => -x)) };
  assert.deepEqual(aircraftSeaContact(opposite, new Quaternion(), 10, 10 + 1 / 60), hit);
  assert.equal(staticContact(20, q(.2, -.8), 45, -120, 40), null);
  assert.throws(() => aircraftSeaContact(p, new Quaternion(), 2, 1), /ordered/);
});

test('CPU water and generated GLSL share coefficients and bounded height at negative/large coordinates', () => {
  for (const w of OCEAN_WAVES) for (const coefficient of [w.x, w.z, w.speed, w.amplitude])
    assert.ok(OCEAN_GLSL.includes(String(coefficient)));
  for (let i = 0; i < 1000; i++) {
    const x = i * 123.4 - 61000, z = i * -83.2 + 42000, time = i * .31;
    const reference = .9 * Math.sin(x * .0023 + z * .0013 - time * .7)
      + .42 * Math.sin(x * -.0039 + z * .0031 + time * .46);
    assert.ok(Math.abs(oceanHeight(x, z, time) - reference) < 1e-12);
    assert.ok(Math.abs(reference) <= OCEAN_MAX_HEIGHT);
  }
});

test('near-field mesh agrees with analytic contact surface without increasing triangle count', () => {
  const geometry = createOceanGeometry();
  try {
    assert.ok(geometry.index!.count / 3 < 128 * 128 * 2);
    assert.ok(OCEAN_MAX_CURVATURE * OCEAN_GRID_STEP ** 2 < .0011);
    const positions = geometry.getAttribute('position'), indices = geometry.index!;
    const anchors = [[0, 0], [1003.8, -2098.2], [-30000.3, 30000.6]];
    let checked = 0;
    for (let i = 0; i < indices.count; i += 3) {
      const v = [0, 1, 2].map(j => new Vector3().fromBufferAttribute(positions, indices.getX(i + j)));
      if (v.some(p => Math.abs(p.x) > OCEAN_NEAR_RADIUS || Math.abs(p.z) > OCEAN_NEAR_RADIUS)) continue;
      for (const [px, pz] of anchors) {
        const ax = oceanAnchor(px), az = oceanAnchor(pz), t = 17.8;
        const x = ax + (v[0].x + v[1].x + v[2].x) / 3;
        const z = az + (v[0].z + v[1].z + v[2].z) / 3;
        const rendered = v.reduce((sum, p) => sum + oceanHeight(ax + p.x, az + p.z, t), 0) / 3;
        assert.ok(Math.abs(rendered - oceanHeight(x, z, t)) < .0011);
        checked++;
      }
    }
    assert.ok(checked > 10000);
    assert.equal(oceanAnchor(3.9), 0);
    assert.equal(oceanAnchor(4.1), 8);
    // A recenter preserves the near-world vertex lattice and wave phase.
    assert.equal(oceanHeight(oceanAnchor(3.9) + 8, 0, 2), oceanHeight(oceanAnchor(4.1), 0, 2));
  } finally { geometry.dispose(); }
});

test('translation sweep crosses a wave crest even when both endpoint airframes are clear', () => {
  const p = plane(2.2, new Quaternion(), 0, 3000); p.previous.z = 0;
  assert.equal(staticContact(2.2), null);
  assert.equal(staticContact(2.2, p.quaternion, 0, 3000, 1 / 60), null);
  const hit = aircraftSeaContact(p, p.quaternion, 0, 1 / 60);
  assert.ok(hit);
  assert.ok(hit.fraction > 0 && hit.fraction < 1);
  const at = { ...p, position: p.previous.clone().lerp(p.position, hit.fraction) };
  assert.ok(Math.abs(clearance(at, p.quaternion, hit.time) - SEA_CONTACT_TOLERANCE) < .00001);
  const before = { ...p, position: p.previous.clone().lerp(p.position, hit.fraction - .0001) };
  assert.ok(clearance(before, p.quaternion, hit.time - .0001 / 60) > SEA_CONTACT_TOLERANCE);
});

test('near-tangent wing sweep distinguishes millimetre penetration from a five-millimetre miss', () => {
  const start = q(0, 80 * Math.PI / 180), end = q(0, 100 * Math.PI / 180);
  const p = plane(0, end);
  let lowest = Infinity;
  for (let i = 0; i <= 400; i++) lowest = Math.min(lowest, clearance(p, start.clone().slerp(end, i / 400), 0));
  p.position.y = p.previous.y = -lowest + SEA_CONTACT_TOLERANCE - .001;
  assert.equal(staticContact(p.position.y, start), null);
  assert.equal(staticContact(p.position.y, end), null);
  const hit = aircraftSeaContact(p, start, 0, 0);
  assert.ok(hit, 'curvature subdivision must not miss shallow interior contact');
  assert.ok(hit.fraction > .25 && hit.fraction < .75);
  p.position.y += .005; p.previous.y += .005;
  assert.equal(aircraftSeaContact(p, start, 0, 0), null);
});
