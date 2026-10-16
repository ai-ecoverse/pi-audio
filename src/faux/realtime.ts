import type { Usage } from '@earendil-works/pi-ai';
import type { AudioChunk } from '../audio.ts';
import { VoiceRequestError } from '../errors.ts';
import {
  type Delivery,
  type DeliverySupport,
  type RealtimeModel,
  registerVoiceModel,
} from '../models.ts';
import {
  planTruncation,
  type RealtimeContext,
  type RealtimeEvent,
  RealtimeLedger,
  type RealtimeOptions,
  type RealtimeSession,
  type RealtimeSocket,
  realtimeSocket,
  type TruncationPlan,
} from '../realtime.ts';
import { registerRealtimeApiProvider } from '../registry.ts';
import type { RealtimeAudioCost } from '../usage.ts';
import { modelKey, pcm, shareApi, zeroCost } from './shared.ts';

export type FauxRealtimeCall =
  | { method: 'appendAudio'; chunk: AudioChunk }
  | { method: 'appendVideoFrame'; jpeg: Uint8Array }
  | { method: 'sendText'; text: string }
  | { method: 'inject'; text: string; delivery: Delivery; support: DeliverySupport }
  | {
      method: 'respond';
      callId: string;
      result: Parameters<RealtimeSession['respond']>[1];
      delivery?: Delivery;
      support?: DeliverySupport;
    }
  | {
      method: 'interrupt';
      heard?: { itemId: string; heardMs: number };
      plan: TruncationPlan;
    }
  | { method: 'update'; patch: Parameters<RealtimeSession['update']>[0] }
  | { method: 'close' };

export interface FauxRealtimeFlags {
  toolCalls?: RealtimeModel<string>['toolCalls'];
  delivery?: Record<Delivery, DeliverySupport>;
  truncation?: RealtimeModel<string>['truncation'];
}

export interface FauxRealtimeOptions extends FauxRealtimeFlags {
  api?: string;
  provider?: string;
  id?: string;
  name?: string;
  events?: RealtimeEvent[];
  audioCost?: RealtimeAudioCost;
}

export interface FauxRealtime {
  model: RealtimeModel<string>;
  calls: FauxRealtimeCall[];
  readonly socket: RealtimeSocket | undefined;
  emit(event: RealtimeEvent): void;
  setFlags(flags: FauxRealtimeFlags): void;
  unregister(): void;
}

interface IteratorResultEvent {
  value?: RealtimeEvent;
  done: boolean;
}

class FauxSession implements RealtimeSession {
  readonly model: RealtimeModel<string>;
  readonly #calls: FauxRealtimeCall[];
  readonly #ledger = new RealtimeLedger();
  readonly #queue: RealtimeEvent[] = [];
  readonly #waiters: Array<(result: IteratorResultEvent) => void> = [];
  #closed = false;

  constructor(model: RealtimeModel<string>, calls: FauxRealtimeCall[]) {
    this.model = model;
    this.#calls = calls;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed) throw new VoiceRequestError('error', 'session is closed');
  }

  push(event: RealtimeEvent): void {
    if (this.#closed) return;
    this.#ledger.observe(event);
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#queue.push(event);
  }

  appendAudio(chunk: AudioChunk): void {
    this.#assertOpen();
    this.#ledger.addInput(chunk);
    this.#calls.push({ method: 'appendAudio', chunk });
  }

  appendVideoFrame(jpeg: Uint8Array): void {
    this.#assertOpen();
    if (this.model.video === undefined)
      throw new VoiceRequestError('error', 'video is unsupported');
    this.#calls.push({ method: 'appendVideoFrame', jpeg });
  }

  sendText(text: string): void {
    this.#assertOpen();
    this.#ledger.addText();
    this.#calls.push({ method: 'sendText', text });
  }

  inject(text: string, delivery: Delivery): void {
    this.#assertOpen();
    const table = this.model.delivery;
    this.#ledger.submit(table, delivery, () => {
      this.#assertOpen();
      this.#ledger.addText();
      this.#calls.push({ method: 'inject', text, delivery, support: table[delivery] });
    });
  }

  respond(
    callId: string,
    result: Parameters<RealtimeSession['respond']>[1],
    delivery?: Delivery
  ): void {
    this.#assertOpen();
    const send = (support?: DeliverySupport) => {
      this.#calls.push({ method: 'respond', callId, result, delivery, support });
    };
    if (delivery === undefined) {
      send();
      return;
    }
    const table = this.model.delivery;
    this.#ledger.submit(table, delivery, () => {
      this.#assertOpen();
      send(table[delivery]);
    });
  }

  interrupt(heard?: { itemId: string; heardMs: number }): void {
    this.#assertOpen();
    this.#calls.push({
      method: 'interrupt',
      heard,
      plan: planTruncation(this.model.truncation, heard),
    });
    this.#ledger.settle();
  }

  update(patch: Parameters<RealtimeSession['update']>[0]): void {
    this.#assertOpen();
    if (patch.tools !== undefined && !this.model.liveToolUpdate) {
      throw new VoiceRequestError('error', 'live tool update is unsupported');
    }
    this.#calls.push({ method: 'update', patch });
  }

  async close(): Promise<{ usage: Usage }> {
    if (this.#closed) return { usage: this.#ledger.usage(this.model.audioCost) };
    this.#ledger.settle();
    this.#calls.push({ method: 'close' });
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.({ done: true });
    return { usage: this.#ledger.usage(this.model.audioCost) };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    while (true) {
      const queued = this.#queue.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResultEvent>((resolve) => this.#waiters.push(resolve));
      if (next.done || next.value === undefined) return;
      yield next.value;
    }
  }
}

interface RealtimeState {
  model: RealtimeModel<string>;
  calls: FauxRealtimeCall[];
  events: RealtimeEvent[];
  pending: RealtimeEvent[];
  socket?: RealtimeSocket;
  session?: FauxSession;
}

const states = new Map<string, RealtimeState>();
const apis = new Map<string, () => void>();

const nativeDelivery: Record<Delivery, DeliverySupport> = {
  interrupt: 'native',
  when_idle: 'native',
  silent: 'native',
};

export function registerFauxRealtime(options: FauxRealtimeOptions = {}): FauxRealtime {
  const model: RealtimeModel<string> = {
    id: options.id ?? 'faux-realtime',
    name: options.name ?? 'Faux realtime',
    api: options.api ?? 'faux-realtime',
    provider: options.provider ?? 'faux',
    baseUrl: 'http://localhost:0',
    type: 'realtime',
    transports: ['websocket'],
    toolCalls: options.toolCalls ?? 'blocking',
    inputFormat: pcm(24000),
    outputFormat: pcm(24000),
    resumable: false,
    ephemeralAuth: false,
    voices: [{ id: 'faux', name: 'Faux' }],
    provisioning: 'none',
    delivery: options.delivery ?? nativeDelivery,
    truncation: options.truncation ?? 'client',
    liveToolUpdate: true,
    cost: zeroCost,
    audioCost: options.audioCost ?? {},
  };
  const state: RealtimeState = { model, calls: [], events: options.events ?? [], pending: [] };
  states.set(modelKey(model), state);
  const unregisterModel = registerVoiceModel(model);
  const release = shareApi(
    apis,
    model.api,
    () => registerRealtimeApiProvider({ api: model.api, connect: connectFaux }),
    () => [...states.values()].some((entry) => entry.model.api === model.api)
  );
  return {
    model,
    calls: state.calls,
    get socket() {
      return state.socket;
    },
    emit(event) {
      if (state.session) state.session.push(event);
      if (!state.session || state.session.closed) state.pending.push(event);
    },
    setFlags(flags) {
      if (flags.toolCalls) state.model.toolCalls = flags.toolCalls;
      if (flags.delivery) state.model.delivery = flags.delivery;
      if (flags.truncation) state.model.truncation = flags.truncation;
    },
    unregister() {
      if (states.get(modelKey(model)) === state) states.delete(modelKey(model));
      unregisterModel();
      release();
    },
  };
}

async function connectFaux(
  model: RealtimeModel<string>,
  _context: RealtimeContext,
  options?: RealtimeOptions
): Promise<RealtimeSession> {
  const state = states.get(modelKey(model));
  if (!state) throw new Error(`Unknown faux realtime model ${model.provider}/${model.id}`);
  state.socket = realtimeSocket(model.baseUrl, options, ['realtime']);
  const session = new FauxSession(state.model, state.calls);
  state.session = session;
  for (const event of state.pending) session.push(event);
  state.pending = [];
  for (const event of state.events) session.push(event);
  return session;
}
