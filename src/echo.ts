import { type AudioChunk, type AudioSource, chunkSeconds } from './audio.ts';
import { VoiceRequestError } from './errors.ts';
import type { AudioOut, Cue } from './soundscape.ts';
import type { EchoRecommendation } from './turns.ts';

export type EchoMode = 'browser' | 'wasm' | 'none';

export interface EchoStats {
  delayMs: number | null;
  cancellationDb: number | null;
}

export interface EchoCanceller {
  cancel(mic: AudioChunk, reference: AudioChunk): AudioChunk;
  stats?(): EchoStats;
}

export interface EchoControl {
  mode: EchoMode;
  reference: AudioSource;
  canceller?: EchoCanceller;
}

export interface EchoReport {
  delayMs: number;
  cancellationDb: number;
  residualDb: number;
  recommendation: EchoRecommendation;
}

export interface MicOpen {
  echoCancellation: boolean | 'all';
  playback: 'webaudio' | 'rtc-loopback';
}

const floor = 1e-8;

export function micOpen(mode: EchoMode, useAll: boolean): MicOpen {
  if (mode === 'browser') {
    let echoCancellation: boolean | 'all' = true;
    if (useAll) echoCancellation = 'all';
    return { echoCancellation, playback: 'rtc-loopback' };
  }
  return { echoCancellation: false, playback: 'webaudio' };
}

export function echoRuntime(hasMediaDevices: boolean): 'node' | 'browser' {
  if (hasMediaDevices) return 'browser';
  return 'node';
}

export function assertNodeEcho(mode: EchoMode, runtime: 'node' | 'browser'): void {
  if (runtime === 'node' && mode === 'browser') {
    throw new VoiceRequestError('error', 'Node echo control is wasm or none');
  }
}

export function chooseCapture(tried: EchoMode, report: EchoReport): EchoMode {
  if (tried === 'none') return 'none';
  if (tried === 'wasm') return 'wasm';
  if (report.cancellationDb < 12) return 'wasm';
  return 'browser';
}

export function openEchoMic(control: EchoControl, mic: AudioSource): AudioSource {
  if (control.mode === 'none' || control.mode === 'browser') return mic;
  const canceller = control.canceller;
  if (canceller === undefined) {
    throw new VoiceRequestError('error', 'wasm echo control needs a canceller');
  }
  return cancelStream(mic, control.reference, canceller);
}

export function measureEcho(
  reference: Float32Array,
  mic: Float32Array,
  sampleRate: number
): EchoReport {
  if (reference.length === 0) return quiet();
  if (mic.length === 0) return quiet();
  let rate = sampleRate;
  if (rate <= 0) rate = 1;
  const maxLag = Math.min(mic.length - 1, Math.max(0, Math.round(rate * 0.25)));
  let bestLag = 0;
  let best = -1;
  let bestGain = 0;
  for (let lag = 0; lag <= maxLag; lag += 1) {
    const scored = scoreLag(reference, mic, lag);
    if (scored.score > best) {
      best = scored.score;
      bestLag = lag;
      bestGain = scored.gain;
    }
  }
  const leak = Math.abs(bestGain);
  const residualDb = amplitudeDb(leak);
  return {
    delayMs: (bestLag / rate) * 1000,
    cancellationDb: -residualDb,
    residualDb,
    recommendation: recommend(residualDb),
  };
}

export async function calibrateEcho(
  out: AudioOut,
  mic: AudioSource,
  probe: Cue,
  durationMs: number,
  signal: AbortSignal,
  canceller?: EchoCanceller
): Promise<EchoReport> {
  if (signal.aborted) throw new VoiceRequestError('aborted', 'aborted');
  out.bed.play(probe, 0);
  const rate = { value: 0 };
  try {
    const heard = readSamples(mic, durationMs, signal, rate);
    const reference = readSamples(out.reference, durationMs, signal, rate);
    const pair = await Promise.all([heard, reference]);
    let used = rate.value;
    if (used <= 0) used = 1;
    const cleaned = applyCanceller(pair[0], pair[1], used, canceller);
    return withStats(measureEcho(pair[1], cleaned.samples, used), cleaned.stats);
  } finally {
    out.bed.stop(0);
  }
}

function applyCanceller(
  mic: Float32Array,
  reference: Float32Array,
  sampleRate: number,
  canceller: EchoCanceller | undefined
): { samples: Float32Array; stats?: EchoStats } {
  if (canceller === undefined) return { samples: mic };
  const cancelled = canceller.cancel(
    floatChunk(mic, sampleRate),
    floatChunk(reference, sampleRate)
  );
  return { samples: heardSamples(cancelled, mic), stats: readStats(canceller) };
}

function readStats(canceller: EchoCanceller): EchoStats | undefined {
  if (canceller.stats === undefined) return undefined;
  return canceller.stats();
}

function heardSamples(chunk: AudioChunk, fallback: Float32Array): Float32Array {
  const decoded = samplesOf(chunk);
  if (decoded.length === 0) return fallback;
  return Float32Array.from(decoded);
}

function floatChunk(samples: Float32Array, sampleRate: number): AudioChunk {
  const data = new Uint8Array(samples.length * 4);
  const view = new DataView(data.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, samples[index] as number, true);
  }
  return {
    data,
    format: { encoding: 'pcmf32', sampleRate, channels: 1 },
    timestamp: 0,
  };
}

function withStats(report: EchoReport, stats: EchoStats | undefined): EchoReport {
  if (stats === undefined) return report;
  return {
    delayMs: chosen(stats.delayMs, report.delayMs),
    cancellationDb: chosen(stats.cancellationDb, report.cancellationDb),
    residualDb: report.residualDb,
    recommendation: report.recommendation,
  };
}

function chosen(value: number | null, fallback: number): number {
  if (value === null) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function quiet(): EchoReport {
  return { delayMs: 0, cancellationDb: 80, residualDb: -80, recommendation: 'interrupt' };
}

function recommend(residualDb: number): EchoRecommendation {
  if (residualDb <= -30) return 'interrupt';
  if (residualDb <= -12) return 'onWords';
  return 'headphones';
}

function scoreLag(
  reference: Float32Array,
  mic: Float32Array,
  lag: number
): { score: number; gain: number } {
  let dot = 0;
  let energy = 0;
  const length = Math.min(reference.length, mic.length - lag);
  for (let index = 0; index < length; index += 1) {
    const ref = reference[index] as number;
    const heard = mic[index + lag] as number;
    dot += ref * heard;
    energy += ref * ref;
  }
  if (energy <= floor) return { score: -1, gain: 0 };
  return { score: Math.abs(dot), gain: dot / energy };
}

function amplitudeDb(amplitude: number): number {
  let safe = amplitude;
  if (safe <= floor) safe = floor;
  return 20 * Math.log10(safe);
}

async function* cancelStream(
  mic: AudioSource,
  reference: AudioSource,
  canceller: EchoCanceller
): AudioSource {
  const refs = reference[Symbol.asyncIterator]();
  for await (const chunk of mic) {
    const next = await refs.next();
    if (next.done) {
      yield chunk;
      continue;
    }
    yield canceller.cancel(chunk, next.value);
  }
}

async function readSamples(
  source: AudioSource,
  durationMs: number,
  signal: AbortSignal,
  rate: { value: number }
): Promise<Float32Array> {
  const samples: number[] = [];
  let heardMs = 0;
  for await (const chunk of source) {
    if (signal.aborted) throw new VoiceRequestError('aborted', 'aborted');
    if (rate.value === 0) rate.value = chunk.format.sampleRate;
    for (const sample of samplesOf(chunk)) samples.push(sample);
    heardMs += chunkSeconds(chunk) * 1000;
    if (heardMs >= durationMs) break;
  }
  return Float32Array.from(samples);
}

function samplesOf(chunk: AudioChunk): number[] {
  if (chunk.format.encoding === 'pcm16') return pcm16Samples(chunk.data);
  if (chunk.format.encoding === 'pcmf32') return pcmf32Samples(chunk.data);
  return [];
}

function pcm16Samples(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples: number[] = [];
  const count = Math.floor(data.byteLength / 2);
  for (let index = 0; index < count; index += 1) {
    samples.push(view.getInt16(index * 2, true) / 32768);
  }
  return samples;
}

function pcmf32Samples(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples: number[] = [];
  const count = Math.floor(data.byteLength / 4);
  for (let index = 0; index < count; index += 1) {
    samples.push(view.getFloat32(index * 4, true));
  }
  return samples;
}
