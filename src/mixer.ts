import { type AudioChunk, type AudioSink, type AudioTag, chunkSeconds } from './audio.ts';
import { convertAudio } from './convert.ts';
import { echoRuntime } from './echo.ts';
import { VoiceRequestError } from './errors.ts';
import type { AudioOut, Cue, CueSource } from './soundscape.ts';
import { bindWorkletNode, isWorkletRelease, type WorkletNodeLike } from './worklet/release.ts';
import { AUDIO_TAP_PROCESSOR, loadAudioTap } from './worklet/tap.ts';

export interface Mixer extends AudioOut {
  close(): void;
}

export interface MixerWorkletNode extends WorkletNodeLike {
  connect(destination: AudioNode): AudioNode;
}

export interface OpenMixerOptions {
  playback?: 'webaudio' | 'rtc-loopback';
  runtime?: 'node' | 'browser';
  tapUrl?: string;
  workletNode?: new (
    context: BaseAudioContext,
    name: string,
    options?: AudioWorkletNodeOptions
  ) => MixerWorkletNode;
}

export async function openMixer(
  context: BaseAudioContext,
  options: OpenMixerOptions = {}
): Promise<Mixer> {
  const playback = playbackOf(options);
  const mix = context.createGain();
  const speechGain = context.createGain();
  const bedGain = context.createGain();
  speechGain.connect(mix);
  bedGain.connect(mix);
  await loadAudioTap(context.audioWorklet, options.tapUrl);
  const tap = new (workletNode(options))(context, AUDIO_TAP_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    outputChannelCount: [2],
  });
  mix.connect(tap as unknown as AudioNode);
  tap.connect(context.destination);
  const queue = new ChunkQueue();
  const release = watchTap(tap, queue, context);
  const speech = new SpeechOut(context, speechGain);
  const bed = new BedPlayer(context, bedGain);
  return {
    context,
    speech,
    bed,
    reference: queue,
    playback,
    close() {
      release();
      bed.close();
      speech.flush();
      queue.close();
      disconnect(speechGain);
      disconnect(mix);
    },
  };
}

class ChunkQueue implements AsyncIterable<AudioChunk> {
  readonly #chunks: AudioChunk[] = [];
  readonly #waiters: Array<(result: IteratorResult<AudioChunk>) => void> = [];
  #closed = false;

  push(chunk: AudioChunk): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: chunk, done: false });
      return;
    }
    if (this.#chunks.length === 32) this.#chunks.shift();
    this.#chunks.push(chunk);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AudioChunk> {
    return this;
  }

  next(): Promise<IteratorResult<AudioChunk>> {
    const queued = this.#chunks.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

class SpeechOut implements AudioSink {
  readonly #context: BaseAudioContext;
  readonly #gain: GainNode;
  readonly #listeners = new Set<(tag: AudioTag, offsetMs: number) => void>();
  readonly #sources: AudioBufferSourceNode[] = [];
  readonly #timers: Array<ReturnType<typeof setTimeout>> = [];
  #origin = -1;
  #writtenMs = 0;
  #nextAt = 0;

  constructor(context: BaseAudioContext, gain: GainNode) {
    this.#context = context;
    this.#gain = gain;
  }

  get playedMs(): number {
    if (this.#origin < 0) return 0;
    const elapsed = (this.#context.currentTime - this.#origin) * 1000;
    if (elapsed <= 0) return 0;
    if (elapsed > this.#writtenMs) return this.#writtenMs;
    return elapsed;
  }

  write(chunk: AudioChunk, tag?: AudioTag): void {
    const channels = planar(chunk);
    const frames = channels[0].length;
    if (frames === 0) return;
    const buffer = this.#context.createBuffer(channels.length, frames, chunk.format.sampleRate);
    writeBuffer(buffer, channels);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain);
    const start = Math.max(this.#context.currentTime, this.#nextAt);
    source.start(start);
    this.#nextAt = start + chunkSeconds(chunk);
    if (this.#origin < 0) this.#origin = start;
    this.#writtenMs += chunkSeconds(chunk) * 1000;
    if (tag) this.#emit(tag, start);
    source.onended = () => disconnect(source);
    this.#sources.push(source);
  }

  flush(): void {
    this.#stopSources();
    this.#clearTimers();
    this.#origin = -1;
    this.#writtenMs = 0;
    this.#nextAt = this.#context.currentTime;
  }

  onPlayback(listener: (tag: AudioTag, offsetMs: number) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(tag: AudioTag, start: number): void {
    const delay = (start - this.#context.currentTime) * 1000;
    const fire = () => {
      for (const listener of this.#listeners) listener(tag, 0);
    };
    if (delay <= 0) {
      fire();
      return;
    }
    this.#timers.push(setTimeout(fire, delay));
  }

  #stopSources(): void {
    const sources = this.#sources.splice(0);
    for (const source of sources) {
      source.stop();
      disconnect(source);
    }
  }

  #clearTimers(): void {
    for (const timer of this.#timers.splice(0)) clearTimeout(timer);
  }
}

class BedPlayer {
  readonly #context: BaseAudioContext;
  readonly #output: GainNode;
  readonly #loops: AudioNode[] = [];
  readonly #shots: AudioNode[] = [];
  readonly #timers: Array<ReturnType<typeof setTimeout>> = [];
  #generation = 0;

  constructor(context: BaseAudioContext, output: GainNode) {
    this.#context = context;
    this.#output = output;
  }

  play(cue: Cue, fadeMs: number): void {
    if (cue.kind === 'keep' || cue.kind === 'silence') return;
    if (cue.kind === 'loop') this.#clear(this.#loops, 0);
    const gain = this.#context.createGain();
    ramp(gain.gain, cue.gain, this.#context.currentTime, fadeMs);
    gain.connect(this.#output);
    const token = this.#generation;
    const node = this.#start(cue, gain, token);
    if (!node) return;
    this.#keep(cue.kind, node);
  }

  duck(gain: number, rampMs: number): void {
    ramp(this.#output.gain, gain, this.#context.currentTime, rampMs);
  }

  stop(fadeMs: number): void {
    this.#generation += 1;
    this.#clear(this.#loops, fadeMs);
    this.#clear(this.#shots, fadeMs);
  }

  close(): void {
    this.stop(0);
    for (const timer of this.#timers.splice(0)) clearTimeout(timer);
    disconnect(this.#output);
  }

  #start(
    cue: Extract<Cue, { kind: 'loop' | 'oneShot' }>,
    gain: GainNode,
    token: number
  ): AudioNode | undefined {
    const source = cue.source;
    if ('url' in source) {
      void this.#loadUrl(source.url, gain, cue.kind, token).catch(() => disconnect(gain));
      return undefined;
    }
    if ('buffer' in source) return this.#buffer(source.buffer, gain, cue.kind);
    return this.#synth(source, gain);
  }

  #synth(source: Extract<CueSource, { synth: unknown }>, gain: GainNode): AudioNode {
    const node = source.synth(this.#context);
    node.connect(gain);
    startNode(node);
    return node;
  }

  #buffer(buffer: AudioBuffer, gain: GainNode, kind: 'loop' | 'oneShot'): AudioNode {
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.loop = kind === 'loop';
    source.connect(gain);
    source.start();
    if (kind === 'oneShot') source.onended = () => disconnect(source);
    return source;
  }

  async #loadUrl(
    url: string,
    gain: GainNode,
    kind: 'loop' | 'oneShot',
    token: number
  ): Promise<void> {
    const response = await fetch(url).catch(() => undefined);
    if (response === undefined || !response.ok || token !== this.#generation) {
      disconnect(gain);
      return;
    }
    const bytes = await response.arrayBuffer();
    if (token !== this.#generation) {
      disconnect(gain);
      return;
    }
    const buffer = await decoded(this.#context, bytes);
    if (buffer === undefined || token !== this.#generation) {
      disconnect(gain);
      return;
    }
    this.#keep(kind, this.#buffer(buffer, gain, kind));
  }

  #keep(kind: 'loop' | 'oneShot', node: AudioNode): void {
    if (kind === 'loop') this.#loops.push(node);
    else this.#shots.push(node);
  }

  #clear(list: AudioNode[], fadeMs: number): void {
    const nodes = list.splice(0);
    for (const node of nodes) this.#end(node, fadeMs);
  }

  #end(node: AudioNode, fadeMs: number): void {
    const stoppable = node as AudioNode & { stop?: (when?: number) => void };
    if (fadeMs <= 0) {
      if (typeof stoppable.stop === 'function') stoppable.stop();
      disconnect(node);
      return;
    }
    if (typeof stoppable.stop === 'function') {
      stoppable.stop(this.#context.currentTime + fadeMs / 1000);
    }
    this.#timers.push(setTimeout(() => disconnect(node), fadeMs));
  }
}

function playbackOf(options: OpenMixerOptions): 'webaudio' | 'rtc-loopback' {
  const playback = options.playback ?? 'webaudio';
  const runtime = options.runtime ?? echoRuntime(hasMediaDevices());
  if (runtime === 'node' && playback === 'rtc-loopback') {
    throw new VoiceRequestError('error', 'Node playback is webaudio');
  }
  return playback;
}

function hasMediaDevices(): boolean {
  return typeof navigator !== 'undefined' && navigator.mediaDevices !== undefined;
}

function workletNode(options: OpenMixerOptions): NonNullable<OpenMixerOptions['workletNode']> {
  if (options.workletNode) return options.workletNode;
  const ctor = (globalThis as { AudioWorkletNode?: OpenMixerOptions['workletNode'] })
    .AudioWorkletNode;
  if (ctor) return ctor;
  throw new VoiceRequestError('error', 'AudioWorkletNode is not available');
}

function watchTap(tap: WorkletNodeLike, queue: ChunkQueue, context: BaseAudioContext): () => void {
  tap.port.onmessage = (event) => {
    const samples = readSamples(event.data);
    if (!samples) return;
    queue.push({
      data: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice(),
      format: { encoding: 'pcmf32', sampleRate: context.sampleRate, channels: 1 },
      timestamp: context.currentTime * 1000,
    });
  };
  return bindWorkletNode(tap);
}

function readSamples(data: unknown): Float32Array | undefined {
  if (isWorkletRelease(data)) return undefined;
  if (typeof data !== 'object' || data === null || !('samples' in data)) return undefined;
  if (!(data.samples instanceof Float32Array) || data.samples.length === 0) return undefined;
  return data.samples;
}

function planar(chunk: AudioChunk): Float32Array[] {
  const pcm =
    chunk.format.encoding === 'pcmf32'
      ? chunk
      : convertAudio(chunk, { ...chunk.format, encoding: 'pcmf32' });
  const channels = pcm.format.channels;
  const view = new DataView(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength);
  const frames = Math.floor(pcm.data.byteLength / (4 * channels));
  const out: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const samples = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      samples[frame] = view.getFloat32((frame * channels + channel) * 4, true);
    }
    out.push(samples);
  }
  return out;
}

function writeBuffer(buffer: AudioBuffer, channels: Float32Array[]): void {
  if (typeof buffer.copyToChannel === 'function') {
    for (let index = 0; index < channels.length; index += 1) {
      buffer.copyToChannel(channels[index] as Float32Array<ArrayBuffer>, index);
    }
    return;
  }
  for (let index = 0; index < channels.length; index += 1) {
    buffer.getChannelData(index).set(channels[index] as Float32Array<ArrayBuffer>);
  }
}

function ramp(param: AudioParam, value: number, when: number, fadeMs: number): void {
  param.cancelScheduledValues(when);
  if (fadeMs <= 0) {
    param.setValueAtTime(value, when);
    return;
  }
  param.setValueAtTime(param.value, when);
  param.linearRampToValueAtTime(value, when + fadeMs / 1000);
}

function startNode(node: AudioNode): void {
  const startable = node as AudioNode & { start?: (when?: number) => void };
  if (typeof startable.start === 'function') startable.start();
}

async function decoded(
  context: BaseAudioContext,
  bytes: ArrayBuffer
): Promise<AudioBuffer | undefined> {
  try {
    return await context.decodeAudioData(bytes);
  } catch {
    return undefined;
  }
}

function disconnect(node: { disconnect(): void }): void {
  try {
    node.disconnect();
  } catch {
    return;
  }
}
