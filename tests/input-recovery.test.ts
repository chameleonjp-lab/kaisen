import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';

class ElementStub extends EventTarget {
  style = {left:'',top:'',setProperty(){},removeProperty(){}};
  classList = {add(){},remove(){}};
  attributes = new Map<string,string>();
  getAttribute(k:string){return this.attributes.get(k)??null;}
  setAttribute(k:string,v:string){this.attributes.set(k,v);}
  getBoundingClientRect(){return {left:0,top:0};}
  closest(){return this;}
  querySelector(){return this;}
  setPointerCapture(){throw new Error('Simulated capture unavailable');}
  hasPointerCapture(){return false;}
}
function pointer(type:string,id:number,x=100,y=200,primary=false) {
  const e=new Event(type,{cancelable:true});
  Object.assign(e,{pointerId:id,clientX:x,clientY:y,pointerType:'touch',button:0,buttons:1,isPrimary:primary});
  return e;
}
test('capture failure plus release on window cannot strand steering; other held fingers survive cancellation',()=>{
  const originals=['window','document','HTMLElement'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
  const win=Object.assign(new EventTarget(),{visualViewport:new EventTarget()});
  const doc=Object.assign(new EventTarget(),{hidden:false,getElementById:()=>new ElementStub()});
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  Object.defineProperty(globalThis,'HTMLElement',{configurable:true,value:ElementStub});
  const surface=new ElementStub(),buttons={fire:new ElementStub(),loop:new ElementStub(),accelerate:new ElementStub(),brake:new ElementStub()};
  const controls=new FlightControls(surface as any,buttons as any,()=>true);
  try {
    surface.dispatchEvent(pointer('pointerdown',1));
    win.dispatchEvent(pointer('pointermove',1,130,200));
    assert.ok(controls.sample().turn>.7);
    buttons.fire.dispatchEvent(pointer('pointerdown',2));buttons.accelerate.dispatchEvent(pointer('pointerdown',3));
    win.dispatchEvent(pointer('pointercancel',2));
    assert.equal(controls.sample().fire,false);assert.equal(controls.sample().accelerate,true);
    assert.equal(controls.peek().steerPointer,1);
    win.dispatchEvent(pointer('pointerup',1));
    assert.equal(controls.peek().steerPointer,null);assert.equal(controls.sample().turn,0);
    // New steering works without a retry/home reset.
    surface.dispatchEvent(pointer('pointerdown',4));win.dispatchEvent(pointer('pointermove',4,70,200));
    assert.ok(controls.sample().turn<-.7);
    for(const event of ['resize','blur','pagehide']) {
      win.dispatchEvent(new Event(event));assert.equal(controls.peek().steerPointer,null);
      assert.equal(controls.sample().accelerate,false);surface.dispatchEvent(pointer('pointerdown',5));
    }
    // A missing terminal notification is recoverable when the browser identifies a new primary finger.
    surface.dispatchEvent(pointer('pointerdown',8,100,200,true));assert.equal(controls.peek().steerPointer,8);
    doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(controls.peek().steerPointer,null);
  } finally {
    controls.dispose();for(const [key,value] of originals)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
  }
});
