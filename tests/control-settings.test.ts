import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlSettings, DEFAULT_LAYOUT, controlBounds, controlDisplaySize, persistControlSettings, migratePayloadDefault, previewLabelStyle } from '../src/control-settings';
import { DEFAULT_KEY_BINDINGS, KEYBOARD_STORAGE_KEY, KeyboardSettings } from '../src/keyboard-settings';

function storageFixture() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('small desktop preview buttons use readable external labels rather than overflowing or microscopic text', () => {
  for (const diameter of [15.75,20.66,26.1]) assert.deepEqual(previewLabelStyle(diameter,3),{outside:true,fontSize:10});
  const large=previewLabelStyle(52,3); assert.equal(large.outside,false); assert.ok(large.fontSize*3+6<=52);
});

test('only exact legacy payload defaults move to the lower edge without mutating custom saved placements', () => {
  for (const [name,x] of [['bomb',.39],['torpedo',.58]] as const) {
    const old={x,y:.72,size:56,opacity:.88}, copy={...old};
    assert.deepEqual(migratePayloadDefault(name,old),DEFAULT_LAYOUT[name]); assert.deepEqual(old,copy);
    const custom={...old,x:x+.01};assert.deepEqual(migratePayloadDefault(name,custom),custom);
    assert.deepEqual(migratePayloadDefault(name,DEFAULT_LAYOUT[name]),DEFAULT_LAYOUT[name]);
  }
});

test('layout and keyboard persistence roll back together when any write fails', () => {
  const storage = storageFixture(); storage.values.set('normal', 'before');
  const write = storage.setItem;
  storage.setItem = (key, value) => { if (key === 'keys' && value === 'new keys') throw new Error('quota'); write(key, value); };
  assert.equal(persistControlSettings([{ key: 'normal', value: 'after' }, { key: 'easy', value: 'new easy' }, { key: 'keys', value: 'new keys' }], storage), false);
  assert.equal(storage.getItem('normal'), 'before');
  assert.equal(storage.getItem('easy'), null);
  assert.equal(storage.getItem('keys'), null);
  assert.equal(persistControlSettings([{ key: 'normal', value: 'after' }], storage), true);
  assert.equal(storage.getItem('normal'), 'after');
});

test('unavailable storage reads cannot cause partial writes', () => {
  let writes = 0;
  assert.equal(persistControlSettings([{ key: 'x', value: 'value' }], {
    getItem() { throw new Error('blocked'); }, setItem() { writes++; }, removeItem() { writes++; },
  }), false);
  assert.equal(writes, 0);
});

test('saving from an older tab preserves a future settings format', () => {
  const storage = storageFixture();
  const future = JSON.stringify({ version: 2, bindings: { future: 'format' } });
  storage.values.set(KEYBOARD_STORAGE_KEY, future);
  assert.equal(persistControlSettings([{ key: 'kaisen-controls-v1', value: 'layout' }, { key: KEYBOARD_STORAGE_KEY, value: JSON.stringify({ version: 1, bindings: DEFAULT_KEY_BINDINGS }) }], storage), false);
  assert.equal(storage.getItem(KEYBOARD_STORAGE_KEY), future);
  assert.equal(storage.getItem('kaisen-controls-v1'), null);
});

function dialogFixture() {
  const keyboard = new KeyboardSettings();
  const nodes = new Map<string, any>();
  const dialog = {
    returnValue: '',
    close(value: string) { this.returnValue = value; },
    querySelector(selector: string) {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: '', hidden: true, scrollIntoView() {} });
      return nodes.get(selector);
    },
  };
  const saved = { normal: structuredClone(DEFAULT_LAYOUT), easy: structuredClone(DEFAULT_LAYOUT) };
  const editor: any = Object.assign(Object.create(ControlSettings.prototype), {
    keyboard, dialog, saved, draft: structuredClone(saved), keyDraft: keyboard.bindings,
    allowedModes: ['normal', 'easy'], activeMode: 'normal', layoutMode: 'normal', capturing: null,
    editor: 'keyboard', dragPointer: null, dragControl: null, returnFocus: null,
    saveFailedAwaitingUse: false, storageUnavailable: false,
    apply() {}, updateEditor() {}, renderKeys(message: string) { this.keyMessage = message; },
  });
  return { editor, keyboard, dialog, nodes };
}

test('save applies both drafts only after successful persistence; cancel restores both saved values', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = storageFixture(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const { editor, keyboard, dialog } = dialogFixture();
    editor.draft.normal.bomb.x = .2; editor.keyDraft.bomb = 'KeyB';
    assert.equal(keyboard.code('bomb'), 'KeyZ');
    editor.save();
    assert.equal(dialog.returnValue, 'save');
    assert.equal(keyboard.code('bomb'), 'KeyB');
    assert.equal(JSON.parse(storage.getItem(KEYBOARD_STORAGE_KEY)!).bindings.bomb, 'KeyB');
    assert.equal(JSON.parse(storage.getItem('kaisen-controls-v1')!).controls.bomb.x, .2);
    editor.draft.normal.bomb.x = .7; editor.keyDraft.bomb = 'KeyC'; editor.capturing = 'bomb';
    editor.onClosed();
    assert.equal(editor.draft.normal.bomb.x, .2); assert.equal(editor.keyDraft.bomb, 'KeyB');
    assert.equal(editor.capturing, null); assert.equal(keyboard.code('bomb'), 'KeyB');
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('save failure leaves controls unchanged until explicit session-only confirmation', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = storageFixture(); storage.setItem = () => { throw new Error('blocked'); };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const { editor, keyboard, dialog } = dialogFixture();
    editor.draft.normal.bomb.x = .2; editor.keyDraft.bomb = 'KeyB';
    editor.save();
    assert.equal(editor.saveFailedAwaitingUse, true); assert.equal(dialog.returnValue, '');
    assert.equal(editor.saved.normal.bomb.x, DEFAULT_LAYOUT.bomb.x); assert.equal(keyboard.code('bomb'), 'KeyZ');
    editor.save();
    assert.equal(dialog.returnValue, 'session-only'); assert.equal(editor.saved.normal.bomb.x, .2); assert.equal(keyboard.code('bomb'), 'KeyB');
    assert.equal(storage.getItem(KEYBOARD_STORAGE_KEY), null);
    const cancelled = dialogFixture(); cancelled.editor.keyDraft.bomb = 'KeyB'; cancelled.editor.save(); cancelled.editor.onClosed();
    assert.equal(cancelled.editor.keyDraft.bomb, 'KeyZ'); assert.equal(cancelled.editor.saveFailedAwaitingUse, false);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('reset remains a draft and cancelling capture preserves the previous assignment', () => {
  const { editor, keyboard } = dialogFixture();
  keyboard.apply({ ...DEFAULT_KEY_BINDINGS, fire: 'KeyF' });
  editor.keyDraft = { ...DEFAULT_KEY_BINDINGS }; // Same draft operation as the reset button.
  editor.onClosed(); assert.equal(editor.keyDraft.fire, 'KeyF');
  const send = (code: string, extra = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { code, repeat: false, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, ...extra });
    editor.captureKeyboard(event); return event;
  };
  editor.capturing = 'bomb';
  send('KeyF'); assert.equal(editor.capturing, 'bomb'); assert.match(editor.keyMessage, /射撃/); assert.equal(editor.keyDraft.bomb, 'KeyZ');
  send('F5'); assert.equal(editor.capturing, 'bomb'); assert.equal(editor.keyDraft.bomb, 'KeyZ');
  send('KeyB', { repeat: true }); send('KeyB', { isComposing: true }); assert.equal(editor.keyDraft.bomb, 'KeyZ');
  send('Escape'); assert.equal(editor.capturing, null); assert.equal(editor.keyDraft.bomb, 'KeyZ');
  editor.capturing = 'bomb'; assert.equal(send('Tab').defaultPrevented, false); assert.equal(editor.capturing, null);
  editor.capturing = 'bomb'; editor.cancelKeyCapture(); assert.equal(editor.capturing, null);
  editor.capturing = 'bomb'; send('KeyB'); assert.equal(editor.capturing, null); assert.equal(editor.keyDraft.bomb, 'KeyB'); assert.equal(keyboard.code('bomb'), 'KeyZ');
});

test('default touch controls keep safe edges and payloads separate in portrait and short landscape', () => {
  for (const [width, height, side, bottom] of [[393, 852, 0, 34], [393, 648, 0, 34], [320, 568, 0, 0], [568, 320, 44, 21], [852, 393, 44, 21]]) {
    const insets = { top: 0, right: side, bottom, left: side };
    const rects = Object.fromEntries(Object.entries(DEFAULT_LAYOUT).map(([name, placement]) => {
      const size = controlDisplaySize(placement.size, width, height);
      const bounds = controlBounds(size, width, height, insets);
      const x = Math.max(bounds.minX, Math.min(bounds.maxX, placement.x)) * width;
      const y = Math.max(bounds.minY, Math.min(bounds.maxY, placement.y)) * height;
      return [name, { x, y, size }];
    }));
    for (const [name, rect] of Object.entries(rects)) {
      assert.ok(rect.size >= 44, `${width}×${height} ${name} touch size`);
      assert.ok(rect.x - rect.size / 2 >= side && rect.x + rect.size / 2 <= width - side, `${name} horizontal safe area`);
      assert.ok(rect.y - rect.size / 2 >= 0 && rect.y + rect.size / 2 <= height - bottom, `${name} vertical safe area`);
      for (const [other, peer] of Object.entries(rects)) {
        if (name === other) continue;
        assert.ok(Math.abs(rect.x - peer.x) >= (rect.size + peer.size) / 2 || Math.abs(rect.y - peer.y) >= (rect.size + peer.size) / 2, `${width}×${height}: ${name} must not overlap ${other}`);
      }
    }
    assert.ok(rects.bomb.y > height * .8 && rects.torpedo.y > height * .8, 'payloads stay near the lower edge');
  }
});
