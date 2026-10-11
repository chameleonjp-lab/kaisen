import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';
class ElementStub extends EventTarget {
 style={left:'',top:'',setProperty(){},removeProperty(){}};classList={add(){},remove(){},toggle(){}};
 constructor(readonly kind='surface'){super();}
 attributes=new Map<string,string>();captures=new Set<number>();offsetHeight=200;
 getAttribute(k:string){return this.attributes.get(k)??null;}setAttribute(k:string,v:string){this.attributes.set(k,v);}
 getBoundingClientRect(){return {left:0,top:100,right:48,bottom:300,width:48,height:200};}
 closest(selector:string){return selector==='#app'||this.kind==='button'&&selector.includes('button')?this:null;}querySelector(){return this;}focus(){}
 setPointerCapture(id:number){this.captures.add(id);}hasPointerCapture(id:number){return this.captures.has(id);}releasePointerCapture(id:number){this.captures.delete(id);}
}
function pointer(type:string,id:number,x=100,y=200){const e=new Event(type,{cancelable:true});Object.assign(e,{pointerId:id,clientX:x,clientY:y,pointerType:'touch',button:0,buttons:1,isPrimary:false});return e;}
test('three pointer owners preserve micro-steering through fire/lever release and cancel, then clear on recovery',()=>{
 const originals=['window','document','HTMLElement','Element'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 const win=Object.assign(new EventTarget(),{visualViewport:new EventTarget()}),doc=Object.assign(new EventTarget(),{hidden:false,getElementById:()=>new ElementStub()});
 Object.defineProperty(globalThis,'window',{configurable:true,value:win});Object.defineProperty(globalThis,'document',{configurable:true,value:doc});Object.defineProperty(globalThis,'HTMLElement',{configurable:true,value:ElementStub});Object.defineProperty(globalThis,'Element',{configurable:true,value:ElementStub});
 const surface=new ElementStub(),buttons={fire:new ElementStub('button'),loop:new ElementStub('button'),throttle:new ElementStub('button')},controls=new FlightControls(surface as any,buttons as any,()=>true);controls.setMode('normal');
 try {
  surface.dispatchEvent(pointer('pointerdown',1));win.dispatchEvent(pointer('pointermove',1,106,197));const held=controls.sample();assert.equal(held.steeringActive,true);assert.ok(held.turn>0&&held.turn<.35);
  buttons.fire.dispatchEvent(pointer('pointerdown',2));buttons.throttle.dispatchEvent(pointer('pointerdown',3,100,122));
  const all=controls.sample();assert.equal(all.turn,held.turn);assert.equal(all.climb,held.climb);assert.equal(all.fire,true);assert.equal(all.throttle,1);
  win.dispatchEvent(pointer('pointermove',2,20,30));assert.equal(controls.sample().climb,held.climb);
  buttons.fire.dispatchEvent(pointer('lostpointercapture',2));assert.equal(controls.sample().fire,false);assert.equal(controls.sample().turn,held.turn);assert.equal(controls.sample().throttle,1);
  win.dispatchEvent(pointer('pointercancel',3));assert.equal(controls.sample().throttle,0);assert.equal(controls.sample().climb,held.climb);
  win.dispatchEvent(pointer('pointerup',1));assert.equal(controls.sample().turn,0);assert.equal(controls.sample().climb,0);assert.equal(controls.sample().steeringActive,undefined);
  for(const name of ['blur','resize','pagehide']){surface.dispatchEvent(pointer('pointerdown',4));win.dispatchEvent(new Event(name));assert.equal(controls.peek().steerPointer,null);assert.equal(controls.sample().steeringActive,undefined);}
  surface.dispatchEvent(pointer('pointerdown',5));controls.clear();assert.equal(controls.sample().turn,0);
 } finally {controls.dispose();for(const [key,d] of originals)if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}
});
