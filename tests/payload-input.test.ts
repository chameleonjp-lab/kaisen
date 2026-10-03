import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';
class ElementStub extends EventTarget {
  style = { left: '', top: '', setProperty() {}, removeProperty() {} };
  classList = { add() {}, remove() {} }; attributes = new Map<string, string>();
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  closest() { return this; } querySelector() { return this; }
  setPointerCapture() { throw new Error('capture unavailable'); } hasPointerCapture() { return false; }
}
function pointer(type: string, id: number, x = 100, y = 200) {
  return Object.assign(new Event(type, { cancelable: true }), { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0, buttons: 1, isPrimary: false });
}
test('payload touch release and keyboard edges remain independent of steering, cancel, blur and mode', () => {
  const originals = ['window', 'document', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const win = Object.assign(new EventTarget(), { visualViewport: new EventTarget() });
  const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: () => new ElementStub() });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: ElementStub });
  const surface = new ElementStub(), buttons = { fire: new ElementStub(), loop: new ElementStub(), accelerate: new ElementStub(), brake: new ElementStub(), bomb: new ElementStub(), torpedo: new ElementStub() };
  let active = true;
  const controls = new FlightControls(surface as any, buttons as any, () => active);
  const key = (type: string, code: string, repeat = false) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat, isComposing: false }));
  try {
    controls.setMode('easy'); surface.dispatchEvent(pointer('pointerdown', 1)); win.dispatchEvent(pointer('pointermove', 1, 130));
    buttons.bomb.dispatchEvent(pointer('pointerdown', 2)); assert.equal(controls.sample().bomb, false);
    win.dispatchEvent(pointer('pointerup', 2)); let input = controls.sample(); assert.equal(input.bomb, true); assert.ok(input.turn > .7);
    assert.equal(controls.peek().steerPointer, 1); assert.equal(controls.sample().bomb, false);
    buttons.torpedo.dispatchEvent(pointer('pointerdown', 3)); win.dispatchEvent(pointer('pointercancel', 3)); assert.equal(controls.sample().torpedo, false);
    buttons.bomb.dispatchEvent(pointer('pointerdown', 4)); win.dispatchEvent(new Event('blur')); win.dispatchEvent(pointer('pointerup', 4)); assert.equal(controls.sample().bomb, false);
    key('keydown', 'KeyZ'); assert.equal(controls.sample().bomb, true);
    key('keydown', 'KeyZ', true); key('keydown', 'KeyZ'); assert.equal(controls.sample().bomb, false);
    key('keyup', 'KeyZ'); key('keydown', 'KeyZ'); assert.equal(controls.sample().bomb, true); key('keyup', 'KeyZ');
    key('keydown', 'KeyX'); controls.setMode('normal'); assert.equal(controls.sample().torpedo, false, 'mode change clears old actions');
    key('keydown', 'KeyX'); assert.equal(controls.sample().torpedo, true); key('keyup', 'KeyX');
    active = false; key('keydown', 'KeyZ'); assert.equal(Boolean(controls.sample().bomb), false);
    active = true; assert.equal(controls.sample().bomb, false);
  } finally {
    controls.dispose(); for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
