import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';

class ElementStub extends EventTarget {
  style = { left: '', top: '', setProperty() {}, removeProperty() {} };
  classList = { add() {}, remove() {} };
  attributes = new Map<string, string>();
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  closest() { return this; }
  querySelector() { return this; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
}

function pointer(type: string, pointerId: number, pointerType: string, x = 100, button = 0) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId, pointerType, clientX: x, clientY: 200,
    button, buttons: 1, isPrimary: true });
  return event;
}

test('primary mouse or pen pointers cannot erase a live touch steering owner or held button', () => {
  const original = ['window', 'document', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const win = Object.assign(new EventTarget(), { visualViewport: new EventTarget() });
  const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: () => new ElementStub() });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: ElementStub });
  const surface = new ElementStub();
  const buttons = { fire: new ElementStub(), loop: new ElementStub(), accelerate: new ElementStub(), brake: new ElementStub() };
  const controls = new FlightControls(surface as any, buttons as any, () => true);
  try {
    surface.dispatchEvent(pointer('pointerdown', 1, 'touch'));
    win.dispatchEvent(pointer('pointermove', 1, 'touch', 130));
    const secondary = pointer('pointerdown', 2, 'touch'); Object.assign(secondary,{isPrimary:false});
    buttons.accelerate.dispatchEvent(secondary);
    for (const [kind, button] of [['mouse', 2], ['mouse', 0], ['pen', 0]] as const) {
      surface.dispatchEvent(pointer('pointerdown', 3, kind, 100, button));
      assert.equal(controls.peek().steerPointer, 1, `${kind}/${button} must not steal a live touch owner`);
      assert.ok(controls.sample().turn > .7);
      assert.equal(controls.sample().accelerate, true);
    }
    // The browser retired the contact but its terminal notification was lost.
    // The next primary contact is allowed to reuse the same pointer ID.
    surface.dispatchEvent(pointer('pointerdown', 1, 'touch', 200));
    assert.equal(controls.sample().turn, 0, 'a recycled ID starts a new neutral drag');
    win.dispatchEvent(pointer('pointermove', 1, 'touch', 170));
    assert.ok(controls.sample().turn < -.7, 'movement is relative to the new contact origin');
  } finally {
    controls.dispose();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
