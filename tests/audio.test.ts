import assert from 'node:assert/strict';
import test from 'node:test';
import { FlightAudio } from '../src/audio';
import type { GameEvent } from '../src/types';

interface ParamEvent {
  type: string;
  value: number;
  time: number;
}

class FakeAudioParam {
  value = 0;
  readonly events: ParamEvent[] = [];

  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.events.push({ type: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'exponential', value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number, constant: number): this {
    this.events.push({ type: `target:${constant}`, value, time });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', value: this.value, time });
    return this;
  }
}

class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  disconnectCount = 0;

  connect(destination: FakeAudioNode): FakeAudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  readonly frequency = new FakeAudioParam();
}

abstract class FakeScheduledSource extends FakeAudioNode {
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  readonly stopCalls: number[] = [];
  ended = false;

  start(when = 0): void {
    this.startAt = when;
  }

  stop(when = 0): void {
    this.stopAt = when;
    this.stopCalls.push(when);
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.onended?.();
  }
}

class FakeOscillatorNode extends FakeScheduledSource {
  type = 'sine';
  readonly frequency = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeScheduledSource {
  buffer: FakeAudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam();
}

class FakeAudioBuffer {
  private readonly channel: Float32Array;

  constructor(length: number) {
    this.channel = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.channel;
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;

  state: AudioContextState = 'suspended';
  currentTime = 0;
  readonly sampleRate = 44100;
  readonly destination = new FakeAudioNode();
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly gains: FakeGainNode[] = [];

  constructor() {
    FakeAudioContext.latest = this;
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  createBuffer(_channels: number, length: number): FakeAudioBuffer {
    return new FakeAudioBuffer(length);
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const source of [...this.oscillators, ...this.bufferSources]) {
      if (source.stopAt !== null && source.stopAt <= this.currentTime) source.finish();
    }
  }
}

function installFakeAudioContext(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: FakeAudioContext,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  };
}

async function createFixture(): Promise<{
  audio: FlightAudio;
  context: FakeAudioContext;
  restore: () => void;
}> {
  const restore = installFakeAudioContext();
  const audio = new FlightAudio();
  audio.active = true;
  await audio.unlock();
  const context = FakeAudioContext.latest;
  assert.ok(context);
  return { audio, context, restore };
}

function gameEvent(id: number, type: GameEvent['type'], owner = 1): GameEvent {
  return { id, type, position: {} as GameEvent['position'], owner };
}

function rememberedIds(audio: FlightAudio): Set<number> {
  return Reflect.get(audio, 'seenEventIds') as Set<number>;
}

test('enemy-owned non-kill effects stay silent while a player death explosion is routed; duplicate IDs do not replay', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const eventTypes: GameEvent['type'][] = ['shot', 'hit', 'kill', 'damage', 'loop'];
    eventTypes.forEach((type, index) => audio.event(gameEvent(index + 1, type, 2), false));
    assert.equal(audio.activeEffectSourceCount, 5, 'only the enemy-owned kill routes to the five-layer player explosion');

    const hit = gameEvent(10, 'hit');
    audio.event(hit, true);
    audio.event(hit, true);
    assert.equal(audio.activeEffectSourceCount, 6);
    assert.equal(context.oscillators.filter(node => node.startAt === 0).length, 3);
  } finally {
    audio.dispose();
    restore();
  }
});

test('shot and hit voices respect their separate minimum intervals', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    audio.event(gameEvent(1, 'shot'), true);
    context.currentTime = 0.02;
    audio.event(gameEvent(2, 'shot'), true);
    assert.equal(audio.activeEffectSourceCount, 1, 'shots inside 35 ms are suppressed');
    context.currentTime = 0.036;
    audio.event(gameEvent(3, 'shot'), true);
    assert.equal(audio.activeEffectSourceCount, 2);

    audio.event(gameEvent(4, 'hit'), true);
    assert.equal(audio.activeEffectSourceCount, 3);
    context.currentTime = 0.08;
    audio.event(gameEvent(5, 'hit'), true);
    assert.equal(audio.activeEffectSourceCount, 3, 'hits inside 45 ms are suppressed');
    context.currentTime = 0.086;
    audio.event(gameEvent(6, 'hit'), true);
    assert.equal(audio.activeEffectSourceCount, 4);
  } finally {
    audio.dispose();
    restore();
  }
});

test('enemy hit and explosion keep established pulses; player death uses layered blast and finish tail', async () => {
  const hitFixture = await createFixture();
  try {
    hitFixture.audio.event(gameEvent(1, 'hit'), true);
    const source = hitFixture.context.bufferSources.at(-1);
    const envelope = hitFixture.context.gains.at(-1)?.gain.events;
    assert.ok(source);
    assert.equal(hitFixture.context.filters.at(-1)?.frequency.value, 1000);
    assert.equal(source.playbackRate.value, 1.3);
    assert.equal(source.startAt, 0);
    assert.equal(source.stopAt, 0.14);
    assert.deepEqual(envelope?.map(event => [event.type, event.value, event.time]), [
      ['set', 0.0001, 0],
      ['linear', 0.16, 0.004],
      ['exponential', 0.0001, 0.12],
    ]);
    assert.equal(hitFixture.audio.activeEffectSourceCount, 1);
    assert.equal(hitFixture.context.oscillators.length, 3, 'the restored noise hit adds no tonal oscillators');
  } finally {
    hitFixture.audio.dispose();
    hitFixture.restore();
  }

  const killFixture = await createFixture();
  try {
    killFixture.audio.event(gameEvent(2, 'kill'), true);
    const explosion = killFixture.context.bufferSources.at(-1);
    const envelope = killFixture.context.gains.at(-1)?.gain.events;
    assert.ok(explosion);
    assert.equal(killFixture.context.filters.at(-1)?.frequency.value, 550);
    assert.equal(explosion.playbackRate.value, 0.65);
    assert.equal(explosion.startAt, 0);
    assert.equal(explosion.stopAt, 0.4);
    assert.deepEqual(envelope?.map(event => [event.type, event.value, event.time]), [
      ['set', 0.0001, 0],
      ['linear', 0.16, 0.004],
      ['exponential', 0.0001, 0.38],
    ]);
  } finally {
    killFixture.audio.dispose();
    killFixture.restore();
  }

  const deathFixture = await createFixture();
  try {
    deathFixture.audio.event(gameEvent(3, 'kill', 2), false);
    const debris = deathFixture.context.bufferSources.slice(-5);
    assert.equal(deathFixture.audio.activeEffectSourceCount, 5);
    assert.deepEqual(debris.map(source => source.startAt), [0, 0, 0.18, 0.45, 0.72]);
    assert.deepEqual(debris.map(source => source.stopAt), [0.06, 0.84, 0.35, 0.62, 0.95]);
    assert.deepEqual(deathFixture.context.filters.slice(-5).map(filter => [filter.type, filter.frequency.value]), [
      ['highpass', 1500],
      ['lowpass', 260],
      ['bandpass', 1300],
      ['bandpass', 1900],
      ['lowpass', 760],
    ]);
    assert.deepEqual(deathFixture.context.gains.slice(-5).map(gain =>
      gain.gain.events.find(event => event.type === 'linear')?.value,
    ), [0.24, 0.22, 0.11, 0.085, 0.06]);

    assert.equal(deathFixture.audio.active, true, 'the game remains active until the owning finish transition');
    deathFixture.audio.finishFlight();
    assert.equal(deathFixture.audio.active, false);
    assert.equal(deathFixture.audio.activeEffectSourceCount, 5, 'the scheduled death explosion survives flight finish');
    assert.ok(deathFixture.context.gains[0].gain.events.some(event =>
      event.type === 'linear' && event.value === 0 && event.time === 1.05,
    ));
    deathFixture.context.advance(0.95);
    assert.equal(deathFixture.audio.activeEffectSourceCount, 0);
    assert.equal(deathFixture.audio.activeEffectVoiceCount, 0);
  } finally {
    deathFixture.audio.dispose();
    deathFixture.restore();
  }

  const damageFixture = await createFixture();
  try {
    damageFixture.audio.event(gameEvent(4, 'damage'), true);
    const impacts = damageFixture.context.bufferSources.slice(-2);
    const airframe = damageFixture.context.oscillators.at(-1);
    assert.equal(damageFixture.audio.activeEffectSourceCount, 3);
    assert.deepEqual(damageFixture.context.filters.slice(-2).map(filter => [filter.type, filter.frequency.value]), [
      ['highpass', 1900],
      ['lowpass', 520],
    ]);
    assert.deepEqual(impacts.map(source => source.stopAt), [0.055, 0.21]);
    assert.deepEqual(damageFixture.context.gains.slice(-3).map(gain =>
      gain.gain.events.find(event => event.type === 'linear')?.value,
    ), [0.18, 0.11, 0.08]);
    assert.ok(airframe);
    assert.equal(airframe.frequency.value, 190);
    assert.ok(airframe.frequency.events.some(event => event.type === 'exponential' && event.value === 100));
    assert.equal(airframe.stopAt, 0.22);
    assert.equal(damageFixture.context.oscillators.some(node => [410, 660].includes(node.frequency.value)), false);
  } finally {
    damageFixture.audio.dispose();
    damageFixture.restore();
  }
});

test('effect sources stay bounded, reserve three slots for damage, and rate-limit repeats', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    for (let id = 1; id <= 7; id++) audio.event(gameEvent(id, 'kill'), true);
    assert.equal(audio.activeEffectSourceCount, 7);

    audio.event(gameEvent(20, 'shot'), true);
    assert.equal(audio.activeEffectSourceCount, 7, 'low-priority effects cannot consume the damage reserve');

    audio.event(gameEvent(21, 'damage'), true);
    assert.equal(audio.activeEffectSourceCount, 10);
    const firstDamageCount = audio.activeEffectSourceCount;

    audio.event(gameEvent(22, 'damage'), true);
    assert.equal(audio.activeEffectSourceCount, firstDamageCount, 'damage events inside 110 ms are suppressed');

    context.currentTime = 0.13;
    audio.event(gameEvent(23, 'damage'), true);
    assert.equal(audio.activeEffectSourceCount, 10);
    assert.ok(
      context.bufferSources.filter(node => node.stopCalls.length > 1).length >= 3,
      'a high-priority damage cue retires lower-priority kill voices when the cap is full',
    );

    for (let id = 100; id < 400; id++) audio.event(gameEvent(id, 'kill'), true);
    assert.equal(audio.activeEffectSourceCount, 10);
    assert.equal(rememberedIds(audio).size, 256);

    const stoppedBeforeSelfExplosion = [...context.bufferSources, ...context.oscillators]
      .filter(node => node.stopCalls.length > 1).length;
    audio.event(gameEvent(24, 'kill', 2), false);
    assert.equal(audio.activeEffectSourceCount, 8, 'a fatal player explosion evicts damage voices before being suppressed');
    const stoppedAfterSelfExplosion = [...context.bufferSources, ...context.oscillators]
      .filter(node => node.stopCalls.length > 1).length;
    assert.ok(stoppedAfterSelfExplosion - stoppedBeforeSelfExplosion >= 7, 'the self-explosion retires four kill sources and one three-source damage voice');

    audio.event(gameEvent(25, 'kill', 2), false);
    audio.event(gameEvent(26, 'kill', 2), false);
    assert.equal(audio.activeEffectSourceCount, 10, 'repeated explosions never exceed the global source cap');
  } finally {
    audio.dispose();
    restore();
  }
});

test('mute stops active sounds immediately, while finish lets the final damage decay and cleans up', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    audio.event(gameEvent(1, 'kill', 2), false);
    const delayedExplosionSources = context.bufferSources.slice(-5);
    assert.equal(audio.activeEffectSourceCount, 5);
    audio.enabled = false;
    audio.sync();
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.ok(delayedExplosionSources.every(source => source.stopAt === context.currentTime), 'mute cancels even debris scheduled in the future');
    assert.equal(context.oscillators.slice(0, 3).every(node => node.stopAt === context.currentTime), true);

    audio.enabled = true;
    await audio.unlock();
    audio.event(gameEvent(2, 'damage'), true);
    assert.equal(audio.activeEffectSourceCount, 3);
    audio.finishFlight();
    assert.equal(audio.activeEffectSourceCount, 3, 'finish does not cut off the scheduled damage cue');
    assert.equal(audio.active, false);
    assert.equal(context.oscillators.slice(0, 3).every(node => node.stopAt === context.currentTime), true);
    assert.ok(context.gains[0].gain.events.some(event => event.type === 'linear' && event.value === 0 && event.time === 1.05));

    audio.event(gameEvent(3, 'hit'), true);
    assert.equal(audio.activeEffectSourceCount, 3, 'finished flight rejects new sounds');
    context.advance(0.23);
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(audio.activeEffectVoiceCount, 0);
  } finally {
    audio.dispose();
    restore();
  }
});

test('event dedupe is bounded and a new flight resets the event ID window', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    for (let id = 1; id <= 300; id++) audio.event(gameEvent(id, 'kill'), true);
    assert.equal(rememberedIds(audio).size, 256);
    audio.event(gameEvent(301, 'kill', 2), false);
    assert.equal(audio.activeEffectSourceCount, 10);

    const pendingExplosion = context.bufferSources.slice(-5);
    audio.resetFlight();
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.ok(pendingExplosion.every(source => source.stopAt === context.currentTime), 'new game reset clears delayed self-explosion sources');
    audio.active = true;
    audio.sync();
    audio.event(gameEvent(1, 'hit'), true);
    assert.equal(audio.activeEffectSourceCount, 1, 'IDs from a prior game cannot suppress a new game');
    assert.equal(context.state, 'running');

    audio.event(gameEvent(2, 'kill', 2), false);
    const finalExplosion = context.bufferSources.slice(-5);
    audio.dispose();
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.ok(finalExplosion.every(source => source.stopAt === context.currentTime), 'dispose stops delayed explosion sources');
  } finally {
    audio.dispose();
    restore();
  }
});

