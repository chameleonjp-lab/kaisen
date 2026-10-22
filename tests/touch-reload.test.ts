import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGame, startGame, stepGame } from '../src/simulation';
import { createTouchReloadPilot, pointerOffsetForControls } from './helpers/touch-reload-pilot';

test('real circular-stick mapping reaches and completes reload with six/seven tick sample jitter', () => {
  for (const pattern of [[6], [6, 7]]) {
    const state = createGame(), pilot = createTouchReloadPilot(); startGame(state);
    let next = 0, sample = 0;
    let held = { turn: 0, climb: 0, fire: false, loop: false, steeringActive: true, viewAspect: 393 / 852 };
    const reloads: number[] = [];
    for (let i = 0; i < 60 * 150 && reloads.length < 2 && state.phase === 'playing'; i++) {
      if (state.tick >= next) {
        next = state.tick + pattern[sample++ % pattern.length];
        const before = JSON.stringify(state);
        const requested = pilot(JSON.parse(before));
        assert.equal(JSON.stringify(state), before, 'pilot only observes');
        const { dx, dy } = pointerOffsetForControls(requested.turn, requested.climb);
        const distance = Math.hypot(dx, dy); assert.ok(distance <= 36 + 1e-9);
        const response = distance / 36 <= .08 ? 0 : (distance / 36 - .08) / .92;
        held = { ...held, turn: distance ? dx / distance * response : 0, climb: distance ? -dy / distance * response : 0 };
      }
      stepGame(state, held);
      for (const e of state.events) if (e.type === 'reload-start' || e.type === 'reload-complete') reloads.push(state.tick);
    }
    assert.ok(state.player.health > 0); // Full all-clear runs are optional scenarios in pilot-victories.scenario.ts.
    assert.ok(reloads.length >= 2); assert.equal(reloads[1] - reloads[0], 360);
    assert.ok(state.stats.shots >= 384);
  }
});

test('browser reload practice engages aircraft and completes real magazines despite uneven input delivery', async context => {
  for(const pattern of [[6,7],[6,10,15]]) {
    const state=createGame(),pilot=createTouchReloadPilot();startGame(state);
    let next=0,sample=0,pending:{tick:number;turn:number;climb:number}|null=null;
    let held={turn:0,climb:0,fire:false,loop:false,steeringActive:true,viewAspect:393/852};
    const reloads:number[]=[];
    for(let tick=0;tick<60*145&&reloads.length<2&&state.phase==='playing';tick++) {
      if(pending&&tick>=pending.tick){held={...held,turn:pending.turn,climb:pending.climb};pending=null;}
      if(tick>=next) {
        next=tick+pattern[sample++%pattern.length];
        const request=pilot(JSON.parse(JSON.stringify(state)));
        const {dx,dy}=pointerOffsetForControls(request.turn,request.climb),r=Math.hypot(dx,dy),response=r/36<=.08?0:(r/36-.08)/.92;
        assert.ok(r<=36+1e-9);pending={tick:tick+1,turn:r?dx/r*response:0,climb:r?-dy/r*response:0};
      }
      stepGame(state,held);
      for(const e of state.events)if(e.type==='reload-start'||e.type==='reload-complete')reloads.push(state.tick);
    }
    context.diagnostic(JSON.stringify({pattern,time:state.elapsed,hp:state.player.health,reloads,shots:state.stats.shots}));
    assert.equal(state.phase,'playing');assert.equal(reloads.length,2);assert.equal(reloads[1]-reloads[0],360);
    assert.ok(state.stats.shots>=384);assert.equal(state.player.bombs,2,'gun reload practice does not depend on ordnance');
  }
});


test('CI66 reload pose preserves collision avoidance through delayed legal stick delivery', async context => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/reload-collision-ci66.json', import.meta.url), 'utf8'));
  const replay = (legacy: boolean) => {
    const state = createGame(), pilot = createTouchReloadPilot(); startGame(state);
    for (const aircraft of [...state.allies, ...state.enemies]) aircraft.health = 0;
    for (const ship of state.ships) ship.health = 0;
    for (const [target, source] of [[state.player, fixture.player], [state.enemies[0], fixture.threat]] as const) {
      for (const [key, value] of Object.entries(source)) {
        if (key === 'quaternion') target.quaternion.fromArray(value as number[]);
        else if (key === 'position' || key === 'previous' || key === 'aiWaypoint') {
          const point = value as {x:number;y:number;z:number};
          target[key].set(point.x, point.y, point.z);
        } else (target as any)[key] = value;
      }
    }
    state.tick = fixture.tick; state.elapsed = fixture.elapsed;
    let held = {turn:0, climb:0, fire:false, loop:false, steeringActive:true, viewAspect:393/852};
    let pending: {tick:number; turn:number; climb:number} | null = null, next = state.tick;
    let minDistance = Infinity;
    while (state.phase === 'playing' && state.player.reloadTicksRemaining > 0) {
      if (pending && state.tick >= pending.tick) {
        held = {...held, turn:pending.turn, climb:pending.climb}; pending = null;
      }
      if (state.tick >= next) {
        next = state.tick + 12;
        const before = JSON.stringify(state), snapshot = JSON.parse(before);
        const request = legacy ? {turn:.45,climb:.8} : pilot(snapshot);
        assert.equal(JSON.stringify(state), before); assert.equal(JSON.stringify(snapshot), before);
        assert.ok(Math.hypot(request.turn,request.climb) <= 1 + 1e-12);
        const {dx,dy} = pointerOffsetForControls(request.turn,request.climb), r = Math.hypot(dx,dy);
        const response = r/36 <= .08 ? 0 : (r/36-.08)/.92;
        pending = {tick:state.tick+8,turn:r ? dx/r*response : 0,climb:r ? -dy/r*response : 0};
      }
      stepGame(state,held);
      minDistance = Math.min(minDistance,state.player.position.distanceTo(state.enemies[0].position));
    }
    return {state,minDistance};
  };
  const original = replay(true);
  assert.equal(original.state.deathCause,'aircraft-collision','the unchanged fixed climb reproduces the observed collision');
  const corrected = replay(false);
  assert.equal(corrected.state.phase,'playing'); assert.equal(corrected.state.result,null);
  assert.ok(corrected.state.player.health > 0);
  assert.equal(corrected.state.player.reloadTicksRemaining,0);
  assert.ok(corrected.state.player.mg + corrected.state.player.cannon > 0);
  assert.ok(corrected.minDistance > 20,`ordinary avoidance keeps over 20m of center separation (${corrected.minDistance}m)`);
  context.diagnostic(JSON.stringify({originalTick:original.state.tick,originalCause:original.state.deathCause,correctedTick:corrected.state.tick,correctedMinDistance:corrected.minDistance,correctedHealth:corrected.state.player.health}));
});
