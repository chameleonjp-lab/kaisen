import type { CDPSession, Page } from '@playwright/test';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';

/** CDP acknowledges enqueueing a move before the pointer handler necessarily runs.
 * Read its accepted value before another feedback decision; no game state is written.
 */
export async function steerAndObserve(page: Page, cdp: CDPSession, origin: {x:number;y:number}, turn:number, climb:number) {
  const {dx,dy} = pointerOffsetForControls(turn,climb);
  await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:origin.x+dx,y:origin.y+dy,id:1}]});
  await page.waitForFunction(({turn,climb})=> {
    const s=(window as any).__kaisenReadState(false);
    return s.phase !== 'playing' || (Math.abs(s.controlsInput.turn-turn)<1e-5 && Math.abs(s.controlsInput.climb-climb)<1e-5);
  }, {turn,climb}, {polling:'raf',timeout:5000});
  return page.evaluate(()=> {
    const s=(window as any).__kaisenReadState(false);
    return {tick:s.tick as number,phase:s.phase as string};
  });
}

/** Press an ordinary payload button while the steering finger remains held. */
export async function releasePayloadAndObserve(page: Page, cdp: CDPSession, origin: {x:number;y:number}, turn:number, climb:number, kind:'bomb'|'torpedo') {
  const {dx,dy}=pointerOffsetForControls(turn,climb);
  const steering={x:origin.x+dx,y:origin.y+dy,id:1};
  const before=await page.evaluate(kind=>{const s=(window as any).__kaisenReadState(false);return {phase:s.phase,steer:s.controlsInput.steerPointer,count:kind==='bomb'?s.player.bombs:s.player.torpedoes};},kind);
  if(before.phase!=='playing')return false;
  if(before.steer===null)throw new Error('Payload route requires an already owned steering finger');
  const box=await page.locator(`#${kind}`).boundingBox();
  if(!box)throw new Error(`Missing ${kind} control`);
  const payload={x:box.x+box.width/2,y:box.y+box.height/2,id:2};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[steering,payload]});
  await page.waitForFunction(({kind,steer})=>{const s=(window as any).__kaisenReadState(false);return s.controlsInput.steerPointer===steer&&s.controlsInput.heldPointers[kind].length===1;},{kind,steer:before.steer},{polling:'raf',timeout:5000});
  // Chromium's WebTouch path ends the explicitly named point. Passing the
  // remaining steering point ended the wrong finger and kept the bomb held.
  // See CreateWebTouchEvents in Chromium content/browser/devtools/protocol/input_handler.cc.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[payload]});
  await page.waitForFunction(({kind,steer})=>{const s=(window as any).__kaisenReadState(false);return s.phase!=='playing'||(s.controlsInput.steerPointer===steer&&s.controlsInput.heldPointers[kind].length===0);},{kind,steer:before.steer},{polling:'raf',timeout:5000});
  await page.waitForFunction(({kind,count})=>{const s=(window as any).__kaisenReadState(false);return s.phase!=='playing'||(kind==='bomb'?s.player.bombs:s.player.torpedoes)<count;},{kind,count:before.count},{polling:'raf',timeout:5000});
  return page.evaluate(()=>{const s=(window as any).__kaisenReadState(false);return s.phase==='playing'&&s.controlsInput.steerPointer!==null;});
}
