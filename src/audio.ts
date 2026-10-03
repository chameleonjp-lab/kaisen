/** Proposed propeller-only level: half the previous amplitude, other voices unchanged. */
const PROPELLER_GAIN = 0.0475;
import type { Aircraft, GameEvent } from './types';

const MAX_EFFECT_SOURCES = 10;
const DAMAGE_SOURCE_RESERVE = 3;
const MAX_REMEMBERED_EVENTS = 256;
const NOISE_BUFFER_SECONDS = 1.2;
const PLAYER_EXPLOSION_DURATION_SECONDS = 0.95;
const FINISH_TAIL_SECONDS = PLAYER_EXPLOSION_DURATION_SECONDS + 0.1;
const KILL_TAIL_SECONDS = 0.4;
const MAX_REMEMBERED_MOUNTS = 128;
const MAX_PASS_AIRCRAFT = 32;
const MAX_PASS_VOICES = 2;
const WORLD_SOUND_RANGE = 3200;
const PASS_START_DISTANCE = 180;
const PASS_STOP_DISTANCE = 360;
const PASS_DURATION = 1.4;
const PASS_COOLDOWN = 4;

export type WorldAudioCategory = 'naval-shot' | 'metal-hit' | 'splash' | 'ship-explosion' | 'ordnance-impact';
type AudioListener = Pick<Aircraft, 'id' | 'position' | 'quaternion'>;
type EffectType = 'shot' | 'hit' | 'kill' | 'damage' | 'loop' | 'playerExplosion' | WorldAudioCategory | 'aircraft-pass';

interface SpatialMix {
  distance: number;
  pan: number;
  gain: number;
  cutoff: number;
}

interface PassState {
  x: number;
  y: number;
  z: number;
  distance: number;
  elapsed: number;
  age: number;
  lastStart: number;
  voice?: EffectVoice;
}

interface EffectVoice {
  type: EffectType;
  priority: number;
  sources: Set<AudioScheduledSourceNode>;
  nodes: Set<AudioNode>;
  ended: boolean;
  output?: AudioNode;
  spatial?: { gain: GainNode; filter: BiquadFilterNode; pan: StereoPannerNode };
  passNoise?: AudioBufferSourceNode;
  passTone?: OscillatorNode;
}

const EFFECT_PRIORITY: Record<EffectType, number> = {
  shot: 1,
  hit: 2,
  loop: 2,
  kill: 3,
  damage: 4,
  playerExplosion: 5,
  'naval-shot': 1,
  'metal-hit': 2,
  splash: 1,
  'ship-explosion': 3,
  'ordnance-impact': 3,
  'aircraft-pass': 1,
};

const RATE_LIMIT_SECONDS: Partial<Record<EffectType, number>> = {
  shot: 0.035,
  hit: 0.045,
  damage: 0.11,
  'metal-hit': 0.045,
  splash: 0.075,
  'ship-explosion': 0.14,
  'ordnance-impact': 0.09,
  'aircraft-pass': 0.3,
};

const SOUND_EFFECTS = new Set<GameEvent['type']>([
  'shot',
  'hit',
  'kill',
  'damage',
  'loop',
]);

/** Audio reads world facts only; it never consumes simulation randomness or changes entities. */
function spatialMix(position: GameEvent['position'], player: AudioListener): SpatialMix | null {
  const dx = position.x - player.position.x;
  const dy = position.y - player.position.y;
  const dz = position.z - player.position.z;
  const distance = Math.hypot(dx, dy, dz);
  const q = player.quaternion;
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(distance) || !Number.isFinite(norm) || norm < 0.00001) return null;
  const x = q.x / norm, y = q.y / norm, z = q.z / norm, w = q.w / norm;
  // Inverse listener rotation: +local X is the right ear; the aircraft nose is -local Z.
  const localX = (1 - 2 * (y * y + z * z)) * dx + 2 * (x * y + w * z) * dy + 2 * (x * z - w * y) * dz;
  const localZ = 2 * (x * z + w * y) * dx + 2 * (y * z - w * x) * dy + (1 - 2 * (x * x + y * y)) * dz;
  const horizontal = Math.hypot(localX, localZ);
  return {
    distance,
    pan: horizontal < 0.001 ? 0 : Math.max(-1, Math.min(1, localX / horizontal)),
    gain: 1 / (1 + Math.pow(distance / 180, 1.4)),
    cutoff: Math.max(650, Math.min(12000, 12000 / (1 + distance / 380))),
  };
}

export class FlightAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engine: OscillatorNode[] = [];
  private engineNodes: AudioNode[] = [];
  private sources = new Set<AudioScheduledSourceNode>();
  private voices = new Set<EffectVoice>();
  private noise: AudioBuffer | null = null;
  private seenEventIds = new Set<number>();
  private seenEventOrder: number[] = [];
  private lastEventAt = new Map<EffectType, number>();
  private unlockRequest: Promise<void> | null = null;
  private finishing = false;
  private mountReports = new Map<string, { tick: number | undefined; time: number }>();
  private passes = new Map<number, PassState>();
  private passElapsed: number | null = null;

  enabled = true;
  active = false;
  failed = false;

  get activeEffectSourceCount(): number {
    return this.sources.size;
  }

  get activeEffectVoiceCount(): number {
    return this.voices.size;
  }

  async unlock(): Promise<void> {
    if (!this.enabled) return;
    if (this.unlockRequest) return this.unlockRequest;

    const request = this.tryUnlock();
    this.unlockRequest = request;
    try {
      await request;
    } finally {
      if (this.unlockRequest === request) this.unlockRequest = null;
    }
  }

  private async tryUnlock(): Promise<void> {
    try {
      if (this.ctx?.state === 'closed') this.clearClosedContext();
      if (!this.ctx) this.createContext();
      const ctx = this.ctx;
      if (!ctx) return;

      await ctx.resume();
      if (ctx !== this.ctx) return;

      this.failed = ctx.state !== 'running';
      this.sync();
    } catch {
      this.failed = true;
    }
  }

  private createContext(): void {
    const ctx = new AudioContext();
    try {
      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);

      const engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      engineGain.connect(master);

      const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_BUFFER_SECONDS), ctx.sampleRate);
      const data = noise.getChannelData(0);
      let seed = 47;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        data[i] = (seed >>> 0) / 2147483648 - 1;
      }

      this.ctx = ctx;
      this.master = master;
      this.engineGain = engineGain;
      this.noise = noise;
    } catch (error) {
      void ctx.close().catch(() => undefined);
      throw error;
    }
  }

  private clearClosedContext(): void {
    this.stopAllEffects(0);
    this.stopEngine(0);
    this.ctx = null;
    this.master = null;
    this.engineGain = null;
    this.noise = null;
    this.finishing = false;
  }

  sync(): void {
    const ctx = this.ctx;
    const master = this.master;
    const engineGain = this.engineGain;
    if (!ctx || !master || !engineGain || ctx.state === 'closed') return;

    const now = ctx.currentTime;
    const shouldPlay = this.enabled && this.active && ctx.state === 'running';
    this.finishing = false;

    if (!shouldPlay) {
      this.stopAllEffects(now);
      this.stopEngine(now);
      engineGain.gain.cancelScheduledValues(now);
      engineGain.gain.setValueAtTime(0, now);
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(0, now);
      return;
    }

    this.ensureEngine(now);
    engineGain.gain.cancelScheduledValues(now);
    engineGain.gain.setTargetAtTime(PROPELLER_GAIN, now, 0.035);
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(0.6, now, 0.04);
  }

  update(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.engine.forEach((oscillator, index) => {
      oscillator.frequency.setTargetAtTime((40 + speed * 0.13) * (index + 1), ctx.currentTime, 0.15);
    });
  }

  event(event: GameEvent, playerEvent: boolean): void {
    if (!SOUND_EFFECTS.has(event.type) || (event.type !== 'kill' && !playerEvent)) return;
    if (!this.rememberEvent(event.id)) return;

    const type: EffectType = event.type === 'kill' && !playerEvent
      ? 'playerExplosion'
      : event.type as EffectType;
    const ctx = this.ctx;
    if (!this.enabled || !this.active || !ctx || ctx.state !== 'running' || !this.master) return;

    const now = ctx.currentTime;
    const rateLimit = RATE_LIMIT_SECONDS[type];
    const lastAt = this.lastEventAt.get(type);
    if (rateLimit !== undefined && lastAt !== undefined && now - lastAt < rateLimit) return;

    const sourceCost = this.sourceCost(type);
    if (!this.reserveCapacity(type, sourceCost, now)) return;

    const voice: EffectVoice = {
      type,
      priority: EFFECT_PRIORITY[type],
      sources: new Set(),
      nodes: new Set(),
      ended: false,
    };
    this.voices.add(voice);

    try {
      switch (type) {
        case 'shot':
          this.createNoisePulse(voice, now, 1800, 1.3, 0.07, 0.05, 0.07);
          break;
        case 'hit':
          this.createNoisePulse(voice, now, 1000, 1.3, 0.16, 0.12, 0.14);
          break;
        case 'kill':
          this.createNoisePulse(voice, now, 550, 0.65, 0.16, 0.38, KILL_TAIL_SECONDS);
          break;
        case 'damage':
          this.createPlayerDamageImpact(voice, now);
          break;
        case 'loop':
          this.createNoisePulse(voice, now, 1000, 1.3, 0.16, 0.12, 0.14);
          break;
        case 'playerExplosion':
          this.createPlayerExplosion(voice, now);
          break;
      }
      this.lastEventAt.set(type, now);
    } catch {
      this.retireVoice(voice, now);
    }
  }

  /** The caller classifies the actual shooter/target; an anonymous shot is never guessed to be naval. */
  worldEvent(event: GameEvent, player: AudioListener, category: WorldAudioCategory): void {
    if (!this.rememberEvent(event.id)) return;
    const ctx = this.ctx;
    if (!this.enabled || !this.active || !ctx || ctx.state !== 'running' || !this.master) return;
    const mix = spatialMix(event.position, player);
    if (!mix || mix.distance > WORLD_SOUND_RANGE) return;
    const now = ctx.currentTime;
    const heavy = event.detail === 'heavy-aa';
    if (category === 'naval-shot') {
      const key = `${event.owner}:${event.mountId ?? 'unknown'}`;
      const last = this.mountReports.get(key);
      // Several real barrels from one mount/tick form one report, without inventing extra shots.
      if (last && ((event.tick !== undefined && last.tick === event.tick)
        || now - last.time < (heavy ? 0.16 : 0.075))) return;
      this.mountReports.delete(key);
      this.mountReports.set(key, { tick: event.tick, time: now });
      if (this.mountReports.size > MAX_REMEMBERED_MOUNTS) {
        const oldest = this.mountReports.keys().next().value;
        if (oldest !== undefined) this.mountReports.delete(oldest);
      }
    } else {
      const last = this.lastEventAt.get(category);
      if (last !== undefined && now - last < (RATE_LIMIT_SECONDS[category] ?? 0)) return;
    }
    const cost = category === 'naval-shot' ? (heavy ? 2 : 1) : this.sourceCost(category);
    if (!this.reserveCapacity(category, cost, now)) return;
    const voice = this.newVoice(category);
    try {
      this.attachSpatial(voice, mix, now);
      switch (category) {
        case 'naval-shot':
          if (heavy) {
            this.createNoisePulse(voice, now, 620, 0.72, 0.18, 0.29, 0.32);
            this.createTonePulse(voice, now, 105, 48, 0.085, 0.27, 'triangle');
          } else {
            this.createNoisePulse(voice, now, 2350, 1.55, 0.095, 0.085, 0.1, 'bandpass', 0.002);
          }
          break;
        case 'metal-hit':
          this.createNoisePulse(voice, now, 2600, 1.65, 0.1, 0.06, 0.085, 'highpass', 0.001);
          this.createTonePulse(voice, now, 940, 620, 0.055, 0.22, 'triangle');
          break;
        case 'splash':
          this.createNoisePulse(voice, now, 880, 0.78, 0.13, 0.44, 0.48, 'bandpass', 0.035);
          break;
        case 'ship-explosion':
          this.createNoisePulse(voice, now, 190, 0.58, 0.21, 0.94, 1.0, 'lowpass', 0.012);
          this.createNoisePulse(voice, now, 1450, 1.1, 0.1, 0.19, 0.23, 'bandpass', 0.003);
          this.createTonePulse(voice, now, 74, 28, 0.12, 0.78, 'sine');
          break;
        case 'ordnance-impact':
          this.createNoisePulse(voice, now, event.weapon === 'torpedo' ? 420 : 950, 0.82, 0.18, 0.47, 0.52);
          this.createTonePulse(voice, now, event.weapon === 'torpedo' ? 82 : 125, 42, 0.095, 0.45, 'sine');
          break;
      }
      this.lastEventAt.set(category, now);
    } catch {
      this.retireVoice(voice, now);
    }
  }

  /** Track at most 32 current aircraft, using simulation time and real relative motion for each pass. */
  updatePasses(aircraft: readonly Aircraft[], player: Aircraft, elapsed: number): void {
    const ctx = this.ctx;
    if (!this.enabled || !this.active || !ctx || ctx.state !== 'running' || !this.master
      || player.health <= 0 || !Number.isFinite(elapsed)) {
      this.clearPasses(ctx?.currentTime ?? 0);
      return;
    }
    const now = ctx.currentTime;
    if (this.passElapsed !== null && elapsed < this.passElapsed) this.clearPasses(now);
    this.passElapsed = elapsed;
    const candidates = aircraft
      .filter(entity => entity.id !== player.id && entity.health > 0)
      .map(entity => ({ entity, mix: spatialMix(entity.position, player) }))
      .filter((entry): entry is { entity: Aircraft; mix: SpatialMix } => entry.mix !== null)
      .sort((a, b) => a.mix.distance - b.mix.distance || a.entity.id - b.entity.id)
      .slice(0, MAX_PASS_AIRCRAFT);
    const aliveIds = new Set(candidates.map(({ entity }) => entity.id));
    for (const [id, state] of this.passes) {
      if (!aliveIds.has(id)) {
        if (state.voice) this.retireVoice(state.voice, now);
        this.passes.delete(id);
      }
    }
    for (const { entity, mix } of candidates) {
      const x = entity.position.x - player.position.x;
      const y = entity.position.y - player.position.y;
      const z = entity.position.z - player.position.z;
      let previous = this.passes.get(entity.id);
      if (previous && entity.age < previous.age) {
        if (previous.voice) this.retireVoice(previous.voice, now);
        previous = undefined;
      }
      const dt = previous ? elapsed - previous.elapsed : 0;
      if (previous && dt === 0) continue;
      const state: PassState = {
        x, y, z, distance: mix.distance, elapsed, age: entity.age,
        lastStart: previous?.lastStart ?? -Infinity,
        voice: previous?.voice?.ended ? undefined : previous?.voice,
      };
      this.passes.set(entity.id, state);
      // A pause/gap/respawn only establishes a baseline; never play a backlog of passes.
      if (!previous || dt <= 0 || dt > 0.5) {
        if (state.voice) this.retireVoice(state.voice, now);
        state.voice = undefined;
        continue;
      }
      const radialSpeed = Math.max(-260, Math.min(260, (previous.distance - mix.distance) / dt));
      const relativeSpeed = Math.hypot(x - previous.x, y - previous.y, z - previous.z) / dt;
      if (state.voice) {
        if (mix.distance > PASS_STOP_DISTANCE || elapsed - state.lastStart >= PASS_DURATION) {
          this.retireVoice(state.voice, now);
          state.voice = undefined;
        } else {
          this.updatePassVoice(state.voice, mix, entity.speed, radialSpeed, now);
        }
      }
      const lastPass = this.lastEventAt.get('aircraft-pass');
      if (state.voice || mix.distance > PASS_START_DISTANCE || radialSpeed < 25 || relativeSpeed < 45
        || elapsed - state.lastStart < PASS_COOLDOWN
        || (lastPass !== undefined && now - lastPass < RATE_LIMIT_SECONDS['aircraft-pass']!)
        || Array.from(this.voices).filter(voice => voice.type === 'aircraft-pass').length >= MAX_PASS_VOICES
        || !this.reserveCapacity('aircraft-pass', 2, now)) continue;
      const voice = this.newVoice('aircraft-pass');
      try {
        this.attachSpatial(voice, mix, now);
        this.createPassVoice(voice, now);
        this.updatePassVoice(voice, mix, entity.speed, radialSpeed, now, true);
        state.voice = voice;
        state.lastStart = elapsed;
        this.lastEventAt.set('aircraft-pass', now);
      } catch {
        this.retireVoice(voice, now);
      }
    }
  }

  private newVoice(type: EffectType): EffectVoice {
    const voice: EffectVoice = { type, priority: EFFECT_PRIORITY[type], sources: new Set(), nodes: new Set(), ended: false };
    this.voices.add(voice);
    return voice;
  }

  private attachSpatial(voice: EffectVoice, mix: SpatialMix, now: number): void {
    const ctx = this.ctx!;
    const filter = this.trackNode(voice, ctx.createBiquadFilter());
    const gain = this.trackNode(voice, ctx.createGain());
    const pan = this.trackNode(voice, ctx.createStereoPanner());
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(mix.cutoff, now);
    gain.gain.setValueAtTime(mix.gain, now);
    pan.pan.setValueAtTime(mix.pan, now);
    filter.connect(gain);
    gain.connect(pan);
    pan.connect(this.master!);
    voice.output = filter;
    voice.spatial = { filter, gain, pan };
  }

  private clearPasses(now: number): void {
    for (const state of this.passes.values()) if (state.voice) this.retireVoice(state.voice, now);
    this.passes.clear();
    this.passElapsed = null;
    this.lastEventAt.delete('aircraft-pass');
  }

  /** Clear per-flight event IDs and stop every sound before a fresh run begins. */
  resetFlight(): void {
    this.active = false;
    this.finishing = false;
    this.seenEventIds.clear();
    this.seenEventOrder.length = 0;
    this.lastEventAt.clear();

    const now = this.ctx?.currentTime ?? 0;
    this.stopAllEffects(now);
    this.stopEngine(now);
    if (this.ctx && this.master && this.engineGain) {
      this.engineGain.gain.cancelScheduledValues(now);
      this.engineGain.gain.setValueAtTime(0, now);
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(0, now);
    }
  }

  /** Stop new flight audio while allowing the last critical effect to decay. */
  finishFlight(): void {
    this.active = false;
    const ctx = this.ctx;
    this.clearPasses(ctx?.currentTime ?? 0);
    const master = this.master;
    const engineGain = this.engineGain;
    if (!ctx || !master || !engineGain || ctx.state !== 'running' || !this.enabled) {
      this.finishing = false;
      const now = ctx?.currentTime ?? 0;
      this.stopAllEffects(now);
      this.stopEngine(now);
      if (master && engineGain) {
        engineGain.gain.cancelScheduledValues(now);
        engineGain.gain.setValueAtTime(0, now);
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(0, now);
      }
      return;
    }

    const now = ctx.currentTime;
    this.finishing = true;
    this.stopEngine(now);
    engineGain.gain.cancelScheduledValues(now);
    engineGain.gain.setValueAtTime(0, now);
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(0.6, now);
    master.gain.setValueAtTime(0.6, now + FINISH_TAIL_SECONDS - 0.06);
    master.gain.linearRampToValueAtTime(0, now + FINISH_TAIL_SECONDS);
  }

  private rememberEvent(id: number): boolean {
    if (this.seenEventIds.has(id)) return false;
    this.seenEventIds.add(id);
    this.seenEventOrder.push(id);
    if (this.seenEventOrder.length > MAX_REMEMBERED_EVENTS) {
      const expired = this.seenEventOrder.shift();
      if (expired !== undefined) this.seenEventIds.delete(expired);
    }
    return true;
  }

  private sourceCost(type: EffectType): number {
    if (type === 'hit') return 1;
    if (type === 'damage') return 3;
    if (type === 'playerExplosion') return 5;
    if (type === 'ship-explosion') return 3;
    if (type === 'metal-hit' || type === 'ordnance-impact' || type === 'aircraft-pass') return 2;
    return 1;
  }

  private reserveCapacity(type: EffectType, cost: number, now: number): boolean {
    const limit = type === 'damage' || type === 'playerExplosion'
      ? MAX_EFFECT_SOURCES
      : MAX_EFFECT_SOURCES - DAMAGE_SOURCE_RESERVE;
    if (this.sources.size + cost <= limit) return true;

    const candidates = Array.from(this.voices)
      .filter(voice => voice.priority < EFFECT_PRIORITY[type])
      .sort((a, b) => a.priority - b.priority);
    for (const candidate of candidates) {
      this.retireVoice(candidate, now);
      if (this.sources.size + cost <= limit) return true;
    }
    return this.sources.size + cost <= limit;
  }

  private ensureEngine(now: number): void {
    if (this.engine.length > 0 || !this.ctx || !this.engineGain) return;

    try {
      for (const [index, frequency] of [49, 98, 147].entries()) {
        const oscillator = this.ctx.createOscillator();
        const partial = this.ctx.createGain();
        oscillator.type = index === 0 ? 'sawtooth' : 'sine';
        oscillator.frequency.setValueAtTime(frequency, now);
        partial.gain.value = [0.45, 0.2, 0.12][index];
        oscillator.connect(partial);
        partial.connect(this.engineGain);
        this.engine.push(oscillator);
        this.engineNodes.push(oscillator, partial);
        oscillator.start(now);
      }
    } catch {
      this.stopEngine(now);
      this.failed = true;
    }
  }

  private stopEngine(now: number): void {
    for (const oscillator of this.engine) {
      try {
        oscillator.stop(now);
      } catch {
        // An oscillator may not have started or may already have ended.
      }
    }
    for (const node of this.engineNodes) {
      try {
        node.disconnect();
      } catch {
        // A node may already be disconnected.
      }
    }
    this.engine.length = 0;
    this.engineNodes.length = 0;
  }

  private createNoisePulse(
    voice: EffectVoice,
    now: number,
    cutoff: number,
    playbackRate: number,
    peak: number,
    decay: number,
    stopAt: number,
    filterType: BiquadFilterType = 'lowpass',
    attack = 0.004,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;

    const source = this.trackSource(voice, ctx.createBufferSource());
    const filter = this.trackNode(voice, ctx.createBiquadFilter());
    const envelope = this.trackNode(voice, ctx.createGain());
    source.buffer = noise;
    source.playbackRate.setValueAtTime(playbackRate, now);
    filter.type = filterType;
    filter.frequency.setValueAtTime(cutoff, now);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(peak, now + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(voice.output ?? master);
    source.start(now);
    source.stop(now + stopAt);
  }

  private createTonePulse(
    voice: EffectVoice, now: number, frequency: number, endFrequency: number,
    peak: number, duration: number, type: OscillatorType,
  ): void {
    const ctx = this.ctx!;
    const tone = this.trackSource(voice, ctx.createOscillator());
    const envelope = this.trackNode(voice, ctx.createGain());
    tone.type = type;
    tone.frequency.setValueAtTime(frequency, now);
    tone.frequency.exponentialRampToValueAtTime(endFrequency, now + duration * 0.7);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.linearRampToValueAtTime(peak, now + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    tone.connect(envelope);
    envelope.connect(voice.output ?? this.master!);
    tone.start(now);
    tone.stop(now + duration + 0.02);
  }

  private createPassVoice(voice: EffectVoice, now: number): void {
    const ctx = this.ctx!;
    const noise = this.trackSource(voice, ctx.createBufferSource());
    const filter = this.trackNode(voice, ctx.createBiquadFilter());
    const air = this.trackNode(voice, ctx.createGain());
    noise.buffer = this.noise;
    noise.loop = true;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(720, now);
    air.gain.setValueAtTime(0.0001, now);
    air.gain.linearRampToValueAtTime(0.075, now + 0.14);
    air.gain.exponentialRampToValueAtTime(0.0001, now + PASS_DURATION - 0.02);
    noise.connect(filter);
    filter.connect(air);
    air.connect(voice.output!);
    const tone = this.trackSource(voice, ctx.createOscillator());
    const engine = this.trackNode(voice, ctx.createGain());
    tone.type = 'sawtooth';
    engine.gain.setValueAtTime(0.0001, now);
    engine.gain.linearRampToValueAtTime(0.035, now + 0.12);
    engine.gain.exponentialRampToValueAtTime(0.0001, now + PASS_DURATION - 0.02);
    tone.connect(engine);
    engine.connect(voice.output!);
    noise.start(now);
    tone.start(now);
    noise.stop(now + PASS_DURATION);
    tone.stop(now + PASS_DURATION);
    voice.passNoise = noise;
    voice.passTone = tone;
  }

  private updatePassVoice(voice: EffectVoice, mix: SpatialMix, speed: number, radialSpeed: number, now: number, initial = false): void {
    const spatial = voice.spatial!;
    const doppler = Math.max(0.7, Math.min(1.45, 343 / (343 - radialSpeed)));
    spatial.gain.gain.setTargetAtTime(mix.gain, now, 0.045);
    spatial.filter.frequency.setTargetAtTime(mix.cutoff, now, 0.045);
    spatial.pan.pan.setTargetAtTime(mix.pan, now, 0.035);
    const safeSpeed = Number.isFinite(speed) ? Math.max(0, Math.min(200, speed)) : 0;
    const pitch = (70 + safeSpeed * 0.35) * doppler;
    if (initial) {
      voice.passNoise!.playbackRate.setValueAtTime(0.8 * doppler, now);
      voice.passTone!.frequency.setValueAtTime(pitch, now);
    } else {
      voice.passNoise!.playbackRate.setTargetAtTime(0.8 * doppler, now, 0.045);
      voice.passTone!.frequency.setTargetAtTime(pitch, now, 0.045);
    }
  }

  private createPlayerDamageImpact(voice: EffectVoice, now: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    this.createNoisePulse(voice, now, 1900, 1.35, 0.18, 0.035, 0.055, 'highpass', 0.001);
    this.createNoisePulse(voice, now, 520, 0.82, 0.11, 0.17, 0.21, 'lowpass', 0.006);

    const airframe = this.trackSource(voice, ctx.createOscillator());
    const body = this.trackNode(voice, ctx.createGain());
    airframe.type = 'sine';
    airframe.frequency.setValueAtTime(190, now);
    airframe.frequency.exponentialRampToValueAtTime(100, now + 0.15);
    body.gain.setValueAtTime(0.0001, now);
    body.gain.linearRampToValueAtTime(0.08, now + 0.004);
    body.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    airframe.connect(body);
    body.connect(master);
    airframe.start(now);
    airframe.stop(now + 0.22);
  }

  private createPlayerExplosion(voice: EffectVoice, now: number): void {
    this.createNoisePulse(voice, now, 1500, 1.45, 0.24, 0.035, 0.06, 'highpass', 0.001);
    this.createNoisePulse(voice, now, 260, 0.72, 0.22, 0.78, 0.84, 'lowpass', 0.006);
    this.createNoisePulse(voice, now + 0.18, 1300, 1.25, 0.11, 0.14, 0.17, 'bandpass', 0.002);
    this.createNoisePulse(voice, now + 0.45, 1900, 0.92, 0.085, 0.13, 0.17, 'bandpass', 0.003);
    this.createNoisePulse(
      voice,
      now + 0.72,
      760,
      1.35,
      0.06,
      0.18,
      PLAYER_EXPLOSION_DURATION_SECONDS - 0.72,
      'lowpass',
      0.004,
    );
  }

  private trackSource<T extends AudioScheduledSourceNode>(voice: EffectVoice, source: T): T {
    voice.sources.add(source);
    voice.nodes.add(source);
    this.sources.add(source);
    source.onended = () => this.sourceEnded(voice, source);
    return source;
  }

  private trackNode<T extends AudioNode>(voice: EffectVoice, node: T): T {
    voice.nodes.add(node);
    return node;
  }

  private sourceEnded(voice: EffectVoice, source: AudioScheduledSourceNode): void {
    if (voice.ended) return;
    this.sources.delete(source);
    voice.sources.delete(source);
    if (voice.sources.size === 0) this.retireVoice(voice);
  }

  private retireVoice(voice: EffectVoice, now = this.ctx?.currentTime ?? 0): void {
    if (voice.ended) return;
    voice.ended = true;
    this.voices.delete(voice);
    for (const source of voice.sources) {
      this.sources.delete(source);
      source.onended = null;
      try {
        source.stop(now);
      } catch {
        // Stopping an unstarted or ended source is allowed to fail harmlessly.
      }
    }
    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // Disconnecting a node more than once is harmless.
      }
    }
    voice.sources.clear();
    voice.nodes.clear();
  }

  private stopAllEffects(now: number): void {
    for (const voice of Array.from(this.voices)) this.retireVoice(voice, now);
    this.clearPasses(now);
    this.mountReports.clear();
  }

  dispose(): void {
    const ctx = this.ctx;
    this.active = false;
    this.finishing = false;
    this.stopAllEffects(ctx?.currentTime ?? 0);
    this.stopEngine(ctx?.currentTime ?? 0);
    this.seenEventIds.clear();
    this.seenEventOrder.length = 0;
    this.lastEventAt.clear();
    this.ctx = null;
    this.master = null;
    this.engineGain = null;
    this.noise = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
  }
}
