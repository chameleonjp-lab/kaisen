import './style.css';
import { createGame, startGame, pauseGame, resumeGame, stepGame } from './simulation';
import { FIXED_DT, LOW_ALTITUDE_WARNING } from './mission';
import { FlightControls } from './input';
import { KaisenScene } from './scene';
import { FlightAudio } from './audio';
import type { GameEvent, GameState } from './types';

function el<T extends HTMLElement=HTMLElement>(id:string):T{const node=document.getElementById(id);if(!node)throw new Error(`Missing UI: ${id}`);return node as T;}
const app=el('app'),canvas=el<HTMLCanvasElement>('flight'),overlay=el<HTMLCanvasElement>('markers');
let state=createGame();let screen:'home'|'playing'|'paused'|'result'='home';
let scene:KaisenScene|null=null;let contextLost=false;
const audio=new FlightAudio();audio.enabled=false;
const controls=new FlightControls(canvas,{fire:el('fire'),loop:el('loop'),accelerate:el('accelerate'),brake:el('brake')},()=>screen==='playing'&&state.phase==='playing');controls.setMode('easy');
const pauseReasons=new Set<string>();
let accumulator=0,lastFrame=0,frameId=0,disposed=false,generation=0,announcementUntil=0;
let pendingLoop=false;let frameIntervals:number[]=[];let updateTimes:number[]=[];
function formatTime(seconds:number){const cs=Math.floor(Math.max(0,seconds)*100+1e-6);return `${String(Math.floor(cs/6000)).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;}
function setScreen(next:typeof screen){screen=next;app.dataset.screen=next;el('home').hidden=next!=='home';el('hud').hidden=next!=='playing'&&next!=='paused';el('pause-screen').hidden=next!=='paused';el('result').hidden=next!=='result';controls.clear();const focus=next==='home'?'start':next==='paused'?'resume':next==='result'?'retry':null;if(focus)el<HTMLButtonElement>(focus).focus({preventScroll:true});}
function announce(text:string,duration=3){el('announcement').textContent=text;announcementUntil=state.elapsed+duration;}
function syncAudio(){audio.active=state.phase==='playing'&&screen==='playing'&&!document.hidden;audio.sync();el('home-sound').textContent=audio.enabled?'音をオフにする':'音をオンにする';el('game-sound').textContent=audio.enabled?'音 ON':'音 OFF';el('game-sound').setAttribute('aria-label',audio.enabled?'音をオフにする':'音をオンにする');for(const id of ['home-sound','game-sound'])el(id).setAttribute('aria-pressed',String(audio.enabled));}
async function toggleAudio(){audio.enabled=!audio.enabled;syncAudio();if(audio.enabled){await audio.unlock();syncAudio();if(audio.failed)announce('音を再生できません。飛行は続けられます');}}
for(const id of ['home-sound','game-sound'])el(id).addEventListener('click',()=>void toggleAudio());
function begin(){if(!scene||contextLost||document.hidden||screen==='playing')return;generation++;pendingLoop=false;audio.resetFlight();controls.clear();pauseReasons.clear();state=createGame();startGame(state);accumulator=0;lastFrame=performance.now();frameIntervals=[];updateTimes=[];setScreen('playing');syncAudio();void audio.unlock().then(()=>syncAudio());announce('敵機5機と艦隊3隻をすべて撃破',4);scene.render(state,true);updateHUD();}
function home(){pendingLoop=false;generation++;audio.resetFlight();state=createGame();pauseReasons.clear();accumulator=0;setScreen('home');el('announcement').textContent='';syncAudio();scene?.render(state,false);}
function pause(reason:string){if(state.phase!=='playing'&&state.phase!=='paused')return;pendingLoop=false;pauseReasons.add(reason);pauseGame(state);accumulator=0;setScreen('paused');el('pause-reason').textContent=contextLost?'描画が中断されました。復帰を待っています':reason==='frame'?'画面の更新が中断されたため停止しました':'タイムの計測も止まっています';el<HTMLButtonElement>('resume').disabled=contextLost;syncAudio();}
function resume(){if(document.hidden||contextLost||state.phase!=='paused')return;pauseReasons.clear();resumeGame(state);accumulator=0;lastFrame=performance.now();setScreen('playing');syncAudio();void audio.unlock().then(()=>syncAudio());}
function finish(){if(!state.result)return;controls.clear();audio.finishFlight();setScreen('result');el('announcement').textContent='';const r=state.result;el('result-title').textContent=r.outcome==='victory'?'作戦成功':'作戦終了';el('result-kicker').textContent=r.outcome==='victory'?'ALL TARGETS DESTROYED':'MISSION REPORT';el('result-reason').textContent=r.outcome==='victory'?'敵航空隊と敵艦隊を全滅させました':state.endReason==='sea'?'海面に接触しました':state.endReason==='collision'?'敵と衝突しました':'自機が撃墜されました';el('result-time-label').textContent=r.outcome==='victory'?'クリアタイム':'経過時間';el('result-time').textContent=formatTime(r.time);el('player-kills').textContent=`${r.playerAircraftKills}機 · ${r.playerShipKills}隻`;el('ally-kills').textContent=`${r.allyAircraftKills}機 · ${r.allyShipKills}隻`;el('survivors').textContent=`${r.alliesSurvived}機`;}
function updateHUD(){el('timer').textContent=formatTime(state.elapsed);el('enemy-count').textContent=String(state.enemies.filter(p=>p.health>0).length);el('ship-count').textContent=String(state.ships.filter(s=>s.health>0).length);el('allies-count').textContent=String(state.allies.filter(p=>p.health>0).length);el('health').textContent=String(Math.ceil(state.player.health));el('health-bar').style.width=`${Math.max(0,state.player.health)}%`;el('altitude').textContent=`${Math.round(state.player.position.y)}m`;el('speed').textContent=`${Math.round(state.player.speed*3.6)}km/h`;el('warning').hidden=state.player.position.y>=LOW_ALTITUDE_WARNING||state.phase!=='playing';el('loop-status').textContent=state.player.loopProgress>0?'旋回中':state.player.loopCooldown>0?`${state.player.loopCooldown.toFixed(1)}秒`:'すぐ使える';el('flight-tip').hidden=state.elapsed>8;if(state.elapsed>announcementUntil)el('announcement').textContent='';}
function frame(now:number){if(disposed)return;frameId=requestAnimationFrame(frame);const dt=lastFrame?(now-lastFrame)/1000:0;lastFrame=now;
  if(state.phase==='playing'&&screen==='playing'){
    if(dt>.25){pause('frame');return;}if(dt>0){frameIntervals.push(dt*1000);if(frameIntervals.length>3600)frameIntervals.shift();}
    accumulator+=dt;const input=controls.sample();pendingLoop ||= input.loop;input.viewAspect=scene?.camera.aspect??1;const events:GameEvent[]=[];let first=true;const begin=performance.now();
    while(accumulator+1e-9>=FIXED_DT&&state.phase==='playing'){stepGame(state,{...input,loop:first&&pendingLoop},FIXED_DT);events.push(...state.events);accumulator-=FIXED_DT;first=false;pendingLoop=false;}
    updateTimes.push(performance.now()-begin);if(updateTimes.length>3600)updateTimes.shift();
    scene?.events(events,state.elapsed);
    for(const e of events){const relates=e.owner===state.player.id||e.target===state.player.id;if(e.type==='kill')audio.event(e,e.target!==state.player.id);else if(relates)audio.event(e,true);if(e.type==='kill'&&e.target!==state.player.id&&e.team==='friendly')announce(e.targetKind==='ship'?'敵艦撃沈':'敵機撃墜',1.5);}
    audio.update(state.player.speed);updateHUD();if(state.result!==null)finish();
  }
  if(scene&&!contextLost)scene.render(state,screen==='playing'||screen==='paused',dt);
}
for(const id of ['start','retry','pause-restart'])el(id).addEventListener('click',begin);
for(const id of ['result-home','pause-home'])el(id).addEventListener('click',home);
el('pause').addEventListener('click',()=>pause('manual'));el('resume').addEventListener('click',resume);
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause('hidden');});window.addEventListener('blur',()=>pause('blur'));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(screen==='playing')pause('manual');else if(screen==='paused')resume();}if(e.key==='Tab'&&screen==='paused'){const items=[el('resume'),el('pause-restart'),el('pause-home')].filter(x=>!(x as HTMLButtonElement).disabled);const index=items.indexOf(document.activeElement as HTMLElement);if(e.shiftKey&&index<=0){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&index===items.length-1){e.preventDefault();items[0]?.focus();}}});
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();contextLost=true;pause('context');});canvas.addEventListener('webglcontextrestored',()=>{contextLost=false;el<HTMLButtonElement>('resume').disabled=false;el('pause-reason').textContent='描画が復帰しました。操作して再開できます';});
window.addEventListener('resize',()=>scene?.resize());window.visualViewport?.addEventListener('resize',()=>scene?.resize());window.addEventListener('pageshow',event=>{if(event.persisted)pause('restored');});
try{scene=new KaisenScene(canvas,overlay);scene.render(state,false);frameId=requestAnimationFrame(frame);}catch(error){el<HTMLButtonElement>('start').disabled=true;const message=el('startup-error');message.hidden=false;message.textContent='3D画面を開始できませんでした。対応するブラウザで開き直してください';console.error('Kaisen renderer initialization failed',error);}

// Development-only, deeply copied observation. No mutation or result injection API.
if(import.meta.env.DEV){Object.defineProperty(window,'__kaisenReadState',{value:()=>JSON.parse(JSON.stringify({phase:state.phase,screen,tick:state.tick,elapsed:state.elapsed,player:state.player,allies:state.allies,enemies:state.enemies,ships:state.ships,bullets:state.bullets.length,result:state.result,stats:state.stats,render:scene?.diagnostics(),frameIntervals,updateTimes})),configurable:true});}
window.addEventListener('pagehide',event=>{if(event.persisted){pause('hidden');return;}if(disposed)return;disposed=true;cancelAnimationFrame(frameId);controls.dispose();audio.dispose();scene?.dispose();});
