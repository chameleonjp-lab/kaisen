import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/simulation';
import { missionProgress, payloadReadout } from '../src/mission-hud';
import { ruleSections } from '../src/rules-guide';

test('formation kill tallies start at zero and retain prior kills through enemy replenishment', () => {
  const state = createGame();
  assert.deepEqual(missionProgress(state), { aircraftDestroyed: 0, shipsDestroyed: 0, aircraftRemaining: 5, shipsRemaining: 4 });
  state.stats.playerAircraftKills = 2; state.stats.allyAircraftKills = 1; state.stats.allyShipKills = 1;
  for (const plane of state.enemies.slice(0, 3)) plane.health = 0;
  state.ships[0].health = 0;
  assert.deepEqual(missionProgress(state), { aircraftDestroyed: 3, shipsDestroyed: 1, aircraftRemaining: 2, shipsRemaining: 3 });
  for (const plane of state.enemies) plane.health = plane.maxHealth;
  assert.deepEqual(missionProgress(state), { aircraftDestroyed: 3, shipsDestroyed: 1, aircraftRemaining: 5, shipsRemaining: 3 });
  assert.equal(state.stats.score, 0, 'HUD never changes scoring');
});
test('payload readout distinguishes one remaining bomb from an action number and shows reload time', () => {
  assert.equal(payloadReadout(2, 0), '残り2発'); assert.equal(payloadReadout(1, 0), '残り1発');
  assert.equal(payloadReadout(0, 360), '装填 6.0秒'); assert.equal(payloadReadout(0, 1), '装填 0.1秒');
});
test('rule guide shows only the active device instructions and current keyboard bindings', () => {
  for (const mode of ['easy','normal'] as const) {
    const touch = JSON.stringify(ruleSections({ mode, input: 'touch', keyboardDescription: 'CUSTOM-KEYS' }));
    const pc = JSON.stringify(ruleSections({ mode, input: 'keyboard', keyboardDescription: 'CUSTOM-KEYS' }));
    assert.ok(touch.includes('スマートフォンの操作')); assert.ok(!touch.includes('CUSTOM-KEYS')); assert.ok(!touch.includes('PCの操作'));
    assert.ok(pc.includes('PCの操作')); assert.ok(pc.includes('CUSTOM-KEYS')); assert.ok(!pc.includes('スマートフォン')); assert.ok(!pc.includes('別の指'));
    assert.ok(pc.includes('40秒ごと')); assert.ok(pc.includes('自機は復活しません')); assert.ok(pc.includes('撃破数が5機に達するだけでは'));
  }
});
