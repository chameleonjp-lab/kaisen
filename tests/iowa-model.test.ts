import assert from 'node:assert/strict';
import test from 'node:test';
import { Box3, InstancedMesh, Mesh, Quaternion, Raycaster, Vector3 } from 'three';
import { CAPITAL_SHIP, NAVAL_MOUNTS, NAVAL_STRUCTURE_PARTS, NAVAL_WEAPONS, createNavalMounts, segmentNavalHullEntry, stepNavalGuns } from '../src/naval';
import { segmentMountContact } from '../src/naval-damage';
import { ShipFactory } from '../src/ships';
import { makeAircraft, makeFleet } from '../src/mission';
import { createGame } from '../src/simulation';
import { AIRFRAME_CONTACT_VERTICES } from '../src/sea-contact';
import { projectFlightTarget } from '../src/flight-view';
import { beginShipWreck, shipWreckPose } from '../src/ship-wreck';

function localShip() {
  const ship = makeFleet(4)[0]; ship.position.set(0, 0, 0); ship.previous.copy(ship.position);
  ship.quaternion.identity(); ship.previousQuaternion.identity(); ship.yaw = 0; return ship;
}
function close(a: number, b: number, tolerance = 2e-5) { assert.ok(Math.abs(a - b) < tolerance, `${a} versus ${b}`); }
function vertices(mesh: Mesh) {
  const position = mesh.geometry.getAttribute('position');
  return Array.from({ length: position.count }, (_, i) => new Vector3().fromBufferAttribute(position, i));
}

test('rendered Iowa hull/deck have real 887ft3in by 108ft2in proportions, without a root scale trick', () => {
  const factory = new ShipFactory(), ship = localShip(), root = factory.create(ship);
  try {
    assert.deepEqual(root.scale.toArray(), [1, 1, 1]);
    for (const name of ['iowa-hull', 'iowa-deck']) {
      const mesh = root.getObjectByName(name) as Mesh, size = new Box3().setFromPoints(vertices(mesh)).getSize(new Vector3());
      close(size.z, (887 + 3 / 12) * .3048, .005); close(size.x, (108 + 2 / 12) * .3048, .005);
      close(size.z, ship.length); close(size.x, ship.width);
    }
    const funnels = NAVAL_STRUCTURE_PARTS.filter(part => part.shape === 'cylinder');
    assert.equal(funnels.length, 2); assert.ok(funnels[1].position[2] - funnels[0].position[2] > 30);
    assert.equal(NAVAL_MOUNTS.filter(m => NAVAL_WEAPONS[m.weapon].caliberMm === 127).length, 10);
    const mains = NAVAL_MOUNTS.filter(m => m.weapon === 'main');
    assert.deepEqual(mains.map(m => NAVAL_WEAPONS[m.weapon].barrels), [3, 3, 3]);
    assert.ok(mains[0].pivot[2] < mains[1].pivot[2] && mains[1].pivot[2] < 0 && mains[2].pivot[2] > 0);
    assert.ok(mains[1].pivot[1] > mains[0].pivot[1], 'second forward turret is superfiring');
  } finally { factory.dispose(); }
});

test('700 oblique hull rays agree with visible triangles, including the same listed wreck transform', () => {
  const factory = new ShipFactory(), ship = localShip(), root = factory.create(ship);
  try {
    const hull = ['iowa-hull', 'iowa-deck'].map(name => root.getObjectByName(name) as Mesh);
    beginShipWreck(ship, 0);
    for (const age of [0, 11]) {
      shipWreckPose(ship.wreck!, age, root.position, root.quaternion); root.updateMatrixWorld(true);
      for (let i = 0; i < 350; i++) {
        const angle = i * 2.399963229728653;
        const start = new Vector3(Math.cos(angle) * 35, 16 + (i % 11), Math.sin(angle) * 165);
        const end = new Vector3(Math.sin(angle * 3) * 22, -6, Math.cos(angle * 2) * 155);
        const fraction = segmentNavalHullEntry(start, end);
        const from = start.clone().applyMatrix4(root.matrixWorld), to = end.clone().applyMatrix4(root.matrixWorld);
        const length = from.distanceTo(to), ray = new Raycaster(from, to.clone().sub(from).normalize(), 0, length);
        const hit = ray.intersectObjects(hull, false)[0];
        assert.equal(fraction !== null, !!hit, `age=${age} ray=${i}`);
        if (hit && fraction !== null) close(hit.distance / length, fraction, 1e-6);
      }
    }
  } finally { factory.dispose(); }
});

test('sloped armor collision matches actual rotating gun-house triangles for every mount', () => {
  const factory = new ShipFactory(), ship = localShip(), root = factory.create(ship);
  try {
    ship.guns.forEach((gun, i) => gun.yaw += Math.sin(i) * .5); factory.update(ship, root); root.updateMatrixWorld(true);
    const bodies = root.getObjectByName('naval-mounts') as InstancedMesh;
    for (const definition of NAVAL_MOUNTS) for (let i = 0; i < 32; i++) {
      const angle = i * Math.PI / 16, center = new Vector3(...definition.pivot).add(new Vector3(0, -1, 0));
      const from = center.clone().add(new Vector3(Math.cos(angle) * 40, (i % 2 ? 1 : -1) * 50, Math.sin(angle) * 40));
      const to = center.clone().add(new Vector3(Math.sin(angle * 2) * 8, Math.cos(angle) * 4, Math.cos(angle * 2) * 8));
      const length = from.distanceTo(to), hit = new Raycaster(from, to.clone().sub(from).normalize(), 0, length).intersectObject(bodies)[0];
      const contact = segmentMountContact(from, to, ship);
      assert.equal(contact !== null, !!hit, `${definition.id} ray=${i}`);
      if (hit && contact) { assert.equal(contact.index, hit.instanceId); close(contact.fraction, hit.distance / length, 1e-6); }
    }
  } finally { factory.dispose(); }
});

test('quad light-AA preserves sustained damage and the prior per-round strength hierarchy', () => {
  const light = NAVAL_WEAPONS['light-aa']; assert.equal(light.caliberMm, 40); assert.equal(light.barrels, 4);
  assert.equal(light.damage, .8); assert.equal(light.roundsPerMinute, 120); assert.equal(light.magazine, 4);
  close(light.damage * light.barrels, 3.2);
  assert.ok(light.damage * light.barrels * light.roundsPerMinute < 3 * .8 * 220, 'burst pressure does not increase');
  const sustainedRpm = light.magazine / (60 * light.magazine / light.roundsPerMinute + light.reloadSeconds) * 60;
  close(sustainedRpm, 82.5); close(light.damage * light.barrels * sustainedRpm / 60, 3 * .8 * 110 / 60);
  assert.equal(NAVAL_MOUNTS.filter(m => m.weapon === 'heavy-aa').length, 6);
  assert.equal(NAVAL_MOUNTS.filter(m => m.weapon === 'light-aa').length, 8);
});

test('four-ship controlled AA emission stays within the pre-Iowa 90-second damage budget', context => {
  const targets = [-600, 600].map((x, i) => {
    const plane = makeAircraft(i + 1, 'friendly', new Vector3(x, 180, 0)); plane.speed = 0; return plane;
  });
  let heavy = 0, light = 0;
  // Each hull faces the same two legal, stationary targets in its own local space.
  // Baseline measurement: 3456 heavy + 12672 light HP emitted, not damage actually landed.
  for (const source of makeFleet(4)) {
    const ship = { ...source, position: new Vector3(), quaternion: new Quaternion(), velocity: new Vector3(), guns: createNavalMounts(source.id) };
    for (let tick = 0; tick < 90 * 60; tick++) for (const shot of stepNavalGuns(ship, targets, tick, 1 / 60)) {
      if (shot.mountId.startsWith('heavy-')) heavy += shot.damage; else light += shot.damage;
    }
  }
  close(heavy, 3456);
  assert.ok(light <= 12672 + 1e-6 && light > 12672 - 32 * 4 * 4 * .8, 'within one clip per mount of the old total, with no emission increase');
  context.diagnostic(JSON.stringify({ seconds: 90, ships: 4, heavy, light, emittedDamage: heavy + light, preIowaDamage: 16128 }));
});

test('same-camera projection separates 22.54-to-one physical size from nearby chase-plane perspective', context => {
  const state = createGame(), factory = new ShipFactory(), root = factory.create(state.ships[0]);
  try {
    const hull = vertices(root.getObjectByName('iowa-hull') as Mesh);
    const airframe = Array.from({ length: AIRFRAME_CONTACT_VERTICES.length / 3 }, (_, i) => new Vector3().fromArray(AIRFRAME_CONTACT_VERTICES, i * 3));
    const wingspan = new Box3().setFromPoints(airframe).getSize(new Vector3()).x;
    close(wingspan, 12); close(CAPITAL_SHIP.length / wingspan, 22.5358333333);
    const span = (points: Vector3[]) => {
      const x = points.map(p => projectFlightTarget(state.player, p, 393 / 852, 'easy').x);
      return (Math.max(...x) - Math.min(...x)) * 393 / 2;
    };
    const aircraftPixels = span(airframe.map(p => p.applyQuaternion(state.player.quaternion).add(state.player.position)));
    const shipPixels = span(hull.map(p => p.applyQuaternion(state.ships[0].quaternion).add(state.ships[0].position)));
    // With equal depth and orientation the ratio recovers the metre ratio exactly.
    const center = new Vector3(0, 220, -600);
    const equalDepthShip = span([center.clone().add(new Vector3(-CAPITAL_SHIP.length / 2, 0, 0)), center.clone().add(new Vector3(CAPITAL_SHIP.length / 2, 0, 0))]);
    const equalDepthPlane = span([center.clone().add(new Vector3(-6, 0, 0)), center.clone().add(new Vector3(6, 0, 0))]);
    close(equalDepthShip / equalDepthPlane, CAPITAL_SHIP.length / 12);
    assert.ok(shipPixels > aircraftPixels && shipPixels / aircraftPixels < 3);
    context.diagnostic(JSON.stringify({ physicalLength: CAPITAL_SHIP.length, wingspan, aircraftPixels, shipPixels,
      chasePixelRatio: shipPixels / aircraftPixels, sameDepthRatio: equalDepthShip / equalDepthPlane,
      player: state.player.position.toArray(), ship: state.ships[0].position.toArray(), shipYaw: state.ships[0].yaw, viewport: [393, 852] }));
  } finally { factory.dispose(); }
});
