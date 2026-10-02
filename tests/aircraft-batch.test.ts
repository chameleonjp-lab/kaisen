import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage,
  Group, Material, Matrix3, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Object3D, ShaderMaterial, Vector3,
} from 'three';
import { AircraftBatchFactory } from '../src/aircraft-batch';
import type { AircraftVisual } from '../src/aircraft';

function emptyVisual(): AircraftVisual {
  const root = new Group();
  const propeller = new Group(); propeller.name = 'propeller';
  const ailerons: [Group, Group] = [new Group(), new Group()];
  ailerons[0].name = 'left'; ailerons[1].name = 'right';
  const elevator = new Group(); elevator.name = 'elevator';
  root.add(propeller, ...ailerons, elevator);
  return { root, propeller, ailerons, elevator };
}

function cloneVisual(source: AircraftVisual): AircraftVisual {
  const root = source.root.clone(true);
  return {
    root,
    propeller: root.getObjectByName('propeller') as Group,
    ailerons: [root.getObjectByName('left') as Group, root.getObjectByName('right') as Group],
    elevator: root.getObjectByName('elevator') as Group,
  };
}

function addMeshes(parent: Object3D, geometry: BufferGeometry, material: Material, count: number): Mesh[] {
  return Array.from({ length: count }, (_, index) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(index * .31, index * -.17, index * .23);
    mesh.rotation.set(index * .07, index * .13, index * -.11);
    mesh.scale.set(1 + index * .03, .7 + index * .04, 1.3 - index * .01);
    parent.add(mesh);
    return mesh;
  });
}

interface Triangle {
  material: Material;
  flags: string;
  vertices: number[][];
}

/** CPU topology inspection; this deliberately does not claim renderer/GPU FPS. */
function inspect(root: Object3D): { triangles: Triangle[]; submissions: number } {
  root.updateWorldMatrix(true, true);
  const triangles: Triangle[] = [];
  let submissions = 0;
  root.traverseVisible(object => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const color = geometry.getAttribute('color');
    const count = geometry.index?.count ?? position.count;
    const normalMatrix = new Matrix3().getNormalMatrix(object.matrixWorld);
    const ranges = Array.isArray(object.material)
      ? geometry.groups.map(group => ({ ...group, material: object.material[group.materialIndex ?? 0] }))
      : [{ start: 0, count, material: object.material }];
    for (const range of ranges) {
      if (!range.material?.visible) continue;
      const start = Math.max(range.start, geometry.drawRange.start);
      const end = Math.min(count, range.start + range.count, geometry.drawRange.start + geometry.drawRange.count);
      if (end <= start) continue;
      submissions++;
      for (let i = start; i + 2 < end; i += 3) {
        const vertices: number[][] = [];
        for (let corner = 0; corner < 3; corner++) {
          const index = geometry.index?.getX(i + corner) ?? i + corner;
          const values = new Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld).toArray();
          if (normal) values.push(...new Vector3().fromBufferAttribute(normal, index).applyNormalMatrix(normalMatrix).toArray());
          if (uv) values.push(uv.getX(index), uv.getY(index));
          if (color) values.push(color.getX(index), color.getY(index), color.getZ(index));
          vertices.push(values);
        }
        triangles.push({
          material: range.material,
          flags: JSON.stringify([object.renderOrder, object.layers.mask, object.castShadow,
            object.receiveShadow, object.frustumCulled]),
          vertices,
        });
      }
    }
  });
  return { triangles, submissions };
}

function assertSameTriangles(before: Triangle[], after: Triangle[]): void {
  assert.equal(after.length, before.length, 'rendered triangle count is unchanged');
  const unmatched = [...after];
  for (const triangle of before) {
    const match = unmatched.findIndex(candidate =>
      candidate.material === triangle.material && candidate.flags === triangle.flags &&
      triangle.vertices.every((vertex, corner) => vertex.length === candidate.vertices[corner].length &&
        vertex.every((value, component) => Math.abs(value - candidate.vertices[corner][component]) < 1e-5)),
    );
    assert.notEqual(match, -1, 'world positions, normals, UVs, attributes, winding and material flags match');
    unmatched.splice(match, 1);
  }
}

function batches(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse(object => {
    if (object instanceof Mesh && object.name === 'aircraft static batch') meshes.push(object);
  });
  return meshes;
}

test('static batching preserves world-space triangles, normals, UVs, material identity and animated subtrees', () => {
  const visual = emptyVisual();
  const geometry = new BoxGeometry(.7, .4, 1.2);
  const opaque = new MeshStandardMaterial({ color: 0x657359, side: DoubleSide, roughness: .43, metalness: .3 });
  const transparent = new MeshStandardMaterial({ transparent: true, opacity: .46 });
  const noDepthWrite = new MeshBasicMaterial({ depthWrite: false });
  visual.root.position.set(24, 5, -7);
  visual.root.rotation.set(.2, -.4, .6);
  visual.root.scale.set(2, 1.2, .9);
  addMeshes(visual.root, geometry, opaque, 20);
  const nested = new Group();
  nested.position.set(1.4, -.8, 2.1); nested.rotation.set(.14, .8, -.23); nested.scale.set(1.1, .6, 1.3);
  nested.renderOrder = 3;
  visual.root.add(nested);
  addMeshes(nested, geometry, opaque, 6);
  addMeshes(visual.propeller, geometry, opaque, 2);
  addMeshes(visual.ailerons[0], geometry, opaque, 1);
  addMeshes(visual.ailerons[1], geometry, opaque, 1);
  const elevatorChild = new Group(); visual.elevator.add(elevatorChild);
  addMeshes(elevatorChild, geometry, opaque, 1);
  const retained = [...addMeshes(visual.root, geometry, transparent, 2), ...addMeshes(visual.root, geometry, noDepthWrite, 2)];
  const animatedChildren = [visual.propeller, ...visual.ailerons, visual.elevator].map(group => [...group.children]);
  const sourceAttributes = Object.fromEntries(Object.entries(geometry.attributes).map(([name, attr]) => [name, [...attr.array]]));
  const before = inspect(visual.root);
  const factory = new AircraftBatchFactory();
  assert.equal(factory.optimize(visual, 'hero'), visual);
  const after = inspect(visual.root);
  assertSameTriangles(before.triangles, after.triangles);
  assert.equal(before.submissions, 35);
  assert.equal(after.submissions, 11, 'synthetic submission count falls 35 → 11, with all 420 triangles retained');
  assert.equal(before.triangles.length, 420);
  assert.deepEqual([visual.propeller, ...visual.ailerons, visual.elevator].map(group => [...group.children]), animatedChildren);
  for (const mesh of retained) assert.equal(mesh.parent, visual.root);
  assert.equal(batches(nested).length, 1, 'nested parent and render ordering are retained');
  assert.deepEqual(Object.fromEntries(Object.entries(geometry.attributes).map(([name, attr]) => [name, [...attr.array]])), sourceAttributes);
  assert.ok(batches(visual.root).every(mesh => mesh.geometry.boundingSphere && mesh.geometry.boundingBox));
  visual.propeller.rotation.z = 1.3; visual.ailerons[0].rotation.x = .23; visual.elevator.rotation.x = -.17;
  assert.equal(visual.propeller.children.length, 2, 'individual animation remains available');
  factory.dispose();
});

test('mixed indexed/non-indexed input, single-material groups and normalized color attributes remain exact', () => {
  const visual = emptyVisual();
  const material = new MeshBasicMaterial({ vertexColors: true });
  const indexed = new BoxGeometry();
  indexed.setAttribute('color', new BufferAttribute(new Uint8Array(indexed.getAttribute('position').count * 3).fill(173), 3, true));
  const nonIndexed = indexed.toNonIndexed();
  addMeshes(visual.root, indexed, material, 2);
  addMeshes(visual.root, nonIndexed, material, 2);
  const before = inspect(visual.root);
  const factory = new AircraftBatchFactory(); factory.optimize(visual, 'enemy');
  const after = inspect(visual.root);
  assertSameTriangles(before.triangles, after.triangles);
  assert.equal(after.submissions, 1);
  assert.equal(batches(visual.root)[0].geometry.groups.length, 0, 'single-material source groups do not create extra submissions');
  assert.equal(batches(visual.root)[0].geometry.getAttribute('color').normalized, true);
  assert.ok(batches(visual.root)[0].geometry.getAttribute('color').array instanceof Uint8Array);
  factory.dispose();
});

test('different render flags, material identities, parent groups and attribute layouts never coalesce', () => {
  const visual = emptyVisual();
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();
  const variants: ((mesh: Mesh) => void)[] = [
    () => {}, mesh => { mesh.renderOrder = 1; }, mesh => { mesh.layers.set(2); },
    mesh => { mesh.castShadow = true; }, mesh => { mesh.receiveShadow = true; },
    mesh => { mesh.frustumCulled = false; },
  ];
  for (const change of variants) addMeshes(visual.root, geometry, material, 2).forEach(change);
  addMeshes(visual.root, geometry, material.clone(), 2);
  const noUV = geometry.clone(); noUV.deleteAttribute('uv');
  addMeshes(visual.root, noUV, material, 2);
  const parent = new Group(); visual.root.add(parent); addMeshes(parent, geometry, material, 2);
  const before = inspect(visual.root);
  const factory = new AircraftBatchFactory(); factory.optimize(visual, 'hero');
  const after = inspect(visual.root);
  assert.equal(after.submissions, 9);
  assertSameTriangles(before.triangles, after.triangles);
  factory.dispose();
});

test('multi-material groups, partial draw ranges, invisible and unsupported dynamic meshes stay untouched', () => {
  const visual = emptyVisual();
  const material = new MeshBasicMaterial();
  const geometry = new BoxGeometry();
  const retained: Mesh[] = [];
  const multi = new Mesh(geometry, [material, material, material, material, material, material]);
  visual.root.add(multi); retained.push(multi);
  const partial = geometry.clone(); partial.setDrawRange(3, 12);
  retained.push(...addMeshes(visual.root, partial, material, 2));
  const dynamic = geometry.clone(); dynamic.getAttribute('position').setUsage(DynamicDrawUsage);
  retained.push(...addMeshes(visual.root, dynamic, material, 2));
  const hidden = addMeshes(visual.root, geometry, material, 2); hidden.forEach(mesh => { mesh.visible = false; });
  retained.push(...hidden);
  const mirrored = addMeshes(visual.root, geometry, material, 2); mirrored.forEach(mesh => { mesh.scale.x = -1; });
  retained.push(...mirrored);
  const hooks = addMeshes(visual.root, geometry, material, 2); hooks.forEach(mesh => { mesh.onBeforeRender = () => {}; });
  retained.push(...hooks);
  retained.push(...addMeshes(visual.root, geometry, new ShaderMaterial(), 2));
  const withChildren = addMeshes(visual.root, geometry, material, 1)[0]; withChildren.add(new Group()); retained.push(withChildren);
  addMeshes(visual.root, geometry, material, 2);
  const before = inspect(visual.root);
  const factory = new AircraftBatchFactory(); factory.optimize(visual, 'hero');
  for (const mesh of retained) assert.equal(mesh.parent, visual.root);
  assert.equal(multi.geometry.groups.length, 6);
  assert.equal(batches(visual.root).length, 1);
  assertSameTriangles(before.triangles, inspect(visual.root).triangles);
  factory.dispose();
});

test('replays share a bounded per-detail geometry cache; only the cache owns disposal', () => {
  const prototype = emptyVisual();
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  addMeshes(prototype.root, geometry, material, 5);
  const factory = new AircraftBatchFactory();
  const generated = new Set<BufferGeometry>();
  let sourceDisposals = 0, materialDisposals = 0, batchDisposals = 0;
  geometry.addEventListener('dispose', () => sourceDisposals++);
  material.addEventListener('dispose', () => materialDisposals++);
  for (let replay = 0; replay < 10; replay++) {
    for (let plane = 0; plane < 10; plane++) {
      const visual = cloneVisual(prototype);
      visual.root.position.set(replay, plane, -plane * 3);
      const detail = plane === 0 ? 'hero' : 'enemy';
      factory.optimize(visual, detail);
      const merged = batches(visual.root);
      assert.equal(merged.length, 1);
      generated.add(merged[0].geometry);
      const teamBand = new Mesh(geometry, new MeshBasicMaterial({ color: plane % 2 ? 'red' : 'blue' }));
      visual.root.add(teamBand);
      assert.equal(factory.optimize(visual, detail), visual, 'repeat optimization is idempotent');
      assert.equal(teamBand.parent, visual.root, 'later team attachments are untouched');
      visual.root.clear();
    }
  }
  assert.equal(generated.size, 2, '100 visuals across 10 resets allocate only one merged geometry per detail');
  for (const batch of generated) batch.addEventListener('dispose', () => batchDisposals++);
  assert.equal(sourceDisposals, 0); assert.equal(materialDisposals, 0);
  factory.dispose(); factory.dispose();
  assert.equal(batchDisposals, 2, 'owned geometry is disposed exactly once');
  assert.equal(sourceDisposals, 0); assert.equal(materialDisposals, 0, 'source factory retains ownership');
  assert.throws(() => factory.optimize(cloneVisual(prototype), 'hero'), /disposed/);
});

test('changed source transforms or geometries cannot silently reuse stale cached geometry', () => {
  const prototype = emptyVisual();
  const material = new MeshBasicMaterial();
  addMeshes(prototype.root, new BoxGeometry(), material, 3);
  const factory = new AircraftBatchFactory();
  factory.optimize(cloneVisual(prototype), 'enemy');
  for (const kind of ['transform', 'geometry', 'attribute'] as const) {
    const changed = cloneVisual(prototype);
    const mesh = changed.root.children.find(child => child instanceof Mesh) as Mesh;
    if (kind === 'transform') mesh.position.x += 7;
    if (kind === 'geometry') mesh.geometry = new BoxGeometry(2, 1, 1);
    if (kind === 'attribute') { mesh.geometry = mesh.geometry.clone(); mesh.geometry.getAttribute('position').needsUpdate = true; }
    const before = inspect(changed.root);
    factory.optimize(changed, 'enemy');
    assert.equal(batches(changed.root).length, 0);
    assertSameTriangles(before.triangles, inspect(changed.root).triangles);
  }
  factory.dispose();
});
