import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createGame, startGame } from '../src/simulation';

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
  const win=Object.assign(new EventTarget(),{innerWidth:402,innerHeight:874,visualViewport:new EventTarget()});
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
    for(const event of ['orientationchange','blur','pagehide']) {
      win.dispatchEvent(new Event(event));assert.equal(controls.peek().steerPointer,null);
      assert.equal(controls.sample().accelerate,false);surface.dispatchEvent(pointer('pointerdown',5));
    }
    controls.clear();surface.dispatchEvent(pointer('pointerdown',11));win.dispatchEvent(pointer('pointermove',11,118,190));
    const held=controls.sample();buttons.fire.dispatchEvent(pointer('pointerdown',12));
    win.innerHeight=820;win.dispatchEvent(new Event('resize'));win.visualViewport.dispatchEvent(new Event('resize'));
    assert.equal(controls.peek().steerPointer,11);assert.equal(controls.sample().fire,true);
    win.dispatchEvent(pointer('pointermove',11,118,136));
    assert.equal(controls.sample().turn,held.turn);assert.equal(controls.sample().climb,held.climb,'first shifted client coordinate rebases without a jump');
    win.dispatchEvent(pointer('pointermove',11,124,136));assert.ok(controls.sample().turn>held.turn,'same finger keeps steering');
    win.dispatchEvent(pointer('pointercancel',12));assert.equal(controls.peek().steerPointer,11);
    win.innerWidth=874;win.innerHeight=402;win.dispatchEvent(new Event('resize'));assert.equal(controls.peek().steerPointer,null);
    // A missing terminal notification is recoverable when the browser identifies a new primary finger.
    surface.dispatchEvent(pointer('pointerdown',8,100,200,true));assert.equal(controls.peek().steerPointer,8);
    doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));assert.equal(controls.peek().steerPointer,null);
  } finally {
    controls.dispose();for(const [key,value] of originals)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
  }
});

for(const mode of ['easy','normal'] as const) test(`${mode}: height-only 402x430↔402x390 retains steering through the real main resize handler`,()=>{
  const originals=['window','document','HTMLElement'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
  const win=Object.assign(new EventTarget(),{innerWidth:402,innerHeight:430,visualViewport:new EventTarget()});
  const doc=Object.assign(new EventTarget(),{hidden:false,getElementById:()=>new ElementStub()});
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});Object.defineProperty(globalThis,'document',{configurable:true,value:doc});Object.defineProperty(globalThis,'HTMLElement',{configurable:true,value:ElementStub});
  const state=createGame(73,mode);startGame(state);
  const surface=new ElementStub(),buttons={fire:new ElementStub(),loop:new ElementStub(),accelerate:new ElementStub(),brake:new ElementStub()};
  const controls=new FlightControls(surface as any,buttons as any,()=>state.phase==='playing');controls.setMode(mode);
  const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const resize=source.slice(source.indexOf('function handleResize()'),source.indexOf('window.addEventListener("pageshow"'));
  let layouts=0;
  const context:any={window:win,screen:'playing',noticeLayoutDirty:false,scene:{resize(){layouts++;}},el:()=>new ElementStub(),
    pause(){state.phase='paused';controls.clear();}};
  vm.createContext(context);vm.runInContext(ts.transpileModule(resize,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  try {
    surface.dispatchEvent(pointer('pointerdown',21));win.dispatchEvent(pointer('pointermove',21,118,190));
    const held=controls.sample();assert.equal(held.steeringActive,true);
    buttons.fire.dispatchEvent(pointer('pointerdown',22));
    let clientY=190;
    for(const height of [390,430]) {
      win.innerHeight=height;win.dispatchEvent(new Event('resize'));win.visualViewport.dispatchEvent(new Event('resize'));
      assert.equal(controls.peek().steerPointer,21,'crossing square proportions is a height-only resize');
      assert.equal(controls.sample().turn,held.turn);assert.equal(controls.sample().climb,held.climb);
      assert.equal(controls.sample().fire,mode==='normal','the independently held trigger remains owned');
      assert.equal(state.phase,'playing');assert.equal(context.screen,'playing');
      clientY+=height===390?-40:40;
      win.dispatchEvent(pointer('pointermove',21,118,clientY));
      assert.equal(controls.sample().turn,held.turn);assert.equal(controls.sample().climb,held.climb,'shifted coordinate is rebased without a jump');
    }
    assert.equal(layouts,4);assert.equal(context.noticeLayoutDirty,true,'main still resizes the renderer and HUD');
    win.dispatchEvent(pointer('pointermove',21,124,clientY));assert.ok(controls.sample().turn>held.turn,'same finger continues steering');
    win.dispatchEvent(new Event('orientationchange'));assert.equal(controls.peek().steerPointer,null,'explicit rotation still clears');
    surface.dispatchEvent(pointer('pointerdown',23));win.innerWidth=430;win.dispatchEvent(new Event('resize'));assert.equal(controls.peek().steerPointer,null,'width changes still clear');
  } finally {
    controls.dispose();for(const [key,value] of originals)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
  }
});
