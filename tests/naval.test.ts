import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InstancedMesh, Matrix4, Mesh, Quaternion, Raycaster, Vector3 } from 'three';
import { makeAircraft, makeFleet } from '../src/mission';
import { ShipFactory } from '../src/ships';
import {
  CAPITAL_SHIP, MAX_LIVE_NAVAL_ROUNDS_PER_SHIP, MAX_NAVAL_SHOTS_PER_STEP, NAVAL_GRAVITY,
  NAVAL_MOUNTS, NAVAL_PLATFORM_PARTS, NAVAL_WEAPONS, createNavalMounts, navalAnglesAllowed, navalBarrelClear,
  navalDirection, navalMuzzleLocal, segmentNavalHullEntry, shipCollisionBoxes, solveNavalAim, stepNavalGuns, wrapNavalAngle,
} from '../src/naval';
import type { NavalMountState, NavalShot } from '../src/naval';
const DT = 1 / 60, RAD = Math.PI / 180;
function shipAtOrigin() {
  const ship = makeFleet(3)[0]; ship.position.set(0, 0, 0); ship.previous.copy(ship.position);
  ship.quaternion.identity(); ship.yaw = 0; ship.velocity.set(0, 0, 0); ship.guns = createNavalMounts(ship.id); return ship;
}
function targetAt(x: number, y = 180, z = 0, id = 1) {
  const target = makeAircraft(id, 'friendly', new Vector3(x, y, z)); target.speed = 0; return target;
}
function close(a: number, b: number, error = 1e-8) { assert.ok(Math.abs(a - b) < error, `${a} versus ${b}`); }

test('capitalships preserve meter scale and early-fit visible turret/barrel counts', () => {
  for (const ship of makeFleet(3)) assert.deepEqual([ship.length, ship.width, ship.height], [263, 38.9, 42]);
  for (const [kind, count, barrels] of [['main', 3, 9], ['secondary', 4, 12], ['heavy-aa', 6, 12], ['light-aa', 8, 24]] as const) {
    const mounts = NAVAL_MOUNTS.filter(m => m.weapon === kind); assert.equal(mounts.length, count);
    assert.equal(mounts.reduce((sum, m) => sum + NAVAL_WEAPONS[m.weapon].barrels, 0), barrels);
  }
  close(CAPITAL_SHIP.length / 12, 21.9166666667, 1e-9);
  assert.equal(NAVAL_WEAPONS.main.roundsPerMinute, 1.8); assert.equal(NAVAL_WEAPONS.main.historicalMaxRange, 42000);
  assert.equal(new Set(NAVAL_MOUNTS.map(m => m.id)).size, 21);
});

test('each AA mount selects its own legal outboard target and main guns do not engage aircraft', () => {
  const ship = shipAtOrigin(), port = targetAt(-600), starboard = targetAt(600, 180, 0, 2);
  const shots: NavalShot[] = [];
  for (let tick = 0; tick < 360; tick++) shots.push(...stepNavalGuns(ship, [port, starboard], tick, DT));
  assert.ok(shots.length > 60);
  for (const gun of ship.guns) {
    const definition = NAVAL_MOUNTS.find(d => d.id === gun.mountId)!;
    if (definition.weapon === 'main' || definition.weapon === 'secondary') { assert.equal(gun.targetId, null); assert.equal(gun.salvo, 0); }
    else { assert.equal(gun.targetId, definition.pivot[0] < 0 ? port.id : starboard.id); assert.ok(gun.salvo > 0); }
  }
  assert.ok(shots.every(shot => shot.mountId.startsWith('heavy-') || shot.mountId.startsWith('light-')));
});

test('turret movement, including dispersion and branch-cut crossings, never exceeds mechanical rates', () => {
  const ship = shipAtOrigin(), target = targetAt(500, 300, 400);
  for (let tick = 0; tick < 900; tick++) {
    if (tick === 350) target.position.set(500, 250, -450);
    const before = ship.guns.map(g => ({ yaw: g.yaw, elevation: g.elevation }));
    stepNavalGuns(ship, [target], tick, DT);
    ship.guns.forEach((gun, i) => {
      const definition = NAVAL_MOUNTS[i];
      assert.ok(Math.abs(wrapNavalAngle(gun.yaw - before[i].yaw)) <= definition.traverseRate * DT + 1e-10);
      assert.ok(Math.abs(gun.elevation - before[i].elevation) <= definition.elevationRate * DT + 1e-10);
      assert.ok(navalAnglesAllowed(definition, gun.yaw, gun.elevation));
    });
  }
});

test('legal AA targets survive near-distance crossings but a target 20% closer wins the next decision', () => {
  const ship = shipAtOrigin(), current = targetAt(700, 180, -200, 2), challenger = targetAt(720, 180, 200, 1);
  const index = NAVAL_MOUNTS.findIndex(m => m.id === 'heavy-starboard-2'), gun = ship.guns[index];
  const decisionTick = (12 - index % 12) % 12;
  stepNavalGuns(ship, [challenger, current], 0, DT);
  assert.equal(gun.targetId, current.id);
  // The closer aircraft has the smaller ID too: neither sort order nor a minor
  // distance advantage should discard the current mount's finite-speed tracking.
  challenger.position.x = 690;
  for (let tick = decisionTick; tick < decisionTick + 60; tick += 12) {
    stepNavalGuns(ship, tick % 24 ? [current, challenger] : [challenger, current], tick, DT);
    assert.equal(gun.targetId, current.id);
  }
  challenger.position.copy(current.position).multiplyScalar(.8);
  stepNavalGuns(ship, [current, challenger], decisionTick + 60, DT);
  assert.equal(gun.targetId, challenger.id, '20% distance boundary is inclusive');
});

test('AA retention immediately releases dead, out-of-range and out-of-arc targets', () => {
  for (const invalidate of [
    (p: ReturnType<typeof targetAt>) => { p.health = 0; },
    (p: ReturnType<typeof targetAt>) => { p.position.set(4000, 180, 0); },
    (p: ReturnType<typeof targetAt>) => { p.position.set(-500, 180, 0); },
  ]) {
    const ship = shipAtOrigin(), current = targetAt(500, 180, 0, 1), alternative = targetAt(700, 180, 200, 2);
    const index = NAVAL_MOUNTS.findIndex(m => m.id === 'heavy-starboard-2'), gun = ship.guns[index];
    stepNavalGuns(ship, [alternative, current], 0, DT); assert.equal(gun.targetId, current.id);
    invalidate(current);
    const nonDecisionTick = (13 - index % 12) % 12;
    assert.notEqual((nonDecisionTick + index) % 12, 0);
    stepNavalGuns(ship, [current, alternative], nonDecisionTick, DT);
    assert.equal(gun.targetId, alternative.id);
    alternative.health = 0;
    stepNavalGuns(ship, [current, alternative], nonDecisionTick, DT);
    assert.equal(gun.targetId, null);
  }
});

test('same-tick twin/triple volleys originate at all real barrel ends without phantom grouped rounds', () => {
  const ship = shipAtOrigin(), target = targetAt(700);
  const kinds = new Set<string>();
  for (let tick = 0; tick < 500; tick++) {
    const shots = stepNavalGuns(ship, [target], tick, DT);
    assert.ok(shots.length <= MAX_NAVAL_SHOTS_PER_STEP);
    const ids = new Set(shots.map(shot => shot.mountId));
    for (const id of ids) {
      const group = shots.filter(shot => shot.mountId === id), definition = NAVAL_MOUNTS.find(d => d.id === id)!, gun = ship.guns.find(g => g.mountId === id)!;
      const weapon = NAVAL_WEAPONS[definition.weapon]; kinds.add(definition.weapon);
      assert.equal(group.length, weapon.barrels); assert.equal(new Set(group.map(s => s.barrelIndex)).size, weapon.barrels);
      group.forEach(shot => {
        assert.ok(shot.position.distanceTo(navalMuzzleLocal(definition, gun, shot.barrelIndex)) < 1e-9);
        assert.ok(shot.velocity.clone().normalize().distanceTo(navalDirection(gun.yaw, gun.elevation)) < 1e-9);
        close(shot.velocity.length(), weapon.muzzleSpeed); assert.equal(shot.gravity, NAVAL_GRAVITY);
      });
      assert.ok(group[0].position.distanceTo(group[1].position) > .3);
    }
  }
  assert.deepEqual([...kinds].sort(), ['heavy-aa', 'light-aa']);
});

test('per-barrel rate retains 220rpm bursts, 15-round magazine gaps, and 10rpm heavy cycle', () => {
  const ship = shipAtOrigin(), target = targetAt(700), fires = new Map<string, number[]>();
  for (let tick = 0; tick < 60 * 90; tick++) {
    for (const shot of stepNavalGuns(ship, [target], tick, DT)) if (shot.barrelIndex === 0) {
      const values = fires.get(shot.mountId) ?? []; values.push(tick); fires.set(shot.mountId, values);
    }
  }
  const light = fires.get('light-starboard-2')!, heavy = fires.get('heavy-starboard-2')!;
  assert.ok(light.length > 140 && light.length < 175, `sustained90s=${light.length}`);
  const gaps = light.slice(1).map((tick, i) => (tick - light[i]) * DT);
  assert.ok(gaps.some(gap => Math.abs(gap - 16 * DT) < 1e-8)); assert.ok(gaps.some(gap => Math.abs(gap - 17 * DT) < 1e-8));
  const reloadGaps = gaps.map((gap, i) => ({ gap, i })).filter(g => g.gap > 4);
  assert.ok(reloadGaps.length >= 9); assert.equal(reloadGaps[0].i, 14);
  assert.ok(heavy.length >= 14 && heavy.length <= 15);
  heavy.slice(1).forEach((tick, i) => close((tick - heavy[i]) * DT, 6, DT + 1e-8));
});

test('finite range, low-altitude light-AA envelope, dead targets and invalid ticks cannot fire', () => {
  const ship = shipAtOrigin();
  const snapshots = JSON.stringify(ship.guns);
  for (const dt of [0, -1, NaN, Infinity, 1]) assert.deepEqual(stepNavalGuns(ship, [targetAt(400)], 0, dt), []);
  assert.equal(JSON.stringify(ship.guns), snapshots);
  for (const target of [targetAt(3000), targetAt(500, 2800)]) {
    for (let tick = 0; tick < 360; tick++) assert.deepEqual(stepNavalGuns(ship, [target], tick, DT), []);
  }
  const high = targetAt(900, 1000);
  const shots = Array.from({ length: 900 }, (_, tick) => stepNavalGuns(ship, [high], tick, DT)).flat();
  assert.ok(shots.length > 0); assert.ok(shots.every(s => s.mountId.startsWith('heavy-')));
  high.health = 0; assert.deepEqual(stepNavalGuns(ship, [high], 901, DT), []);
  assert.ok(ship.guns.every(g => g.targetId === null));
  ship.health = 0; const dead = JSON.stringify(ship.guns);
  assert.deepEqual(stepNavalGuns(ship, [targetAt(600)], 902, DT), []); assert.equal(JSON.stringify(ship.guns), dead);
});

test('hull and pagoda block a barrel/path even independently of firing-arc checks', () => {
  const mount = NAVAL_MOUNTS.find(m => m.id === 'light-starboard-1')!;
  assert.equal(navalBarrelClear(mount, { yaw: -Math.PI / 2, elevation: 10 * RAD }, 1), true);
  assert.equal(navalBarrelClear(mount, { yaw: Math.PI / 2, elevation: 10 * RAD }, 1), false, 'inboard through bridge');
  assert.equal(navalBarrelClear(mount, { yaw: 0, elevation: -40 * RAD }, 1), false, 'down through deck');
  assert.equal(navalAnglesAllowed(mount, Math.PI / 2, 10 * RAD), false);
  assert.equal(navalAnglesAllowed(mount, -Math.PI / 2, 89 * RAD), false);
  assert.equal(navalAnglesAllowed(mount, NaN, 10 * RAD), false);
  const ship = shipAtOrigin(), boxes = shipCollisionBoxes(ship);
  assert.equal(boxes[0].min.y, 9); assert.equal(boxes.length, 12 + NAVAL_PLATFORM_PARTS.length);
  assert.ok(boxes.some(box => box.min.z < -16 && box.max.z > -16 && box.max.y === 37));
});

test('ballistic flight time accounts for gravity, moving targets and inherited ship velocity', () => {
  const origin = new Vector3(0, 15, 0), target = new Vector3(1000, 200, -50), targetV = new Vector3(0, 0, 120), shipV = new Vector3(6, 0, 0);
  const aim = solveNavalAim(origin, target, targetV, shipV, 720, 4.5); assert.ok(aim); assert.ok(aim.time > 1.3 && aim.time < 1.6);
  const hit = origin.clone().addScaledVector(aim.direction.clone().multiplyScalar(720).add(shipV), aim.time); hit.y -= .5 * NAVAL_GRAVITY * aim.time ** 2;
  assert.ok(hit.distanceTo(target.clone().addScaledVector(targetV, aim.time)) < .001);
  assert.equal(solveNavalAim(origin, target, targetV, shipV, 720, .5), null);
  assert.equal(solveNavalAim(origin, origin, targetV, shipV, 720, 4.5), null);
  assert.equal(solveNavalAim(origin, target, targetV, shipV, Infinity, 4.5), null);
});

test('launched shot retains initial trajectory when targets move and later turrets slew', () => {
  const ship = shipAtOrigin(), target = targetAt(600); let first: NavalShot | undefined;
  for (let tick = 0; tick < 240 && !first; tick++) first = stepNavalGuns(ship, [target], tick, DT)[0];
  assert.ok(first); const velocity = first.velocity.clone(), position = first.position.clone();
  target.position.set(-500, 100, -300);
  for (let tick = 240; tick < 600; tick++) stepNavalGuns(ship, [target], tick, DT);
  assert.ok(first.velocity.equals(velocity)); assert.ok(first.position.equals(position)); assert.equal(target.health, target.maxHealth);
});

test('7-ship full-arc synthetic load is deterministic and remains below conservative live-round bound', () => {
  const a = shipAtOrigin(), b = shipAtOrigin();
  const targets = [targetAt(600), targetAt(-600, 180, 0, 2)];
  let live: { death: number }[] = [], max = 0;
  for (let tick = 0; tick < 60 * 25; tick++) {
    const shotsA = stepNavalGuns(a, targets, tick, DT), shotsB = stepNavalGuns(b, targets.slice().reverse(), tick, DT);
    assert.deepEqual(shotsA, shotsB);
    live = live.filter(s => s.death > tick * DT); shotsA.forEach(s => live.push({ death: tick * DT + s.life }));
    max = Math.max(max, live.length); assert.ok(live.length <= MAX_LIVE_NAVAL_ROUNDS_PER_SHIP);
  }
  assert.ok(max > 80); assert.ok(MAX_LIVE_NAVAL_ROUNDS_PER_SHIP * 7 + 256 < 2048);
});

test('render batches preserve 57 independent barrel endpoints and read state without mutation', () => {
  const factory = new ShipFactory(), ship = shipAtOrigin(), root = factory.create(ship);
  ship.guns.forEach((g: NavalMountState, i) => { if (i > 6) { g.yaw += 12 * RAD; g.elevation = 37 * RAD; } });
  const before = JSON.stringify(ship.guns); factory.update(ship, root); assert.equal(JSON.stringify(ship.guns), before);
  const barrels = root.getObjectByName('naval-barrels') as InstancedMesh; assert.equal(barrels.count, 57);
  assert.equal((root.getObjectByName('naval-mounts') as InstancedMesh).count, 21);
  const matrix = new Matrix4(); let index = 0;
  NAVAL_MOUNTS.forEach((definition, i) => {
    for (let barrel = 0; barrel < NAVAL_WEAPONS[definition.weapon].barrels; barrel++) {
      barrels.getMatrixAt(index++, matrix); const endpoint = new Vector3(0, .5, 0).applyMatrix4(matrix);
      assert.ok(endpoint.distanceTo(navalMuzzleLocal(definition, ship.guns[i], barrel)) < 1e-5);
    }
  });
  let submissions = 0; root.traverse(o => { if (o instanceof Mesh) submissions++; }); assert.ok(submissions <= 11, `submissions=${submissions}`);
  const geometry = (root.children.find(o => o instanceof Mesh && !(o instanceof InstancedMesh)) as Mesh).geometry;
  let disposed = 0; geometry.addEventListener('dispose', () => disposed++); factory.dispose(); factory.dispose(); assert.equal(disposed, 1);
  assert.throws(() => factory.create(ship));
});

test('distinct roots share immutable static geometry but never another ship mount matrices', () => {
  const factory = new ShipFactory(), ship = shipAtOrigin(), other = shipAtOrigin(); other.id = 101;
  const a = factory.create(ship), b = factory.create(other);
  const aa = a.getObjectByName('naval-barrels') as InstancedMesh, bb = b.getObjectByName('naval-barrels') as InstancedMesh;
  assert.equal(aa.geometry, bb.geometry); assert.notEqual(aa.instanceMatrix, bb.instanceMatrix);
  const snapshot = Array.from(bb.instanceMatrix.array); ship.guns[0].elevation = .5; factory.update(ship, a);
  assert.deepEqual(Array.from(bb.instanceMatrix.array), snapshot); factory.dispose();
});


test('tapered bow/stern collision matches visible geometry, without an invisible rectangular deck', () => {
  const factory = new ShipFactory(), ship = shipAtOrigin(), root = factory.create(ship); root.updateMatrixWorld(true);
  for (const [x, z] of [[18, -125], [15, -110], [15, 125], [10, -130]]) {
    const start = new Vector3(x, 12, z), end = new Vector3(x, 1, z);
    assert.equal(segmentNavalHullEntry(start, end), null, `outside tapered hull ${x},${z}`);
    const ray = new Raycaster(start, new Vector3(0, -1, 0), 0, 11);
    assert.equal(ray.intersectObject(root, true).length, 0, `visible geometry also misses ${x},${z}`);
  }
  for (const [x, z] of [[0, -125], [0, -130], [15, 0], [-15, 0], [0, 125]]) {
    const start = new Vector3(x, 12, z), end = new Vector3(x, 1, z), time = segmentNavalHullEntry(start, end);
    assert.notEqual(time, null); close(time!, 3 / 11);
    const ray = new Raycaster(start, new Vector3(0, -1, 0), 0, 11);
    const hit = ray.intersectObject(root, true).find(hit => Math.abs(hit.point.y - 9) < 1e-6); assert.ok(hit);
  }
  assert.equal(segmentNavalHullEntry(new Vector3(0, 1, 0), new Vector3(0, 2, 0)), 0);
  assert.equal(segmentNavalHullEntry(new Vector3(0, 10, 0), new Vector3(0, 11, 0)), null);
  assert.equal(segmentNavalHullEntry(new Vector3(0, 10, 0), new Vector3(0, 11, 0), 1), 0);
  factory.dispose();
});


test('low-flying aircraft remain engageable by light AA with safe outboard depression', () => {
  const ship = shipAtOrigin(), target = targetAt(500, 5);
  const shots: NavalShot[] = [];
  for (let tick = 0; tick < 600; tick++) shots.push(...stepNavalGuns(ship, [target], tick, DT));
  const light = shots.filter(s => s.mountId.startsWith('light-'));
  assert.ok(light.length > 30, `sea-skimming target gets real light-AA shots: ${light.length}`);
  assert.ok(light.some(s => s.velocity.y < 0), 'actual depressed trajectories, not overhead visual fire');
  for (const gun of ship.guns) {
    const definition = NAVAL_MOUNTS.find(d => d.id === gun.mountId)!;
    if (definition.weapon === 'light-aa' && gun.salvo > 0) {
      assert.ok(gun.elevation < 0); assert.ok(gun.elevation >= -10 * RAD);
      for (let barrel = 0; barrel < 3; barrel++) assert.ok(navalBarrelClear(definition, gun, barrel));
    }
  }
});


test('depressed legal forward rays cannot pass through adjacent AA platforms or supports', () => {
  const factory = new ShipFactory(), ship = shipAtOrigin(), root = factory.create(ship); root.updateMatrixWorld(true);
  const definition = NAVAL_MOUNTS.find(m => m.id === 'light-starboard-4')!;
  for (const [degrees, barrel] of [[-5, 0], [-6, 0], [-6, 1], [-7, 0], [-7, 1]]) {
    const angles = { yaw: -8 * RAD, elevation: degrees * RAD };
    assert.ok(navalAnglesAllowed(definition, angles.yaw, angles.elevation));
    {
      const muzzle = navalMuzzleLocal(definition, angles, barrel), direction = navalDirection(angles.yaw, angles.elevation);
      const ray = new Raycaster(muzzle, direction, .01, 30), hit = ray.intersectObject(root, true)[0];
      assert.ok(hit, `visible adjacent platform blocks barrel ${barrel} at ${degrees} degrees`);
      assert.equal(navalBarrelClear(definition, angles, barrel), false);
      const boxes = shipCollisionBoxes(ship);
      assert.ok(boxes.some(box => hit.point.x >= box.min.x - .001 && hit.point.x <= box.max.x + .001 &&
        hit.point.y >= box.min.y - .001 && hit.point.y <= box.max.y + .001 &&
        hit.point.z >= box.min.z - .001 && hit.point.z <= box.max.z + .001), 'visible platform is also a ship damage solid');
    }
  }
  // The pivot is above its own platform: a properly outboard depressed barrel remains free.
  for (let barrel = 0; barrel < 3; barrel++) {
    assert.equal(navalBarrelClear(definition, { yaw: -90 * RAD, elevation: -6 * RAD }, barrel), true);
  }
  assert.equal(NAVAL_PLATFORM_PARTS.length, 36);
  factory.dispose();
});
