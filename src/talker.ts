import {
  type JsonObject,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  Type,
} from '@earendil-works/pi-ai';
import { VoiceRequestError } from './errors.ts';
import type { Delivery } from './models.ts';
import type { RealtimeSession } from './realtime.ts';

const heardLimit = 20;

export const talkerTools = ['ask_agent', 'read'] as const;

export const askAgent: Tool = {
  name: 'ask_agent',
  description:
    'Hand a request to the coding agent. Use for anything that needs files, the browser, tools or more than a few seconds of thought.',
  parameters: Type.Object({
    request: Type.String(),
    context: Type.Optional(Type.String()),
  }),
};

export type ThinkerUpdate =
  | { type: 'progress'; text: string }
  | { type: 'result'; message: ToolResultMessage };

export interface Thinker {
  ask(request: string, heard: string[], signal: AbortSignal): AsyncIterable<ThinkerUpdate>;
}

export interface BindThinkerOptions {
  progress: Delivery;
  result: Delivery;
  ack: string;
  directTimeoutMs: number;
  directMaxChars: number;
}

export type ThinkerCaption =
  | { type: 'thinker_progress'; callId: string; text: string }
  | { type: 'thinker_result'; callId: string; summary: string; isError: boolean };

export type ThinkerPhase =
  | { phase: 'thinking' }
  | { phase: 'tool'; toolName: string; toolCallId: string; args: JsonObject }
  | { phase: 'idle' };

export interface BoundThinker {
  captions: AsyncIterable<ThinkerCaption>;
  phases: AsyncIterable<ThinkerPhase>;
  done: Promise<void>;
}

class PushStream<T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  readonly #waiters: Array<(result: { value?: T; done: boolean }) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#queue.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.({ done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<{ value?: T; done: boolean }>((resolve) =>
        this.#waiters.push(resolve)
      );
      if (next.done || next.value === undefined) return;
      yield next.value;
    }
  }
}

function send(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof VoiceRequestError)) throw error;
  }
}

function textOf(message: ToolResultMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function acknowledged(call: ToolCall, ack: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: ack }],
    isError: false,
    timestamp: Date.now(),
  };
}

function errorResult(call: ToolCall, error: unknown): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    timestamp: Date.now(),
  };
}

function capResult(result: ToolResultMessage, maxChars: number): ToolResultMessage {
  let left = maxChars;
  const content = result.content.map((part) => {
    if (part.type !== 'text') return part;
    if (left <= 0) return { ...part, text: '' };
    if (part.text.length <= left) {
      left -= part.text.length;
      return part;
    }
    const text = part.text.slice(0, left);
    left = 0;
    return { ...part, text };
  });
  return { ...result, content };
}

interface AskJob {
  abort: AbortController;
  answered: boolean;
  call: ToolCall;
}

export function bindThinker(
  session: RealtimeSession,
  thinker: Thinker,
  direct: (call: ToolCall, signal: AbortSignal) => Promise<ToolResultMessage>,
  options: BindThinkerOptions
): BoundThinker {
  const captions = new PushStream<ThinkerCaption>();
  const phases = new PushStream<ThinkerPhase>();
  const done = run(session, thinker, direct, options, captions, phases).finally(() => {
    captions.close();
    phases.close();
    captions.close();
    phases.close();
  });
  return { captions, phases, done };
}

async function run(
  session: RealtimeSession,
  thinker: Thinker,
  direct: (call: ToolCall, signal: AbortSignal) => Promise<ToolResultMessage>,
  options: BindThinkerOptions,
  captions: PushStream<ThinkerCaption>,
  phases: PushStream<ThinkerPhase>
): Promise<void> {
  const heard: string[] = [];
  const running = new Map<string, AskJob>();
  for await (const event of session) {
    if (event.type === 'input_transcript' && event.final) heard.push(`user: ${event.text}`);
    if (event.type === 'output_transcript' && event.final) heard.push(`talker: ${event.text}`);
    if (event.type === 'tool_call_cancelled') {
      const job = running.get(event.callId);
      if (!job) continue;
      job.abort.abort();
      if (!job.answered) {
        job.answered = true;
        send(() => session.respond(event.callId, errorResult(job.call, new Error('cancelled'))));
      }
      continue;
    }
    if (event.type !== 'tool_call') continue;
    const call = event.call;
    if (call.name !== askAgent.name) {
      phases.push({
        phase: 'tool',
        toolName: call.name,
        toolCallId: call.id,
        args: call.arguments,
      });
      void direct(call, AbortSignal.timeout(options.directTimeoutMs))
        .then((result) => {
          send(() => session.respond(call.id, capResult(result, options.directMaxChars)));
          phases.push({ phase: 'idle' });
        })
        .catch((error: unknown) => {
          send(() => session.respond(call.id, errorResult(call, error)));
          phases.push({ phase: 'idle' });
        });
      continue;
    }
    const job: AskJob = { abort: new AbortController(), answered: event.blocking, call };
    running.set(call.id, job);
    phases.push({ phase: 'thinking' });
    if (event.blocking) send(() => session.respond(call.id, acknowledged(call, options.ack)));
    void followAsk(
      session,
      thinker,
      options,
      captions,
      phases,
      running,
      heard,
      call,
      event.blocking,
      job
    );
  }
}

async function followAsk(
  session: RealtimeSession,
  thinker: Thinker,
  options: BindThinkerOptions,
  captions: PushStream<ThinkerCaption>,
  phases: PushStream<ThinkerPhase>,
  running: Map<string, AskJob>,
  heard: string[],
  call: ToolCall,
  blocking: boolean,
  job: AskJob
): Promise<void> {
  try {
    for await (const update of thinker.ask(
      String(call.arguments.request),
      heard.slice(-heardLimit),
      job.abort.signal
    )) {
      if (job.abort.signal.aborted) break;
      if (update.type === 'progress') {
        captions.push({ type: 'thinker_progress', callId: call.id, text: update.text });
        send(() => session.inject(update.text, options.progress));
        continue;
      }
      job.answered = true;
      captions.push({
        type: 'thinker_result',
        callId: call.id,
        summary: textOf(update.message),
        isError: update.message.isError,
      });
      if (blocking) send(() => session.inject(textOf(update.message), options.result));
      else send(() => session.respond(call.id, update.message, options.result));
    }
  } catch (error) {
    if (!job.abort.signal.aborted && !job.answered) {
      job.answered = true;
      send(() => session.respond(call.id, errorResult(call, error)));
    }
  } finally {
    running.delete(call.id);
    phases.push({ phase: 'idle' });
  }
}
