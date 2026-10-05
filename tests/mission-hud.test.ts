import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startGame } from '../src/simulation';
import { missionProgress, payloadReadout, torpedoReleaseCue, placeHudNotice, type HudRect } from '../src/mission-hud';
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


test('torpedo cue follows real ammunition, cooldown, capacity and envelope rejection without mutating state', async () => {
  const { MAX_ORDNANCE } = await import('../src/mission');
  const { releaseBomb } = await import('../src/ordnance');
  const state = createGame(123, 'normal'); startGame(state);
  state.player.position.set(0, 50, 0); state.player.pitch = 0; state.player.bank = 0; state.player.quaternion.identity();
  const check = (ready: boolean, short: string, text: RegExp) => {
    const before = JSON.stringify(state), cue = torpedoReleaseCue(state);
    assert.equal(cue.ready, ready); assert.equal(cue.short, short); assert.match(cue.text, text);
    assert.equal(JSON.stringify(state), before, 'presentation cannot change ammunition or flight');
  };
  check(true, '投下可能', /投下可能/);
  state.player.payloadCooldown = .5; check(false, '投下待ち', /0.5秒/);
  state.player.torpedoes = 0; state.player.torpedoReloadTicks = 360; check(false, '装填中', /6.0秒/);
  state.player.torpedoReloadTicks = 1; check(false, '装填中', /0.1秒/);
  state.player.torpedoes = 1; state.player.torpedoReloadTicks = 0; state.player.payloadCooldown = 0;
  state.ordnance = Array.from({length:MAX_ORDNANCE}, (_, i) => releaseBomb(1000+i,state.player)!);
  check(false, '投下待ち', /兵装が多い/); state.ordnance = [];
  state.player.position.y = 279; state.player.speed = 502/3.6; check(false, '高度↓', /20〜80m/);
  state.player.position.y = 8; check(false, '高度↑', /20〜80m/);
  state.player.position.y = 50; check(false, '減速', /450km\/h以下/);
  state.player.speed = 110; state.player.pitch = .3; check(false, '機首水平', /機首を水平/);
  state.player.pitch = 0; state.player.bank = .5; check(false, '翼を水平', /翼を水平/);
  state.player.bank = 0; check(true, '投下可能', /投下可能/);
  state.player.speed = NaN; check(false, '投下不可', /姿勢/);
  state.player.speed = 110; state.player.health = 0; check(false, '投下不可', /投下できません/);
});

test('torpedo cue tracks actual bomb cooldown, launch, six-second reload and pause', async () => {
  const {startGame,stepGame,pauseGame,resumeGame} = await import('../src/simulation');
  const state=createGame(123,'normal'), neutral={turn:0,climb:0,fire:false,loop:false};
  for(const p of [...state.allies,...state.enemies])p.health=0;
  for(const ship of state.ships)ship.health=0;
  state.ships[0].health=state.ships[0].maxHealth;state.ships[0].position.set(30000,0,30000);state.ships[0].previous.copy(state.ships[0].position);
  state.player.position.set(0,50,0);state.player.previous.copy(state.player.position);startGame(state);
  stepGame(state,{...neutral,bomb:true});assert.equal(torpedoReleaseCue(state).short,'投下待ち');
  stepGame(state,{...neutral,torpedo:true});assert.equal(state.events.find(e=>e.type==='payload-rejected')?.detail,'cooldown');
  for(let i=0;i<31;i++)stepGame(state,neutral);assert.equal(torpedoReleaseCue(state).ready,true);
  stepGame(state,{...neutral,torpedo:true});assert.equal(state.events.find(e=>e.type==='payload-release')?.weapon,'torpedo');
  assert.equal(state.player.torpedoes,0);assert.equal(torpedoReleaseCue(state).ready,false);assert.equal(torpedoReleaseCue(state).short,'装填中');
  pauseGame(state);const cue=torpedoReleaseCue(state);assert.equal(cue.short,'停止中');assert.equal(cue.ready,false);stepGame(state,neutral,.25);assert.deepEqual(torpedoReleaseCue(state),cue);resumeGame(state);
  for(let i=0;i<360;i++)stepGame(state,neutral);assert.equal(state.player.torpedoes,1);assert.equal(torpedoReleaseCue(state).ready,true);
});

const overlaps=(a:HudRect,b:HudRect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
test('notice placement avoids the reported short portrait sight and all measured obstacles', () => {
  const bounds={x:8,y:8,width:377,height:632};
  const obstacles=[{x:12,y:16,width:369,height:62},{x:18,y:96,width:118,height:115},
    {x:151.095,y:189.918,width:90.81,height:90.81},{x:277,y:131,width:98,height:116},
    {x:34,y:410,width:64,height:128},{x:278,y:492,width:96,height:96},
    {x:203,y:584,width:52,height:52}];
  const original={x:155,y:245,width:220,height:28.15};assert.ok(obstacles.some(o=>overlaps(original,o)), 'fixture catches the original screenshot defect');
  const placed=placeHudNotice(bounds,{x:155,y:245,width:160,height:83} as HudRect,obstacles,{x:225,y:253});
  assert.ok(placed);assert.ok(!obstacles.some(o=>overlaps(placed,o)));
  assert.ok(placed.x>=8&&placed.x+placed.width<=385&&placed.y>=8&&placed.y+placed.height<=640);
  assert.deepEqual(placeHudNotice(bounds,{width:160,height:83},obstacles,{x:225,y:253}),placed,'measurement origin cannot overwrite the chosen position');
});
test('notice placement handles enlarged text, short landscape, and explicitly reports no available slot', () => {
  for(const [width,height]of [[393,648],[568,320],[852,393]])for(const scale of [1,2]){
    const bounds={x:8,y:8,width:width-16,height:height-16};
    const obstacles=[{x:width/2-48,y:height*.36-48,width:96,height:96},{x:width-116,y:Math.min(height*.33,180)-49,width:98,height:116}];
    const placed=placeHudNotice(bounds,{width:160,height:42*scale},obstacles,{x:width-178,y:Math.min(height*.33,180)+73});
    assert.ok(placed,`${width}x${height} text ${scale}`);assert.ok(!obstacles.some(o=>overlaps(placed,o)));
  }
  assert.equal(placeHudNotice({x:0,y:0,width:100,height:100},{width:40,height:40},[{x:0,y:0,width:100,height:100}],{x:0,y:0}),null);
});


test('CI45 Easy compact report fits both previously unavailable 200-percent viewports', () => {
  const fixtures=[{"viewport": {"width": 568, "height": 320}, "obstacles": [{"id": "hud-top", "x": 12, "y": 12, "width": 544, "height": 64}, {"id": "flight-data", "x": 18, "y": 77, "width": 118, "height": 113}, {"id": "bomb", "x": 195.921875, "y": 260.796875, "width": 51.1875, "height": 51.1875}, {"id": "torpedo", "x": 309.515625, "y": 260.796875, "width": 51.1875, "height": 51.1875}, {"id": "flight-tip", "x": 90, "y": 270.3125, "width": 77, "height": 18.6875}, {"id": "loop", "x": 445.84375, "y": 185.59375, "width": 51.1875, "height": 51.1875}, {"id": "announcement", "x": 198.359375, "y": 171, "width": 171.28125, "height": 17}, {"id": "sight-and-reload-ring", "x": 228.8, "y": 104.8, "width": 110.4, "height": 110.4}, {"id": "radar-and-label", "x": 452, "y": 56.60000000000001, "width": 98, "height": 116}], "size": {"width": 160, "height": 62.8}}, {"viewport": {"width": 320, "height": 568}, "obstacles": [{"id": "hud-top", "x": 12, "y": 16, "width": 296, "height": 97}, {"id": "flight-data", "x": 18, "y": 136, "width": 118, "height": 113}, {"id": "bomb", "x": 98.796875, "y": 507.90625, "width": 52, "height": 52}, {"id": "torpedo", "x": 162.796875, "y": 507.90625, "width": 52, "height": 52}, {"id": "flight-tip", "x": 20, "y": 458.3125, "width": 77, "height": 18.6875}, {"id": "loop", "x": 229.59375, "y": 338.875, "width": 72, "height": 72}, {"id": "announcement", "x": 74.359375, "y": 419, "width": 171.28125, "height": 17}, {"id": "sight-and-reload-ring", "x": 104.8, "y": 228.8, "width": 110.4, "height": 110.4}, {"id": "radar-and-label", "x": 218, "y": 138, "width": 84, "height": 102}], "size": {"width": 160, "height": 62.8}}];
  for(const f of fixtures){
    const bounds={x:8,y:8,width:f.viewport.width-16,height:f.viewport.height-16};
    assert.equal(placeHudNotice(bounds,{width:200,height:69.375},f.obstacles,{x:bounds.width-200,y:240}),null,'old expanded summary does not fit the captured scene');
    const placed=placeHudNotice(bounds,f.size,f.obstacles,{x:bounds.width-f.size.width,y:240});
    assert.ok(placed,JSON.stringify(f.viewport));
    assert.ok(!f.obstacles.some(o=>overlaps(placed,o)));
    assert.ok(placed.x+placed.width<=f.viewport.width-8&&placed.y+placed.height<=f.viewport.height-8);
  }
});
