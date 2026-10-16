import type { UserMessage } from '@earendil-works/pi-ai';
import {
  createSpokenState,
  type SpokenState,
  spokenPieces,
  type VoiceAgentEvent,
} from '../spoken.ts';
import { type VendorCall, vendorCall } from './call.ts';
import { replyHash } from './hash.ts';
import type { BrainOptions } from './options.ts';
import type { Memory, ParsedTurn, TurnPlan } from './parse.ts';
import { sseChunk, sseDone, sseError } from './sse.ts';

const encoder = new TextEncoder();

interface Clock {
  cause: 'client' | 'deadline' | undefined;
  sent: boolean;
  streamed: string;
  opened: boolean;
}

type Send = (delta: Record<string, unknown>, finish: string | null) => void;
type Controller = ReadableStreamDefaultController<Uint8Array>;

function sender(model: string, created: number, clock: Clock, controller: Controller): Send {
  return (delta, finish) => {
    const body = clock.opened ? delta : { role: 'assistant', ...delta };
    clock.opened = true;
    controller.enqueue(encoder.encode(sseChunk(model, created, body, finish)));
  };
}

function finish(send: Send, controller: Controller, reason: string): void {
  send({}, reason);
  controller.enqueue(encoder.encode(sseDone()));
}

function remember(sessions: Map<string, Memory>, parsed: ParsedTurn, clock: Clock): void {
  sessions.set(parsed.sessionKey, {
    hash: replyHash(clock.streamed),
    text: clock.streamed,
    user: parsed.user,
  });
}

function writeReplay(
  parsed: ParsedTurn,
  text: string,
  sessions: Map<string, Memory>,
  controller: Controller
): void {
  const clock: Clock = { cause: undefined, sent: false, streamed: text, opened: false };
  const send = sender(parsed.model, Math.floor(Date.now() / 1000), clock, controller);
  if (text.length > 0) send({ content: text }, null);
  finish(send, controller, 'stop');
  remember(sessions, parsed, clock);
}

function bindAbort(
  request: Request,
  control: AbortController,
  clock: Clock,
  hardMs: number
): () => void {
  const fromClient = () => {
    clock.cause = clock.cause ?? 'client';
    control.abort();
  };
  if (request.signal.aborted) fromClient();
  else request.signal.addEventListener('abort', fromClient, { once: true });
  const deadline = setTimeout(() => {
    clock.cause = clock.cause ?? 'deadline';
    control.abort();
  }, hardMs);
  return () => {
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', fromClient);
  };
}

function armFiller(
  options: BrainOptions,
  message: UserMessage,
  clock: Clock,
  send: Send
): () => void {
  const timer = setTimeout(() => {
    if (clock.sent) return;
    const text = options.filler(message);
    if (text.length === 0) return;
    clock.sent = true;
    clock.streamed += text;
    send({ content: text }, null);
  }, options.budget.firstTokenMs);
  return () => clearTimeout(timer);
}

function writeAnswers(event: VoiceAgentEvent, state: SpokenState, clock: Clock, send: Send): void {
  for (const piece of spokenPieces(event, state)) {
    clock.sent = true;
    clock.streamed += piece.text;
    send({ content: piece.text }, null);
  }
}

function writeTool(send: Send, call: VendorCall): void {
  send(
    {
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        },
      ],
    },
    null
  );
}

function stopFor(clock: Clock, controller: Controller): void {
  if (clock.cause === 'deadline') controller.enqueue(encoder.encode(sseError('llm deadline')));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function liveTurn(
  options: BrainOptions,
  sessions: Map<string, Memory>,
  parsed: ParsedTurn,
  content: string,
  request: Request,
  controller: Controller
): Promise<void> {
  const clock: Clock = { cause: undefined, sent: false, streamed: '', opened: false };
  const send = sender(parsed.model, Math.floor(Date.now() / 1000), clock, controller);
  const message: UserMessage = { role: 'user', content, timestamp: Date.now() };
  const control = new AbortController();
  const releaseAbort = bindAbort(request, control, clock, options.budget.hardDeadlineMs);
  const releaseFiller = armFiller(options, message, clock, send);
  try {
    if (clock.cause !== undefined) return stopFor(clock, controller);
    const conversation = await options.conversation(parsed.sessionKey, control.signal);
    if (clock.cause !== undefined) return stopFor(clock, controller);
    const state = createSpokenState();
    const meta = { source: 'voice' as const, transcriptionModel: parsed.model };
    for await (const event of conversation.prompt(message, meta, control.signal)) {
      if (clock.cause !== undefined) return stopFor(clock, controller);
      writeAnswers(event, state, clock, send);
      const call = vendorCall(event, parsed.tools);
      if (call === undefined || options.vendorTools === 'drop') continue;
      writeTool(send, call);
      finish(send, controller, 'tool_calls');
      remember(sessions, parsed, clock);
      return;
    }
    if (clock.cause !== undefined) return stopFor(clock, controller);
    finish(send, controller, 'stop');
    remember(sessions, parsed, clock);
  } catch (error) {
    if (clock.cause === 'client') return;
    const text = clock.cause === 'deadline' ? 'llm deadline' : errorText(error);
    controller.enqueue(encoder.encode(sseError(text)));
  } finally {
    releaseFiller();
    releaseAbort();
  }
}

export async function runTurn(
  options: BrainOptions,
  sessions: Map<string, Memory>,
  parsed: ParsedTurn,
  plan: TurnPlan,
  request: Request,
  controller: Controller
): Promise<void> {
  if (plan.replay) {
    writeReplay(parsed, plan.text, sessions, controller);
    return;
  }
  await liveTurn(options, sessions, parsed, plan.content, request, controller);
}
