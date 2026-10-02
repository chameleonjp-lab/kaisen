import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderQueue, type RenderQueueContext } from '../src/render-queue';

// Protocol tests only: this mock does not measure or prove real GPU behavior.
function mockGL() {
  const calls: { name: string; args: unknown[] }[] = [];
  const deleted: WebGLSync[] = [];
  const created: WebGLSync[] = [];
  let lost = false;
  let nullFence = false;
  let waitResult = 0x911b;
  let throwOn = '';
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
    if (name === throwOn) throw new Error(`Mock ${name} failed`);
  };
  const gl: RenderQueueContext = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    ALREADY_SIGNALED: 0x911a,
    TIMEOUT_EXPIRED: 0x911b,
    CONDITION_SATISFIED: 0x911c,
    WAIT_FAILED: 0x911d,
    fenceSync(condition, flags) {
      record('fenceSync', condition, flags);
      if (nullFence) return null;
      const fence = {} as WebGLSync;
      created.push(fence);
      return fence;
    },
    clientWaitSync(fence, flags, timeout) {
      record('clientWaitSync', fence, flags, timeout);
      return waitResult;
    },
    deleteSync(fence) {
      if (fence) deleted.push(fence);
      record('deleteSync', fence);
    },
    flush() { record('flush'); },
    isContextLost() { record('isContextLost'); return lost; },
  };
  return {
    gl, calls, created, deleted,
    setLost(value = true) { lost = value; },
    setNullFence(value = true) { nullFence = value; },
    setWaitResult(value: number) { waitResult = value; },
    setThrowOn(value: string) { throwOn = value; },
  };
}

test('constructor is GL-free; one fenced submission flushes once and polls without blocking', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  assert.deepEqual(mock.calls, []);
  assert.equal(queue.poll(0), 'ready');
  queue.submit(10);
  assert.deepEqual(mock.calls.slice(-2), [
    { name: 'fenceSync', args: [mock.gl.SYNC_GPU_COMMANDS_COMPLETE, 0] },
    { name: 'flush', args: [] },
  ]);

  assert.equal(queue.poll(26), 'pending');
  assert.equal(queue.poll(42), 'pending');
  assert.deepEqual(mock.calls.filter((call) => call.name === 'clientWaitSync'), [
    { name: 'clientWaitSync', args: [mock.created[0], 0, 0] },
    { name: 'clientWaitSync', args: [mock.created[0], 0, 0] },
  ]);
  assert.equal(mock.calls.filter((call) => call.name === 'flush').length, 1);
  assert.equal(mock.created.length, 1);
  assert.deepEqual(mock.deleted, []);
  const countBeforeSnapshot = mock.calls.length;
  assert.deepEqual(queue.diagnostics(50), {
    status: 'pending', failure: null, pendingMs: 40,
    lastCompletedPendingMs: null, completedFrameIntervalMs: null,
    submittedCount: 1, completedCount: 0, skippedCount: 2,
  });
  queue.diagnostics(60);
  assert.equal(mock.calls.length, countBeforeSnapshot, 'diagnostics do not touch GL');
});

for (const result of ['ALREADY_SIGNALED', 'CONDITION_SATISFIED'] as const) {
  test(`${result} deletes the fence exactly once, permits another frame, and measures observed intervals`, () => {
    const mock = mockGL();
    const queue = new RenderQueue(mock.gl);
    queue.submit(10);
    assert.equal(queue.poll(20), 'pending');
    mock.setWaitResult(mock.gl[result]);
    assert.equal(queue.poll(30), 'ready');
    assert.deepEqual(mock.deleted, [mock.created[0]]);
    assert.equal(queue.diagnostics(35).lastCompletedPendingMs, 20);
    assert.equal(queue.diagnostics(35).completedFrameIntervalMs, null);
    assert.equal(queue.diagnostics(35).pendingMs, 0);
    assert.equal(queue.poll(36), 'ready');
    assert.equal(mock.deleted.length, 1);

    queue.submit(40);
    assert.equal(queue.poll(70), 'ready');
    assert.equal(queue.diagnostics(75).completedFrameIntervalMs, 40);
    assert.equal(queue.diagnostics(75).lastCompletedPendingMs, 30);
    assert.equal(queue.diagnostics(75).completedCount, 2);
    assert.equal(queue.diagnostics(75).submittedCount, 2);
    assert.equal(queue.diagnostics(75).skippedCount, 1);
    queue.reset();
    queue.dispose();
    assert.deepEqual(mock.deleted, mock.created);
  });
}

test('only pending time beyond 1000ms stalls; the same retained fence can later complete', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  queue.submit(25);
  assert.equal(queue.poll(1025), 'pending');
  assert.equal(queue.poll(1025.01), 'stalled');
  assert.equal(queue.poll(2500), 'stalled');
  assert.equal(queue.diagnostics(2500).pendingMs, 2475);
  assert.equal(queue.diagnostics(2500).skippedCount, 3);
  assert.equal(queue.diagnostics(2500).failure, null);
  assert.equal(mock.created.length, 1);
  assert.equal(mock.deleted.length, 0, 'stall does not discard uncompleted GPU work');
  mock.setWaitResult(mock.gl.ALREADY_SIGNALED);
  assert.equal(queue.poll(3000), 'ready');
  assert.equal(queue.diagnostics(3000).lastCompletedPendingMs, 2975);
  assert.deepEqual(mock.deleted, mock.created);
});

test('WAIT_FAILED is sticky, releases once, and cannot spin up a queue before explicit recovery', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  queue.submit(0);
  mock.setWaitResult(mock.gl.WAIT_FAILED);
  assert.equal(queue.poll(20), 'failed');
  assert.equal(queue.diagnostics(20).failure, 'wait-failed');
  assert.equal(queue.diagnostics(20).completedCount, 0);
  assert.deepEqual(mock.deleted, mock.created);
  const failedCallCount = mock.calls.length;
  queue.submit(30);
  assert.equal(queue.poll(40), 'failed');
  assert.equal(mock.calls.length, failedCallCount);

  // The owner is responsible for draining/rebuilding GL before this reset.
  queue.reset();
  assert.equal(queue.poll(50), 'ready');
  queue.submit(50);
  assert.equal(mock.created.length, 2);
  assert.equal(queue.diagnostics(50).submittedCount, 1, 'reset starts a measurement epoch');
  assert.equal(queue.diagnostics(50).failure, null);
});

test('null fence explicitly fails without repeated allocations or pretending the frame completed', () => {
  const mock = mockGL();
  mock.setNullFence();
  const queue = new RenderQueue(mock.gl);
  queue.submit(0);
  assert.equal(queue.poll(16), 'failed');
  assert.equal(queue.diagnostics(16).failure, 'fence-unavailable');
  assert.equal(queue.diagnostics(16).completedCount, 0);
  assert.equal(mock.calls.filter((call) => call.name === 'flush').length, 0);
  const failedCallCount = mock.calls.length;
  queue.submit(32);
  queue.poll(48);
  assert.equal(mock.calls.length, failedCallCount);
  queue.reset();
  assert.equal(mock.deleted.length, 0);
  mock.setNullFence(false);
  assert.equal(queue.poll(64), 'ready');
  queue.submit(64);
  assert.equal(mock.created.length, 1);
});

test('context loss while pending releases the fence and stays failed after restoration until reset', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  queue.submit(0);
  mock.setLost();
  assert.equal(queue.poll(16), 'failed');
  assert.equal(queue.diagnostics(16).failure, 'context-lost');
  assert.equal(mock.calls.filter((call) => call.name === 'clientWaitSync').length, 0);
  assert.deepEqual(mock.deleted, mock.created);
  mock.setLost(false);
  assert.equal(queue.poll(32), 'failed');
  queue.reset();
  assert.equal(queue.poll(48), 'ready');
  assert.equal(mock.deleted.length, 1);
});

test('context loss before first render or submission is exposed without allocating a fence', () => {
  for (const operation of ['poll', 'submit'] as const) {
    const mock = mockGL();
    const queue = new RenderQueue(mock.gl);
    mock.setLost();
    queue[operation](0);
    assert.equal(queue.diagnostics(0).failure, 'context-lost');
    assert.equal(mock.created.length, 0);
  }
});

test('duplicate submission cannot replace a pending fence or enqueue another one', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  queue.submit(0);
  queue.submit(16);
  assert.equal(queue.poll(32), 'failed');
  assert.equal(queue.diagnostics(32).failure, 'submission-pending');
  assert.equal(mock.created.length, 1);
  assert.deepEqual(mock.deleted, mock.created);
  assert.equal(mock.calls.filter((call) => call.name === 'flush').length, 1);
});

test('reset releases once and clears measurements; disposal is idempotent and cannot be revived', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  queue.submit(0);
  queue.poll(16);
  queue.reset();
  queue.reset();
  assert.deepEqual(mock.deleted, [mock.created[0]]);
  assert.deepEqual(queue.diagnostics(100), {
    status: 'ready', failure: null, pendingMs: 0,
    lastCompletedPendingMs: null, completedFrameIntervalMs: null,
    submittedCount: 0, completedCount: 0, skippedCount: 0,
  });
  queue.submit(120);
  queue.dispose();
  const disposedCallCount = mock.calls.length;
  queue.dispose();
  queue.reset();
  queue.submit(200);
  assert.equal(queue.poll(220), 'failed');
  assert.equal(queue.diagnostics(220).failure, 'disposed');
  assert.equal(mock.calls.length, disposedCallCount);
  assert.deepEqual(mock.deleted, mock.created);
});

for (const operation of ['fenceSync', 'flush', 'clientWaitSync', 'deleteSync']) {
  test(`${operation} exception is an explicit sticky failure with no duplicate release`, () => {
    const mock = mockGL();
    const queue = new RenderQueue(mock.gl);
    if (operation === 'fenceSync' || operation === 'flush') {
      mock.setThrowOn(operation);
      queue.submit(0);
    } else {
      queue.submit(0);
      mock.setThrowOn(operation);
      mock.setWaitResult(mock.gl.ALREADY_SIGNALED);
      queue.poll(16);
    }
    assert.equal(queue.diagnostics(20).failure, 'api-error');
    const failedCallCount = mock.calls.length;
    queue.poll(30);
    queue.submit(40);
    assert.equal(mock.calls.length, failedCallCount);
    queue.reset();
    queue.dispose();
    assert.deepEqual(mock.deleted, mock.created);
  });
}

test('unexpected wait status fails instead of reporting readiness or silently stalling forever', () => {
  const mock = mockGL();
  const queue = new RenderQueue(mock.gl);
  queue.submit(0);
  mock.setWaitResult(0);
  assert.equal(queue.poll(16), 'failed');
  assert.equal(queue.diagnostics(16).failure, 'wait-failed');
  assert.equal(queue.diagnostics(16).completedCount, 0);
  assert.deepEqual(mock.deleted, mock.created);
});
