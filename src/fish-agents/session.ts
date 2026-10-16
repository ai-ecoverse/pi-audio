import type { JsonObject, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import type { AudioChunk, AudioSource } from '../audio.ts';
import { type EchoControl, micOpen, openEchoMic } from '../echo.ts';
import { VoiceRequestError } from '../errors.ts';
import type { HostedAgent, HostedAgentSpec, HostedCache } from '../hosted-agent.ts';
import type { Delivery, RealtimeModel } from '../models.ts';
import { pushQueue } from '../queue.ts';
import type {
  RealtimeContext,
  RealtimeEvent,
  RealtimeOptions,
  RealtimeSession,
} from '../realtime.ts';
import { planTruncation, RealtimeLedger } from '../realtime.ts';
import { priceAudio } from '../usage.ts';
import {
  type FishText,
  type FishTurn,
  ingestFishAudio,
  ingestFishData,
  ingestFishState,
  ingestFishText,
  ingestSpeakers,
  toolResult,
  userMessage,
} from './events.ts';
import { type ProvisionOptions, provisionAgent } from './provision.ts';
import {
  type FishHandlers,
  type FishRoom,
  type FishRoomFactory,
  type FishSdk,
  importFishSdk,
  openFishRoom,
} from './room.ts';

export interface FishOptions {
  room?: FishRoomFactory;
  sdk?: FishSdk;
  cache?: HostedCache;
  agentId?: string;
  now?: () => number;
  firstMessage?: string;
  microphone?: AudioSource;
  echo?: EchoControl;
  loadSdk?: (specifier: string) => Promise<FishSdk>;
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

function hasKey(options: RealtimeOptions | undefined): boolean {
  return typeof options?.apiKey === 'string' && options.apiKey.length > 0;
}

function talkerLlm(model: RealtimeModel<string>): string {
  const cascade = model.cascade;
  if (cascade === undefined) return 'fish';
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

function placeholder(agentId: string): HostedAgent {
  return { agentId, specHash: '', publishedAt: 0 };
}

async function ensureAgent(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  settings: FishOptions
): Promise<HostedAgent> {
  if (!hasKey(options)) {
    const id = settings.agentId;
    if (id === undefined || id.length === 0) {
      throw new VoiceRequestError('error', 'missing realtime credential');
    }
    return placeholder(id);
  }
  const provision: ProvisionOptions = {
    ...options,
    agentId: settings.agentId,
    cache: settings.cache,
    now: settings.now,
  };
  return provisionAgent(model, specFromContext(model, context), provision);
}

function sessionBody(
  agentId: string,
  context: RealtimeContext,
  firstMessage: string | undefined
): JsonObject {
  const overrides: JsonObject = {};
  if (context.instructions.length > 0) overrides.system_prompt = context.instructions;
  if (context.voice.length > 0) overrides.voice_id = context.voice;
  if (firstMessage !== undefined) overrides.first_message = firstMessage;
  const body: JsonObject = { agent_id: agentId };
  if (Object.keys(overrides).length > 0) body.overrides = overrides;
  return body;
}

function authHeaders(options: RealtimeOptions | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = options?.apiKey;
  if (typeof key === 'string' && key.length > 0) headers.Authorization = `Bearer ${key}`;
  const extra = options?.headers;
  if (extra === undefined) return headers;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

async function createSession(
  model: RealtimeModel<string>,
  agentId: string,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  firstMessage: string | undefined
): Promise<{ url: string; token: string; sessionId: string }> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${new URL(model.baseUrl).origin}/v1/agent/sessions`, {
    method: 'POST',
    headers: authHeaders(options),
    body: JSON.stringify(sessionBody(agentId, context, firstMessage)),
    signal: options?.signal,
  });
  if (!response.ok)
    throw new VoiceRequestError('error', `session request failed (${response.status})`);
  const json: unknown = await response.json();
  if (!isRecord(json)) throw new VoiceRequestError('error', 'session response was not an object');
  if (json.transport !== 'livekit') throw new VoiceRequestError('error', 'unsupported transport');
  const url = json.livekit_url;
  const token = json.token;
  const sessionId = json.session_id;
  if (typeof url !== 'string' || url.length === 0) {
    throw new VoiceRequestError('error', 'missing livekit url');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new VoiceRequestError('error', 'missing livekit token');
  }
  return {
    url,
    token,
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'session',
  };
}

async function joinTarget(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  settings: FishOptions
): Promise<{ url: string; token: string; sessionId: string }> {
  const minted = options?.token;
  if (minted !== undefined && minted.value.length > 0) {
    const url = minted.url;
    if (url === undefined || url.length === 0)
      throw new VoiceRequestError('error', 'missing livekit url');
    return { url, token: minted.value, sessionId: 'session' };
  }
  const agent = await ensureAgent(model, context, options, settings);
  return createSession(model, agent.agentId, context, options, settings.firstMessage);
}

async function openRoom(settings: FishOptions, handlers: FishHandlers): Promise<FishRoom> {
  if (settings.room !== undefined) return settings.room(handlers);
  if (settings.sdk !== undefined) return openFishRoom(settings.sdk, handlers);
  return openFishRoom(await importFishSdk(settings.loadSdk), handlers);
}

async function publishMicrophone(room: FishRoom, settings: FishOptions): Promise<void> {
  const mic = settings.microphone;
  if (mic === undefined) return;
  const echo = settings.echo;
  const mode = echo === undefined ? 'browser' : echo.mode;
  const source = echo === undefined ? mic : openEchoMic(echo, mic);
  await room.publishMic(source, micOpen(mode, false));
}

class FishSession implements RealtimeSession {
  readonly model: RealtimeModel<string>;
  readonly #context: RealtimeContext;
  readonly #room: FishRoom;
  readonly #now: () => number;
  readonly #started: number;
  readonly #ledger = new RealtimeLedger();
  readonly #events = pushQueue<RealtimeEvent>();
  readonly #turn: FishTurn = {
    dropAudio: false,
    discardFinals: 0,
    speaking: false,
    turnOpen: false,
  };
  #closed = false;
  #usage: Usage | undefined;

  constructor(
    model: RealtimeModel<string>,
    context: RealtimeContext,
    room: FishRoom,
    now: () => number
  ) {
    this.model = model;
    this.#context = context;
    this.#room = room;
    this.#now = now;
    this.#started = now();
  }

  start(sessionId: string): void {
    this.#emit({ type: 'session_start', sessionId });
  }

  #assertOpen(): void {
    if (this.#closed) throw new VoiceRequestError('error', 'session is closed');
  }

  #send(event: JsonObject): void {
    void Promise.resolve(this.#room.publishData(JSON.stringify(event))).catch((error: unknown) => {
      this.#fail(error);
    });
  }

  #emit(event: RealtimeEvent): void {
    if (this.#closed) return;
    this.#ledger.observe(event);
    this.#events.push(event);
  }

  appendAudio(chunk: AudioChunk): void {
    this.#assertOpen();
    this.#ledger.addInput(chunk);
    const source = (async function* source() {
      yield chunk;
    })();
    void publishMicrophone(this.#room, { microphone: source }).catch((error: unknown) =>
      this.#fail(error)
    );
  }

  sendText(value: string): void {
    this.#assertOpen();
    this.#ledger.addText();
    this.#send(userMessage(value, true));
  }

  inject(value: string, delivery: Delivery): void {
    this.#assertOpen();
    this.#ledger.submit(this.model.delivery, delivery, () => {
      this.#assertOpen();
      this.#ledger.addText();
      if (delivery === 'silent') this.#turn.discardFinals += 1;
      if (delivery === 'interrupt') this.#send({ type: 'user.interrupt' });
      this.#send(userMessage(value, delivery !== 'silent'));
    });
  }

  respond(callId: string, result: ToolResultMessage, delivery?: Delivery): void {
    this.#assertOpen();
    const send = () => {
      this.#send(toolResult(callId, resultText(result), result.isError));
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
    this.#send({ type: 'user.interrupt' });
    this.#ledger.settle();
  }

  update(patch: Partial<Pick<RealtimeContext, 'instructions' | 'tools' | 'voice'>>): void {
    this.#assertOpen();
    if (patch.tools !== undefined && this.model.liveToolUpdate === false) {
      throw new VoiceRequestError('error', 'live tool update is unsupported');
    }
    if (patch.tools !== undefined) this.#context.tools = patch.tools;
    if (patch.instructions !== undefined) this.#context.instructions = patch.instructions;
    if (patch.voice !== undefined) this.#context.voice = patch.voice;
  }

  async close(): Promise<{ usage: Usage }> {
    if (this.#usage !== undefined) return { usage: this.#usage };
    this.#ledger.settle();
    this.#closed = true;
    this.#room.close();
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

  handlers(): FishHandlers {
    return {
      data: (topic, json) => {
        if (topic !== 'agent-event' || !isRecord(json)) return;
        for (const event of ingestFishData(json)) this.#emit(event);
      },
      text: (identity, value, attributes) => {
        const packet: FishText = { identity, text: value, attributes };
        for (const event of ingestFishText(this.#turn, packet, this.#room.identity))
          this.#emit(event);
      },
      attribute: (key, value) => {
        if (key !== 'lk.agent.state') return;
        for (const event of ingestFishState(this.#turn, value)) this.#emit(event);
      },
      speakers: (identities) => {
        for (const event of ingestSpeakers(this.#turn, identities)) this.#emit(event);
      },
      audio: (chunk) => {
        for (const event of ingestFishAudio(this.#turn, chunk)) this.#emit(event);
      },
      fail: (error) => this.#fail(error),
    };
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#emit({ type: 'error', error: message, fatal: true });
  }
}

export async function connectFish(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options: RealtimeOptions | undefined,
  settings: FishOptions = {}
): Promise<RealtimeSession> {
  if (options?.signal?.aborted === true) throw new VoiceRequestError('aborted', 'session aborted');
  const target = await joinTarget(model, context, options, settings);
  const sessionHolder: { session?: FishSession } = {};
  const room = await openRoom(settings, {
    data: (topic, json) => sessionHolder.session?.handlers().data(topic, json, undefined),
    text: (identity, value, attributes) =>
      sessionHolder.session?.handlers().text(identity, value, attributes),
    attribute: (key, value) => sessionHolder.session?.handlers().attribute(key, value),
    speakers: (identities) => sessionHolder.session?.handlers().speakers(identities),
    audio: (chunk) => sessionHolder.session?.handlers().audio(chunk),
    fail: (error) => sessionHolder.session?.handlers().fail(error),
  });
  const now = settings.now !== undefined ? settings.now : Date.now;
  const session = new FishSession(model, context, room, now);
  sessionHolder.session = session;
  await room.connect(target.url, target.token);
  if (room.identity.length === 0) room.identity = 'user';
  await publishMicrophone(room, settings);
  session.start(target.sessionId);
  return session;
}
