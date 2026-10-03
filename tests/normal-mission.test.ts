import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGame, startGame, stepGame } from '../src/simulation';
import type { FlightInput } from '../src/types';
import { createBrowserMissionPilot as createNormalMissionPilot } from './helpers/mission-browser-pilot';
import { pointerOffsetForControls } from './helpers/touch-reload-pilot';

test('Normal default fleet clears through manual fire and circular input with six/seven and coarse twelve tick hold', context => {
  for (const pattern of [[6], [6, 7], [12]]) {
    const state = createGame(undefined, 'normal'), pilot = createNormalMissionPilot();
    startGame(state);
    let nextSample = 0, sample = 0, navalShots = 0;
    let held: FlightInput = { turn: 0, climb: 0, fire: false, loop: false, viewAspect: 393 / 852 };
    const reloads: { type: 'reload-start' | 'reload-complete'; tick: number }[] = [];
    for (let i = 0; i < 60 * 600 && state.phase === 'playing'; i++) {
      if (state.tick >= nextSample) {
        nextSample = state.tick + pattern[sample++ % pattern.length];
        const before = JSON.stringify(state), snapshot = JSON.parse(before);
        const requested = pilot(snapshot);
        assert.equal(JSON.stringify(snapshot), before, 'pilot must only observe its snapshot');
        assert.equal(JSON.stringify(state), before, 'pilot must not modify the live world');
        const { dx, dy } = pointerOffsetForControls(requested.turn, requested.climb);
        const distance = Math.hypot(dx, dy);
        assert.ok(distance <= 36 + 1e-9, 'legal circular pointer radius');
        const response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
        held = { ...requested, turn: distance ? dx / distance * response : 0,
          climb: distance ? -dy / distance * response : 0, viewAspect: 393 / 852 };
      }
      const previousShots = state.stats.shots;
      stepGame(state, held);
      assert.equal(state.mode, 'normal');
      if (!held.fire && !held.bomb && !held.torpedo) assert.equal(state.stats.shots, previousShots, 'Normal launches only on the corresponding manual action');
      for (const event of state.events) {
        if (event.type === 'reload-start' || event.type === 'reload-complete') reloads.push({ type: event.type, tick: state.tick });
        if (event.type === 'shot' && state.ships.some(ship => ship.id === event.owner)) navalShots++;
      }
    }
    context.diagnostic(JSON.stringify({pattern,time:state.elapsed,hp:state.player.health,reason:state.endReason,cause:state.deathCause,stats:state.stats}));
    assert.equal(state.config.shipCount, 4);
    assert.equal(state.endReason, 'all-clear', `hold pattern ${pattern}`);
    assert.equal(state.result?.outcome, 'victory');
    assert.ok(state.player.health > 0);
    assert.ok(state.enemies.every(target => target.health <= 0));
    assert.ok(state.ships.every(target => target.health <= 0));
    assert.ok(state.stats.playerAircraftKills > 0 && state.stats.playerShipKills > 0);
    assert.ok(state.stats.shots > 0 && navalShots > 0, 'real manual combat and naval retaliation');
    // Bombs now sink armored hulls. A legitimate early victory need not spend
    // an entire gun magazine; dedicated reload tests still require all 360 ticks.
    if (reloads[1]) assert.equal(reloads[1].tick - reloads[0].tick, 360, 'full fixed-tick six-second reload');
  }
});


test('bombing pilot extends after an overhead pass with payloads still available at high altitude', async () => {
  const {updateQuaternion}=await import('../src/flight');
  for(const mode of ['easy','normal'] as const) for(const bombs of [1,2]) {
    const state=createGame(undefined,mode),pilot=createNormalMissionPilot(),ship=state.ships[0];
    for(const e of state.enemies)e.health=0;for(const s of state.ships.slice(1))s.health=0;
    const stern=ship.velocity.clone().normalize().negate();
    state.player.position.copy(ship.position).addScaledVector(stern,1800);state.player.position.y=900;
    state.player.yaw=ship.yaw;state.player.pitch=state.player.bank=0;updateQuaternion(state.player);
    pilot(state); // Reach the ordinary staging waypoint and start the bombing run.
    state.tick=600;state.elapsed=10;state.player.bombs=bombs;
    state.player.position.copy(ship.position).addScaledVector(stern,180);state.player.position.y=900;
    assert.ok(state.player.position.distanceTo(ship.position)>900,'3D distance cannot trigger a240m overhead escape');
    const before=JSON.stringify(state),command=pilot(state);assert.equal(JSON.stringify(state),before);
    assert.ok(command.climb>.2,'ordinary climbing extension creates another attack run');
    assert.equal(command.bomb,false);assert.equal(command.fire,false);
  }
});

test('Easy bombing pilot counters retained downward steering with ordinary upward input', async()=>{
  const {updateQuaternion}=await import('../src/flight');
  const {getFlightAssist}=await import('../src/flight-assist');
  const s=createGame(undefined,'easy'),pilot=createNormalMissionPilot(),ship=s.ships[0];
  for(const enemy of s.enemies)enemy.health=0;for(const other of s.ships.slice(1))other.health=0;
  const stern=ship.velocity.clone().normalize().negate();
  s.player.position.copy(ship.position).addScaledVector(stern,1800);s.player.position.y=900;
  s.player.yaw=ship.yaw;s.player.pitch=s.player.bank=0;updateQuaternion(s.player);pilot(s);
  s.player.position.copy(ship.position).addScaledVector(stern,800);s.player.position.y=900;
  const enemy=s.enemies[0];enemy.health=enemy.maxHealth;
  enemy.position.copy(s.player.position).addScaledVector(stern,-1000);enemy.position.y=600;
  s.tick=600;s.elapsed=10;const before=JSON.stringify(s),command=pilot(s);
  const neutral={turn:0,climb:0,fire:false,loop:false,viewAspect:393/852};
  assert.ok(getFlightAssist(s.player,[ship,enemy],neutral,'easy').climb<-.1,'a visible lower aircraft pulls a neutral bombing approach downward');
  assert.ok(command.climb>.05);
  assert.equal(getFlightAssist(s.player,[ship,enemy],{...command,viewAspect:393/852},'easy').climb,command.climb);
  assert.equal(JSON.stringify(s),before);
});

test('final air engagement retains collision avoidance without fleeing every safe 250m pass in both modes', async()=>{
  const {updateQuaternion}=await import('../src/flight');
  for(const mode of ['easy','normal'] as const) for(const offset of [0,60]) {
    const s=createGame(undefined,mode),pilot=createNormalMissionPilot();
    for(const ship of s.ships)ship.health=0;for(const enemy of s.enemies.slice(1))enemy.health=0;
    const enemy=s.enemies[0];s.player.position.set(0,500,0);enemy.position.set(offset,500,-190);
    enemy.yaw=Math.PI;enemy.speed=110;updateQuaternion(enemy);updateQuaternion(s.player);
    const command=pilot(s);
    if(offset===0)assert.equal(Math.abs(command.climb),1,'actual collision course is still dodged');
    else assert.ok(Math.abs(command.climb)<.1,'a passing aircraft can be engaged instead of a mandatory three-second climb');
  }
});

test('Normal recovery can engage a safe passing enemy while a distant ship remains alive', async()=>{
  const {updateQuaternion}=await import('../src/flight');
  const s=createGame(undefined,'normal'),pilot=createNormalMissionPilot();
  for(const enemy of s.enemies.slice(1))enemy.health=0;
  for(const ship of s.ships)ship.position.set(5000,0,5000);
  s.player.health=50;s.player.position.set(0,500,0);
  const enemy=s.enemies[0];enemy.position.set(60,500,-190);enemy.yaw=Math.PI;enemy.speed=110;enemy.generation='reinforcement';
  updateQuaternion(enemy);updateQuaternion(s.player);
  const before=JSON.stringify(s),command=pilot(s);
  assert.ok(Math.abs(command.climb)<.1,'distant surviving ships must not force a three-second air disengagement');
  assert.equal(JSON.stringify(s),before);
});

test('Easy chooses a target whose required lead and live firing circle can coexist', async()=>{
  const {updateQuaternion}=await import('../src/flight');
  for(const mode of ['easy','normal'] as const) {
    const s=createGame(undefined,mode),pilot=createNormalMissionPilot(true);
    for(const ship of s.ships)ship.health=0;for(const enemy of s.enemies.slice(2))enemy.health=0;
    s.player.position.set(0,500,0);updateQuaternion(s.player);
    const crossing=s.enemies[0],trailing=s.enemies[1];
    crossing.position.set(80,500,-650);crossing.yaw=-Math.PI/2;updateQuaternion(crossing);
    trailing.position.set(-100,500,-850);trailing.yaw=0;updateQuaternion(trailing);
    const before=JSON.stringify(s),command=pilot(s);
    if(mode==='easy')assert.ok(command.turn<0,'select the usable left-hand target instead of an unfireable crossing lead');
    else assert.ok(command.turn>0,'Normal manual fire is not restricted by the Easy circle');
    assert.equal(JSON.stringify(s),before);
  }
});

test('Easy completes a begun bombing pass before switching to recovery, then still exits overhead',async()=>{
  const {updateQuaternion}=await import('../src/flight');
  const s=createGame(undefined,'easy'),pilot=createNormalMissionPilot(),ship=s.ships[0];
  for(const enemy of s.enemies)enemy.health=0;
  for(const other of s.ships.slice(1))other.health=0;
  const stern=ship.velocity.clone().normalize().negate();
  s.player.position.copy(ship.position).addScaledVector(stern,1800);s.player.position.y=900;
  s.player.yaw=ship.yaw;s.player.pitch=s.player.bank=0;updateQuaternion(s.player);pilot(s);
  s.tick=600;s.elapsed=10;s.player.health=50;
  s.player.position.copy(ship.position).addScaledVector(stern,800);s.player.position.y=900;
  const enemy=s.enemies[0];enemy.health=enemy.maxHealth;enemy.generation='reinforcement';
  enemy.position.copy(s.player.position);enemy.position.x+=1000;
  const before=JSON.stringify(s),command=pilot(s);
  assert.ok(Math.abs(command.turn)<.01,'continue the established ship axis despite a recovery target to the side');
  assert.equal(JSON.stringify(s),before);
  s.tick+=6;s.elapsed+=.1;
  s.player.position.copy(ship.position).addScaledVector(stern,180);s.player.position.y=900;
  const exit=pilot(s);
  assert.ok(exit.climb>.2,'commitment still ends at the normal overhead escape');
  assert.equal(exit.bomb,false);assert.equal(exit.fire,false);
});
