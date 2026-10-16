import { create, type WasmSource } from '@ai-ecoverse/wasm-webrtc-audio-processing';
import type { AudioChunk } from '../audio.ts';
import { convertAudio } from '../convert.ts';
import type { EchoCanceller, EchoStats } from '../echo.ts';
import { VoiceRequestError } from '../errors.ts';

type Aec = ReturnType<typeof create>;

export interface WebRtcEchoOptions {
  sampleRate: 16000 | 48000;
  noiseSuppression?: boolean | 'low' | 'moderate' | 'high' | 'veryHigh';
  vad?: boolean | 0 | 1 | 2 | 3;
  wasm: WasmSource;
}

export interface WebRtcEcho extends EchoCanceller {
  readonly sampleRate: 16000 | 48000;
  readonly latencySamples: number;
  stats(): EchoStats;
  destroy(): void;
}

export interface NodeWebRtcModule {
  wasmModule(): WebAssembly.Module;
}

export function createWebRtcEcho(options: WebRtcEchoOptions): WebRtcEcho {
  const aec = create({
    wasm: options.wasm,
    sampleRate: options.sampleRate,
    noiseSuppression: options.noiseSuppression,
    vad: options.vad,
  });
  return adapt(aec, options.sampleRate);
}

export async function createNodeWebRtcEcho(
  options: Omit<WebRtcEchoOptions, 'wasm'>,
  load: () => Promise<NodeWebRtcModule> = loadNodeWebRtc
): Promise<WebRtcEcho> {
  let loaded: NodeWebRtcModule;
  try {
    loaded = await load();
  } catch (error) {
    if (missingModule(error)) {
      throw new VoiceRequestError('error', 'WebRTC echo canceller is unavailable');
    }
    throw error;
  }
  return createWebRtcEcho({ ...options, wasm: loaded.wasmModule() });
}

async function loadNodeWebRtc(): Promise<NodeWebRtcModule> {
  return import('@ai-ecoverse/wasm-webrtc-audio-processing/node');
}

function missingModule(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  return error.code === 'ERR_MODULE_NOT_FOUND';
}

function adapt(aec: Aec, sampleRate: 16000 | 48000): WebRtcEcho {
  return {
    sampleRate,
    latencySamples: aec.latencySamples,
    cancel(mic: AudioChunk, reference: AudioChunk): AudioChunk {
      const cleaned = aec.cancel(floatsOf(mic, sampleRate), floatsOf(reference, sampleRate));
      return pcmChunk(cleaned, mic, sampleRate);
    },
    stats(): EchoStats {
      const live = aec.stats();
      return { delayMs: live.delayMs, cancellationDb: live.erleDb };
    },
    destroy(): void {
      aec.destroy();
    },
  };
}

function floatsOf(chunk: AudioChunk, sampleRate: 16000 | 48000): Float32Array {
  const pcm = convertAudio(chunk, { encoding: 'pcmf32', sampleRate, channels: 1 });
  const length = Math.floor(pcm.data.byteLength / 4);
  const samples = new Float32Array(length);
  const view = new DataView(pcm.data.buffer, pcm.data.byteOffset, pcm.data.byteLength);
  for (let index = 0; index < length; index += 1) {
    samples[index] = finiteSample(view.getFloat32(index * 4, true));
  }
  return samples;
}

function finiteSample(sample: number): number {
  if (Number.isFinite(sample)) return sample;
  return 0;
}

function pcmChunk(samples: Float32Array, mic: AudioChunk, sampleRate: 16000 | 48000): AudioChunk {
  const data = new Uint8Array(samples.byteLength);
  data.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return convertAudio(
    {
      data,
      format: { encoding: 'pcmf32', sampleRate, channels: 1 },
      timestamp: mic.timestamp,
    },
    mic.format
  );
}
