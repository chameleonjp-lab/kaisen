import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardOf, updateQuaternion } from '../src/flight';
import { createGame } from '../src/simulation';
import { createBrowserMissionPilot } from './helpers/mission-browser-pilot';

test('Easy collision dodge moves away from an aircraft above when the full dodge has ground clearance', () => {
  for (const altitude of [323, 280]) {
    const state = createGame(undefined, 'easy');
    for (const ship of state.ships) ship.health = 0;
    for (const enemy of state.enemies.slice(1)) enemy.health = 0;
    const player = state.player, enemy = state.enemies[0];
    player.position.set(0, altitude, 0); player.yaw = 0; player.pitch = .15; player.speed = 110;
    enemy.position.set(0, altitude + 87, -154); enemy.yaw = Math.PI; enemy.pitch = -.5; enemy.speed = 120;
    updateQuaternion(player); updateQuaternion(enemy);
    const relative = enemy.position.clone().sub(player.position);
    const velocity = forwardOf(enemy).multiplyScalar(enemy.speed).sub(forwardOf(player).multiplyScalar(player.speed));
    const time = -relative.dot(velocity) / velocity.lengthSq();
    assert.ok(time > .7 && time < .9, 'the recorded close approach is less than a second away');
    assert.ok(relative.clone().addScaledVector(velocity, time).length() < 40, 'the existing collision predictor must trigger');
    const before = JSON.stringify(state), command = createBrowserMissionPilot()(state);
    assert.equal(JSON.stringify(state), before, 'the pilot only observes the world');
    assert.equal(command.turn, 0);
    assert.equal(command.climb, altitude === 323 ? -1 : 1,
      'descend away from higher traffic only when two seconds of travel leave the existing 90m floor');
    assert.equal(command.fire, false);
    assert.equal(command.bomb, false);
  }
});
