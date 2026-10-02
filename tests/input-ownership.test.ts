import assert from 'node:assert/strict';
import test from 'node:test';
import { FlightControls } from '../src/input';

/** Handler-level ownership regression. Actual browser gestures are tested separately. */
function fixture() {
  const attributes = new Map([['aria-pressed', 'true']]);
  const button = { getAttribute: (name: string) => attributes.get(name) ?? null, setAttribute: (name: string, value: string) => attributes.set(name, value), classList: {remove() {}} };
  // Use the real copied source handlers, without inventing a DOM/event engine.
  const controls = Object.assign(Object.create(FlightControls.prototype), {
    active: () => true, mode: 'easy', steerPointer: 1, turn: .5, climb: -.25,
    steeringRevision: 9, loopEdge: false, keys: new Set(), clickBursts: new Set(),
    holds: {fire: new Set(), loop: new Set([2, 3]), accelerate: new Set(), brake: new Set()},
    joystick: {classList: {remove() {}}, style: {removeProperty() {}}},
  });
  return {controls, button, attributes};
}

test('releasing one button finger preserves the other finger and active steering', () => {
  const {controls, button, attributes} = fixture();
  controls.endButton('loop', button, {pointerId: 2}, true);
  assert.equal(controls.steerPointer, 1);
  assert.deepEqual([...controls.holds.loop], [3]);
  assert.equal(attributes.get('aria-pressed'), 'true');
  const input=controls.sample();
  assert.equal(input.turn,.5); assert.equal(input.climb,-.25); assert.equal(input.loop,true);
  assert.equal(controls.sample().loop,false, 'single release produces one edge');
  controls.endButton('loop', button, {pointerId: 3}, false);
  assert.equal(attributes.get('aria-pressed'), 'false');
  assert.equal(controls.sample().loop,false, 'cancel is not a completed loop action');
  assert.equal(controls.steerPointer,1);
});

test('steering cancellation does not release another control pointer', () => {
  const {controls}=fixture();
  controls.endSteering({pointerId:99});
  assert.equal(controls.turn,.5);
  controls.endSteering({pointerId:1});
  assert.equal(controls.steerPointer,null);assert.equal(controls.turn,0);assert.equal(controls.climb,0);
  assert.equal(controls.steeringRevision,10);
  assert.deepEqual([...controls.holds.loop],[2,3]);
});
