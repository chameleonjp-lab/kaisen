import test from 'node:test';
import assert from 'node:assert/strict';
import { containDialogTabFocus } from '../src/dialog-focus';

function fixture() {
  const ownerDocument = {
    activeElement: null as unknown,
    defaultView: { getComputedStyle: (element: any) => ({ visibility: element.visibility }) },
  };
  const control = (id: string, properties = {}) => ({
    id, tabIndex: 0, disabled: false, hiddenAncestor: false, rendered: true, visibility: 'visible',
    matches(selector: string) { assert.equal(selector, ':disabled'); return this.disabled; },
    closest(selector: string) { assert.equal(selector, '[hidden], [inert]'); return this.hiddenAncestor ? {} : null; },
    getClientRects() { return this.rendered ? [{}] : []; },
    focus() { ownerDocument.activeElement = this; },
    ...properties,
  });
  const close = control('close'), content = control('settings-main'), range = control('control-x'), save = control('save');
  const controls = [close, content, range, save];
  const dialog = {
    open: true, ownerDocument,
    querySelectorAll() { return controls; },
    focus() { ownerDocument.activeElement = this; },
  };
  const press = (from: unknown, properties = {}) => {
    ownerDocument.activeElement = from;
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'Tab', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...properties,
    }) as KeyboardEvent;
    containDialogTabFocus(dialog as unknown as HTMLDialogElement, event);
    return event;
  };
  return { ownerDocument, control, close, content, range, save, controls, dialog, press };
}

test('modal Tab wraps Close to Save and Save to Close without leaving the document', () => {
  const f = fixture();
  assert.equal(f.press(f.close, { shiftKey: true }).defaultPrevented, true);
  assert.equal(f.ownerDocument.activeElement, f.save);
  assert.equal(f.press(f.save).defaultPrevented, true);
  assert.equal(f.ownerDocument.activeElement, f.close);
});

test('interior content regions and range controls retain native forward and backward traversal', () => {
  const f = fixture();
  for (const from of [f.content, f.range]) {
    for (const shiftKey of [false, true]) {
      assert.equal(f.press(from, { shiftKey }).defaultPrevented, false);
      assert.equal(f.ownerDocument.activeElement, from);
    }
  }
  assert.equal(f.press(f.close).defaultPrevented, false);
  assert.equal(f.press(f.save, { shiftKey: true }).defaultPrevented, false);
});

test('hidden editor controls, disabled actions and non-tabbable elements cannot become wrap targets', () => {
  const f = fixture();
  for (const properties of [
    { hiddenAncestor: true }, { rendered: false }, { visibility: 'hidden' },
    { visibility: 'collapse' }, { disabled: true }, { tabIndex: -1 },
  ]) f.controls.push(f.control('unavailable', properties));
  f.press(f.close, { shiftKey: true });
  assert.equal(f.ownerDocument.activeElement, f.save);
  f.save.disabled = true;
  f.press(f.close, { shiftKey: true });
  assert.equal(f.ownerDocument.activeElement, f.range);
});

test('missing or stale modal focus is recovered, and a modal with no controls retains focus', () => {
  const f = fixture();
  assert.equal(f.press(null).defaultPrevented, true);
  assert.equal(f.ownerDocument.activeElement, f.close);
  assert.equal(f.press({ id: 'outside' }, { shiftKey: true }).defaultPrevented, true);
  assert.equal(f.ownerDocument.activeElement, f.save);
  f.controls.length = 0;
  assert.equal(f.press(null).defaultPrevented, true);
  assert.equal(f.ownerDocument.activeElement, f.dialog);
});

test('closed dialogs, composition, other keys and browser modifier shortcuts are left alone', () => {
  const f = fixture();
  for (const properties of [
    { key: 'Escape' }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true },
  ]) {
    assert.equal(f.press(f.save, properties).defaultPrevented, false);
    assert.equal(f.ownerDocument.activeElement, f.save);
  }
  f.dialog.open = false;
  assert.equal(f.press(f.save).defaultPrevented, false);
  assert.equal(f.ownerDocument.activeElement, f.save);
});

test('positive tabindex controls preserve their browser tab order at the modal boundaries', () => {
  const f = fixture();
  f.range.tabIndex = 1;
  f.content.tabIndex = 2;
  f.press(f.range, { shiftKey: true });
  assert.equal(f.ownerDocument.activeElement, f.save);
  f.press(f.save);
  assert.equal(f.ownerDocument.activeElement, f.range);
});
