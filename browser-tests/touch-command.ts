import type { CDPSession, Page } from '@playwright/test';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';
import { shouldAttemptBomb } from '../tests/helpers/mission-browser-pilot';

/** CDP acknowledges enqueueing a move before the pointer handler necessarily runs.
 * Read its accepted value before another feedback decision; no game state is written.
 */
export async function steerAndObserve(page: Page, cdp: CDPSession, origin: {x:number;y:number}, turn:number, climb:number) {
  const {dx,dy} = pointerOffsetForControls(turn,climb);
  await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:origin.x+dx,y:origin.y+dy,id:1}]});
  return observeInput(page,{kind:'steer',turn,climb});
}

/** Poll and return the matching observation in one read-only browser call.
 * The real game RAF remains the only source of simulation time.
 */
function observeInput(page: Page, condition: {kind:'steer';turn:number;climb:number} |
  {kind:'release';payload:'bomb'|'torpedo';steer:number;count:number}) {
  return page.evaluate(condition=>new Promise<{tick:number;phase:string;steerPointer:number|null;turn:number;climb:number;held:number;count:number}>((resolve,reject)=>{
    let frame=0;
    const timeout=setTimeout(()=>{cancelAnimationFrame(frame);reject(new Error(`Timed out observing ${condition.kind} input after 5000ms`));},5000);
    const poll=()=>{
      const s=(window as any).__kaisenReadState('input'), input=s.controlsInput;
      const count=condition.kind==='release'
        ? (condition.payload==='bomb'?s.player.bombs:s.player.torpedoes)
        : 0;
      const held=condition.kind==='release'?input.heldPointers[condition.payload].length:0;
      const matches=condition.kind==='steer'
        ? Math.abs(input.turn-condition.turn)<1e-5&&Math.abs(input.climb-condition.climb)<1e-5
        : input.steerPointer===condition.steer&&held===0&&count<condition.count;
      if(s.phase!=='playing'||matches) {
        clearTimeout(timeout);resolve({tick:s.tick,phase:s.phase,steerPointer:input.steerPointer,turn:input.turn,climb:input.climb,held,count});
      } else frame=requestAnimationFrame(poll);
    };
    poll();
  }),condition);
}

/** Release a payload while preserving the already accepted steering finger.
 * The fresh cue read owns the actual steering pose; the caller cannot sneak a
 * newly requested turn into the same touchStart as the payload.
 */
export async function releasePayloadAndObserve(page: Page, cdp: CDPSession, origin: {x:number;y:number}, kind:'bomb'|'torpedo', requireReady = false) {
  // Read the actual cue and button geometry together immediately before the
  // physical press. The pilot's next steering request is intentionally sent
  // only after this pulse has been observed.
  const before=await page.evaluate(({kind,requireReady})=>{
    const s=(window as any).__kaisenReadState(requireReady ? false : 'input');
    const button=document.getElementById(kind)!;
    const box=button.getBoundingClientRect();
    const buttonReady=button.dataset.ready==='true';
    return {tick:s.tick,phase:s.phase,mode:s.mode,steer:s.controlsInput.steerPointer,turn:s.controlsInput.turn,climb:s.controlsInput.climb,
      held:s.controlsInput.heldPointers[kind].length,text:kind==='bomb'?document.getElementById('bomb-hint')!.textContent:document.getElementById('torpedo-hint')!.textContent,
      count:kind==='bomb'?s.player.bombs:s.player.torpedoes,buttonReady,
      bombGuide:kind==='bomb'&&requireReady?s.bombGuide:null,controlsTurn:s.controlsInput.turn,controlsClimb:s.controlsInput.climb,
      ships:kind==='bomb'&&requireReady?s.ships.map((ship:any)=>({id:ship.id,health:ship.health})):[],
      box:{x:box.x,y:box.y,width:box.width,height:box.height}};
  },{kind,requireReady});
  if(before.phase!=='playing')return false;
  if(before.steer===null)throw new Error('Payload route requires an already owned steering finger');
  if(before.held!==0)throw new Error(`${kind} was already held before its payload pulse`);
  // null means a stale or low-value cue was skipped; false still reports interrupted input.
  const usefulBomb=requireReady&&kind==='bomb'&&shouldAttemptBomb({mode:before.mode,
    bombButton:{ready:before.buttonReady?'true':'false'},
    bombGuide:before.bombGuide,ships:before.ships,controlsInput:{turn:before.controlsTurn,climb:before.controlsClimb}});
  if(requireReady&&!(kind==='bomb'?usefulBomb:before.buttonReady))return null;
  const {dx,dy}=pointerOffsetForControls(before.turn,before.climb);
  // CDP touch IDs and DOM PointerEvent.pointerId values are different namespaces.
  // Victory routes keep their one steering touch at CDP id 1; before.steer is
  // used only to prove that the DOM still assigns ownership to that same finger.
  const steering={x:origin.x+dx,y:origin.y+dy,id:1};
  const box=before.box;
  if(box.width<=0||box.height<=0)throw new Error(`Missing ${kind} control`);
  const payload={x:box.x+box.width/2,y:box.y+box.height/2,id:2};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[steering,payload]});
  // Chromium's WebTouch path ends the explicitly named point. Passing the
  // remaining steering point ends the wrong finger. Keep start/end adjacent:
  // polling RAF between them makes the cue age and delays clickBursts.add.
  // See CreateWebTouchEvents in Chromium content/browser/devtools/protocol/input_handler.cc.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[payload]});
  // One observation proves that the same steering pointer still owns controls,
  // the payload is no longer held, and the game consumed one round.
  const after=await observeInput(page,{kind:'release',payload:kind,steer:before.steer,count:before.count});
  return after.phase==='playing'&&after.steerPointer===before.steer&&after.held===0&&after.count<before.count;
}
