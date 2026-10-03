import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { AllyAnnouncements } from '../src/ally-announcements';
import { createGame, startGame, stepGame } from '../src/simulation';
import { ALLY_RESPAWN_TICKS, FIXED_DT } from '../src/mission';
import type { Bullet, GameEvent } from '../src/types';

const neutral = { turn: 0, climb: 0, fire: false, loop: false };
function event(id: number, data: Partial<GameEvent>): GameEvent {
  return { id, owner: 2, position: new Vector3(), type: 'kill', team: 'friendly', targetTeam: 'enemy', targetKind: 'aircraft', ownerAllySlot: 0, ...data };
}
function quiet() {
  const state = createGame(123, 'normal');
  for (const target of [...state.allies, ...state.enemies, ...state.ships]) target.health = 0;
  state.player.position.set(1000, 1000, 1000); state.player.previous.copy(state.player.position);
  state.ships[0].health = state.ships[0].maxHealth;
  state.ships[0].position.set(30000, 0, 30000); state.ships[0].previous.copy(state.ships[0].position);
  startGame(state); return state;
}
function round(owner: number, team: Bullet['team'], x: number): Bullet {
  const position = new Vector3(x, 1000, 60);
  return { id: 90000 + x, owner, team, position, previous: position.clone(), velocity: new Vector3(0, 0, -12000), life: 1, damage: 200, kind: 'mg' };
}

test('ally activity derives the victim and exact shooter from destruction snapshots, not damage or ship hits', () => {
  const feed = new AllyAnnouncements();
  const events = [
    event(1, { targetTeam: 'friendly', owner: 1, ownerAllySlot: undefined, targetAllySlot: 2 }),
    event(2, { type: 'ally-respawn', owner: 1001, ownerAllySlot: 2 }),
    event(3, { owner: 3, ownerAllySlot: 1 }),
    event(4, { type: 'damage', targetAllySlot: 3 }),
    event(5, { targetKind: 'ship' }),
    event(6, { owner: 1, ownerAllySlot: undefined }),
    event(7, { team: 'enemy', ownerAllySlot: undefined }),
  ];
  feed.record(events); feed.record(events);
  assert.deepEqual(feed.update(10), ['僚機3が戦闘不能 · 40秒後に復帰', '僚機3が戦線へ復帰']);
  assert.deepEqual(feed.update(12.999), feed.snapshot().visible);
  assert.deepEqual(feed.update(13), ['僚機2が敵機を撃墜']);
  assert.deepEqual(feed.snapshot().totals, [
    { lost: 0, returned: 0, victory: 0 }, { lost: 0, returned: 0, victory: 1 },
    { lost: 1, returned: 1, victory: 0 }, { lost: 0, returned: 0, victory: 0 },
  ]);
});

test('simultaneous and sustained ally events coalesce into at most twelve pending groups without losing counts', () => {
  const feed = new AllyAnnouncements(); let id = 0;
  for (let burst = 0; burst < 50; burst++) for (let slot = 0; slot < 4; slot++) {
    feed.record([
      event(++id, { targetTeam: 'friendly', targetAllySlot: slot }),
      event(++id, { type: 'ally-respawn', ownerAllySlot: slot }),
      event(++id, { ownerAllySlot: slot }),
    ]);
  }
  assert.equal(feed.snapshot().pendingGroups, 12); assert.equal(feed.snapshot().pendingEvents, 600);
  const shown: string[] = [];
  for (let elapsed = 0; elapsed < 18; elapsed += 3) {
    const lines = feed.update(elapsed); assert.equal(lines.length, 2); shown.push(...lines);
    assert.deepEqual(feed.update(elapsed), lines, 'unchanged simulation time freezes notifications');
  }
  assert.equal(shown.length, 12); assert.ok(shown.every(line => line.endsWith('×50')));
  assert.deepEqual(feed.update(18), []);
  assert.ok(feed.snapshot().totals.every(item => item.lost === 50 && item.returned === 50 && item.victory === 50));
  feed.clear(); assert.deepEqual(feed.summary(), []); assert.deepEqual(feed.update(0), []);
  feed.record([event(1, {})]); assert.deepEqual(feed.update(0), ['僚機1が敵機を撃墜']);
});

test('actual friendly-fire loss, a dead ally remaining round, and respawn retain their four-slot identity', () => {
  const state = quiet(), ally = state.allies[2], enemy = state.enemies[0];
  ally.health = 1; ally.position.set(0, 1000, 0); ally.previous.copy(ally.position);
  enemy.health = 1; enemy.position.set(100, 1000, 0); enemy.previous.copy(enemy.position);
  state.bullets.push(round(state.player.id, 'friendly', 0), round(ally.id, 'friendly', 100));
  stepGame(state, neutral);
  const kills = state.events.filter(item => item.type === 'kill');
  assert.equal(kills.length, 2);
  assert.equal(kills[0].targetAllySlot, 2); assert.equal(kills[0].targetTeam, 'friendly');
  assert.equal(kills[1].ownerAllySlot, 2); assert.equal(kills[1].targetTeam, 'enemy');
  const feed = new AllyAnnouncements(); feed.record(state.events);
  const oldId = ally.id;
  state.tick += ALLY_RESPAWN_TICKS - 1; state.elapsed = state.tick * FIXED_DT;
  stepGame(state, neutral);
  assert.notEqual(state.allies[2].id, oldId);
  const returned = state.events.find(item => item.type === 'ally-respawn');
  assert.equal(returned?.ownerAllySlot, 2); feed.record(state.events);
  assert.deepEqual(feed.snapshot().totals[2], { lost: 1, returned: 1, victory: 1 });
  assert.deepEqual(feed.summary(), ['僚機3：敵機撃墜1 · 戦闘不能1 · 復帰1']);
});

test('final enemy destroyed by an ally remains in the report even when victory immediately ends the HUD', () => {
  const state = quiet(), enemy = state.enemies[0];
  state.ships[0].health = 0; enemy.health = 1; enemy.position.set(100, 1000, 0); enemy.previous.copy(enemy.position);
  state.bullets.push(round(state.allies[3].id, 'friendly', 100));
  stepGame(state, neutral); assert.equal(state.result?.outcome, 'victory');
  const feed = new AllyAnnouncements(); feed.record(state.events);
  assert.deepEqual(feed.summary(), ['僚機4：敵機撃墜1 · 戦闘不能0 · 復帰0']);
});
