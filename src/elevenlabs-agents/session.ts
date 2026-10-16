import type { JsonObject, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import type { AudioChunk } from '../audio.ts';
import { encodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';
import type { HostedAgent, HostedAgentSpec, HostedCache } from '../hosted-agent.ts';
import type { Delivery, RealtimeModel } from '../models.ts';
import {
  openVoiceSocket,
  type VoiceSocketConstructor,
  type VoiceWire,
  type VoiceWireTarget,
} from '../openai-realtime/socket.ts';
import { pushQueue } from '../queue.ts';
import type {
  RealtimeContext,
  RealtimeEvent,
  RealtimeOptions,
  RealtimeSession,
} from '../realtime.ts';
import { planTruncation, RealtimeLedger, realtimeSocket } from '../realtime.ts';
import { mintRealtimeToken } from '../tokens.ts';
import { priceAudio } from '../usage.ts';
import { ingestElevenLabs, type TalkTurn } from './events.ts';
import { type ProvisionOptions, provisionAgent } from './provision.ts';

export type VoiceWireFactory = (target: VoiceWireTarget) => VoiceWire;

export interface ElevenLabsOptions {
  wire?: VoiceWireFactory;
  socket?: VoiceSocketConstructor;
  cache?: HostedCache;
  agentId?: string;
  now?: () => number;
  firstMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultText(result: ToolResultMessage): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('\n');
}

function injectMessage(value: string, delivery: Delivery): JsonObject {
  if (delivery === 'silent') {
    return { type: 'contextual_update', text: value, context_id: 'pi-audio' };
  }
  const text = delivery === 'when_idle' ? `[agent update] ${value}` : value;
  return { type: 'user_message', text };
}

function toolResult(callId: string, result: ToolResultMessage): JsonObject {
  return {
    type: 'client_tool_result',
    tool_call_id: callId,
    result: resultText(result),
    is_error: result.isError,
  };
}

export function talkerLlm(model: RealtimeModel<string>): string {
  const cascade = model.cascade;
  if (cascade === undefined) return 'gemini-2.5-flash';
  return cascade.llm;
}

export function specFromContext(
  model: RealtimeModel<string>,
  context: RealtimeContext
): HostedAgentSpec {
  return {
    name: model.name,
    instructions: context.instructions,
    tools: context.tools,
    voice: context.voice,
    llm: talkerLlm(model),
  };
}

function hasKey(options: RealtimeOptions | undefined): boolean {
  return typeof options?.apiKey === 'string' && options.apiKey.length > 0;
}

function agentFromToken(value: string): string | undefined {
  if (!value.startsWith('ws')) return undefined;
  const id = new URL(value).searchParams.get('agent_id');
  return id === null ? undefined : id;
}

function conversationUrl(model: RealtimeModel<string>, agentId: string, token?: string): string {
  const url = new URL(model.baseUrl);
  url.searchParams.set('agent_id', agentId);
  if (token !== undefined) url.searchParams.set('token', token);
  return url.toString();
}

function socketHeaders(options: RealtimeOptions | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const extra = options?.headers;
  if (extra === undefined) return headers;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

function placeholder(agentId: string): HostedAgent {
  return { agentId, specHash: '', publishedAt: 0 };
}

async function ensureAgent(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  settings: ElevenLabsOptions
): Promise<HostedAgent> {
  const token = options?.token?.value;
  if (typeof token === 'string' && token.length > 0) {
    return placeholder(agentFromToken(token) ?? settings.agentId ?? model.id);
  }
  if (!hasKey(options)) return placeholder(settings.agentId ?? model.id);
  const provision: ProvisionOptions = {
    ...options,
    agentId: settings.agentId,
    cache: settings.cache,
    now: settings.now,
  };
  return provisionAgent(model, specFromContext(model, context), provision);
}

async function socketUrl(
  model: RealtimeModel<string>,
  agentId: string,
  context: RealtimeContext,
  options: RealtimeOptions | undefined
): Promise<string> {
  const token = options?.token?.value;
  if (typeof token === 'string' && token.startsWith('ws')) return token;
  if (typeof token === 'string' && token.length > 0) return conversationUrl(model, agentId, token);
  if (!hasKey(options)) return conversationUrl(model, agentId);
  const minted = await mintRealtimeToken(
    model,
    {
      agentId,
      instructions: context.instructions,
      voice: context.voice,
      tools: context.tools,
    },
    options
  );
  return minted.value;
}

function initiation(context: RealtimeContext, firstMessage: string | undefined): JsonObject {
  const agent: JsonObject = { prompt: { prompt: context.instructions } };
  if (firstMessage !== undefined) agent.first_message = firstMessage;
  return {
    type: 'conversation_initiation_client_data',
    conversation_config_override: { agent, tts: { voice_id: context.voice } },
    dynamic_variables: {},
    custom_llm_extra_body: {},
  };
}

class ElevenLabsSession implements RealtimeSession {
  readonly model: RealtimeModel<string>;
  readonly #context: RealtimeContext;
  readonly #wire: VoiceWire;
  readonly #now: () => number;
  readonly #started: number;
  readonly #ledger = new RealtimeLedger();
  readonly #events = pushQueue<RealtimeEvent>();
  readonly #turn: TalkTurn = { vad: false, dropAudio: false, lastInterruptId: -1 };
  #closed = false;
  #usage: Usage | undefined;

  constructor(
    model: RealtimeModel<string>,
    context: RealtimeContext,
    wire: VoiceWire,
    now: () => number
  ) {
    this.model = model;
    this.#context = context;
    this.#wire = wire;
    this.#now = now;
    this.#started = now();
  }

  start(firstMessage: string | undefined): void {
    this.#send(initiation(this.#context, firstMessage));
    void this.#read();
  }

  #assertOpen(): void {
    if (this.#closed) throw new VoiceRequestError('error', 'session is closed');
  }

  #send(event: JsonObject): void {
    this.#wire.send(JSON.stringify(event));
  }

  #emit(event: RealtimeEvent): void {
    if (this.#closed) return;
    this.#ledger.observe(event);
    this.#events.push(event);
  }

  appendAudio(chunk: AudioChunk): void {
    this.#assertOpen();
    this.#ledger.addInput(chunk);
    this.#send({ user_audio_chunk: encodeAudioBase64(chunk.data) });
  }

  sendText(value: string): void {
    this.#assertOpen();
    this.#ledger.addText();
    this.#send({ type: 'user_message', text: value });
  }

  inject(value: string, delivery: Delivery): void {
    this.#assertOpen();
    this.#ledger.submit(this.model.delivery, delivery, () => {
      this.#assertOpen();
      this.#ledger.addText();
      this.#send(injectMessage(value, delivery));
    });
  }

  respond(callId: string, result: ToolResultMessage, delivery?: Delivery): void {
    this.#assertOpen();
    const send = () => {
      this.#send(toolResult(callId, result));
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
    this.#turn.dropAudio = true;
    this.#ledger.settle();
  }

  update(patch: Partial<Pick<RealtimeContext, 'instructions' | 'tools' | 'voice'>>): void {
    this.#assertOpen();
    if (patch.tools !== undefined && this.model.liveToolUpdate === false) {
      throw new VoiceRequestError('error', 'live tool update is unsupported');
    }
    if (patch.tools !== undefined) this.#context.tools = patch.tools;
    if (patch.instructions !== undefined) {
      this.#context.instructions = patch.instructions;
      this.#send({
        type: 'contextual_update',
        text: patch.instructions,
        context_id: 'pi-audio',
      });
    }
    if (patch.voice !== undefined) this.#context.voice = patch.voice;
  }

  async close(): Promise<{ usage: Usage }> {
    if (this.#usage !== undefined) return { usage: this.#usage };
    this.#ledger.settle();
    this.#closed = true;
    this.#wire.close();
    this.#events.end();
    const inputSeconds = Math.max(0, this.#now() - this.#started) / 1000;
    this.#usage = priceAudio(this.model.audioCost, {
      inputSeconds,
      outputSeconds: this.#ledger.outputSeconds,
      textMessages: this.#ledger.textMessages,
    });
    return { usage: this.#usage };
  }

  [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    return this.#events.iterable[Symbol.asyncIterator]();
  }

  #onRaw(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#emit({ type: 'error', error: 'invalid realtime event', fatal: false });
      return;
    }
    if (!isRecord(parsed)) return;
    const ingested = ingestElevenLabs(this.#turn, parsed, this.model.outputFormat);
    for (const reply of ingested.replies) this.#send(reply);
    for (const event of ingested.events) this.#emit(event);
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#emit({ type: 'error', error: message, fatal: true });
  }

  async #read(): Promise<void> {
    try {
      for await (const raw of this.#wire.incoming) this.#onRaw(raw);
    } catch (error) {
      this.#fail(error);
    } finally {
      this.#closed = true;
      this.#events.end();
    }
  }
}

export async function connectElevenLabs(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  settings: ElevenLabsOptions = {}
): Promise<RealtimeSession> {
  if (options?.signal?.aborted === true) throw new VoiceRequestError('aborted', 'session aborted');
  const agent = await ensureAgent(model, context, options, settings);
  const url = await socketUrl(model, agent.agentId, context, options);
  const routed = realtimeSocket(url, options, []);
  const target: VoiceWireTarget = {
    url: routed.url,
    protocols: routed.protocols,
    headers: socketHeaders(options),
  };
  const open =
    settings.wire !== undefined
      ? settings.wire
      : (wireTarget: VoiceWireTarget) => openVoiceSocket(wireTarget, settings.socket);
  const now = settings.now !== undefined ? settings.now : Date.now;
  const session = new ElevenLabsSession(model, context, open(target), now);
  session.start(settings.firstMessage);
  return session;
}
