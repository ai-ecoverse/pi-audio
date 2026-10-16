import { isWorkletRelease, WORKLET_RELEASE } from './release.ts';

export const AUDIO_TAP_PROCESSOR = 'pi-audio-tap';

interface TapPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data?: unknown }) => void) | null;
}

interface WorkletScope {
  AudioWorkletProcessor?: new () => { port?: TapPort };
  registerProcessor?: (name: string, processor: new () => object) => void;
}

interface TapInputs {
  inputs: Array<ArrayLike<Float32Array | undefined> | undefined>;
  outputs: Array<ArrayLike<Float32Array | undefined> | undefined>;
}

const scope = globalThis as WorkletScope;
const registered = new WeakSet<object>();

export function copyTap(inputs: TapInputs['inputs'], outputs: TapInputs['outputs']): void {
  const input = inputs[0] ?? [];
  const output = outputs[0] ?? [];
  for (let channel = 0; channel < output.length; channel += 1) {
    const dst = output[channel];
    if (dst === undefined) continue;
    writeChannel(dst, input[channel] ?? input[0]);
  }
}

export function tapSamples(inputs: TapInputs['inputs']): Float32Array | undefined {
  const heard = inputs[0]?.[0];
  if (heard === undefined || heard.length === 0) return undefined;
  const copy = new Float32Array(heard.length);
  copy.set(heard);
  return copy;
}

export function registerAudioTapWorklet(target: WorkletScope = scope): void {
  if (typeof target.registerProcessor !== 'function') return;
  if (registered.has(target)) return;
  registered.add(target);
  const Base =
    target.AudioWorkletProcessor ??
    class {
      port?: TapPort;
    };
  const processor = class AudioTapProcessor extends Base {
    released = false;
    #posted = false;

    constructor() {
      super();
      const port = this.port;
      if (port) {
        port.onmessage = (event) => {
          if (isWorkletRelease(event.data)) this.released = true;
        };
      }
    }

    process(inputs: TapInputs['inputs'], outputs: TapInputs['outputs']): boolean {
      if (this.released) {
        this.#finish();
        return true;
      }
      copyTap(inputs, outputs);
      const samples = tapSamples(inputs);
      if (samples) this.port?.postMessage({ samples });
      return true;
    }

    #finish(): void {
      if (this.#posted) return;
      this.#posted = true;
      const port = this.port;
      if (!port) return;
      port.postMessage({ type: WORKLET_RELEASE });
    }
  };
  target.registerProcessor(AUDIO_TAP_PROCESSOR, processor);
}

export function audioTapWorkletUrl(): string {
  return new URL(import.meta.url).href;
}

export async function loadAudioTap(
  worklet: { addModule(module: unknown): Promise<void> },
  url = audioTapWorkletUrl()
): Promise<void> {
  try {
    await worklet.addModule(url);
  } catch (error) {
    try {
      await worklet.addModule((next: WorkletScope) => {
        registerAudioTapWorklet(next);
      });
    } catch {
      throw error;
    }
  }
}

function writeChannel(dst: Float32Array, src: Float32Array | undefined): void {
  if (src === undefined) {
    dst.fill(0);
    return;
  }
  if (src.length === dst.length) {
    dst.set(src);
    return;
  }
  const count = Math.min(src.length, dst.length);
  for (let frame = 0; frame < count; frame += 1) dst[frame] = src[frame] as number;
}

registerAudioTapWorklet();
