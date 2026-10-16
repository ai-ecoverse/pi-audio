import type { ProviderRequestOptions, Usage } from '@earendil-works/pi-ai';
import { EventStream } from '@earendil-works/pi-ai';
import type { AudioSource } from './audio.ts';
import { blankUsage } from './blank-usage.ts';
import { VoiceRequestError } from './errors.ts';
import type { TranscriptionModel } from './models.ts';
import { streamResult } from './stream-result.ts';

export type AudioInput = { data: Uint8Array; mimeType: string } | { url: string };

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
  speaker?: string;
}

export interface Transcript {
  text: string;
  language?: string;
  segments?: TranscriptSegment[];
  usage: Usage;
}

export type TranscriptionEvent =
  | { type: 'speech_start'; at: number }
  | { type: 'partial'; segmentId: string; text: string }
  | { type: 'final'; segmentId: string; text: string; confidence?: number }
  | { type: 'turn_end'; text: string; at: number }
  | { type: 'done'; transcript: Transcript }
  | { type: 'error'; reason: 'aborted' | 'error'; error: string };

export interface ListenOptions extends ProviderRequestOptions {
  language?: string;
  vocabulary?: string[];
}

function blankTranscript(): Transcript {
  return { text: '', usage: blankUsage() };
}

export class TranscriptionEventStream extends EventStream<TranscriptionEvent, Transcript> {
  readonly #settled = streamResult<Transcript>();

  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => (event.type === 'done' ? event.transcript : blankTranscript())
    );
  }

  override push(event: TranscriptionEvent): void {
    super.push(event);
    if (event.type === 'done') this.#settled.finish(event.transcript);
    else if (event.type === 'error')
      this.#settled.fail(new VoiceRequestError(event.reason, event.error));
  }

  override end(result?: Transcript): void {
    super.end(result);
    if (result !== undefined) this.#settled.finish(result);
    else
      this.#settled.fail(
        new VoiceRequestError('error', 'Transcription ended without a transcript')
      );
  }

  override result(): Promise<Transcript> {
    return this.#settled.result;
  }
}

export interface TranscriptionApiProvider<TApi extends string = string> {
  api: TApi;
  transcribe?: (
    model: TranscriptionModel<TApi>,
    input: AudioInput,
    options?: ProviderRequestOptions
  ) => Promise<Transcript>;
  listen?: (
    model: TranscriptionModel<TApi>,
    audio: AudioSource,
    options?: ListenOptions
  ) => TranscriptionEventStream;
}
