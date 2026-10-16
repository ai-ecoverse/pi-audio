import type { AudioFormat } from '../audio.ts';
import { convertAudio } from '../convert.ts';

export const AUDIO_CONVERT_PROCESSOR = 'pi-audio-convert';

export interface AudioConvertProcessorOptions {
  processorOptions?: {
    format?: AudioFormat;
    sampleRate?: number;
  };
}

interface WorkletScope {
  AudioWorkletProcessor?: new (
    options?: AudioConvertProcessorOptions
  ) => {
    port?: { postMessage(message: unknown): void };
  };
  registerProcessor?: (
    name: string,
    processor: new (options?: AudioConvertProcessorOptions) => object
  ) => void;
}

const scope = globalThis as WorkletScope;

const WorkletBase =
  scope.AudioWorkletProcessor ??
  class {
    port?: { postMessage(message: unknown): void };
  };

export class AudioConvertProcessor extends WorkletBase {
  readonly #format: AudioFormat;
  readonly #sampleRate: number;
  #frames = 0;
  readonly #pending: Uint8Array[] = [];

  constructor(options?: AudioConvertProcessorOptions) {
    super(options);
    this.#format = options?.processorOptions?.format ?? {
      encoding: 'pcm16',
      sampleRate: 24000,
      channels: 1,
    };
    const sampleRate = options?.processorOptions?.sampleRate;
    this.#sampleRate =
      sampleRate !== undefined && Number.isFinite(sampleRate) && sampleRate > 0
        ? sampleRate
        : 48000;
  }

  process(inputs: Array<ArrayLike<Float32Array | undefined> | undefined>): boolean {
    const input = inputs[0];
    const channels: Float32Array[] = [];
    if (input) {
      for (let index = 0; index < input.length; index++) {
        const channel = input[index];
        if (channel) channels.push(channel);
      }
    }
    const frames = channels[0]?.length ?? 0;
    if (channels.length === 0 || frames === 0) return true;
    const count = Math.min(channels.length, 2);
    const data = new Uint8Array(frames * count * 4);
    const view = new DataView(data.buffer);
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < count; channel++) {
        view.setFloat32((frame * count + channel) * 4, channels[channel]?.[frame] ?? 0, true);
      }
    }
    const converted = convertAudio(
      {
        data,
        format: {
          encoding: 'pcmf32',
          sampleRate: this.#sampleRate,
          channels: count === 1 ? 1 : 2,
        },
        timestamp: (this.#frames / this.#sampleRate) * 1000,
      },
      this.#format
    );
    this.#frames += frames;
    this.#pending.push(converted.data);
    this.port?.postMessage({
      data: converted.data,
      format: converted.format,
      timestamp: converted.timestamp,
    });
    return true;
  }

  take(): Uint8Array[] {
    return this.#pending.splice(0);
  }
}

export function registerAudioConvertWorklet(target: WorkletScope = scope): void {
  if (typeof target.registerProcessor !== 'function') return;
  target.registerProcessor(AUDIO_CONVERT_PROCESSOR, AudioConvertProcessor);
}

export function audioConvertWorkletUrl(): string {
  return new URL(import.meta.url).href;
}

registerAudioConvertWorklet();
