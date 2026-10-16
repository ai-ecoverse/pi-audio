import type { ProviderRequestOptions, Usage } from '@earendil-works/pi-ai';
import { EventStream } from '@earendil-works/pi-ai';
import type { AudioChunk, AudioFormat, CharAlignment, TextSpan } from './audio.ts';
import { blankUsage } from './blank-usage.ts';
import { VoiceRequestError } from './errors.ts';
import type { SpeechModel } from './models.ts';
import { streamResult } from './stream-result.ts';

export interface SpeechInput {
  text: string | AsyncIterable<string>;
  voice: string;
  language?: string;
  instructions?: string;
  format?: AudioFormat;
}

export type SpeechEvent =
  | { type: 'start'; format: AudioFormat }
  | { type: 'audio'; chunk: AudioChunk; span: TextSpan; alignment?: CharAlignment }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: string };

export class SpeechEventStream extends EventStream<SpeechEvent, Usage> {
  readonly #settled = streamResult<Usage>();

  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => (event.type === 'done' ? event.usage : blankUsage())
    );
  }

  override push(event: SpeechEvent): void {
    super.push(event);
    if (event.type === 'done') this.#settled.finish(event.usage);
    else if (event.type === 'error')
      this.#settled.fail(new VoiceRequestError(event.reason, event.error));
  }

  override end(result?: Usage): void {
    super.end(result);
    if (result !== undefined) this.#settled.finish(result);
    else this.#settled.fail(new VoiceRequestError('error', 'Speech ended without usage'));
  }

  override result(): Promise<Usage> {
    return this.#settled.result;
  }
}

export interface SpeechApiProvider<TApi extends string = string> {
  api: TApi;
  speak: (
    model: SpeechModel<TApi>,
    input: SpeechInput,
    options?: ProviderRequestOptions
  ) => SpeechEventStream;
}
