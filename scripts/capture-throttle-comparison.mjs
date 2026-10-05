import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const clockEpoch = '2026-10-05T00:00:00Z';
const targetTick = 12;
const clockStepMs = 16;
const maxClockSteps = 120;
const browserArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

async function freezeAtCurrentTime(page) {
 const attemptedTimestamps = [await page.evaluate(() => Date.now())];
 let retryCount = 0;
 try {
  await page.clock.pauseAt(attemptedTimestamps[0]);
 } catch (error) {
  // Pinned Playwright pauses real-time sync before rejecting a past timestamp.
  // Only that read-to-pause race may retry, once, using the now-frozen clock.
  const pastTimestampRace = error instanceof Error &&
   /^(?:(?:page\.)?clock\.pauseAt:\s*)?(?:Error:\s*)?Cannot fast-forward to the past(?:\r?\n|$)/.test(error.message);
  if (!pastTimestampRace) throw error;
  retryCount = 1;
  attemptedTimestamps.push(await page.evaluate(() => Date.now()));
  await page.clock.pauseAt(attemptedTimestamps[1]);
 }
 const frozenAt = await page.evaluate(() => Date.now());
 assert.equal(frozenAt, attemptedTimestamps.at(-1), 'Clock must remain frozen at the requested current timestamp');
 return { method: 'pauseAt current Date.now; one retry only for the past-timestamp race', attemptedTimestamps, frozenAt, retryCount };
}

async function logFailureDiagnostics(page, label, error) {
 let diagnostics;
 try {
  diagnostics = await page.evaluate(() => {
   if (typeof window.__kaisenReadState !== 'function') return { readStateAvailable: false };
   const state = window.__kaisenReadState(false);
   return {
    mode: state.mode, phase: state.phase, tick: state.tick, screen: state.screen,
    graphicsReady: state.graphicsReady, renderStatus: state.renderStatus,
    pauseReasons: state.pauseReasons, lastInterruption: state.lastInterruption,
    queue: state.render?.queue,
   };
  });
 } catch (diagnosticError) {
  diagnostics = { unavailable: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) };
 }
 console.error(JSON.stringify({ label, error: error instanceof Error ? error.message : String(error), diagnostics }, null, 2));
}

async function readState(page) {
 return page.evaluate(() => {
  const state = window.__kaisenReadState(false);
  return { mode: state.mode, phase: state.phase, tick: state.tick, player: state.player, gunSight: state.gunSight };
 });
}
function logicalTick(state) { return state.tick; }

async function captureAtTargetTick(page, label) {
 let state = await readState(page);
 let tick = logicalTick(state);
 let clockSteps = 0;
 const clockStart = await page.evaluate(() => Date.now());
 const observations = [];
 for (;;) {
  const context = `${label}: tick=${tick}, phase=${state.phase}, clockSteps=${clockSteps}`;
  assert.ok(Number.isSafeInteger(tick) && tick >= 0, `Invalid logical tick; ${context}`);
  assert.equal(state.mode, 'normal', `Normal mode is required; ${context}`);
  assert.ok(state.phase === 'playing', `Flight failed to start or stopped; ${context}`);
  observations.push({ clockSteps, tick, phase: state.phase });
  assert.ok(tick <= targetTick, `Target tick was skipped; ${context}`);
  if (tick === targetTick) break;
  assert.ok(clockSteps < maxClockSteps, `Target tick was not reached within the bounded clock steps; ${context}`);
  // Less than one 60 Hz tick per clock step: keep every logic tick observable.
  await page.clock.runFor(clockStepMs);
  clockSteps += 1;
  const previousTick = tick;
  state = await readState(page);
  tick = logicalTick(state);
  assert.ok(tick >= previousTick && tick <= previousTick + 1,
   `${label}: logical tick must advance by at most one per ${clockStepMs}ms step (${previousTick} -> ${tick})`);
 }
 assert.equal(tick, targetTick, `${label} must be captured at the exact target tick`);
 assert.equal(state.phase, 'playing', `${label} must be an advancing Normal flight`);
 const clockEnd = await page.evaluate(() => Date.now());
 assert.equal(clockEnd - clockStart, clockSteps * clockStepMs, `${label}: clock advanced outside the controlled steps`);
 return { state, clock: {
  epoch: clockEpoch, targetTick, actualTick: tick, clockStepMs, maxClockSteps, clockSteps,
  advancedMs: clockSteps * clockStepMs, clockStart, clockEnd, observations,
  observation: "window.__kaisenReadState(false).tick",
  procedure: 'Pause the installed clock before the UI Start click; leave flight controls neutral; run 16ms steps and read existing state after each step until exact tick 12; keep the clock paused for capture',
 } };
}

const base=process.argv[2];if(!base)throw Error('Usage: node scripts/capture-throttle-comparison.mjs <baseline checkout>');
const output=resolve('comparison-results/throttle-comparison');await mkdir(output,{recursive:true});
const browser=await chromium.launch({args:browserArgs});
const facts=[];
try {
 for(const [label,cwd,port]of [['before',resolve(base),4181],['after',process.cwd(),4182]]){
  const server=spawn('npm',['run','dev','--','--host','127.0.0.1','--port',String(port)],{cwd,stdio:'pipe',detached:true});
  try{
   let ready=false;for(let n=0;n<100;n++){try{const response=await fetch(`http://127.0.0.1:${port}`);if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error(`${label} server unavailable`);
   for(const [width,height]of [[393,852],[852,393]]){
    const page=await browser.newPage({viewport:{width,height},hasTouch:true,deviceScaleFactor:1});
    try {
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.fulfill({status:200,contentType:'application/json',body:'[]'}));
    await page.clock.install({time:new Date(clockEpoch)});
    await page.goto(`http://127.0.0.1:${port}`);await page.locator('#start').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#start').disabled);
    await page.locator('input[value="normal"]').check();
    const freeze = await freezeAtCurrentTime(page);
    await page.locator('#start').click();
    const { state, clock } = await captureAtTargetTick(page, `${label} ${width}x${height}`);
    await page.screenshot({path:`${output}/${label}-${width}x${height}.png`});
    assert.deepEqual(await readState(page), state, `${label}: state changed during the paused screenshot capture`);
    facts.push({label,width,height,mode:'normal',input:'UI Start then neutral until exact logical tick 12',
     readout:await page.locator('#speed').innerText(),state,clock:{...clock,pauseAt:freeze.frozenAt,freeze},browser:browser.version(),
     environment:{engine:'chromium',headless:true,args:browserArgs,node:process.version,platform:process.platform,arch:process.arch,
      hasTouch:true,deviceScaleFactor:1,userAgent:await page.evaluate(()=>navigator.userAgent)}});
    } catch (error) {
     await logFailureDiagnostics(page, `${label} ${width}x${height}`, error);
     throw error;
    }
    await page.close();
   }
  }finally{try{process.kill(-server.pid,'SIGTERM');}catch{server.kill();}}
 }
}finally{await browser.close();}
await writeFile(`${output}/conditions.json`,JSON.stringify(facts,null,2));

for(const before of facts.filter(item=>item.label==='before')) {
 const after=facts.find(item=>item.label==='after'&&item.width===before.width&&item.height===before.height);
 assert.ok(after,'Matching candidate evidence is required');
 assert.deepEqual(after.state,before.state,'Before/after controlled flight state differs');
}
