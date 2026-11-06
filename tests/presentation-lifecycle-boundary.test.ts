import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { FlightPresentation } from '../src/flight-presentation';
import { KaisenScene } from '../src/scene';
import { createGame, pauseGame, resumeGame, startGame, stepGame } from '../src/simulation';

const main=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
const lifecycle=main.slice(main.indexOf('function pause(reason:'),main.indexOf('function finish()'));
const script=ts.transpileModule(lifecycle,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
for(const mode of ['easy','normal'] as const) test(`${mode}: real pause/resume cannot bypass the paused presentation barrier between RAFs`,()=>{
  const state=createGame(73,mode),presentation=new FlightPresentation();startGame(state);
  presentation.capture(state);stepGame(state,{turn:0,climb:.45,fire:false,loop:false,steeringActive:true});
  assert.notEqual(presentation.sample(state,0),state,'there is an older interpolation sample before pausing');
  const frozen=JSON.stringify(state),queue={status:'ready',failure:null,submittedCount:1,completedCount:1};
  const scene:any=Object.create(KaisenScene.prototype);
  Object.assign(scene,{current:state,disposed:false,prepared:true,missionId:1,layoutRevision:1,width:402,height:874,
    canvas:{width:402,height:874},overlay:{width:402,height:874},pausedView:null,presentation,
    pollRender:()=>queue.status,renderQueue:{diagnostics:()=>queue}});
  const elements=new Map<string,any>();
  const context:any={state,scene,screen:'playing',contextLost:false,renderStatus:'ready',pendingLoop:false,pendingBomb:false,pendingTorpedo:false,
    pauseReasons:new Set(),lastAllyNotice:'',accumulator:.005,settings:{isOpen:false},rules:undefined,document:{hidden:false},performance:{now:()=>1},
    pauseGame,resumeGame,updateBombCue(){},updateTorpedoCue(){},syncAudio(){},frameClock:{reset(){}},audio:{unlock:()=>Promise.resolve()},
    el:(id:string)=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}};
  context.setScreen=(screen:string)=>{context.screen=screen;};vm.createContext(context);vm.runInContext(script,context);
  context.pause('manual');context.resume();
  assert.equal(state.phase,'paused','same-RAF Resume must wait until a paused view has actually been displayed');
  assert.equal(context.screen,'paused');assert.equal(context.el('resume').disabled,true);
  assert.equal((presentation as any).state,state,'no paused sample has secretly run during the events');
  queue.status='pending';assert.equal(scene.render(state,true,0,0),false);context.resume();
  assert.equal(state.phase,'paused','pending GPU work cannot certify the frozen view');
  queue.status='ready';
  // Exercise the actual renderer through its presentation boundary. Stop before
  // Three.js drawing; the later completed stamp is a numerical GPU-completion fixture.
  const sampledPaused=Symbol('sampled paused pose');
  const sample=presentation.sample.bind(presentation);
  (presentation as any).sample=(s:any,alpha:number)=>{const result=sample(s,alpha);assert.equal(result,state);throw sampledPaused;};
  assert.throws(()=>scene.render(state,true,0,0),error=>error===sampledPaused);
  (presentation as any).sample=sample;
  assert.equal((presentation as any).state,null,'a paused submission clears the old interpolation sample');
  scene.pausedView={...scene.pausedViewKey(state,true),submittedCount:2};queue.submittedCount=2;
  context.resume();assert.equal(state.phase,'paused','a submitted frame is not yet a completed frozen view');
  queue.completedCount=2;context.resume();assert.equal(state.phase,'playing');
  assert.equal(presentation.sample(state,0),state,'zero-tick frame after resume uses the current pose');
  assert.equal(JSON.stringify(state),frozen,'the lifecycle changes no authoritative flight, weapons, score, or clock');
});
