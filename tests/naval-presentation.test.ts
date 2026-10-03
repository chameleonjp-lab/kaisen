import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Color, InstancedMesh, Matrix4, Mesh, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { FIXED_DT, makeFleet } from '../src/mission';
import { NAVAL_MOUNTS, NAVAL_WEAPONS, navalDirection, navalMuzzleLocal } from '../src/naval';
import { OCEAN_GLSL } from '../src/ocean';
import { NAVAL_PRESENTATION_CAPACITY, ShipFactory } from '../src/ships';
import { seaVertex, seaFragment, skyVertex, skyFragment } from '../src/atmosphere';

const matrix = new Matrix4();
function endpoint(mesh: InstancedMesh, index: number) {
  mesh.getMatrixAt(index, matrix); return new Vector3(0, .5, 0).applyMatrix4(matrix);
}
function colors(mesh: InstancedMesh) { return Array.from(mesh.instanceColor!.array); }
function matrices(mesh: InstancedMesh) { return Array.from(mesh.instanceMatrix.array); }
function visibleInstances(mesh: InstancedMesh) {
  const color = new Color(); let count = 0;
  for (let i = 0; i < mesh.count; i++) { mesh.getColorAt(i, color); if (color.g > .008) count++; }
  return count;
}

test('shot-timed recoil starts at the authoritative muzzle, returns exactly, and pauses without state writes', () => {
  const factory = new ShipFactory(), ship = makeFleet(3)[0], root = factory.create(ship);
  try {
    const index = NAVAL_MOUNTS.findIndex(m => m.weapon === 'heavy-aa');
    const gun = ship.guns[index], definition = NAVAL_MOUNTS[index];
    gun.lastShotTick = 120; gun.yaw += .24; gun.elevation = .43;
    const barrel = NAVAL_MOUNTS.slice(0, index).reduce((n, m) => n + NAVAL_WEAPONS[m.weapon].barrels, 0);
    const mesh = root.getObjectByName('naval-barrels') as InstancedMesh;
    const before = JSON.stringify(ship), muzzle = navalMuzzleLocal(definition, gun, 0);
    factory.update(ship, root, 120 * FIXED_DT);
    assert.ok(endpoint(mesh, barrel).distanceTo(muzzle) < 1e-5);
    factory.update(ship, root, 2.05);
    const recoiled = endpoint(mesh, barrel), offset = muzzle.clone().sub(recoiled);
    assert.ok(offset.length() > .20 && offset.length() < .43);
    assert.ok(offset.clone().normalize().distanceTo(navalDirection(gun.yaw, gun.elevation)) < .0001);
    const paused = matrices(mesh); factory.update(ship, root, 2.05); assert.deepEqual(matrices(mesh), paused);
    factory.update(ship, root, 2.5); assert.ok(endpoint(mesh, barrel).distanceTo(muzzle) < 1e-5);
    assert.equal(JSON.stringify(ship), before);
  } finally { factory.dispose(); }
});

test('destroyed mounts retain their geometry but become dark and drooped without another shot or state mutation', () => {
  const factory = new ShipFactory(), ship = makeFleet(3)[0], root = factory.create(ship);
  try {
    const index = NAVAL_MOUNTS.findIndex(m => m.weapon === 'heavy-aa'), definition = NAVAL_MOUNTS[index];
    const gun = ship.guns[index]; gun.health = 0; gun.elevation = .6; gun.lastShotTick = 120;
    const saved = JSON.stringify(ship);
    factory.update(ship, root, 2.05);
    const bodies = root.getObjectByName('naval-mounts') as InstancedMesh;
    const barrels = root.getObjectByName('naval-barrels') as InstancedMesh;
    const barrel = NAVAL_MOUNTS.slice(0, index).reduce((n, m) => n + NAVAL_WEAPONS[m.weapon].barrels, 0);
    const color = new Color(); bodies.getColorAt(index, color); assert.ok(color.r < .3);
    assert.ok(endpoint(barrels, barrel).y < definition.pivot[1]);
    bodies.getMatrixAt(index, matrix); const size = new Vector3(); matrix.decompose(new Vector3(), new Quaternion(), size);
    assert.ok(size.x > 0 && size.y > 0 && size.z > 0);
    assert.equal(barrels.count, 57); assert.equal(bodies.count, 21); assert.equal(JSON.stringify(ship), saved);
  } finally { factory.dispose(); }
});

test('foam follows ship-local hull and wake placement, samples physical waves, and vanishes when propulsion stops', () => {
  const factory = new ShipFactory(), [a, b] = makeFleet(3), root = factory.create(a), other = factory.create(b);
  try {
    const wake = root.getObjectByName('wake') as Mesh<any, ShaderMaterial>;
    const otherWake = other.getObjectByName('wake') as Mesh<any, ShaderMaterial>;
    assert.equal(wake.geometry, otherWake.geometry); assert.notEqual(wake.material, otherWake.material);
    wake.geometry.computeBoundingBox();
    assert.ok(wake.geometry.boundingBox!.min.z <= -131.5);
    assert.ok(wake.geometry.boundingBox!.max.z > 350);
    assert.ok(wake.material.vertexShader.includes(OCEAN_GLSL));
    assert.ok(wake.material.vertexShader.includes('oceanHeight(vWorld.xz,uTime)'));
    root.position.set(30, .8, -60); root.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), .7);
    const transform = [...root.position.toArray(), ...root.quaternion.toArray()];
    a.velocity.set(0, 0, -6); factory.update(a, root, 15);
    assert.equal(wake.material.uniforms.uIntensity.value, 1); assert.equal(wake.material.uniforms.uTime.value, 15);
    assert.deepEqual([...root.position.toArray(), ...root.quaternion.toArray()], transform);
    factory.update(a, root, 15); assert.equal(wake.material.uniforms.uTime.value, 15);
    a.velocity.set(0, 0, 0); factory.update(a, root, 16); assert.equal(wake.visible, false);
    assert.equal(otherWake.visible, true, 'one stationary ship cannot remove another ship wake');
    a.velocity.set(0, 0, -6); a.health = 0; factory.update(a, root, 17);
    assert.equal(wake.visible, false, 'a sinking hull cannot keep emitting powered whitewater');
  } finally { factory.dispose(); }
});

test('localized effects use fixed slots, preserve fire priority, freeze at a fixed time, and expire cleanly', () => {
  const factory = new ShipFactory(), ship = makeFleet(3)[0], root = factory.create(ship);
  try {
    const damage = root.getObjectByName('naval-damage') as InstancedMesh;
    const initialBuffers = [damage.geometry, damage.material, damage.instanceColor, damage.instanceMatrix];
    assert.equal(damage.count, NAVAL_PRESENTATION_CAPACITY.damageSites * 6);
    assert.equal(visibleInstances(damage), 0);
    const hit = new Vector3(16, 13, 42), preserved = hit.clone();
    factory.impact(ship.id, hit, 1, 'explosive'); factory.update(ship, root, 2);
    const local = new Vector3(); damage.getMatrixAt(0, matrix); local.setFromMatrixPosition(matrix);
    assert.ok(local.distanceTo(hit) < 12, 'plume remains close to the actual hit, not a generic funnel');
    assert.ok(visibleInstances(damage) > 0); assert.ok(hit.equals(preserved));
    const fixedMatrices = matrices(damage), fixedColors = colors(damage), shipState = JSON.stringify(ship);
    factory.update(ship, root, 2); assert.deepEqual(matrices(damage), fixedMatrices); assert.deepEqual(colors(damage), fixedColors);
    factory.impact(ship.id, hit, 2, 'metal'); factory.update(ship, root, 2);
    assert.deepEqual(matrices(damage), fixedMatrices, 'metal cannot replace an explosive fire');
    for (let i = 0; i < 3000; i++) factory.impact(ship.id, new Vector3((i % 2 ? 1 : -1) * 17, 9, i % 220 - 110), 2 + i / 10000, 'metal');
    factory.update(ship, root, 2.4);
    assert.deepEqual([damage.geometry, damage.material, damage.instanceColor, damage.instanceMatrix], initialBuffers);
    assert.equal(damage.count, 48); assert.ok(visibleInstances(damage) <= 48);
    assert.equal(JSON.stringify(ship), shipState);
    factory.update(ship, root, 26); assert.equal(visibleInstances(damage), 0);
    factory.impact(999999, hit, 26, 'explosive'); factory.update(ship, root, 27);
    assert.equal(visibleInstances(damage), 0);
  } finally { factory.dispose(); }
});

test('seven ships share immutable resources, isolate damage buffers, and dispose each owned resource once', () => {
  const factory = new ShipFactory(), ships = makeFleet(7), roots = ships.map(s => factory.create(s));
  const geometry = new Set<any>(), material = new Set<any>(), instances = new Set<InstancedMesh>();
  for (const root of roots) {
    let submissions = 0;
    root.traverse(object => { if (object instanceof Mesh) {
      submissions++; geometry.add(object.geometry); for (const m of Array.isArray(object.material) ? object.material : [object.material]) material.add(m);
      if (object instanceof InstancedMesh) instances.add(object);
    } });
    assert.ok(submissions <= 11, `bounded ship draws: ${submissions}`);
  }
  const first = roots[0].getObjectByName('naval-damage') as InstancedMesh;
  const second = roots[1].getObjectByName('naval-damage') as InstancedMesh;
  assert.equal(first.geometry, second.geometry); assert.equal(first.material, second.material);
  assert.notEqual(first.instanceMatrix, second.instanceMatrix); assert.notEqual(first.instanceColor, second.instanceColor);
  factory.impact(ships[0].id, new Vector3(0, 12, -80), 1, 'mount'); factory.update(ships[0], roots[0], 1.5);
  assert.ok(visibleInstances(first) > 0); assert.equal(visibleInstances(second), 0);
  assert.equal(factory.create(ships[0]), roots[0], 'repeated create cannot leak a second instance buffer');
  const disposalCounts = new Map<any, number>();
  for (const resource of [...geometry, ...material, ...instances]) {
    disposalCounts.set(resource, 0); resource.addEventListener('dispose', () => disposalCounts.set(resource, disposalCounts.get(resource)! + 1));
  }
  factory.dispose(); factory.dispose();
  for (const count of disposalCounts.values()) assert.equal(count, 1);
  const snapshot = matrices(first); factory.impact(ships[0].id, new Vector3(), 3, 'explosive'); factory.update(ships[0], roots[0], 3);
  assert.deepEqual(matrices(first), snapshot); assert.throws(() => factory.create(ships[0]), /disposed/);
  assert.equal(instances.size, 21);
});

test('atmosphere preserves collision waves and one color transform without requiring textures or extra passes', () => {
  assert.ok(seaVertex.includes(OCEAN_GLSL)); assert.ok(seaFragment.includes(OCEAN_GLSL));
  assert.ok(seaVertex.includes('vWorld.y=oceanHeight(vWorld.xz,uTime)'));
  for (const fragment of [seaFragment, skyFragment]) {
    assert.equal(fragment.match(/#include <tonemapping_fragment>/g)?.length, 1);
    assert.equal(fragment.match(/#include <colorspace_fragment>/g)?.length, 1);
    assert.ok(!fragment.includes('sampler2D'));
  }
  assert.ok(skyVertex.includes('modelViewMatrix')); assert.ok(!skyFragment.includes('uTime'));
});
