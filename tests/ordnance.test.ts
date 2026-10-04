import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Quaternion, Vector3 } from 'three';
import { CAPITAL_SHIP, NAVAL_GRAVITY, createNavalMounts } from '../src/naval';
import { oceanHeight } from '../src/ocean';
import { ORDNANCE_TUNING, checkTorpedoRelease, predictBombImpact, releaseBomb, releaseTorpedo, stepOrdnance } from '../src/ordnance';
import type { OrdnanceAircraft, OrdnanceRound, OrdnanceShip } from '../src/ordnance';

const DT = 1 / 60;
const close = (a: number, b: number, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} versus ${b}`);
function aircraft(x = 0, y = 50, z = 0): OrdnanceAircraft {
  return { id: 1, team: 'friendly', position: new Vector3(x, y, z), quaternion: new Quaternion(), speed: 110, pitch: 0, bank: 0 };
}
function pose(source: OrdnanceAircraft, pitch: number, bank: number, yaw = 0): void {
  source.pitch = pitch; source.bank = bank;
  source.quaternion.setFromEuler(new Euler(pitch, yaw, -bank, 'YXZ'));
}
function ship(id = 8): OrdnanceShip {
  return { id, health: 4000, position: new Vector3(), previous: new Vector3(), quaternion: new Quaternion(),
    previousQuaternion: new Quaternion(), length: CAPITAL_SHIP.length, width: CAPITAL_SHIP.width, height: CAPITAL_SHIP.height };
}
function round(kind: 'bomb' | 'torpedo', position: Vector3, velocity: Vector3): OrdnanceRound {
  return { id: 44, owner: 1, team: 'friendly', kind, phase: 'air', position: position.clone(), previous: position.clone(),
    velocity: velocity.clone(), life: ORDNANCE_TUNING[kind].life, age: 0, waterDistance: 0, damage: ORDNANCE_TUNING[kind].damage };
}
function snapshot(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }

test('release copies the current aircraft pose and velocity without retaining aircraft state', () => {
  const source = aircraft(12, 250, 80); pose(source, .2, .3, 1);
  const bomb = releaseBomb(44, source)!;
  assert.ok(bomb);
  close(bomb.position.distanceTo(source.position), 1.2);
  assert.ok(bomb.position.distanceTo(new Vector3(0, -1.2, 0).applyQuaternion(source.quaternion).add(source.position)) < 1e-10);
  assert.ok(bomb.velocity.distanceTo(new Vector3(0, 0, -source.speed).applyQuaternion(source.quaternion)) < 1e-10);
  assert.equal(bomb.owner, source.id); assert.equal(bomb.team, source.team); assert.equal(bomb.damage, 2000);
  assert.equal(bomb.phase, 'air'); assert.equal(bomb.waterDistance, 0);
  const start = bomb.position.clone(), velocity = bomb.velocity.clone();
  source.position.set(-999, -999, -999); source.quaternion.identity(); source.speed = 65;
  stepOrdnance(bomb, [], 0, DT);
  close(bomb.position.x, start.x + velocity.x * DT); close(bomb.position.z, start.z + velocity.z * DT);
  close(bomb.position.y, start.y + velocity.y * DT - .5 * 9.80665 * DT ** 2);
  close(bomb.velocity.y, velocity.y - 9.80665 * DT); assert.deepEqual(bomb.previous, start);
});

test('torpedo release permits the source cruise and enforces rack altitude against actual waves', () => {
  for (const speed of [65, 110, 125]) for (const altitude of [15, 90]) {
    const time = 4.3, source = aircraft(250, 0, -410);
    source.position.y = oceanHeight(250, -410, time) + altitude + 1.2; source.speed = speed;
    const check = checkTorpedoRelease(source, time); assert.equal(check.allowed, true); close(check.altitude, altitude);
    assert.ok(releaseTorpedo(45, source, time));
  }
  for (const altitude of [14.999, 90.001]) {
    const source = aircraft(0, altitude + 1.2, 0);
    assert.equal(checkTorpedoRelease(source, 0).reason, 'altitude'); assert.equal(releaseTorpedo(45, source, 0), null);
  }
});

test('torpedo speed, pitch and bank limits are inclusive; invalid aircraft are rejected', () => {
  for (const [speed, pitch, bank, reason] of [
    [125, .25, .4, null], [125, -.25, -.4, null], [125.001, 0, 0, 'speed'], [141, 0, 0, 'speed'],
    [110, .25001, 0, 'pitch'], [110, -.25001, 0, 'pitch'], [110, 0, .40001, 'bank'], [110, 0, -.40001, 'bank'],
  ] as const) {
    const source = aircraft(); source.speed = speed; pose(source, pitch, bank);
    assert.equal(checkTorpedoRelease(source, 0).reason, reason);
    assert.equal(releaseTorpedo(46, source, 0) !== null, reason === null);
  }
  const source = aircraft(); source.position.x = NaN;
  assert.equal(checkTorpedoRelease(source, 0).reason, 'invalid'); assert.equal(releaseBomb(1, source), null);
  source.position.x = 0; source.quaternion.set(0, 0, 0, 0);
  assert.equal(releaseTorpedo(1, source, 0), null);
  assert.equal(releaseBomb(NaN, aircraft()), null); assert.equal(checkTorpedoRelease(aircraft(), Infinity).reason, 'invalid');
});

test('bomb flight is ballistic and agrees across valid step sizes without homing', () => {
  const one = releaseBomb(1, aircraft(100, 600, 200))!, two = releaseBomb(2, aircraft(100, 600, 200))!;
  const start = one.position.clone();
  for (let i = 0; i < 60; i++) stepOrdnance(one, [], i * DT, DT);
  for (let i = 0; i < 30; i++) stepOrdnance(two, [], i / 30, 1 / 30);
  close(one.position.y, start.y - .5 * NAVAL_GRAVITY); close(one.position.z, start.z - 110);
  close(one.velocity.y, -NAVAL_GRAVITY); close(one.age, 1); close(one.life, 29);
  assert.ok(one.position.distanceTo(two.position) < 1e-9);
});

test('bombs hit the visible deck before sea contact and cannot apply the same impact twice', () => {
  const target = ship(), before = snapshot(target), bomb = round('bomb', new Vector3(10, 10, 100), new Vector3(0, -100, 0));
  bomb.age = 1;
  const result = stepOrdnance(bomb, [target], 0, DT);
  assert.equal(result.active, false); assert.equal(result.outcomes.length, 1);
  const impact = result.outcomes[0]; assert.equal(impact.type, 'impact');
  if (impact.type === 'impact') { assert.equal(impact.shipId, target.id); assert.equal(impact.damage, 2000); close(impact.position.y, 9); }
  assert.deepEqual(snapshot(target), before); assert.equal(bomb.life, 0);
  assert.deepEqual(stepOrdnance(bomb, [target], DT, DT).outcomes, []);
});

test('bombs hit shared bridge occluders, not an imaginary deck-only hit surface', () => {
  const bomb = round('bomb', new Vector3(0, 38, -23), new Vector3(0, -100, 0));
  bomb.age = 1;
  const result = stepOrdnance(bomb, [ship()], 0, DT);
  assert.equal(result.outcomes[0]?.type, 'impact'); close(bomb.position.y, 37.5);
});

test('water is the terminal first contact when a ship would only be encountered afterwards', () => {
  const target = ship(); target.position.y = -25; target.previous.copy(target.position);
  const bomb = round('bomb', new Vector3(10, oceanHeight(10, 100, 0) + .1, 100), new Vector3(0, -100, 0));
  const result = stepOrdnance(bomb, [target], 0, DT);
  assert.equal(result.active, false); assert.deepEqual(result.outcomes.map(o => o.type), ['splash']);
  close(bomb.position.y, oceanHeight(bomb.position.x, bomb.position.z, bomb.age), 1e-8);
});

test('first ship contact is ordered by swept contact, independent of array order', () => {
  const first = ship(10), later = ship(5); first.position.y = 12; first.previous.copy(first.position);
  const bomb = round('bomb', new Vector3(10, 22, 100), new Vector3(0, -900, 0));
  bomb.age = 1;
  const result = stepOrdnance(bomb, [later, first], 0, 1 / 30), impact = result.outcomes[0];
  assert.equal(impact.type, 'impact'); if (impact.type === 'impact') assert.equal(impact.shipId, 10);
  close(bomb.position.y, 21);
});

test('bomb fuse rejects deck overlap before .25s and arms exactly at that age', () => {
  for (const [age, expected] of [[0, 'dud'], [.249999, 'dud'], [.25, 'impact']] as const) {
    const bomb = round('bomb', new Vector3(10, 9, 100), new Vector3(0, -100, 0)); bomb.age = age;
    const result = stepOrdnance(bomb, [ship()], 0, DT);
    assert.equal(result.active, false); assert.equal(result.outcomes[0]?.type, expected);
    if (result.outcomes[0].type === 'dud') assert.equal(result.outcomes[0].reason, 'unarmed');
    close(bomb.age, age);
  }
  const crossing = round('bomb', new Vector3(10, 10, 100), new Vector3(0, -100, 0)); crossing.age = .245;
  assert.equal(stepOrdnance(crossing, [ship()], 0, DT).outcomes[0]?.type, 'impact');
  assert.ok(crossing.age > .25 && crossing.age < .26);
});

test('torpedoes touching the deck in air are duds even before any possible sea crossing', () => {
  const torpedo = round('torpedo', new Vector3(10, 10, 100), new Vector3(0, -100, -20));
  const result = stepOrdnance(torpedo, [ship()], 0, DT);
  assert.equal(result.active, false); assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].type, 'dud');
  if (result.outcomes[0].type === 'dud') assert.equal(result.outcomes[0].reason, 'air-contact');
  close(torpedo.position.y, 9); assert.equal(torpedo.waterDistance, 0);
});

test('torpedo water entry consumes remaining fixed-step time and cannot teleport to depth', () => {
  const torpedo = round('torpedo', new Vector3(0, .08, 0), new Vector3(100, -10, -40));
  const result = stepOrdnance(torpedo, [], 0, DT), splash = result.outcomes[0];
  assert.equal(result.active, true); assert.equal(splash?.type, 'splash'); assert.equal(torpedo.phase, 'water');
  assert.equal(result.outcomes.length, 1); close(torpedo.age, DT); close(torpedo.life, 70 - DT);
  const airTime = splash.position.x / 100, remaining = DT - airTime;
  close(torpedo.waterDistance, remaining * 24, 1e-8);
  close(Math.hypot(torpedo.velocity.x, torpedo.velocity.z), 24);
  close(torpedo.velocity.x / torpedo.velocity.z, -2.5);
  close(torpedo.position.x, splash.position.x + torpedo.velocity.x * remaining, 1e-8);
  close(torpedo.position.z, splash.position.z + torpedo.velocity.z * remaining, 1e-8);
  close(torpedo.position.y, splash.position.y - 6 * remaining, 1e-8);
  assert.ok(splash.position.y - torpedo.position.y < .1);
  assert.deepEqual(torpedo.previous, new Vector3(0, .08, 0));
});

test('the remaining water-entry interval still collides with a nearby hull before arming', () => {
  const edge = -CAPITAL_SHIP.width / 2 - .15;
  const start = new Vector3(edge, oceanHeight(edge, 0, 0) + .03, 0);
  const torpedo = round('torpedo', start, new Vector3(110, -20, 0));
  const result = stepOrdnance(torpedo, [ship()], 0, DT);
  assert.equal(result.active, false); assert.deepEqual(result.outcomes.map(o => o.type), ['splash', 'dud']);
  assert.equal(torpedo.phase, 'water'); assert.ok(torpedo.waterDistance > 0 && torpedo.waterDistance < .4);
  if (result.outcomes[1].type === 'dud') assert.equal(result.outcomes[1].reason, 'unarmed');
  assert.ok(torpedo.age < DT);
});

test('water run settles below actual waves with constant heading and no target attraction', () => {
  const torpedo = round('torpedo', new Vector3(0, 0, 0), new Vector3(110, -10, 0));
  stepOrdnance(torpedo, [], 0, DT);
  for (let tick = 1; tick < 180; tick++) stepOrdnance(torpedo, [], tick * DT, DT);
  close(torpedo.position.z, 0); close(torpedo.velocity.x, 24); close(torpedo.velocity.z, 0);
  close(torpedo.position.y, oceanHeight(torpedo.position.x, 0, 3) - 1.5, 1e-8);
  close(torpedo.waterDistance, 72); close(torpedo.age, 3); assert.ok(torpedo.life > 0);
});

test('violent torpedo entry splashes then duds without free hull damage', () => {
  for (const downward of [60.01, 90]) {
    const torpedo = round('torpedo', new Vector3(0, 0, 0), new Vector3(110, -downward, 0));
    const result = stepOrdnance(torpedo, [], 0, DT);
    assert.equal(result.active, false); assert.deepEqual(result.outcomes.map(o => o.type), ['splash', 'dud']);
    if (result.outcomes[1].type === 'dud') assert.equal(result.outcomes[1].reason, 'violent-entry');
    assert.equal(torpedo.waterDistance, 0);
  }
  const boundary = round('torpedo', new Vector3(0, 0, 0), new Vector3(110, -60, 0));
  assert.equal(stepOrdnance(boundary, [], 0, DT).active, true);
});

test('torpedo arming uses only water distance including exact contact fraction at 80m', () => {
  // At local z=0 and y=-1.5, the shared tapered hull has this exact half-beam.
  const halfBeam = CAPITAL_SHIP.width / 2 - .32 * (9 + 1.5) / 12;
  for (const [atContact, expected] of [[79.999, 'dud'], [80, 'impact'], [80.001, 'impact']] as const) {
    const torpedo = round('torpedo', new Vector3(-halfBeam, -1.5, 0), new Vector3(24, 0, 0));
    torpedo.phase = 'water'; torpedo.waterDistance = atContact; torpedo.age = 50;
    const result = stepOrdnance(torpedo, [ship()], 0, DT);
    assert.equal(result.active, false); assert.equal(result.outcomes[0]?.type, expected); close(torpedo.waterDistance, atContact);
    if (result.outcomes[0].type === 'impact') assert.equal(result.outcomes[0].damage, 2000);
    if (result.outcomes[0].type === 'dud') assert.equal(result.outcomes[0].reason, 'unarmed');
  }
  const crossing = round('torpedo', new Vector3(-halfBeam - .2, -1.5, 0), new Vector3(24, 0, 0));
  crossing.phase = 'water'; crossing.waterDistance = 79.9;
  const impact = stepOrdnance(crossing, [ship()], 0, DT).outcomes[0];
  assert.equal(impact.type, 'impact'); assert.ok(crossing.waterDistance > 80 && crossing.waterDistance < 80.2);
});

test('underwater torpedo sweeps moving hulls even when both endpoint hull poses miss', () => {
  const target = ship(); target.previous.x = -40; target.position.x = 40;
  const torpedo = round('torpedo', new Vector3(0, -1.5, 0), new Vector3(0, 0, -24));
  torpedo.phase = 'water'; torpedo.waterDistance = 90;
  const before = snapshot(target), result = stepOrdnance(torpedo, [target], 0, DT);
  assert.equal(result.outcomes[0]?.type, 'impact'); assert.equal(result.active, false);
  assert.deepEqual(snapshot(target), before); assert.ok(torpedo.age > 0 && torpedo.age < DT);
});

test('moving rotations and scaled hull dimensions use their actual ship transforms', () => {
  const target = ship(); target.previousQuaternion!.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 3);
  target.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
  const torpedo = round('torpedo', new Vector3(0, -1.5, -100), new Vector3(0, 0, -24));
  torpedo.phase = 'water'; torpedo.waterDistance = 100;
  assert.equal(stepOrdnance(torpedo, [target], 0, DT).outcomes[0]?.type, 'impact');
  const small = ship(); small.width /= 2; small.length /= 2; small.height /= 2;
  const bomb = round('bomb', new Vector3(5, 6, 50), new Vector3(0, -100, 0));
  bomb.age = 1;
  const result = stepOrdnance(bomb, [small], 0, DT); assert.equal(result.outcomes[0]?.type, 'impact'); close(bomb.position.y, 4.5);
});

test('expired rounds, invalid state and invalid dt fail safely without world mutation', () => {
  const target = ship(), before = snapshot(target);
  for (const dt of [0, -DT, NaN, Infinity, 1 / 20]) {
    const bomb = releaseBomb(1, aircraft())!, saved = snapshot(bomb);
    assert.equal(stepOrdnance(bomb, [target], 0, dt).active, true); assert.deepEqual(snapshot(bomb), saved);
  }
  const bomb = releaseBomb(1, aircraft())!; bomb.life = .001;
  assert.equal(stepOrdnance(bomb, [target], 0, DT).active, false); close(bomb.age, .001);
  assert.equal(stepOrdnance(bomb, [target], DT, DT).outcomes.length, 0);
  const tiny = releaseBomb(1, aircraft())!; tiny.life = 1e-12;
  assert.equal(stepOrdnance(tiny, [], 0, DT).active, false); close(tiny.age, 1e-12, 1e-15);
  for (const corrupt of [
    (b: OrdnanceRound) => { b.velocity.x = NaN; }, (b: OrdnanceRound) => { b.position.y = Infinity; },
    (b: OrdnanceRound) => { b.life = Infinity; }, (b: OrdnanceRound) => { b.damage = -1; },
  ]) {
    const bad = releaseBomb(1, aircraft())!; corrupt(bad);
    assert.deepEqual(stepOrdnance(bad, [target], 0, DT), { active: false, outcomes: [] }); assert.equal(bad.life, 0);
  }
  assert.deepEqual(snapshot(target), before);
});

test('dead ships are excluded and caller-selected reduced damage is preserved', () => {
  const dead = ship(); dead.health = 0;
  const bomb = round('bomb', new Vector3(10, 10, 100), new Vector3(0, -100, 0));
  assert.equal(stepOrdnance(bomb, [dead], 0, DT).active, true);
  const reduced = round('bomb', new Vector3(10, 10, 100), new Vector3(0, -100, 0)); reduced.damage = 400;
  reduced.age = 1;
  const impact = stepOrdnance(reduced, [ship()], 0, DT).outcomes[0];
  assert.equal(impact.type, 'impact'); if (impact.type === 'impact') assert.equal(impact.damage, 400);
});

test('bomb impact prediction gives a finite ballistic guide without changing aircraft state', () => {
  const source = aircraft(10, 201.2, 20), saved = snapshot(source), prediction = predictBombImpact(source, 0)!;
  close(prediction.time, Math.sqrt(400 / NAVAL_GRAVITY)); close(prediction.position.x, 10);
  close(prediction.position.z, 20 - 110 * prediction.time); close(prediction.position.y, 0);
  assert.deepEqual(snapshot(source), saved);
  assert.equal(predictBombImpact(source, 500), null); assert.equal(predictBombImpact(source, NaN), null);
  source.position.y = 100000; assert.equal(predictBombImpact(source, 0), null);
});

test('visible AA turret is the first bomb contact before a later platform can arm its fuse',()=>{
 const target=ship();target.guns=createNavalMounts(target.id);
 const bomb=round('bomb',new Vector3(-12,22,-18),new Vector3(0,-100,0));bomb.age=.241;
 const result=stepOrdnance(bomb,[target],0,DT);
 assert.equal(result.active,false);assert.equal(result.outcomes.length,1);
 assert.equal(result.outcomes[0].type,'dud');
 if(result.outcomes[0].type==='dud')assert.equal(result.outcomes[0].reason,'unarmed');
 assert.ok(bomb.position.y>21.69);assert.ok(bomb.age<.245);assert.equal(target.health,4000);
});

test('broad phase includes the relocated Iowa AA platform above the armored deck',()=>{
 const target=ship();target.guns=createNavalMounts(target.id);
 const bomb=round('bomb',new Vector3(12.5,14,10.98),new Vector3(0,-100,0));bomb.age=1;
 const result=stepOrdnance(bomb,[target],0,DT);
 assert.equal(result.active,false);assert.equal(result.outcomes[0]?.type,'impact');
 assert.ok(Math.abs(bomb.position.y-13.25)<.001);
});
