import type { CDPSession, Page } from '@playwright/test';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';

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
  {kind:'press'|'release';payload:'bomb'|'torpedo';steer:number;count:number}) {
  return page.evaluate(condition=>new Promise<{tick:number;phase:string;steerPointer:number|null}>((resolve,reject)=>{
    let frame=0;
    const timeout=setTimeout(()=>{cancelAnimationFrame(frame);reject(new Error(`Timed out observing ${condition.kind} input after 5000ms`));},5000);
    const poll=()=>{
      const s=(window as any).__kaisenReadState('input'), input=s.controlsInput;
      const matches=condition.kind==='steer'
        ? Math.abs(input.turn-condition.turn)<1e-5&&Math.abs(input.climb-condition.climb)<1e-5
        : input.steerPointer===condition.steer&&input.heldPointers[condition.payload].length===(condition.kind==='press'?1:0)&&
          (condition.kind==='press'||(condition.payload==='bomb'?s.player.bombs:s.player.torpedoes)<condition.count);
      if(s.phase!=='playing'||matches) {
        clearTimeout(timeout);resolve({tick:s.tick,phase:s.phase,steerPointer:input.steerPointer});
      } else frame=requestAnimationFrame(poll);
    };
    poll();
  }),condition);
}

/** Press an ordinary payload button while the steering finger remains held. */
export async function releasePayloadAndObserve(page: Page, cdp: CDPSession, origin: {x:number;y:number}, turn:number, climb:number, kind:'bomb'|'torpedo', requireReady = false) {
  const {dx,dy}=pointerOffsetForControls(turn,climb);
  const steering={x:origin.x+dx,y:origin.y+dy,id:1};
  // Read the actual cue and button geometry together immediately before the
  // physical press. A cue sampled before steering or a screenshot can expire.
  const before=await page.evaluate(({kind,requireReady})=>{
    const s=(window as any).__kaisenReadState(requireReady ? false : 'input');
    const button=document.getElementById(kind)!;
    const box=button.getBoundingClientRect();
    const ready=button.dataset.ready==='true' && (kind!=='bomb' ||
      ((s.bombGuide?.kind==='direct'||s.bombGuide?.kind==='blast') &&
        s.bombGuide.affected.some((hit:any)=>hit.damage>0&&s.ships.some((ship:any)=>ship.id===hit.shipId&&ship.health>0))));
    return {phase:s.phase,steer:s.controlsInput.steerPointer,
      count:kind==='bomb'?s.player.bombs:s.player.torpedoes,ready,
      box:{x:box.x,y:box.y,width:box.width,height:box.height}};
  },{kind,requireReady});
  if(before.phase!=='playing')return false;
  if(before.steer===null)throw new Error('Payload route requires an already owned steering finger');
  // null means a stale cue was skipped; false still reports interrupted input.
  if(requireReady&&!before.ready)return null;
  const box=before.box;
  if(box.width<=0||box.height<=0)throw new Error(`Missing ${kind} control`);
  const payload={x:box.x+box.width/2,y:box.y+box.height/2,id:2};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[steering,payload]});
  await observeInput(page,{kind:'press',payload:kind,steer:before.steer,count:before.count});
  // Chromium's WebTouch path ends the explicitly named point. Passing the
  // remaining steering point ended the wrong finger and kept the bomb held.
  // See CreateWebTouchEvents in Chromium content/browser/devtools/protocol/input_handler.cc.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[payload]});
  // Observe release and its actual ammo decrement in the same RAF wait.
  const after=await observeInput(page,{kind:'release',payload:kind,steer:before.steer,count:before.count});
  return after.phase==='playing'&&after.steerPointer===before.steer;
}
