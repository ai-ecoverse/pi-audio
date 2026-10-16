import { PassThrough } from 'node:stream';
import { VoiceRequestError } from './errors.ts';
import { type Mixer, type OpenMixerOptions, openMixer } from './mixer.ts';

export type NodeAudioEngine = 'node-web-audio-api' | 'web-audio-api';

export interface NodeAudioModule {
  AudioContext: new (options?: Record<string, unknown>) => NodeAudioContext;
  AudioWorkletNode: NonNullable<OpenMixerOptions['workletNode']>;
}

export interface NodeAudioContext {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  close(): Promise<void>;
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: AudioDestinationNode;
  readonly audioWorklet: AudioWorklet;
  createGain(): GainNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  decodeAudioData(buffer: ArrayBuffer): Promise<AudioBuffer>;
}

export interface NodeAudioOptions {
  engine?: NodeAudioEngine | 'auto';
  sink?: 'none' | 'default';
  sampleRate?: number;
  load?: (engine: NodeAudioEngine) => Promise<NodeAudioModule>;
}

export interface NodeAudioSession {
  readonly engine: NodeAudioEngine;
  readonly sink: 'none' | 'default';
  readonly context: BaseAudioContext;
  readonly out: Mixer;
  close(): Promise<void>;
}

const TAP_NAME = 'pi-audio-tap.js';

const AUDIO_TAP_CLASSIC = [
  'class PiAudioTap extends AudioWorkletProcessor {',
  '  constructor() {',
  '    super();',
  '    this.released = false;',
  '    this.posted = false;',
  '    var port = this.port;',
  '    if (port) {',
  '      port.onmessage = function (event) {',
  '        if (event.data && event.data.type === "pi-audio-release") this.released = true;',
  '      }.bind(this);',
  '    }',
  '  }',
  '  process(inputs, outputs) {',
  '    if (this.released) {',
  '      if (!this.posted) {',
  '        this.posted = true;',
  '        if (this.port) this.port.postMessage({ type: "pi-audio-release" });',
  '      }',
  '      return true;',
  '    }',
  '    var input = (inputs && inputs[0]) || [];',
  '    var output = (outputs && outputs[0]) || [];',
  '    for (var channel = 0; channel < output.length; channel++) {',
  '      var dst = output[channel];',
  '      if (!dst) continue;',
  '      var src = input[channel] || input[0];',
  '      if (!src) { dst.fill(0); continue; }',
  '      if (src.length === dst.length) dst.set(src);',
  '      else {',
  '        var count = Math.min(src.length, dst.length);',
  '        for (var frame = 0; frame < count; frame++) dst[frame] = src[frame];',
  '      }',
  '    }',
  '    var heard = input[0];',
  '    if (heard && heard.length && this.port) {',
  '      var copy = new Float32Array(heard.length);',
  '      copy.set(heard);',
  '      this.port.postMessage({ samples: copy });',
  '    }',
  '    return true;',
  '  }',
  '}',
  "registerProcessor('pi-audio-tap', PiAudioTap);",
  '',
].join('\n');

export async function loadNodeAudioEngine(engine: NodeAudioEngine): Promise<NodeAudioModule> {
  if (engine === 'node-web-audio-api') {
    return (await import('node-web-audio-api')) as unknown as NodeAudioModule;
  }
  return (await import('web-audio-api')) as unknown as NodeAudioModule;
}

export async function openNodeAudio(options: NodeAudioOptions = {}): Promise<NodeAudioSession> {
  const engine = options.engine ?? 'auto';
  const sink = options.sink ?? 'none';
  const load = options.load ?? loadNodeAudioEngine;
  const names: NodeAudioEngine[] =
    engine === 'auto' ? ['node-web-audio-api', 'web-audio-api'] : [engine];
  const tapUrl = await writeTap();
  let failure: unknown;
  for (const name of names) {
    try {
      return await startEngine(name, sink, options.sampleRate, load, tapUrl);
    } catch (error) {
      failure = error;
      if (engine !== 'auto') break;
    }
  }
  throw new VoiceRequestError('error', failureText(failure));
}

async function startEngine(
  engine: NodeAudioEngine,
  sink: 'none' | 'default',
  sampleRate: number | undefined,
  load: (engine: NodeAudioEngine) => Promise<NodeAudioModule>,
  tapUrl: string
): Promise<NodeAudioSession> {
  const loaded = await load(engine);
  const built = await nodeContextOptions(engine, sink, sampleRate);
  const context = new loaded.AudioContext(built.options);
  try {
    const out = await openMixer(context as unknown as BaseAudioContext, {
      playback: 'webaudio',
      runtime: 'node',
      tapUrl,
      workletNode: loaded.AudioWorkletNode,
    });
    if (context.state === 'suspended') await context.resume();
    return {
      engine,
      sink,
      context: context as unknown as BaseAudioContext,
      out,
      close: () => closeSession(context, out, built.stream),
    };
  } catch (error) {
    await closeSession(context, undefined, built.stream);
    throw error;
  }
}

async function nodeContextOptions(
  engine: NodeAudioEngine,
  sink: 'none' | 'default',
  sampleRate: number | undefined
): Promise<{ options: Record<string, unknown>; stream?: PassThrough }> {
  const options: Record<string, unknown> = {};
  if (sampleRate !== undefined) options.sampleRate = sampleRate;
  if (sink === 'default') return { options };
  if (engine === 'node-web-audio-api') {
    options.sinkId = { type: 'none' };
    return { options };
  }
  const stream = new PassThrough();
  stream.resume();
  options.sinkId = stream;
  return { options, stream };
}

async function closeSession(
  context: NodeAudioContext,
  out: Mixer | undefined,
  stream: PassThrough | undefined
): Promise<void> {
  if (out) out.close();
  if (stream) stream.destroy();
  await context.close();
}

function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Node audio engine is unavailable';
}

async function writeTap(): Promise<string> {
  const { writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(tmpdir(), TAP_NAME);
  writeFileSync(file, AUDIO_TAP_CLASSIC);
  return file;
}
