import type {
  Message,
  ProviderRequestOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import {
  type AudioChunk,
  alignmentSeconds,
  type CharAlignment,
  chunkSeconds,
  type TextSpan,
} from './audio.ts';
import { VoiceRequestError } from './errors.ts';
import type { Delivery, DeliverySupport, RealtimeModel } from './models.ts';
import { priceAudio, type RealtimeAudioCost } from './usage.ts';

export interface RealtimeContext {
  instructions: string;
  tools: Tool[];
  voice: string;
  history?: Message[];
}

export interface RealtimeToken {
  value: string;
  expiresAt: number;
  model: string;
  url?: string;
}

export interface RealtimeOptions extends ProviderRequestOptions {
  token?: RealtimeToken;
  transport?: 'websocket' | 'webrtc';
  gateway?: { url: string; token: string };
  resumeHandle?: string;
}

export type RealtimeEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'input_speech_start' }
  | { type: 'input_transcript'; itemId: string; text: string; final: boolean }
  | {
      type: 'output_audio';
      itemId: string;
      chunk: AudioChunk;
      span?: TextSpan;
      alignment?: CharAlignment;
    }
  | { type: 'output_transcript'; itemId: string; text: string; final: boolean }
  | { type: 'tool_call'; call: ToolCall; blocking: boolean }
  | { type: 'tool_call_cancelled'; callId: string }
  | { type: 'response_done'; itemId: string; interrupted: boolean; usage: Usage }
  | { type: 'go_away'; timeLeftMs: number }
  | { type: 'resumption'; handle: string }
  | { type: 'error'; error: string; fatal: boolean };

export interface RealtimeSession extends AsyncIterable<RealtimeEvent> {
  readonly model: RealtimeModel<string>;
  appendAudio(chunk: AudioChunk): void;
  appendVideoFrame?(jpeg: Uint8Array): void;
  sendText(text: string): void;
  inject(text: string, delivery: Delivery): void;
  respond(callId: string, result: ToolResultMessage, delivery?: Delivery): void;
  interrupt(heard?: { itemId: string; heardMs: number }): void;
  update(patch: Partial<Pick<RealtimeContext, 'instructions' | 'tools' | 'voice'>>): void;
  close(): Promise<{ usage: Usage }>;
}

export interface RealtimeApiProvider<TApi extends string = string> {
  api: TApi;
  connect: (
    model: RealtimeModel<TApi>,
    context: RealtimeContext,
    options?: RealtimeOptions
  ) => Promise<RealtimeSession>;
}

export interface DeliveryPlan {
  delivery: Delivery;
  support: DeliverySupport;
  waitForIdle: boolean;
}

export interface TruncationPlan {
  item?: { itemId: string; audioEndMs: number };
}

export interface RealtimeSocket {
  url: string;
  protocols: string[];
}

export function planDelivery(
  delivery: Record<Delivery, DeliverySupport>,
  requested: Delivery
): DeliveryPlan {
  const support = delivery[requested];
  if (support !== 'native' && support !== 'approximate') {
    throw new VoiceRequestError('error', `unsupported delivery: ${requested}`);
  }
  return {
    delivery: requested,
    support,
    waitForIdle: requested === 'when_idle' && support === 'approximate',
  };
}

export function planTruncation(
  truncation: RealtimeModel<string>['truncation'],
  heard?: { itemId: string; heardMs: number }
): TruncationPlan {
  if (truncation === 'client' && heard !== undefined) {
    return { item: { itemId: heard.itemId, audioEndMs: heard.heardMs } };
  }
  return {};
}

export function realtimeSocket(
  url: string,
  options?: Pick<RealtimeOptions, 'gateway'>,
  protocols: readonly string[] = []
): RealtimeSocket {
  const gateway = options?.gateway;
  if (gateway === undefined) return { url, protocols: [...protocols] };
  return {
    url: gateway.url,
    protocols: [`cf-aig-authorization.${gateway.token}`, ...protocols],
  };
}

export class RealtimeLedger {
  #inputSeconds = 0;
  #outputSeconds = 0;
  #textMessages = 0;
  #busy = false;
  #held: Array<() => void> = [];

  get inputSeconds(): number {
    return this.#inputSeconds;
  }

  get outputSeconds(): number {
    return this.#outputSeconds;
  }

  get textMessages(): number {
    return this.#textMessages;
  }

  get busy(): boolean {
    return this.#busy;
  }

  addInput(chunk: AudioChunk): void {
    this.#inputSeconds += chunkSeconds(chunk);
  }

  addOutput(chunk: AudioChunk, alignment?: CharAlignment): void {
    const seconds = chunkSeconds(chunk);
    this.#outputSeconds += seconds > 0 ? seconds : alignmentSeconds(alignment);
  }

  addText(): void {
    this.#textMessages += 1;
  }

  observe(event: RealtimeEvent): void {
    if (event.type === 'output_audio') this.addOutput(event.chunk, event.alignment);
    if (event.type === 'output_audio' || event.type === 'output_transcript') this.#busy = true;
    if (event.type === 'response_done') this.#release();
  }

  submit(
    delivery: Record<Delivery, DeliverySupport>,
    requested: Delivery,
    run: () => void
  ): DeliveryPlan {
    const plan = planDelivery(delivery, requested);
    if (plan.waitForIdle && this.#busy) this.#held.push(run);
    else run();
    return plan;
  }

  settle(): void {
    this.#release();
  }

  usage(rates: RealtimeAudioCost): Usage {
    return priceAudio(rates, {
      inputSeconds: this.#inputSeconds,
      outputSeconds: this.#outputSeconds,
      textMessages: this.#textMessages,
    });
  }

  #release(): void {
    this.#busy = false;
    const held = this.#held;
    this.#held = [];
    for (const run of held) run();
  }
}
