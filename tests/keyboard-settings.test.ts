import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightControls } from '../src/input';
import {
  ControlInputPresentation, KeyboardSettings, DEFAULT_KEY_BINDINGS, KEY_ACTIONS, KEYBOARD_STORAGE_KEY, captureKey,
  keyConflict, keyLabel, parseKeyBindings, preferredControlEditor, validKeyBindings,
} from '../src/keyboard-settings';

function key(code: string, extras: object = {}): KeyboardEvent {
  return Object.assign(new Event('keydown', { cancelable: true }), { code, repeat: false, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, ...extras }) as KeyboardEvent;
}

test('input presentation cannot move a pressed target before click commits its action', () => {
  const descriptors = ['window','navigator'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)] as const);
  const win = Object.assign(new EventTarget(), { matchMedia: () => ({ matches:false }) });
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{maxTouchPoints:5}});
  const controller = new ControlInputPresentation(); const seen:string[]=[]; controller.subscribe(()=>seen.push(controller.value));
  const pointer=(type:string,pointerType:string)=>win.dispatchEvent(Object.assign(new Event(type),{pointerType}));
  try {
    assert.equal(controller.value,'touch');
    pointer('pointerdown','mouse'); assert.equal(controller.value,'touch','layout stays stable while a mouse press is held');
    pointer('pointerup','mouse'); assert.equal(controller.value,'touch');
    pointer('click','mouse'); assert.equal(controller.value,'keyboard');
    pointer('pointerdown','touch'); pointer('pointercancel','touch'); assert.equal(controller.value,'keyboard');
    pointer('click',''); assert.equal(controller.value,'keyboard','cancelled pointer cannot leak into a later programmatic click');
    pointer('pointerdown','touch'); pointer('pointerup','touch'); pointer('click','');
    assert.equal(controller.value,'touch','Safari click may omit pointerType; use the completed press');
    win.dispatchEvent(key('KeyA')); assert.equal(controller.value,'keyboard');
    assert.deepEqual(seen,['keyboard','touch','keyboard']);
  } finally {
    controller.dispose();
    for(const [name,descriptor] of descriptors)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);
  }
});

test('keyboard persistence restores complete distinct keys and rejects invalid or partial records', () => {
  const bindings = { ...DEFAULT_KEY_BINDINGS, fire: 'KeyF', bomb: 'Numpad1', torpedo: 'IntlYen', pause: 'KeyP' };
  assert.equal(validKeyBindings(bindings), true);
  assert.deepEqual(parseKeyBindings(JSON.stringify({ version: 1, bindings })), bindings);
  for (const value of [null, 'bad json', '{}', '[]', JSON.stringify({ version: 2, bindings }), JSON.stringify({ version: 1, bindings: { fire: 'KeyF' } }),
    JSON.stringify({ version: 1, bindings: { ...bindings, bomb: 'KeyF' } }), JSON.stringify({ version: 1, bindings: { ...bindings, fire: 'Ctrl+KeyR' } }),
    JSON.stringify({ version: 1, bindings: { ...bindings, fire: 'F5' } }), JSON.stringify({ version: 1, bindings: { ...bindings, fire: 'Escape' } })]) {
    assert.deepEqual(parseKeyBindings(value), DEFAULT_KEY_BINDINGS);
  }
});

test('capture accepts physical letters, punctuation, numpad and shift; reserved chords remain unavailable', () => {
  for (const code of ['KeyA', 'Digit1', 'Numpad0', 'NumpadEnter', 'IntlYen', 'Semicolon', 'ShiftLeft', 'ShiftRight', 'ArrowDown', 'Space', 'F2']) {
    assert.deepEqual(captureKey(key(code)), { kind: 'key', code });
  }
  for (const code of ['Tab', 'F1', 'F5', 'F6', 'F10', 'F11', 'F12', 'MetaLeft', 'AltRight', '', 'Unidentified']) assert.equal(captureKey(key(code)).kind, 'error');
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(captureKey(key('KeyR', { [modifier]: true })).kind, 'error');
  assert.deepEqual(captureKey(key('Escape')), { kind: 'cancel' });
  assert.deepEqual(captureKey(key('KeyF', { repeat: true })), { kind: 'ignore' });
  assert.deepEqual(captureKey(key('KeyF', { isComposing: true })), { kind: 'ignore' });
  assert.equal(keyConflict({ ...DEFAULT_KEY_BINDINGS }, 'bomb', 'Space'), 'fire');
  assert.equal(keyConflict({ ...DEFAULT_KEY_BINDINGS }, 'fire', 'Space'), undefined);
  assert.equal(keyLabel('Numpad2'), 'テンキー 2');
  assert.equal(keyLabel('KeyZ'), 'Z');
});

test('input presentation uses capabilities, retaining keyboard on touch laptops and narrow PCs', () => {
  assert.equal(preferredControlEditor(false, false, 5), 'touch');
  assert.equal(preferredControlEditor(true, true, 5), 'keyboard');
  assert.equal(preferredControlEditor(false, false, 0), 'keyboard');
  assert.equal(preferredControlEditor(false, false, 5, true), 'keyboard');
});

test('committed bindings are isolated copies and pause respects reserved chords and key repeats', () => {
  const settings = new KeyboardSettings();
  let changed = 0;
  const unsubscribe = settings.subscribe(() => changed++);
  const draft = settings.bindings;
  draft.pause = 'KeyP';
  assert.equal(settings.matchesPause(key('Escape')), true);
  assert.equal(settings.matchesPause(key('KeyP')), false);
  settings.apply(draft); draft.pause = 'KeyQ';
  assert.equal(settings.matchesPause(key('KeyP')), true);
  for (const extras of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) assert.equal(settings.matchesPause(key('KeyP', extras)), false);
  assert.equal(settings.matchesPause(key('Escape')), false);
  settings.apply({ ...settings.bindings, bomb: 'KeyP' });
  assert.equal(settings.code('bomb'), 'KeyZ');
  assert.equal(changed, 1);
  assert.match(settings.describe('normal'), /Space 射撃/);
  assert.doesNotMatch(settings.describe('easy'), /Space 射撃/);
  assert.match(settings.describe('easy'), /P 一時停止・再開/);
  unsubscribe(); settings.apply({ ...DEFAULT_KEY_BINDINGS }); assert.equal(changed, 1);
});

class ElementStub extends EventTarget {
  style = { left: '', top: '', setProperty() {}, removeProperty() {} };
  classList = { add() {}, remove() {} };
  attributes = new Map<string, string>();
  isContentEditable = false;
  editing = false;
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  closest(selector: string) { return selector === '#app' ? this : this.editing ? this : null; }
  querySelector() { return this; }
  hasPointerCapture() { return false; }
}

test('custom flight keys cover every action, release on remap/blur and never leak from editing or browser chords', () => {
  const originals = ['window', 'document', 'HTMLElement', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const win = Object.assign(new EventTarget(), { visualViewport: new EventTarget() });
  const doc = Object.assign(new EventTarget(), { hidden: false, getElementById: () => new ElementStub() });
  const bindings = { left: 'KeyA', right: 'KeyD', up: 'KeyI', down: 'KeyK', fire: 'KeyF', loop: 'KeyJ', accelerate: 'KeyE', brake: 'KeyQ', bomb: 'Digit1', torpedo: 'Numpad2', pause: 'KeyP' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: ElementStub });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (name: string) => name === KEYBOARD_STORAGE_KEY ? JSON.stringify({ version: 1, bindings }) : null } });
  const settings = new KeyboardSettings();
  const buttons = { fire: new ElementStub(), loop: new ElementStub(), accelerate: new ElementStub(), brake: new ElementStub(), bomb: new ElementStub(), torpedo: new ElementStub() };
  let active = true;
  const controls = new FlightControls(new ElementStub() as any, buttons as any, () => active, settings);
  const down = (code: string, extras = {}) => win.dispatchEvent(key(code, extras));
  const up = (code: string) => win.dispatchEvent(Object.assign(new Event('keyup'), { code }));
  try {
    for (const [code, property, expected] of [['KeyA', 'turn', -1], ['KeyD', 'turn', 1], ['KeyI', 'climb', 1], ['KeyK', 'climb', -1], ['KeyF', 'fire', true], ['KeyE', 'accelerate', true], ['KeyQ', 'brake', true]] as const) {
      down(code); assert.equal(controls.sample()[property], expected);
      up(code); assert.equal(controls.sample()[property], typeof expected === 'number' ? 0 : false);
    }
    for (const [code, property] of [['KeyJ', 'loop'], ['Digit1', 'bomb'], ['Numpad2', 'torpedo']] as const) {
      down(code); assert.equal(controls.sample()[property], true);
      down(code); down(code, { repeat: true }); assert.equal(controls.sample()[property], false);
      up(code); down(code); assert.equal(controls.sample()[property], true); up(code);
    }
    down('KeyD'); down('KeyF'); assert.equal(controls.sample().fire, true);
    win.dispatchEvent(new Event('blur'));
    down('KeyF', { repeat: true }); assert.equal(controls.sample().fire, false);
    assert.equal(controls.sample().turn, 0);
    down('KeyF'); down('KeyR', { ctrlKey: true }); assert.equal(controls.sample().fire, false);
    down('KeyF', { altKey: true }); assert.equal(controls.sample().fire, false);
    down('KeyF', { isComposing: true }); assert.equal(controls.sample().fire, false);
    const input = new ElementStub(); input.editing = true;
    const editingKey = key('KeyF'); Object.defineProperty(editingKey, 'target', { value: input });
    win.dispatchEvent(editingKey); assert.equal(controls.sample().fire, false);
    const editingPause = key('KeyP'); Object.defineProperty(editingPause, 'target', { value: input });
    assert.equal(settings.matchesPause(editingPause), false);
    controls.setMode('easy');
    down('KeyF'); down('KeyE'); down('KeyQ'); assert.equal(controls.sample().fire, false); assert.equal(controls.sample().accelerate, false);
    down('Digit1'); assert.equal(controls.sample().bomb, true); up('Digit1');
    controls.setMode('normal'); down('KeyF');
    settings.apply({ ...bindings, fire: 'KeyG' }); assert.equal(controls.sample().fire, false);
    down('KeyF'); assert.equal(controls.sample().fire, false);
    down('KeyG'); assert.equal(controls.sample().fire, true); up('KeyG');
    active = false; down('KeyG'); down('Digit1'); assert.equal(controls.sample().fire, false);
    active = true; assert.equal(controls.sample().bomb, false);
    for (const action of KEY_ACTIONS) assert.equal(settings.action(settings.code(action)), action);
  } finally {
    controls.dispose();
    for (const [name, original] of originals) if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name);
  }
});
