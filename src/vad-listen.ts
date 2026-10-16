import type { AudioChunk, AudioSource } from './audio.ts';
import type { TranscriptionModel } from './models.ts';
import {
  type ListenOptions,
  type TranscriptionEvent,
  TranscriptionEventStream,
} from './transcription.ts';
import { energyVad, type VadHook, type VadUpdate } from './vad.ts';

type ListenModel = (
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options?: ListenOptions
) => TranscriptionEventStream;

interface Gate {
  source: AudioSource;
  push(chunk: AudioChunk | null): void;
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function audioGate(): Gate {
  const queued: { chunk: AudioChunk | null }[] = [];
  let resolveWait: ((chunk: AudioChunk | null) => void) | undefined;
  const source: AudioSource = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const ready = queued.shift();
        if (ready !== undefined) {
          if (ready.chunk === null) return;
          yield ready.chunk;
          continue;
        }
        const chunk = await new Promise<AudioChunk | null>((resolve) => {
          resolveWait = resolve;
        });
        if (chunk === null) return;
        yield chunk;
      }
    },
  };
  return {
    source,
    push(chunk) {
      if (resolveWait) {
        const resolve = resolveWait;
        resolveWait = undefined;
        resolve(chunk);
        return;
      }
      queued.push({ chunk });
    },
  };
}

function joinSegments(parts: string[]): string {
  let text = '';
  for (const part of parts) {
    if (text.length === 0 || /\s$/.test(text) || /^\s/.test(part)) text += part;
    else text += ` ${part}`;
  }
  return text;
}

interface Session {
  stream: TranscriptionEventStream;
  segments: Map<string, string>;
  closed: string;
  turnOpen: boolean;
  started: boolean;
  pendingStart?: number;
  pendingEnd?: number;
  heldEnd?: number;
  providerTurn?: string;
  pendingDone?: Extract<TranscriptionEvent, { type: 'done' }>;
  stopped: boolean;
  lastAt: number;
}

function liveText(session: Session): string {
  const parts = [...session.segments.values()];
  if (parts.length > 0) return joinSegments(parts);
  return session.pendingDone?.transcript.text ?? session.providerTurn ?? '';
}

function turnText(session: Session): string {
  const live = liveText(session);
  if (session.closed.length > 0 && live.startsWith(session.closed)) {
    return live.slice(session.closed.length).trim();
  }
  if (session.providerTurn && !live.startsWith(session.providerTurn)) return session.providerTurn;
  return live.trim();
}

function closeTurn(session: Session, at: number) {
  if (!session.turnOpen || session.stopped) return;
  const text = turnText(session);
  if (text.length === 0) return;
  session.closed = liveText(session);
  session.turnOpen = false;
  session.started = false;
  session.pendingEnd = undefined;
  session.heldEnd = undefined;
  session.providerTurn = undefined;
  session.stream.push({ type: 'turn_end', text, at });
}

function openTurn(session: Session, at: number) {
  if (session.started || session.stopped) return;
  session.stream.push({ type: 'speech_start', at });
  session.started = true;
  session.turnOpen = true;
  session.pendingStart = undefined;
}

function applyEvent(session: Session, event: TranscriptionEvent) {
  if (event.type === 'speech_start') {
    if (!session.started) session.stream.push(event);
    session.started = true;
    session.turnOpen = true;
    session.pendingStart = undefined;
    return;
  }
  if (event.type === 'turn_end') {
    session.providerTurn = event.text;
    session.pendingEnd = event.at;
    return;
  }
  if (event.type === 'partial' || event.type === 'final') {
    if (!session.started) openTurn(session, session.pendingStart ?? session.lastAt);
    session.segments.set(event.segmentId, event.text);
    session.stream.push(event);
    return;
  }
  if (event.type === 'error') {
    session.stream.push(event);
    session.stopped = true;
    return;
  }
  if (event.type === 'done') session.pendingDone = event;
}

function absorb(session: Session, events: TranscriptionEvent[], update: VadUpdate | undefined) {
  if (session.stopped) return;
  if (update?.speechStart !== undefined) session.pendingStart = update.speechStart;
  if (update?.turnEnd !== undefined) session.pendingEnd = update.turnEnd;
  const textual = events.some(
    (event) => event.type === 'partial' || event.type === 'final' || event.type === 'done'
  );
  if (session.pendingStart !== undefined && (textual || events.length === 0)) {
    openTurn(session, session.pendingStart);
  }
  for (const event of events) {
    applyEvent(session, event);
    if (session.stopped) return;
  }
  if (session.pendingEnd !== undefined) {
    session.heldEnd = session.pendingEnd;
    session.pendingEnd = undefined;
  }
  if (session.heldEnd !== undefined) closeTurn(session, session.heldEnd);
}

function finish(session: Session) {
  if (session.stopped) return;
  if (session.pendingStart !== undefined) openTurn(session, session.pendingStart);
  if (session.turnOpen) closeTurn(session, session.heldEnd ?? session.pendingEnd ?? session.lastAt);
  if (session.pendingDone) session.stream.push(session.pendingDone);
  else {
    session.stream.push({
      type: 'error',
      reason: 'error',
      error: 'Transcription ended without a transcript',
    });
  }
}

export function listenWithVad(
  listenModel: ListenModel,
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options?: ListenOptions,
  vad: VadHook = options?.vad ?? energyVad()
): TranscriptionEventStream {
  const stream = new TranscriptionEventStream();
  void pump(listenModel, model, audio, options, stream, vad);
  return stream;
}

async function pump(
  listenModel: ListenModel,
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options: ListenOptions | undefined,
  stream: TranscriptionEventStream,
  vad: VadHook
) {
  if (options?.signal?.aborted) {
    stream.push({ type: 'error', reason: 'aborted', error: 'aborted' });
    return;
  }
  const gate = audioGate();
  let inner: TranscriptionEventStream;
  try {
    inner = listenModel(model, gate.source, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stream.push({ type: 'error', reason: 'error', error: message });
    return;
  }
  const inbox: TranscriptionEvent[] = [];
  let readerClosed = false;
  const reading = (async () => {
    for await (const event of inner) inbox.push(event);
    readerClosed = true;
  })();
  const session: Session = {
    stream,
    segments: new Map(),
    closed: '',
    turnOpen: false,
    started: false,
    stopped: false,
    lastAt: 0,
  };
  const take = (update?: VadUpdate) => {
    const events = inbox.splice(0, inbox.length);
    absorb(session, events, update);
  };
  try {
    await tick();
    take();
    for await (const chunk of audio) {
      if (session.stopped) break;
      if (options?.signal?.aborted) {
        gate.push(null);
        await tick();
        take();
        if (!session.stopped) {
          stream.push({ type: 'error', reason: 'aborted', error: 'aborted' });
          session.stopped = true;
        }
        break;
      }
      session.lastAt = chunk.timestamp;
      const update = vad.push(chunk);
      gate.push(chunk);
      await tick();
      take(update);
    }
    gate.push(null);
    if (!session.stopped) {
      let attempt = 0;
      do {
        await tick();
        take();
        attempt += 1;
      } while (!readerClosed && attempt < 50);
      finish(session);
    } else await tick();
  } catch (error) {
    gate.push(null);
    if (!session.stopped) {
      const message = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: 'error', error: message });
    }
  }
  await reading;
}
