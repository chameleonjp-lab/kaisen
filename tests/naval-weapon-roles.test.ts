import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';
import { applyAircraftRoundToShip, segmentMountContact, exposedNavalMountPoint } from '../src/naval-damage';
import { NAVAL_MOUNTS, stepNavalGuns } from '../src/naval';
import { releaseBomb } from '../src/ordnance';
import { FIXED_DT, MAX_ORDNANCE } from '../src/mission';
const neutral = { turn: 0, climb: 0, fire: false, loop: false };

function quiet() {
  const state = createGame(123, 'normal');
  for (const plane of [...state.allies, ...state.enemies]) plane.health = 0;
  for (const ship of state.ships) ship.health = 0;
  state.ships[0].health = state.ships[0].maxHealth;
  state.ships[0].position.set(30000, 0, 30000); state.ships[0].previous.copy(state.ships[0].position);
  state.player.position.set(0, 350, 0); state.player.previous.copy(state.player.position);
  startGame(state); return state;
}

test('aircraft rounds break an actual exposed AA body once but never perforate armored hull HP', () => {
  const state = quiet(), ship = state.ships[0], index = NAVAL_MOUNTS.findIndex(item => item.id === 'light-port-1');
  const center = new Vector3(...NAVAL_MOUNTS[index].pivot).add(new Vector3(0, -1, 0));
  const contact = segmentMountContact(center.clone().add(new Vector3(0, 10, 0)), center.clone().add(new Vector3(0, -2, 0)), ship);
  assert.equal(contact?.index, index);
  assert.deepEqual(applyAircraftRoundToShip(ship, 100, center, index), { partDamage: 60, mountDestroyed: true, armor: false });
  assert.equal(ship.guns[index].health, 0); assert.equal(ship.health, ship.maxHealth);
  assert.equal(applyAircraftRoundToShip(ship, 100, center, index).mountDestroyed, false);
  assert.equal(applyAircraftRoundToShip(ship, 100, new Vector3(0, 3, 0), null).armor, true);
  assert.equal(ship.health, ship.maxHealth);
  assert.equal(applyAircraftRoundToShip(ship, 100, new Vector3(0, 25, -16), null).partDamage, 100);
  assert.equal(ship.superstructureHealth, 140);
  ship.guns.forEach(gun => { gun.health = 0; gun.cooldown = 0; gun.targetId = state.player.id; });
  assert.deepEqual(stepNavalGuns(ship, [state.player], 600, FIXED_DT), []);
  assert.ok(ship.guns.filter((_, i) => NAVAL_MOUNTS[i].weapon.endsWith('aa')).every(gun => gun.targetId === null));
});

test('bombs use discrete release edges, six-second rearm, pause freeze, and retry reset', () => {
  const state = quiet();
  stepGame(state, { ...neutral, bomb: true }); assert.equal(state.player.bombs, 1); assert.equal(state.ordnance.length, 1);
  for (let i = 0; i < 40; i++) stepGame(state, { ...neutral, bomb: true });
  assert.equal(state.player.bombs, 1, 'holding the action cannot repeatedly drop');
  stepGame(state, neutral); stepGame(state, { ...neutral, bomb: true });
  assert.equal(state.player.bombs, 0); assert.equal(state.player.bombReloadTicks, 360);
  pauseGame(state); const frozen = JSON.stringify(state); stepGame(state, neutral, .25); assert.equal(JSON.stringify(state), frozen); resumeGame(state);
  for (let i = 0; i < 359; i++) stepGame(state, neutral);
  assert.equal(state.player.bombs, 0); assert.equal(state.player.bombReloadTicks, 1);
  stepGame(state, neutral); assert.equal(state.player.bombs, 2); assert.equal(state.player.bombReloadTicks, 0);
  assert.equal(state.events.filter(event => event.type === 'payload-reload' && event.weapon === 'bomb').length, 1);
  const fresh = createGame(); assert.equal(fresh.ordnance.length, 0); assert.equal(fresh.player.bombs, 2); assert.equal(fresh.player.torpedoes, 1);
});

test('invalid torpedo envelope or saturated payload pool consumes no ammunition', () => {
  const state = quiet(); stepGame(state, { ...neutral, torpedo: true });
  assert.equal(state.player.torpedoes, 1); assert.equal(state.ordnance.length, 0);
  assert.equal(state.events.find(event => event.type === 'payload-rejected')?.detail, 'altitude');
  state.player.position.y = 40; stepGame(state, neutral); stepGame(state, { ...neutral, torpedo: true });
  assert.equal(state.player.torpedoes, 0); assert.equal(state.ordnance[0].kind, 'torpedo');
  const full = quiet(); full.ordnance = Array.from({ length: MAX_ORDNANCE }, (_, id) => releaseBomb(id + 40000, full.player)!);
  stepGame(full, { ...neutral, bomb: true });
  assert.equal(full.player.bombs, 2); assert.equal(full.ordnance.length, MAX_ORDNANCE);
  assert.equal(full.events.find(event => event.type === 'payload-rejected')?.detail, 'capacity');
});

test('actual armed payload hits apply hull damage once and preserve ally versus player kill attribution', () => {
  for (const allied of [false, true]) {
    const state = quiet(), ship = state.ships[0]; ship.position.set(0, 0, 0); ship.previous.copy(ship.position); ship.velocity.set(0, 0, 0); ship.yaw = 0; ship.quaternion.identity(); ship.previousQuaternion.identity();
    state.player.position.set(10000, 1000, 10000); state.player.previous.copy(state.player.position);
    ship.health = 1400;
    const bomb = releaseBomb(40000, allied ? state.allies[2] : state.player)!;
    bomb.age = 1; bomb.position.set(0, 15, 110); bomb.previous.copy(bomb.position); bomb.velocity.set(0, -600, 0);
    state.ordnance.push(bomb); stepGame(state, neutral);
    assert.equal(ship.health, 0); assert.equal(state.result?.outcome, 'victory'); assert.equal(state.ordnance.length, 0);
    assert.equal(state.stats.playerShipKills, allied ? 0 : 1); assert.equal(state.stats.allyShipKills, allied ? 1 : 0);
    assert.equal(state.events.filter(event => event.type === 'ordnance-impact').length, 1);
    const frozen = JSON.stringify(state); stepGame(state, neutral); assert.equal(JSON.stringify(state), frozen);
  }
});


test('ordinary manual gun rounds suppress a visible AA mount while hull health remains armored', () => {
  const state=quiet(),ship=state.ships[0];
  ship.position.set(0,0,0);ship.previous.copy(ship.position);ship.velocity.set(0,0,0);
  ship.yaw=0;ship.quaternion.identity();ship.previousQuaternion.identity();
  const index=NAVAL_MOUNTS.findIndex(m=>m.id==='light-port-4');
  ship.guns.forEach((gun,i)=>{gun.health=i===index?60:0;gun.cooldown=1000;});
  state.player.position.set(-12,21,200);state.player.previous.copy(state.player.position);
  state.player.pitch=state.player.yaw=state.player.bank=0;state.player.quaternion.identity();
  assert.ok(exposedNavalMountPoint(ship,state.player.position),'visible mount offers an unobstructed optional Easy aim point');
  const hull=ship.health;let destroyed=0;
  for(let i=0;i<100&&ship.guns[index].health>0&&state.phase==='playing';i++) {
    stepGame(state,{...neutral,fire:true});
    destroyed+=state.events.filter(e=>e.type==='mount-destroyed'&&e.owner===state.player.id&&e.mountId==='light-port-4').length;
  }
  assert.equal(ship.guns[index].health,0);assert.equal(destroyed,1);
  assert.ok(state.stats.shots>0&&state.stats.hits>0);assert.equal(ship.health,hull);
  assert.ok(state.player.health>0,'suppression happens before entering the hull');
});
