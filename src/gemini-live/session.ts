import type { JsonObject, Message, Tool, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import type { AudioChunk, AudioFormat, TextSpan } from '../audio.ts';
import { blankUsage } from '../blank-usage.ts';
import { decodeAudioBase64, encodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';
import type { Delivery, RealtimeModel } from '../models.ts';
import {
  openVoiceSocket,
  type VoiceSocketConstructor,
  type VoiceWire,
  type VoiceWireTarget,
} from '../openai-realtime/socket.ts';
import type {
  RealtimeContext,
  RealtimeEvent,
  RealtimeOptions,
  RealtimeSession,
} from '../realtime.ts';
import { planTruncation, RealtimeLedger, realtimeSocket } from '../realtime.ts';

export type VoiceWireFactory = (target: VoiceWireTarget) => VoiceWire;

export interface GeminiOptions {
  wire?: VoiceWireFactory;
  socket?: VoiceSocketConstructor;
  vocabulary?: string[];
}

const scheduling: Record<Delivery, string> = {
  interrupt: 'INTERRUPT',
  when_idle: 'WHEN_IDLE',
  silent: 'SILENT',
};

interface PendingAudio {
  chunks: AudioChunk[];
  cursor: number;
}

interface IteratorResultEvent {
  value?: RealtimeEvent;
  done: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function credential(options: RealtimeOptions | undefined): { secret: string; ephemeral: boolean } {
  const token = options?.token?.value;
  if (typeof token === 'string' && token.length > 0) return { secret: token, ephemeral: true };
  const apiKey = options?.apiKey;
  if (typeof apiKey === 'string' && apiKey.length > 0) return { secret: apiKey, ephemeral: false };
  throw new VoiceRequestError('error', 'missing realtime credential');
}

function headersFor(options: RealtimeOptions | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const extra = options?.headers;
  if (extra === undefined) return headers;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

function sessionUrl(model: RealtimeModel<string>, secret: string, ephemeral: boolean): string {
  const url = new URL(model.baseUrl);
  if (ephemeral) url.searchParams.set('access_token', secret);
  else url.searchParams.set('key', secret);
  return url.toString();
}

function timeLeftMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 1000);
  if (typeof value === 'string') {
    const matched = /^(\d+(?:\.\d+)?)s$/.exec(value);
    if (matched !== null) return Math.round(Number(matched[1]) * 1000);
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return Math.round(asNumber * 1000);
  }
  const duration = record(value);
  if (duration !== undefined && typeof duration.seconds === 'number') {
    const nanos = typeof duration.nanos === 'number' ? duration.nanos : 0;
    return Math.round(duration.seconds * 1000 + nanos / 1e6);
  }
  return 0;
}

function count(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' ? value : 0;
}

function usageFrom(value: unknown): Usage {
  const usage = record(value);
  if (usage === undefined) return blankUsage();
  const input = count(usage, 'promptTokenCount');
  const response = count(usage, 'responseTokenCount');
  const candidates = count(usage, 'candidatesTokenCount');
  const output = response > 0 ? response : candidates;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function argumentsOf(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      const object = record(parsed);
      if (object === undefined) return {};
      return object as JsonObject;
    } catch {
      return {};
    }
  }
  const object = record(value);
  if (object === undefined) return {};
  return object as JsonObject;
}

function resultText(result: ToolResultMessage): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

function historyTurns(messages: Message[] | undefined): JsonObject[] {
  if (messages === undefined) return [];
  const turns: JsonObject[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const parts: JsonObject[] = [];
    for (const part of message.content) {
      if (typeof part === 'string') {
        parts.push({ text: part });
        continue;
      }
      if (part.type === 'text') parts.push({ text: part.text });
    }
    if (parts.length === 0) continue;
    turns.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return turns;
}

function declaration(tool: Tool, model: RealtimeModel<string>): JsonObject {
  const fn: JsonObject = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as JsonObject,
  };
  if (model.id === 'gemini-live-2.5-flash-native-audio') fn.behavior = 'NON_BLOCKING';
  if (model.toolCalls === 'blocking') fn.behavior = 'BLOCKING';
  return fn;
}

function transcription(model: RealtimeModel<string>, vocabulary: string[] | undefined): JsonObject {
  if (model.id !== 'gemini-3.8-live') return {};
  if (vocabulary === undefined) return {};
  return { customVocabulary: vocabulary };
}

function setupBody(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  handle: string | undefined,
  vocabulary: string[] | undefined,
  turns: JsonObject[]
): JsonObject {
  const setup: JsonObject = {
    model: `models/${model.id}`,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: context.instructions }] },
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: context.voice } },
    },
    inputAudioTranscription: transcription(model, vocabulary),
    outputAudioTranscription: {},
    contextWindowCompression: {
      triggerTokens: 100_000,
      slidingWindow: { targetTokens: 80_000 },
    },
    sessionResumption: handle === undefined ? {} : { handle },
  };
  if (context.tools.length > 0) {
    setup.tools = [{ functionDeclarations: context.tools.map((tool) => declaration(tool, model)) }];
  }
  if (turns.length > 0) setup.historyConfig = { initialHistoryInClientContent: true };
  return setup;
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
    if (end === undefined) return event;
    const last = index === chunks.length - 1;
    const next = last ? end : start + Math.round(((used + chunk.data.length) / total) * width);
    used += chunk.data.length;
    event.span = spanFor(itemId, cursor, next);
    cursor = next;
    return event;
  });
}

class GeminiSession implements RealtimeSession {
  readonly model: RealtimeModel<string>;
  readonly #context: RealtimeContext;
  readonly #vocabulary: string[] | undefined;
  readonly #turns: JsonObject[];
  readonly #open: VoiceWireFactory;
  readonly #target: VoiceWireTarget;
  readonly #ledger = new RealtimeLedger();
  readonly #queue: RealtimeEvent[] = [];
  readonly #waiters: Array<(result: IteratorResultEvent) => void> = [];
  readonly #outgoing: JsonObject[] = [];
  readonly #format: AudioFormat;
  #wire: VoiceWire;
  #pending: PendingAudio = { chunks: [], cursor: 0 };
  #item = 'g0';
  #turn = 0;
  #heard = '';
  #spoken = '';
  #handle: string | undefined;
  #tokens: Usage = blankUsage();
  #ready = false;
  #historySent = false;
  #closed = false;
  #ended = false;
  #meters: Usage | undefined;
  readonly #toolGroups = new Map<string, { pending: Set<string>; responses: JsonObject[] }>();
  readonly #toolGroupOf = new Map<string, string>();

  constructor(
    model: RealtimeModel<string>,
    context: RealtimeContext,
    vocabulary: string[] | undefined,
    open: VoiceWireFactory,
    target: VoiceWireTarget,
    wire: VoiceWire
  ) {
    this.model = model;
    this.#context = context;
    this.#vocabulary = vocabulary;
    this.#turns = historyTurns(context.history);
    this.#open = open;
    this.#target = target;
    this.#wire = wire;
    this.#format = model.outputFormat;
  }

  start(handle: string | undefined): void {
    if (handle !== undefined && handle.length > 0) this.#handle = handle;
    this.#wire.send(JSON.stringify({ setup: this.#setup(handle) }));
    void this.#read(this.#wire);
  }

  #setup(handle: string | undefined): JsonObject {
    return setupBody(this.model, this.#context, handle, this.#vocabulary, this.#turns);
  }

  #assertOpen(): void {
    if (this.#closed) throw new VoiceRequestError('error', 'session is closed');
  }

  #send(event: JsonObject): void {
    if (!this.#ready) {
      this.#outgoing.push(event);
      return;
    }
    this.#wire.send(JSON.stringify(event));
  }

  #push(event: RealtimeEvent): void {
    if (this.#closed) return;
    this.#ledger.observe(event);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else this.#queue.push(event);
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.({ done: true });
  }

  appendAudio(chunk: AudioChunk): void {
    this.#assertOpen();
    this.#ledger.addInput(chunk);
    this.#send({
      realtimeInput: {
        audio: {
          data: encodeAudioBase64(chunk.data),
          mimeType: `audio/pcm;rate=${String(chunk.format.sampleRate)}`,
        },
      },
    });
  }

  appendVideoFrame(jpeg: Uint8Array): void {
    this.#assertOpen();
    if (this.model.video === undefined) {
      throw new VoiceRequestError('error', 'video is unsupported');
    }
    this.#send({
      realtimeInput: { video: { data: encodeAudioBase64(jpeg), mimeType: 'image/jpeg' } },
    });
  }

  sendText(value: string): void {
    this.#assertOpen();
    this.#ledger.addText();
    this.#send(this.#client(value, true));
  }

  inject(value: string, delivery: Delivery): void {
    this.#assertOpen();
    this.#ledger.submit(this.model.delivery, delivery, () => {
      this.#assertOpen();
      this.#ledger.addText();
      if (delivery === 'silent') this.#send(this.#client(value, false));
      else if (delivery === 'when_idle') this.#send({ realtimeInput: { text: value } });
      else this.#send(this.#client(value, true));
    });
  }

  respond(callId: string, result: ToolResultMessage, delivery?: Delivery): void {
    this.#assertOpen();
    const send = () => {
      const mode = delivery === undefined ? 'interrupt' : delivery;
      this.#queueTool(callId, {
        id: callId,
        name: result.toolName,
        scheduling: scheduling[mode],
        response: {
          status: result.isError ? 'error' : 'ok',
          retryable: false,
          message: resultText(result),
        },
      });
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
    planTruncation(this.model.truncation, heard);
    this.#ledger.settle();
  }

  update(patch: Partial<Pick<RealtimeContext, 'instructions' | 'tools' | 'voice'>>): void {
    this.#assertOpen();
    if (patch.tools !== undefined && !this.model.liveToolUpdate) {
      throw new VoiceRequestError('error', 'live tool update is unsupported');
    }
  }

  async close(): Promise<{ usage: Usage }> {
    if (this.#meters !== undefined) return { usage: this.#meters };
    this.#closed = true;
    this.#ledger.settle();
    this.#wire.close();
    this.#end();
    this.#meters = this.#ledger.usage(this.model.audioCost);
    return { usage: this.#meters };
  }

  #client(value: string, turnComplete: boolean): JsonObject {
    return {
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: value }] }],
        turnComplete,
      },
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    while (true) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResultEvent>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done === true || next.value === undefined) return;
      yield next.value;
    }
  }

  #audio(encoded: string): void {
    if (encoded.length === 0) return;
    this.#pending.chunks.push({
      data: decodeAudioBase64(encoded),
      format: this.#format,
      timestamp: 0,
    });
  }

  #transcript(delta: string, final: boolean): void {
    const end = this.#pending.cursor + delta.length;
    const tagged = delta.length === 0 ? undefined : end;
    for (const event of takeAudio(this.#pending, this.#item, this.#format, tagged)) {
      this.#push(event);
    }
    this.#spoken += delta;
    this.#push({ type: 'output_transcript', itemId: this.#item, text: delta, final });
  }

  #input(transcript: string, final: boolean): void {
    if (transcript.length > 0) this.#heard = transcript;
    this.#push({ type: 'input_transcript', itemId: this.#item, text: this.#heard, final });
  }

  #finish(interrupted: boolean): void {
    for (const event of takeAudio(this.#pending, this.#item, this.#format, undefined)) {
      this.#push(event);
    }
    if (this.#spoken.length > 0) {
      this.#push({
        type: 'output_transcript',
        itemId: this.#item,
        text: this.#spoken,
        final: true,
      });
    }
    if (this.#heard.length > 0) {
      this.#push({ type: 'input_transcript', itemId: this.#item, text: this.#heard, final: true });
    }
    this.#push({
      type: 'response_done',
      itemId: this.#item,
      interrupted,
      usage: this.#tokens,
    });
    this.#tokens = blankUsage();
    this.#spoken = '';
    this.#heard = '';
    this.#turn += 1;
    this.#item = `g${String(this.#turn)}`;
    this.#pending = { chunks: [], cursor: 0 };
  }

  #onSetup(value: unknown): void {
    const done = record(value);
    const sessionId = done === undefined ? '' : text(done.sessionId);
    this.#push({ type: 'session_start', sessionId });
    if (!this.#historySent && this.#turns.length > 0) {
      this.#historySent = true;
      this.#wire.send(
        JSON.stringify({ clientContent: { turns: this.#turns, turnComplete: false } })
      );
    }
    this.#ready = true;
    const pending = this.#outgoing.splice(0);
    for (const event of pending) this.#wire.send(JSON.stringify(event));
  }

  #onResume(value: unknown): void {
    const update = record(value);
    if (update === undefined) return;
    const handle = text(update.newHandle);
    if (handle.length === 0 || update.resumable !== true) return;
    this.#handle = handle;
    this.#push({ type: 'resumption', handle });
  }

  #onGoAway(value: unknown): 'stop' | VoiceWire {
    const gone = record(value);
    const left = gone === undefined ? 0 : timeLeftMs(gone.timeLeft);
    this.#push({ type: 'go_away', timeLeftMs: left });
    const handle = this.#handle;
    if (handle === undefined) {
      this.#push({ type: 'error', error: 'session ended', fatal: true });
      return 'stop';
    }
    const next = this.#open(this.#target);
    this.#wire = next;
    this.#ready = false;
    next.send(JSON.stringify({ setup: this.#setup(handle) }));
    return next;
  }

  #queueTool(callId: string, response: JsonObject): void {
    const groupId = this.#toolGroupOf.get(callId) ?? '';
    const group = groupId.length === 0 ? undefined : this.#toolGroups.get(groupId);
    if (group === undefined) {
      this.#send({ toolResponse: { functionResponses: [response] } });
      return;
    }
    group.responses.push(response);
    group.pending.delete(callId);
    this.#toolGroupOf.delete(callId);
    if (group.pending.size > 0) return;
    this.#toolGroups.delete(groupId);
    this.#send({ toolResponse: { functionResponses: group.responses } });
  }

  #onToolCall(value: unknown): void {
    const call = record(value);
    if (call === undefined || !Array.isArray(call.functionCalls)) return;
    const ids: string[] = [];
    for (const entry of call.functionCalls) {
      const fn = record(entry);
      if (fn === undefined) continue;
      const id = text(fn.id);
      if (id.length > 0) ids.push(id);
      this.#push({
        type: 'tool_call',
        blocking: this.model.toolCalls === 'blocking',
        call: {
          type: 'toolCall',
          id,
          name: text(fn.name),
          arguments: argumentsOf(fn.args),
        },
      });
    }
    const groupId = ids.at(0);
    if (groupId === undefined) return;
    this.#toolGroups.set(groupId, { pending: new Set(ids), responses: [] });
    for (const id of ids) this.#toolGroupOf.set(id, groupId);
  }

  #onCancel(value: unknown): void {
    const cancellation = record(value);
    if (cancellation === undefined || !Array.isArray(cancellation.ids)) return;
    for (const id of cancellation.ids) {
      if (typeof id !== 'string') continue;
      this.#push({ type: 'tool_call_cancelled', callId: id });
    }
  }

  #onServer(value: unknown): void {
    const content = record(value);
    if (content === undefined) return;
    this.#modelTurn(content.modelTurn);
    this.#caption(content.outputTranscription, 'output');
    this.#caption(content.inputTranscription, 'input');
    if (content.interrupted === true) {
      this.#push({ type: 'input_speech_start' });
      this.#finish(true);
      return;
    }
    if (content.turnComplete === true) this.#finish(false);
  }

  #modelTurn(value: unknown): void {
    const turn = record(value);
    if (turn === undefined || !Array.isArray(turn.parts)) return;
    for (const part of turn.parts) {
      const entry = record(part);
      if (entry === undefined) continue;
      const inline = record(entry.inlineData);
      if (inline === undefined) continue;
      if (!text(inline.mimeType).startsWith('audio/')) continue;
      this.#audio(text(inline.data));
    }
  }

  #caption(value: unknown, kind: 'input' | 'output'): void {
    const caption = record(value);
    if (caption === undefined) return;
    if (kind === 'input') this.#input(text(caption.text), false);
    else this.#transcript(text(caption.text), false);
  }

  #onError(value: unknown): void {
    const detail = record(value);
    if (detail === undefined) {
      const message = text(value);
      this.#push({
        type: 'error',
        error: message.length > 0 ? message : 'realtime error',
        fatal: false,
      });
      return;
    }
    const code = text(detail.code);
    const message = text(detail.message);
    let fatal = false;
    if (code === 'MAX_DURATION' || code === 'SESSION_EXPIRED') fatal = true;
    this.#push({
      type: 'error',
      error: message.length > 0 ? message : 'realtime error',
      fatal,
    });
  }

  #apply(event: Record<string, unknown>): 'ok' | 'stop' | VoiceWire {
    if (event.usageMetadata !== undefined) this.#tokens = usageFrom(event.usageMetadata);
    if (event.inputTranscription !== undefined) this.#caption(event.inputTranscription, 'input');
    if (event.outputTranscription !== undefined) this.#caption(event.outputTranscription, 'output');
    if (event.setupComplete !== undefined) this.#onSetup(event.setupComplete);
    if (event.sessionResumptionUpdate !== undefined) this.#onResume(event.sessionResumptionUpdate);
    if (event.toolCall !== undefined) this.#onToolCall(event.toolCall);
    if (event.toolCallCancellation !== undefined) this.#onCancel(event.toolCallCancellation);
    if (event.serverContent !== undefined) this.#onServer(event.serverContent);
    if (event.error !== undefined) this.#onError(event.error);
    if (event.goAway !== undefined) return this.#onGoAway(event.goAway);
    return 'ok';
  }

  #ingest(raw: string): 'ok' | 'stop' | VoiceWire {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#push({ type: 'error', error: 'invalid realtime event', fatal: false });
      return 'ok';
    }
    const event = record(parsed);
    if (event === undefined) return 'ok';
    return this.#apply(event);
  }

  async #read(wire: VoiceWire): Promise<void> {
    let reconnect: VoiceWire | undefined;
    try {
      for await (const raw of wire.incoming) {
        const action = this.#ingest(raw);
        if (action === 'stop') return;
        if (action !== 'ok') {
          reconnect = action;
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#push({ type: 'error', error: message, fatal: true });
    } finally {
      if (reconnect !== undefined) {
        wire.close();
        void this.#read(reconnect);
      } else {
        this.#closed = true;
        this.#end();
      }
    }
  }
}

export async function connectGeminiSession(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  gemini: GeminiOptions
): Promise<RealtimeSession> {
  if (options?.signal?.aborted === true) {
    throw new VoiceRequestError('aborted', 'session aborted');
  }
  const { secret, ephemeral } = credential(options);
  const socket = realtimeSocket(sessionUrl(model, secret, ephemeral), options, []);
  const target: VoiceWireTarget = {
    url: socket.url,
    protocols: socket.protocols,
    headers: headersFor(options),
  };
  const open =
    gemini.wire !== undefined
      ? gemini.wire
      : (wireTarget: VoiceWireTarget) => openVoiceSocket(wireTarget, gemini.socket);
  const session = new GeminiSession(model, context, gemini.vocabulary, open, target, open(target));
  const handle = options?.resumeHandle;
  session.start(handle);
  const signal = options?.signal;
  if (signal !== undefined) {
    signal.addEventListener('abort', () => void session.close(), { once: true });
  }
  return session;
}

export function pcmFormat(sampleRate: number): AudioFormat {
  return { encoding: 'pcm16', sampleRate, channels: 1 };
}
