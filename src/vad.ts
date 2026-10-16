import type { AudioChunk, AudioEncoding } from './audio.ts';
import { convertAudio } from './convert.ts';

export interface VadUpdate {
  speechStart?: number;
  turnEnd?: number;
}

export interface VadHook {
  push(chunk: AudioChunk): VadUpdate | undefined;
}

export interface EnergyVadOptions {
  threshold?: number;
  silenceMs?: number;
}

function width(encoding: AudioChunk['format']['encoding']): number | undefined {
  if (encoding === 'pcm16') return 2;
  if (encoding === 'pcmf32') return 4;
  return undefined;
}

function durationMs(chunk: AudioChunk): number {
  const bytes = width(chunk.format.encoding);
  if (bytes === undefined || chunk.format.sampleRate <= 0 || chunk.format.channels <= 0) return 0;
  const samples = chunk.data.byteLength / bytes / chunk.format.channels;
  return (samples / chunk.format.sampleRate) * 1000;
}

function rms(chunk: AudioChunk): number | undefined {
  const bytes = width(chunk.format.encoding);
  if (bytes === undefined) return undefined;
  const samples = Math.floor(chunk.data.byteLength / bytes);
  if (samples === 0) return 0;
  const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample =
      bytes === 2 ? view.getInt16(index * 2, true) / 32768 : view.getFloat32(index * 4, true);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

const compressed = new Set<AudioEncoding>(['opus', 'mp3', 'flac']);

function pcmEnergy(chunk: AudioChunk): AudioChunk {
  const encoding = chunk.format.encoding;
  if (encoding === 'pcm16' || encoding === 'pcmf32') return chunk;
  if (compressed.has(encoding)) {
    throw new Error(`energyVad requires PCM audio, received ${encoding}`);
  }
  return convertAudio(chunk, { ...chunk.format, encoding: 'pcm16' });
}

export function energyVad(options: EnergyVadOptions = {}): VadHook {
  const threshold = options.threshold ?? 0.02;
  const silenceMs = options.silenceMs ?? 500;
  let speaking = false;
  let silence = 0;
  return {
    push(chunk) {
      const sample = pcmEnergy(chunk);
      const measured = rms(sample);
      let level = 0;
      if (measured !== undefined) level = measured;
      const duration = durationMs(sample);
      if (level >= threshold) {
        silence = 0;
        if (speaking) return undefined;
        speaking = true;
        return { speechStart: chunk.timestamp };
      }
      if (!speaking) return undefined;
      silence += duration;
      if (silence < silenceMs) return undefined;
      speaking = false;
      silence = 0;
      return { turnEnd: chunk.timestamp + duration };
    },
  };
}
