import type { JsonObject, Tool, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import type { AudioChunk, AudioFormat, TextSpan } from '../audio.ts';
import { blankUsage } from '../blank-usage.ts';
import { decodeAudioBase64, encodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';
import type { Delivery, RealtimeModel } from '../models.ts';
import type {
  RealtimeContext,
  RealtimeEvent,
  RealtimeOptions,
  RealtimeSession,
} from '../realtime.ts';
import { planTruncation, RealtimeLedger, realtimeSocket } from '../realtime.ts';
import {
  openVoiceSocket,
  type VoiceSocketConstructor,
  type VoiceWire,
  type VoiceWireTarget,
} from './socket.ts';

export type VoiceWireFactory = (target: VoiceWireTarget) => VoiceWire;

export interface AdapterOptions {
  wire?: VoiceWireFactory;
  socket?: VoiceSocketConstructor;
  replace?: Record<string, string>;
}

export interface VendorSessionOptions extends AdapterOptions {
  dialect: 'openai' | 'xai';
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function credential(options: RealtimeOptions | undefined): string {
  const token = options?.token?.value;
  if (typeof token === 'string' && token.length > 0) return token;
  const apiKey = options?.apiKey;
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;
  throw new VoiceRequestError('error', 'missing realtime credential');
}

function headersFor(
  options: RealtimeOptions | undefined,
  secret: string,
  bearer: boolean
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (bearer) headers.Authorization = `Bearer ${secret}`;
  const extra = options?.headers;
  if (extra === undefined) return headers;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

function sessionUrl(model: RealtimeModel<string>, resumeHandle: string | undefined): string {
  const params = new URLSearchParams({ model: model.id });
  if (resumeHandle !== undefined) params.set('conversation_id', resumeHandle);
  return `${model.baseUrl}?${params.toString()}`;
}

function functionTool(tool: Tool): JsonObject {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as JsonObject,
  };
}

function openaiSession(context: RealtimeContext, model: RealtimeModel<string>): JsonObject {
  return {
    type: 'realtime',
    instructions: context.instructions,
    tools: context.tools.map(functionTool),
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: model.inputFormat.sampleRate },
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: { type: 'server_vad' },
      },
      output: {
        format: { type: 'audio/pcm', rate: model.outputFormat.sampleRate },
        voice: context.voice,
      },
    },
  };
}

function xaiSession(
  context: RealtimeContext,
  model: RealtimeModel<string>,
  replace: Record<string, string> | undefined
): JsonObject {
  const session: JsonObject = {
    voice: context.voice,
    instructions: context.instructions,
    turn_detection: { type: 'server_vad' },
    tools: context.tools.map(functionTool),
    resumption: { enabled: true },
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: model.inputFormat.sampleRate },
        transcription: { model: 'grok-transcribe' },
      },
      output: { format: { type: 'audio/pcm', rate: model.outputFormat.sampleRate } },
    },
  };
  if (replace !== undefined) session.replace = replace;
  return session;
}

function userItem(value: string): JsonObject {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: value }],
    },
  };
}

function responseCreate(): JsonObject {
  return { type: 'response.create' };
}

function resultText(result: ToolResultMessage): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

function toolOutput(callId: string, result: ToolResultMessage): JsonObject {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: resultText(result) },
  };
}

function forceMessage(value: string): JsonObject {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'force_message',
      role: 'assistant',
      content: [{ type: 'output_text', text: value }],
    },
  };
}

interface PendingAudio {
  chunks: AudioChunk[];
  cursor: number;
}

function spanFor(itemId: string, start: number, end: number): TextSpan {
  return { itemId, start, end };
}

function takeAudio(
  pending: PendingAudio,
  itemId: string,
  format: AudioFormat,
  end: number | undefined
): RealtimeEvent[] {
  const chunks = pending.chunks;
  pending.chunks = [];
  if (chunks.length === 0) return [];
  const start = pending.cursor;
  if (end !== undefined) pending.cursor = end;
  const width = end === undefined ? 0 : end - start;
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  let used = 0;
  let cursor = start;
  return chunks.map((chunk, index) => {
    const event: RealtimeEvent = {
      type: 'output_audio',
      itemId,
      chunk: { data: chunk.data, format, timestamp: chunk.timestamp },
    };
    if (end === undefined || total === 0) return event;
    const last = index === chunks.length - 1;
    const next = last ? end : start + Math.round(((used + chunk.data.length) / total) * width);
    used += chunk.data.length;
    event.span = spanFor(itemId, cursor, next);
    cursor = next;
    return event;
  });
}

function argumentsOf(value: unknown): JsonObject {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    const object = record(parsed);
    if (object === undefined) return {};
    return object as JsonObject;
  } catch {
    return {};
  }
}

function responseUsage(value: unknown): Usage {
  const usage = record(value);
  if (usage === undefined) return blankUsage();
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

class VendorSession implements RealtimeSession {
  readonly model: RealtimeModel<string>;
  readonly #dialect: 'openai' | 'xai';
  readonly #context: RealtimeContext;
  readonly #replace: Record<string, string> | undefined;
  readonly #wire: VoiceWire;
  readonly #ledger = new RealtimeLedger();
  readonly #format: AudioFormat;
  readonly #pending = new Map<string, PendingAudio>();
  readonly #inputText = new Map<string, string>();
  readonly #queue: RealtimeEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<RealtimeEvent>) => void> = [];
  #closed = false;
  #usage: Usage | undefined;
  #lastItem = '';
  #busy = false;
  #heldCreate = false;
  readonly #calls = new Set<string>();

  constructor(
    model: RealtimeModel<string>,
    context: RealtimeContext,
    dialect: 'openai' | 'xai',
    replace: Record<string, string> | undefined,
    wire: VoiceWire
  ) {
    this.model = model;
    this.#context = context;
    this.#dialect = dialect;
    this.#replace = replace;
    this.#wire = wire;
    this.#format = model.outputFormat;
  }

  start(options: RealtimeOptions | undefined): void {
    this.#send(this.#sessionUpdate(this.#context));
    const signal = options?.signal;
    if (signal !== undefined) signal.addEventListener('abort', () => void this.close());
    void this.#read();
  }

  appendAudio(chunk: AudioChunk): void {
    this.#assertOpen();
    this.#ledger.addInput(chunk);
    this.#send({ type: 'input_audio_buffer.append', audio: encodeAudioBase64(chunk.data) });
  }

  sendText(textValue: string): void {
    this.#assertOpen();
    this.#ledger.addText();
    this.#send(userItem(textValue));
    this.#armCreate(false);
  }

  inject(textValue: string, delivery: Delivery): void {
    this.#assertOpen();
    this.#ledger.submit(this.model.delivery, delivery, () => {
      this.#assertOpen();
      this.#ledger.addText();
      this.#sendInject(textValue, delivery);
    });
  }

  respond(callId: string, result: ToolResultMessage, delivery?: Delivery): void {
    this.#assertOpen();
    const send = (): void => {
      this.#send(toolOutput(callId, result));
      this.#calls.delete(callId);
      if (delivery !== 'silent') this.#armCreate(true);
      else if (this.#heldCreate && this.#calls.size === 0) this.#armCreate(false);
    };
    if (delivery === undefined) {
      send();
      return;
    }
    this.#ledger.submit(this.model.delivery, delivery, () => {
      this.#assertOpen();
      send();
    });
  }

  interrupt(heard?: { itemId: string; heardMs: number }): void {
    this.#assertOpen();
    this.#send({ type: 'response.cancel' });
    const plan = planTruncation(this.model.truncation, heard);
    if (plan.item !== undefined) {
      this.#send({
        type: 'conversation.item.truncate',
        item_id: plan.item.itemId,
        content_index: 0,
        audio_end_ms: plan.item.audioEndMs,
      });
    }
    this.#ledger.settle();
  }

  update(patch: Partial<Pick<RealtimeContext, 'instructions' | 'tools' | 'voice'>>): void {
    this.#assertOpen();
    if (patch.tools !== undefined && !this.model.liveToolUpdate) {
      throw new VoiceRequestError('error', 'live tool update is unsupported');
    }
    let instructions = this.#context.instructions;
    if (patch.instructions !== undefined) instructions = patch.instructions;
    let tools = this.#context.tools;
    if (patch.tools !== undefined) tools = patch.tools;
    let voice = this.#context.voice;
    if (patch.voice !== undefined) voice = patch.voice;
    const context: RealtimeContext = { instructions, tools, voice };
    if (patch.instructions !== undefined) this.#context.instructions = context.instructions;
    if (patch.tools !== undefined) this.#context.tools = context.tools;
    if (patch.voice !== undefined) this.#context.voice = context.voice;
    this.#send(this.#sessionUpdate(context));
  }

  async close(): Promise<{ usage: Usage }> {
    if (this.#usage !== undefined) return { usage: this.#usage };
    this.#ledger.settle();
    this.#closed = true;
    this.#wire.close();
    this.#end();
    this.#usage = this.#ledger.usage(this.model.audioCost);
    return { usage: this.#usage };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    while (true) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<RealtimeEvent>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done === true || next.value === undefined) return;
      yield next.value;
    }
  }

  #sessionUpdate(context: RealtimeContext): JsonObject {
    if (this.#dialect === 'openai') {
      return { type: 'session.update', session: openaiSession(context, this.model) };
    }
    return { type: 'session.update', session: xaiSession(context, this.model, this.#replace) };
  }

  #sendInject(textValue: string, delivery: Delivery): void {
    if (this.#dialect === 'xai' && delivery !== 'silent') {
      this.#send(forceMessage(textValue));
      return;
    }
    this.#send(userItem(textValue));
    if (delivery !== 'silent') this.#armCreate(false);
  }

  #send(event: JsonObject): void {
    this.#wire.send(JSON.stringify(event));
  }

  #assertOpen(): void {
    if (this.#closed) throw new VoiceRequestError('error', 'session is closed');
  }

  #push(event: RealtimeEvent): void {
    if (this.#closed) return;
    this.#ledger.observe(event);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else this.#queue.push(event);
  }

  #end(): void {
    for (const waiter of this.#waiters) waiter({ value: undefined, done: true });
    this.#waiters.length = 0;
  }

  #pendingFor(itemId: string): PendingAudio {
    const existing = this.#pending.get(itemId);
    if (existing !== undefined) return existing;
    const created = { chunks: [], cursor: 0 };
    this.#pending.set(itemId, created);
    return created;
  }

  #audio(itemId: string, encoded: string): void {
    this.#lastItem = itemId;
    const pending = this.#pendingFor(itemId);
    pending.chunks.push({
      data: decodeAudioBase64(encoded),
      format: this.#format,
      timestamp: 0,
    });
  }

  #armCreate(waitForCalls: boolean): void {
    if (this.#busy || (waitForCalls && this.#calls.size > 0)) {
      this.#heldCreate = true;
      return;
    }
    this.#heldCreate = false;
    this.#busy = true;
    this.#send(responseCreate());
  }

  #releaseResponse(): void {
    this.#busy = false;
    if (this.#heldCreate && this.#calls.size === 0) this.#armCreate(false);
  }

  #transcript(itemId: string, value: string, final: boolean): void {
    const pending = this.#pendingFor(itemId);
    const addition = final ? value.slice(pending.cursor) : value;
    const end = pending.cursor + addition.length;
    const tagged = addition.length === 0 ? undefined : end;
    for (const event of takeAudio(pending, itemId, this.#format, tagged)) this.#push(event);
    this.#push({ type: 'output_transcript', itemId, text: value, final });
  }

  #input(itemId: string, transcript: string, mode: 'append' | 'replace', final: boolean): void {
    const previous = this.#inputText.get(itemId) ?? '';
    const next = mode === 'append' ? `${previous}${transcript}` : transcript;
    this.#inputText.set(itemId, next);
    this.#push({ type: 'input_transcript', itemId, text: next, final });
  }

  #field(value: unknown, key: string): string {
    const object = record(value);
    if (object === undefined) return '';
    return text(object[key]);
  }

  #functionCall(event: Record<string, unknown>): void {
    const id = text(event.call_id);
    if (id.length > 0) this.#calls.add(id);
    this.#push({
      type: 'tool_call',
      blocking: this.model.toolCalls === 'blocking',
      call: {
        type: 'toolCall',
        id,
        name: text(event.name),
        arguments: argumentsOf(event.arguments),
      },
    });
  }

  #responseDone(event: Record<string, unknown>): void {
    this.#releaseResponse();
    const response = record(event.response);
    const output = response === undefined ? undefined : response.output;
    const first = Array.isArray(output) ? record(output[0]) : undefined;
    let itemId = this.#lastItem;
    if (first !== undefined && text(first.id).length > 0) itemId = text(first.id);
    const pending = this.#pendingFor(itemId);
    for (const audioEvent of takeAudio(pending, itemId, this.#format, undefined)) {
      this.#push(audioEvent);
    }
    const status = response === undefined ? '' : text(response.status);
    const usage = response === undefined ? undefined : response.usage;
    this.#push({
      type: 'response_done',
      itemId,
      interrupted: status === 'cancelled',
      usage: responseUsage(usage),
    });
  }

  #serverError(event: Record<string, unknown>): void {
    const detail = record(event.error);
    const code = detail === undefined ? '' : text(detail.code);
    const message = detail === undefined ? '' : text(detail.message);
    let fatal = false;
    if (code === 'max_duration') fatal = true;
    if (code === 'session_expired') fatal = true;
    this.#push({ type: 'error', error: message, fatal });
  }

  #apply(event: Record<string, unknown>): void {
    const type = text(event.type);
    if (type === 'session.created') {
      this.#push({ type: 'session_start', sessionId: this.#field(event.session, 'id') });
      return;
    }
    if (type === 'conversation.created') {
      this.#push({ type: 'resumption', handle: this.#field(event.conversation, 'id') });
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.#push({ type: 'input_speech_start' });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.delta') {
      this.#input(text(event.item_id), text(event.delta), 'append', false);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.updated') {
      this.#input(text(event.item_id), text(event.transcript), 'replace', false);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.#input(text(event.item_id), text(event.transcript), 'replace', true);
      return;
    }
    if (type === 'response.output_audio.delta') {
      this.#audio(text(event.item_id), text(event.delta));
      return;
    }
    if (type === 'response.output_audio_transcript.delta') {
      this.#transcript(text(event.item_id), text(event.delta), false);
      return;
    }
    if (type === 'response.output_audio_transcript.done') {
      this.#transcript(text(event.item_id), text(event.transcript), true);
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      this.#functionCall(event);
      return;
    }
    if (type === 'response.done') {
      this.#responseDone(event);
      return;
    }
    if (type === 'error') this.#serverError(event);
  }

  async #read(): Promise<void> {
    try {
      for await (const raw of this.#wire.incoming) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          this.#push({ type: 'error', error: 'invalid realtime event', fatal: false });
          continue;
        }
        const event = record(parsed);
        if (event === undefined || typeof event.type !== 'string') continue;
        this.#apply(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#push({ type: 'error', error: message, fatal: true });
    } finally {
      this.#closed = true;
      this.#end();
    }
  }
}

export async function connectVendorSession(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  vendor: VendorSessionOptions
): Promise<RealtimeSession> {
  if (options?.signal?.aborted === true) {
    throw new VoiceRequestError('aborted', 'session aborted');
  }
  if (options?.transport === 'webrtc' && vendor.wire === undefined) {
    throw new VoiceRequestError('error', 'webrtc requires a data channel wire');
  }
  const secret = credential(options);
  const token = options?.token?.value;
  const ephemeral = typeof token === 'string' && token.length > 0;
  const protocols: string[] = [];
  if (vendor.dialect === 'openai') protocols.push(`openai-insecure-api-key.${secret}`, 'realtime');
  else if (ephemeral) protocols.push(`xai-client-secret.${secret}`);
  else protocols.push('realtime');
  const resumeHandle = vendor.dialect === 'xai' ? options?.resumeHandle : undefined;
  const socket = realtimeSocket(sessionUrl(model, resumeHandle), options, protocols);
  const target: VoiceWireTarget = {
    url: socket.url,
    protocols: socket.protocols,
    headers: headersFor(options, secret, vendor.dialect === 'openai' || !ephemeral),
  };
  const open =
    vendor.wire !== undefined
      ? vendor.wire
      : (wireTarget: VoiceWireTarget) => openVoiceSocket(wireTarget, vendor.socket);
  const session = new VendorSession(model, context, vendor.dialect, vendor.replace, open(target));
  session.start(options);
  return session;
}

export function pcmFormat(sampleRate: number): AudioFormat {
  return { encoding: 'pcm16', sampleRate, channels: 1 };
}
