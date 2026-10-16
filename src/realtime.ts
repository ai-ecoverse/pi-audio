import type {
  Message,
  ProviderRequestOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { AudioChunk, CharAlignment, TextSpan } from './audio.ts';
import type { Delivery, RealtimeModel } from './models.ts';

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
