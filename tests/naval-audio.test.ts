import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { FlightAudio, type WorldAudioCategory } from '../src/audio';
import type { Aircraft, GameEvent } from '../src/types';

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

class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam();
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
  loop = false;
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
  static instances = 0;
  failPanner = false;
  failBufferAfter = Infinity;

  state: AudioContextState = 'suspended';
  currentTime = 0;
  readonly sampleRate = 44100;
  readonly destination = new FakeAudioNode();
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];

  constructor() {
    FakeAudioContext.latest = this;
    FakeAudioContext.instances++;
  }

  createStereoPanner(): FakeStereoPannerNode {
    if (this.failPanner) throw new Error('panner creation failed');
    const node = new FakeStereoPannerNode();
    this.panners.push(node);
    return node;
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
    if (this.bufferSources.length >= this.failBufferAfter) throw new Error('buffer source creation failed');
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

function aircraft(id = 1, x = 0, y = 0, z = 0): Aircraft {
  return { id, position: new Vector3(x, y, z), quaternion: new Quaternion(), health: 80, speed: 110, age: 0 } as Aircraft;
}

function event(id: number, position = new Vector3(), extra: Partial<GameEvent> = {}): GameEvent {
  return { id, type: 'shot', owner: 100, tick: 1, mountId: 'port-1', detail: 'light-aa', position, ...extra };
}

interface InspectedVoice {
  type: string;
  ended: boolean;
  sources: Set<FakeScheduledSource>;
  nodes: Set<FakeAudioNode>;
  spatial: { pan: FakeStereoPannerNode; gain: FakeGainNode; filter: FakeBiquadFilterNode };
}

function voices(audio: FlightAudio): InspectedVoice[] {
  return Array.from(Reflect.get(audio, 'voices') as Set<InspectedVoice>);
}

function latestVoice(audio: FlightAudio): InspectedVoice {
  const voice = voices(audio).at(-1);
  assert.ok(voice);
  return voice;
}

function passStateCount(audio: FlightAudio): number {
  return (Reflect.get(audio, 'passes') as Map<number, unknown>).size;
}

function actualEffects(audio: FlightAudio, context: FakeAudioContext): FakeScheduledSource[] {
  const engine = Reflect.get(audio, 'engine') as FakeOscillatorNode[];
  return [...context.bufferSources, ...context.oscillators.filter(node => !engine.includes(node))]
    .filter(node => node.startAt !== null && !node.ended && node.stopAt !== null && node.stopAt > context.currentTime);
}

function paramLast(param: FakeAudioParam): number {
  return param.events.at(-1)!.value;
}

test('world audio pans in listener-local horizontal space, including heading changes and overhead sources', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    audio.worldEvent(event(1, new Vector3(100, 0, 0)), player, 'naval-shot');
    assert.equal(latestVoice(audio).spatial.pan.pan.value, 1);
    audio.worldEvent(event(2, new Vector3(-100, 0, 0), { mountId: 'starboard-1' }), player, 'naval-shot');
    assert.equal(latestVoice(audio).spatial.pan.pan.value, -1);
    audio.worldEvent(event(3, new Vector3(0, 100, 0), { mountId: 'overhead' }), player, 'naval-shot');
    assert.equal(latestVoice(audio).spatial.pan.pan.value, 0);
    player.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    audio.worldEvent(event(4, new Vector3(0, 0, -100), { mountId: 'rotated' }), player, 'naval-shot');
    assert.ok(latestVoice(audio).spatial.pan.pan.value > 0.999, 'world forward moves to the right ear when the player faces west');
    assert.ok(context.panners.every(node => node.connections[0] === context.gains[0]), 'spatial output joins the established master');
  } finally { audio.dispose(); restore(); }
});

test('world distance reduces gain and bandwidth, stays finite nearby, and culls remote or invalid positions', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    audio.worldEvent(event(1), player, 'naval-shot');
    const near = latestVoice(audio).spatial;
    audio.worldEvent(event(2, new Vector3(1600, 0, 0), { mountId: 'far' }), player, 'naval-shot');
    const far = latestVoice(audio).spatial;
    assert.equal(near.gain.gain.value, 1);
    assert.equal(near.filter.frequency.value, 12000);
    assert.ok(far.gain.gain.value > 0 && far.gain.gain.value < 0.06);
    assert.ok(far.filter.frequency.value >= 650 && far.filter.frequency.value < near.filter.frequency.value / 3);
    assert.ok(far.filter.connections.includes(far.gain));
    assert.ok(far.gain.connections.includes(far.pan));
    audio.worldEvent(event(3, new Vector3(3201, 0, 0), { mountId: 'culled' }), player, 'naval-shot');
    audio.worldEvent(event(4, new Vector3(NaN, 0, 0), { mountId: 'invalid' }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 2);
    assert.equal(context.panners.length, 2, 'inaudible positions allocate no graph');
    for (const voice of voices(audio)) {
      const { gain, filter, pan } = voice.spatial;
      assert.ok([gain.gain.value, filter.frequency.value, pan.pan.value].every(Number.isFinite));
    }
  } finally { audio.dispose(); restore(); }
});

test('same-mount salvos group by owner and tick with bounded repeat rate and shared generic-event dedupe', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const first = event(1);
    audio.worldEvent(first, player, 'naval-shot');
    audio.worldEvent(event(2), player, 'naval-shot');
    audio.event(first, true);
    assert.equal(audio.activeEffectSourceCount, 1, 'two barrels and a duplicate generic route produce one report');
    audio.worldEvent(event(3, undefined, { mountId: 'port-2' }), player, 'naval-shot');
    audio.worldEvent(event(4, undefined, { owner: 101 }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 3, 'other actual mounts/ships remain independent');
    context.currentTime = 0.03;
    audio.worldEvent(event(5, undefined, { tick: 2 }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 3);
    context.currentTime = 0.08;
    audio.worldEvent(event(6, undefined, { tick: 3 }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 4);
    context.currentTime = 0.2;
    audio.worldEvent(event(7, undefined, { tick: 3 }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 4, 'the same salvo cannot replay just because audio time advanced');
    audio.event(event(8), true);
    audio.worldEvent(event(8), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 5, 'dedupe also holds when generic was called first');
    for (let id = 20; id < 400; id++) audio.worldEvent(event(id, undefined, { mountId: `mount-${id}` }), player, 'naval-shot');
    assert.equal((Reflect.get(audio, 'mountReports') as Map<string, unknown>).size, 128);
    assert.equal((Reflect.get(audio, 'seenEventIds') as Set<number>).size, 256);
    assert.equal(audio.activeEffectSourceCount, 7);
  } finally { audio.dispose(); restore(); }
});

test('light/heavy gunfire, metal, water, ship and ordnance voices use distinct finite source bands and envelopes', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const cases: { category: WorldAudioCategory; extra?: Partial<GameEvent>; count: number; band: number; end: number }[] = [
      { category: 'naval-shot', count: 1, band: 2350, end: 0.1 },
      { category: 'naval-shot', extra: { detail: 'heavy-aa' }, count: 2, band: 620, end: 0.32 },
      { category: 'metal-hit', count: 2, band: 2600, end: 0.24 },
      { category: 'splash', count: 1, band: 880, end: 0.48 },
      { category: 'ship-explosion', count: 3, band: 190, end: 1.0 },
      { category: 'ordnance-impact', extra: { weapon: 'torpedo' }, count: 2, band: 420, end: 0.52 },
      { category: 'ordnance-impact', extra: { weapon: 'bomb' }, count: 2, band: 950, end: 0.52 },
    ];
    for (const [index, sample] of cases.entries()) {
      const filterCount = context.filters.length;
      const now = context.currentTime;
      audio.worldEvent(event(index + 1, undefined, { tick: index + 1, ...sample.extra }), player, sample.category);
      assert.equal(audio.activeEffectSourceCount, sample.count, sample.category);
      assert.equal(context.filters[filterCount + 1].frequency.value, sample.band);
      const sources = [...latestVoice(audio).sources];
      assert.ok(Math.abs(Math.max(...sources.map(source => source.stopAt!)) - now - sample.end) < 1e-8);
      assert.ok(sources.every(source => source.startAt === now));
      for (const node of latestVoice(audio).nodes) {
        if (node instanceof FakeGainNode && node !== latestVoice(audio).spatial.gain) {
          assert.ok(node.gain.events.some(value => value.type === 'linear' && value.value > 0));
          assert.ok(node.gain.events.filter(value => value.type === 'exponential').every(value => value.value > 0));
        }
      }
      context.advance(1.1);
      assert.equal(audio.activeEffectSourceCount, 0);
      assert.equal(audio.activeEffectVoiceCount, 0);
    }
  } finally { audio.dispose(); restore(); }
});

test('all world voices share the existing ten-source cap and keep three slots and eviction priority for player damage', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    for (let id = 1; id <= 20; id++) audio.worldEvent(event(id, undefined, { mountId: `mount-${id}` }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 7);
    assert.equal(actualEffects(audio, context).length, 7);
    audio.event(event(21, undefined, { type: 'damage' }), true);
    assert.equal(audio.activeEffectSourceCount, 10);
    assert.equal(actualEffects(audio, context).length, 10);
    const damage = latestVoice(audio);
    audio.worldEvent(event(22), player, 'ship-explosion');
    assert.equal(audio.activeEffectSourceCount, 7);
    assert.equal(actualEffects(audio, context).length, 7);
    assert.equal(damage.ended, false, 'naval blast can replace lesser effects but never damage');
    audio.event(event(23, undefined, { type: 'kill' }), false);
    assert.equal(audio.activeEffectSourceCount, 8);
    assert.equal(actualEffects(audio, context).length, 8);
    assert.ok(voices(audio).every(voice => ['damage', 'playerExplosion'].includes(voice.type)));
    for (let id = 24; id < 80; id++) audio.worldEvent(event(id, undefined, { mountId: `mount-${id}`, detail: 'heavy-aa' }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 8, 'lesser effects cannot evict either critical cue');
  } finally { audio.dispose(); restore(); }
});

test('pass cues require actual approach, track real pan and Doppler through recession, and have finite per-aircraft cooldown', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const passing = aircraft(2, 50, 0, -170);
    audio.updatePasses([player, passing], player, 0);
    audio.updatePasses([player, passing], player, 0.1);
    assert.equal(audio.activeEffectSourceCount, 0, 'nearby stationary formation aircraft do not fake a pass');
    passing.position.z = -140;
    context.currentTime = 0.2;
    audio.updatePasses([passing], player, 0.2);
    assert.equal(audio.activeEffectSourceCount, 2);
    const voice = latestVoice(audio);
    const tone = [...voice.sources].find(source => source instanceof FakeOscillatorNode) as FakeOscillatorNode;
    const approachPitch = paramLast(tone.frequency);
    assert.ok(approachPitch > 70 + passing.speed * 0.35);
    assert.ok(paramLast(voice.spatial.pan.pan) > 0);
    passing.position.set(-50, 0, 170);
    context.currentTime = 0.3;
    audio.updatePasses([passing], player, 0.3);
    assert.ok(paramLast(tone.frequency) < 70 + passing.speed * 0.35, 'recession lowers actual pass pitch');
    assert.ok(paramLast(voice.spatial.pan.pan) < 0, 'pan follows the moving entity');
    context.advance(1.5);
    assert.equal(audio.activeEffectSourceCount, 0);
    for (let tick = 18; tick <= 42; tick++) {
      context.currentTime = tick / 10;
      passing.position.z = tick % 2 ? -140 : -170;
      audio.updatePasses([passing], player, tick / 10);
    }
    assert.equal(context.panners.length, 1, 'repeat approach inside four seconds creates no new pass');
    passing.position.z = -140;
    context.currentTime = 4.3;
    audio.updatePasses([passing], player, 4.3);
    assert.equal(context.panners.length, 2, 'a later real approach can sound again');
    assert.equal(audio.activeEffectSourceCount, 2);
  } finally { audio.dispose(); restore(); }
});

test('pass tracking excludes dead/self aircraft, limits active voices and state, and removes replaced entities', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const fleet = Array.from({ length: 50 }, (_, i) => aircraft(i + 2, 0, 0, -180 - i));
    audio.updatePasses([player, ...fleet], player, 0);
    assert.equal(passStateCount(audio), 32);
    fleet.forEach(entity => entity.position.z += 40);
    context.currentTime = 0.1;
    audio.updatePasses([player, ...fleet], player, 0.1);
    assert.equal(audio.activeEffectVoiceCount, 1, 'the global 300ms pass interval limits same-frame clusters');
    for (const tick of [4, 8]) {
      context.currentTime = tick / 10;
      fleet.forEach(entity => entity.position.z += 20);
      audio.updatePasses(fleet, player, tick / 10);
    }
    assert.equal(audio.activeEffectVoiceCount, 2);
    assert.equal(audio.activeEffectSourceCount, 4);
    assert.equal(actualEffects(audio, context).length, 4);
    fleet.forEach(entity => { entity.health = 0; });
    audio.updatePasses([player, ...fleet], player, 0.9);
    assert.equal(passStateCount(audio), 0);
    assert.equal(audio.activeEffectSourceCount, 0, 'death immediately cancels pass tails');
    const respawn = aircraft(99, 0, 0, -120);
    audio.updatePasses([respawn], player, 1);
    assert.equal(audio.activeEffectSourceCount, 0, 'a respawn gets a new motion baseline');
    respawn.position.z = -100;
    context.currentTime = 1.1;
    audio.updatePasses([respawn], player, 1.1);
    assert.equal(audio.activeEffectSourceCount, 2);
    audio.updatePasses([], player, 1.2);
    assert.equal(passStateCount(audio), 0);
    assert.equal(audio.activeEffectSourceCount, 0);
  } finally { audio.dispose(); restore(); }
});

test('mute, pause, reset and disposal cancel world/pass sources and old callbacks cannot touch a new flight', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const passing = aircraft(2, 0, 0, -180);
    const start = (id: number, elapsed: number) => {
      passing.position.z = -180;
      audio.updatePasses([passing], player, elapsed);
      passing.position.z = -150;
      context.currentTime = elapsed + 0.1;
      audio.updatePasses([passing], player, elapsed + 0.1);
      audio.worldEvent(event(id), player, 'ship-explosion');
    };
    start(1, 0);
    const staleCallbacks = voices(audio).flatMap(voice => [...voice.sources].map(source => source.onended!));
    const oldNodes = voices(audio).flatMap(voice => [...voice.nodes]);
    audio.enabled = false;
    audio.sync();
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(actualEffects(audio, context).length, 0);
    assert.equal(passStateCount(audio), 0);
    assert.ok(oldNodes.every(node => node.disconnectCount > 0));
    audio.worldEvent(event(2), player, 'ship-explosion');
    audio.enabled = true;
    audio.sync();
    audio.worldEvent(event(2), player, 'ship-explosion');
    assert.equal(audio.activeEffectSourceCount, 0, 'events received while muted never replay');
    start(3, 1);
    audio.active = false;
    audio.sync();
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(passStateCount(audio), 0);
    audio.active = true;
    audio.sync();
    start(4, 2);
    audio.resetFlight();
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(passStateCount(audio), 0);
    audio.active = true;
    audio.sync();
    audio.worldEvent(event(1), player, 'ship-explosion');
    assert.equal(audio.activeEffectSourceCount, 3, 'reset releases the ID window');
    staleCallbacks.forEach(callback => callback());
    assert.equal(audio.activeEffectSourceCount, 3, 'stale onended callbacks cannot retire new sources');
    audio.dispose();
    assert.equal(actualEffects(audio, context).length, 0);
    assert.equal(audio.activeEffectVoiceCount, 0);
    assert.equal(context.state, 'closed');
  } finally { audio.dispose(); restore(); }
});

test('rewound time, same-ID respawn and missing pass updates discard old motion without replaying a tail', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const passing = aircraft(2, 0, 0, -170);
    passing.age = 10;
    audio.updatePasses([passing], player, 10);
    passing.position.z = -140;
    context.currentTime = 0.1;
    audio.updatePasses([passing], player, 10.1);
    assert.equal(audio.activeEffectSourceCount, 2);
    passing.age = 0;
    audio.updatePasses([passing], player, 10.2);
    assert.equal(audio.activeEffectSourceCount, 0);
    audio.updatePasses([passing], player, 0);
    assert.equal(audio.activeEffectSourceCount, 0);
    passing.position.z = -10;
    audio.updatePasses([passing], player, 2);
    assert.equal(audio.activeEffectSourceCount, 0, 'an unobserved gap cannot synthesize a historic flyby');
  } finally { audio.dispose(); restore(); }
});

test('flight finish stops live passes immediately and lets the final ship blast end within the existing finish tail', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    const passing = aircraft(2, 0, 0, -180);
    audio.updatePasses([passing], player, 0);
    passing.position.z = -150;
    context.currentTime = 0.1;
    audio.updatePasses([passing], player, 0.1);
    audio.worldEvent(event(1), player, 'ship-explosion');
    assert.equal(audio.activeEffectSourceCount, 5);
    audio.finishFlight();
    assert.equal(audio.activeEffectSourceCount, 3);
    assert.equal(passStateCount(audio), 0);
    audio.updatePasses([passing], player, 0.2);
    audio.worldEvent(event(2), player, 'metal-hit');
    assert.equal(audio.activeEffectSourceCount, 3, 'finished flights reject new environmental cues');
    context.advance(1);
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(actualEffects(audio, context).length, 0);
    assert.ok(context.gains[0].gain.events.some(value => value.type === 'linear' && value.value === 0 && Math.abs(value.time - 1.15) < 1e-8));
  } finally { audio.dispose(); restore(); }
});

test('a partially built multi-source voice is fully stopped and disconnected on failure', async () => {
  const { audio, context, restore } = await createFixture();
  try {
    context.failBufferAfter = 1;
    audio.worldEvent(event(1), aircraft(), 'ship-explosion');
    assert.equal(context.bufferSources.length, 1);
    assert.equal(context.bufferSources[0].stopAt, 0);
    assert.equal(context.bufferSources[0].onended, null);
    assert.ok(context.bufferSources[0].disconnectCount > 0);
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(audio.activeEffectVoiceCount, 0);
    assert.equal(actualEffects(audio, context).length, 0);
    context.failBufferAfter = Infinity;
    audio.worldEvent(event(2), aircraft(), 'ship-explosion');
    assert.equal(audio.activeEffectSourceCount, 3, 'a later real event can recover in the same context');
  } finally { audio.dispose(); restore(); }
});

test('graph creation failures clean up, resumed promises honor mute, and existing engine/master/player envelopes remain fixed', async () => {
  const instanceCount = FakeAudioContext.instances;
  const { audio, context, restore } = await createFixture();
  try {
    const player = aircraft();
    context.failPanner = true;
    audio.worldEvent(event(1), player, 'ship-explosion');
    assert.equal(audio.activeEffectVoiceCount, 0);
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.ok(context.filters.at(-1)!.disconnectCount > 0);
    context.failPanner = false;
    audio.worldEvent(event(2, undefined, { tick: 2 }), player, 'naval-shot');
    assert.equal(audio.activeEffectSourceCount, 1);
    assert.equal(FakeAudioContext.instances, instanceCount + 1, 'world/pass work never creates a second context');
    assert.ok(context.gains[0].gain.events.some(value => value.type.startsWith('target') && value.value === 0.6));
    assert.ok(context.gains[1].gain.events.some(value => value.type.startsWith('target') && value.value === 0.0475));
    audio.event(event(3, undefined, { type: 'shot' }), true);
    assert.ok(context.gains.at(-1)!.gain.events.some(value => value.type === 'linear' && value.value === 0.07));
    audio.event(event(4, undefined, { type: 'hit' }), true);
    assert.ok(context.gains.at(-1)!.gain.events.some(value => value.type === 'linear' && value.value === 0.16));
    audio.event(event(5, undefined, { type: 'damage' }), true);
    assert.deepEqual(context.gains.slice(-3).map(gain => gain.gain.events.find(value => value.type === 'linear')?.value), [0.18, 0.11, 0.08]);
    let resume!: () => void;
    context.state = 'suspended';
    context.resume = () => new Promise<void>(resolve => { resume = () => { context.state = 'running'; resolve(); }; });
    const pending = audio.unlock();
    audio.enabled = false;
    audio.sync();
    resume();
    await pending;
    assert.equal(audio.activeEffectSourceCount, 0);
    assert.equal(actualEffects(audio, context).length, 0);
    assert.equal(paramLast(context.gains[0].gain), 0);
  } finally { audio.dispose(); restore(); }
});
