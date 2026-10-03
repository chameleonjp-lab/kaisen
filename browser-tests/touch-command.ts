import type { CDPSession, Page } from '@playwright/test';
import { pointerOffsetForControls } from '../tests/helpers/touch-reload-pilot';

/** CDP acknowledges enqueueing a move before the pointer handler necessarily runs.
 * Read its accepted value before another feedback decision; no game state is written.
 */
export async function steerAndObserve(page: Page, cdp: CDPSession, origin: {x:number;y:number}, turn:number, climb:number) {
  const {dx,dy} = pointerOffsetForControls(turn,climb);
  await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:origin.x+dx,y:origin.y+dy,id:1}]});
  await page.waitForFunction(({turn,climb})=> {
    const s=(window as any).__kaisenReadState();
    return s.phase !== 'playing' || (Math.abs(s.controlsInput.turn-turn)<1e-5 && Math.abs(s.controlsInput.climb-climb)<1e-5);
  }, {turn,climb}, {polling:'raf',timeout:5000});
  return page.evaluate(()=> {
    const s=(window as any).__kaisenReadState();
    return {tick:s.tick as number,phase:s.phase as string};
  });
}
