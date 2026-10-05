import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';
import { settingsViewportSize } from '../src/control-obstacles';
import { persistSettingsBatch, readSettingsValue, SETTINGS_RECOVERY_KEY } from '../src/settings-storage';
const normal = 'kaisen-controls-v2', keyboard = 'kaisen-keyboard-v1';
function storage() {
  const map = new Map<string,string>([[normal,'old'],[keyboard,'old keys']]);
  return {map,getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);}};
}
test('Save verifies its journal before changing any setting',()=>{
  const s=storage(),write=s.setItem; s.setItem=(k,v)=>{if(k!==SETTINGS_RECOVERY_KEY)write(k,v);};
  assert.equal(persistSettingsBatch([{key:normal,value:'new',maxVersion:2}],s),false);
  assert.equal(s.getItem(normal),'old');assert.equal(s.getItem(SETTINGS_RECOVERY_KEY),null);
});
test('Save detects a silent settings write and restores the full batch',()=>{
  const s=storage(),write=s.setItem;s.setItem=(k,v)=>{if(k!==keyboard||v!=='new keys')write(k,v);};
  assert.equal(persistSettingsBatch([{key:normal,value:'new',maxVersion:2},{key:keyboard,value:'new keys'}],s),false);
  assert.equal(s.getItem(normal),'old');assert.equal(s.getItem(keyboard),'old keys');assert.equal(s.getItem(SETTINGS_RECOVERY_KEY),null);
});
test('silent rollback failure preserves recoverable raw and read-only old settings',()=>{
  const s=storage(),write=s.setItem;s.setItem=(k,v)=>{if((k===keyboard&&v==='new keys')||(k===normal&&v==='old'))return;write(k,v);};
  assert.equal(persistSettingsBatch([{key:normal,value:'new',maxVersion:2},{key:keyboard,value:'new keys'}],s),false);
  assert.equal(s.getItem(normal),'new');assert.equal(readSettingsValue(normal,s),'old');assert.ok(s.getItem(SETTINGS_RECOVERY_KEY));
});
test('silent journal cleanup is not success and remains safely reloadable',()=>{
  const s=storage(),remove=s.removeItem;s.removeItem=k=>{if(k!==SETTINGS_RECOVERY_KEY)remove(k);};
  assert.equal(persistSettingsBatch([{key:normal,value:'new',maxVersion:2}],s),false);
  assert.equal(readSettingsValue(normal,s),'old');assert.ok(s.getItem(SETTINGS_RECOVERY_KEY));
});
test('duplicate Save entries are rejected without overwriting a recovery record',()=>{
  const s=storage();assert.equal(persistSettingsBatch([{key:normal,value:'a',maxVersion:2},{key:normal,value:'b',maxVersion:2}],s),false);
  assert.equal(s.getItem(normal),'old');assert.equal(s.getItem(SETTINGS_RECOVERY_KEY),null);
});
test('a changed value between journal and write is preserved',()=>{
  const s=storage(),write=s.setItem;s.setItem=(k,v)=>{write(k,v);if(k===SETTINGS_RECOVERY_KEY)write(normal,'{"version":99}');};
  assert.equal(persistSettingsBatch([{key:normal,value:'new',maxVersion:2}],s),false);
  assert.equal(s.getItem(normal),'{"version":99}');assert.ok(s.getItem(SETTINGS_RECOVERY_KEY));
});
class NodeStub extends EventTarget {
  attrs=new Map<string,string>();captured=new Set<number>();offsetHeight=144;
  style={left:'',top:'',setProperty(){},removeProperty(){}};classList={add(){},remove(){},toggle(){}};
  getAttribute(k:string){return this.attrs.get(k)??null;}setAttribute(k:string,v:string){this.attrs.set(k,v);}
  getBoundingClientRect(){return {left:0,top:100,bottom:244,width:72,height:144};}
  closest(selector:string){return selector==='#app'||(selector.includes('[role="slider"]')&&this.attrs.get('role')==='slider')?this:null;}querySelector(){return this;}
  setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);}
}
const pointer=(type:string,id:number,y=122,extra={})=>Object.assign(new Event(type,{cancelable:true}),{pointerId:id,clientX:36,clientY:y,pointerType:'touch',button:0,buttons:1,isPrimary:false,...extra});
const key=(type:string,code:string,extra={})=>Object.assign(new Event(type,{cancelable:true}),{code,repeat:false,isComposing:false,ctrlKey:false,metaKey:false,altKey:false,...extra});
function fixture() {
  const originals=['window','document','HTMLElement'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
  const win=Object.assign(new EventTarget(),{visualViewport:new EventTarget()});const doc=Object.assign(new EventTarget(),{hidden:false,getElementById:()=>new NodeStub()});
  for(const[k,v]of [['window',win],['document',doc],['HTMLElement',NodeStub]]as const)Object.defineProperty(globalThis,k,{configurable:true,value:v});
  const surface=new NodeStub(),throttle=new NodeStub(),fire=new NodeStub(),loop=new NodeStub();throttle.setAttribute('role','slider');
  const controls=new FlightControls(surface as any,{throttle,fire,loop}as any,()=>true);
  const send=(code:string)=>{const event=key('keydown',code);Object.defineProperty(event,'target',{value:throttle});(controls as any).keyDown(event);};
  return{win,surface,throttle,fire,controls,send,cleanup(){controls.dispose();for(const[k,v]of originals)if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}};
}
test('focused configured speed keys clear on focusout and Escape without releasing independent touch',()=>{
  const f=fixture();try{
    f.surface.dispatchEvent(pointer('pointerdown',1,170,{isPrimary:true}));f.win.dispatchEvent(pointer('pointermove',1,155,{clientX:60}));f.fire.dispatchEvent(pointer('pointerdown',2));
    for(const terminal of ['focusout','Escape']) {
      f.throttle.dispatchEvent(new Event('focusin'));f.send('KeyW');assert.equal(f.controls.sampleThrottle(),1);
      f.throttle.dispatchEvent(terminal==='Escape'?key('keydown','Escape'):new Event('focusout'));
      assert.equal(f.controls.sampleThrottle(),0);assert.equal(f.controls.sample().fire,true);assert.equal(f.controls.peek().steerPointer,1);
      f.win.dispatchEvent(key('keyup','KeyW'));
    }
  }finally{f.cleanup();}
});
test('zoomed visible handle endpoints produce full continuous throttle',()=>{
  const f=fixture();try{
    f.throttle.offsetHeight=128;f.throttle.getBoundingClientRect=()=>({left:0,top:100,bottom:356,width:128,height:256});
    f.throttle.dispatchEvent(pointer('pointerdown',9,144));assert.equal(f.controls.sampleThrottle(),1);
    f.win.dispatchEvent(pointer('pointermove',9,312));assert.equal(f.controls.sampleThrottle(),-1);
    f.win.dispatchEvent(pointer('pointermove',9,228));assert.equal(f.controls.sampleThrottle(),0);
  }finally{f.cleanup();}
});

test('dialog viewport height uses layout units at CSS zoom without double scaling',()=>{
  for(const scale of [.5,1,2]) {
    const element={offsetWidth:393,offsetHeight:852,getBoundingClientRect:()=>({width:393*scale,height:852*scale})};
    assert.deepEqual(settingsViewportSize(element as any,393,852),{width:393/scale,height:852/scale});
  }
  assert.deepEqual(settingsViewportSize({offsetWidth:0,offsetHeight:0,getBoundingClientRect:()=>({width:0,height:0})} as any,393,852),{width:393,height:852});
});
