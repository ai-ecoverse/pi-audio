import type {
  AssistantMessageEvent,
  JsonObject,
  ProviderRequestOptions,
  ToolCall,
  UserMessage,
} from '@earendil-works/pi-ai';
import {
  type AudioSink,
  type AudioSource,
  type AudioTag,
  type CharAlignment,
  chunkSeconds,
  type TextSpan,
} from './audio.ts';
import { type SpokenClock, spokenOffset, utteranceIndex } from './captions.ts';
import { type EchoControl, openEchoMic } from './echo.ts';
import { VoiceRequestError } from './errors.ts';
import type { SpeechModel, TranscriptionModel } from './models.ts';
import { pushQueue } from './queue.ts';
import {
  type AudioOut,
  type BedFollower,
  followBed,
  isAudioOut,
  type Soundscape,
} from './soundscape.ts';
import type { SpeechEvent, SpeechInput } from './speech.ts';
import {
  createSpokenState,
  type SpokenPiece,
  spokenPieces,
  type VoiceAgentEvent,
} from './spoken.ts';
import type { ListenOptions, TranscriptionEvent } from './transcription.ts';

export interface VoiceTurnMeta {
  source: 'voice';
  transcriptionModel: string;
  confidence?: number;
}

export interface VoiceCut {
  entryId: string;
  contentIndex: number;
  heardUpTo: number;
  heardMs: number;
}

export interface VoiceConversation {
  prompt(
    message: UserMessage,
    meta: VoiceTurnMeta,
    signal: AbortSignal
  ): AsyncIterable<VoiceAgentEvent>;
  truncate(cut: VoiceCut): Promise<void>;
}

export type BargeIn = 'interrupt' | 'onWords' | 'ignore' | 'auto';

export type EchoRecommendation = 'interrupt' | 'onWords' | 'headphones';

export interface VoiceTurnOptions {
  ears: TranscriptionModel<string>;
  mouth: SpeechModel<string>;
  voice: string;
  speakable?: (event: AssistantMessageEvent) => string | undefined;
  announce?: (call: ToolCall) => string | undefined;
  bargeIn?: BargeIn;
  echoRecommendation?: EchoRecommendation;
  echo?: EchoControl;
  soundscape?: Soundscape;
}

export interface VoiceModels {
  listen(
    model: TranscriptionModel<string>,
    audio: AudioSource,
    options?: ListenOptions
  ): AsyncIterable<TranscriptionEvent>;
  speak(
    model: SpeechModel<string>,
    input: SpeechInput,
    options?: ProviderRequestOptions
  ): AsyncIterable<SpeechEvent>;
}

export type VoicePhase =
  | { phase: 'listening' }
  | { phase: 'heard'; text: string }
  | { phase: 'thinking' }
  | { phase: 'tool'; toolName: string; toolCallId: string; args: JsonObject }
  | { phase: 'retrying'; attempt: number; at: number }
  | { phase: 'compacting' }
  | { phase: 'speaking' }
  | { phase: 'idle' };

export type CaptionEvent =
  | { type: 'user_partial'; turnId: string; segmentId: string; text: string }
  | { type: 'user_final'; turnId: string; segmentId: string; text: string; confidence?: number }
  | { type: 'agent_generated'; turnId: string; utteranceId: string; text: string }
  | { type: 'agent_spoken'; turnId: string; utteranceId: string; upTo: number }
  | { type: 'agent_cut'; turnId: string; utteranceId: string; heardUpTo: number }
  | { type: 'announce'; turnId: string; text: string }
  | { type: 'thinker_progress'; turnId: string; callId: string; text: string }
  | { type: 'thinker_result'; turnId: string; callId: string; summary: string; isError: boolean };

export interface VoiceSession {
  phases: AsyncIterable<VoicePhase>;
  captions: AsyncIterable<CaptionEvent>;
  done: Promise<void>;
}

interface SpokenMap {
  spokenStart: number;
  spokenEnd: number;
  contentIndex: number;
  start: number;
  end: number;
  entryId?: string;
  kind: SpokenPiece['kind'];
}

interface PlayedTag {
  tag: AudioTag;
  offsetMs: number;
}

interface ActiveTurn {
  controller: AbortController;
  unlink: () => void;
  done: Promise<void>;
  turnId: string;
  utteranceId: string;
  spokenUpTo: number;
  plays: PlayedTag[];
  cut?: VoiceCut;
}

export function voiceTurns(
  models: VoiceModels,
  conversation: VoiceConversation,
  mic: AudioSource,
  out: AudioSink | AudioOut,
  options: VoiceTurnOptions,
  signal: AbortSignal
): VoiceSession {
  const phases = pushQueue<VoicePhase>();
  const captions = pushQueue<CaptionEvent>();
  const session: Session = {
    models,
    conversation,
    mic: heardMic(options, mic),
    out: speechOf(out),
    options,
    signal,
    phases,
    captions,
    maps: [],
    clocks: new WeakMap(),
    bed: attachBed(out, options.soundscape),
  };
  const done = runSession(session).finally(() => {
    phases.end();
    captions.end();
  });
  return { phases: phases.iterable, captions: captions.iterable, done };
}

interface Session {
  models: VoiceModels;
  conversation: VoiceConversation;
  mic: AudioSource;
  out: AudioSink;
  options: VoiceTurnOptions;
  signal: AbortSignal;
  phases: ReturnType<typeof pushQueue<VoicePhase>>;
  captions: ReturnType<typeof pushQueue<CaptionEvent>>;
  maps: SpokenMap[];
  clocks: WeakMap<AudioTag, SpokenClock>;
  bed: BedFollower;
}

async function runSession(session: Session): Promise<void> {
  const mode = bargeMode(session.options);
  let active: ActiveTurn | undefined;
  let confidence: number | undefined;
  let reserved = 0;
  let openId = '';
  const openTurn = () => {
    if (!openId) {
      reserved += 1;
      openId = String(reserved);
    }
    return openId;
  };
  const stopPlayback = session.out.onPlayback((tag, offsetMs) => {
    if (!active) return;
    notePlayback(session, active, tag, offsetMs);
  });
  const setPhase = phaseSetter(session.phases, session.bed);
  const turnFailed = Promise.withResolvers<never>();
  try {
    if (session.signal.aborted) return;
    setPhase({ phase: 'listening' });
    const heard = session.models
      .listen(session.options.ears, session.mic, {
        signal: session.signal,
      })
      [Symbol.asyncIterator]();
    while (true) {
      const event = await nextVoiceEvent(heard, turnFailed.promise);
      if (!event) break;
      if (event.type === 'error') {
        if (event.reason === 'aborted' || session.signal.aborted) return;
        throw new VoiceRequestError(event.reason, event.error);
      }
      const captionId =
        event.type === 'partial' || event.type === 'final' || event.type === 'turn_end'
          ? openTurn()
          : openId;
      confidence = noteUser(session, event, captionId, confidence);
      if (shouldBarge(mode, event)) active = await interrupt(session, active);
      if (event.type !== 'turn_end') continue;
      const turnId = openId || openTurn();
      openId = '';
      if (mode === 'ignore') active = await finishTurn(active);
      else active = await interrupt(session, active);
      setPhase({ phase: 'heard', text: event.text });
      const meta = turnMeta(session.options, confidence);
      confidence = undefined;
      active = startTurn(session, setPhase, turnId, event, meta, turnFailed.reject);
    }
  } finally {
    if (session.signal.aborted && active) await interrupt(session, active);
    else if (active) await active.done;
    stopPlayback();
    setPhase({ phase: 'idle' });
    session.bed.stop();
  }
}

function turnMeta(options: VoiceTurnOptions, confidence: number | undefined): VoiceTurnMeta {
  return {
    source: 'voice',
    transcriptionModel: options.ears.id,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function noteUser(
  session: Session,
  event: TranscriptionEvent,
  turnId: string,
  confidence: number | undefined
): number | undefined {
  if (event.type === 'partial') {
    session.captions.push({
      type: 'user_partial',
      turnId,
      segmentId: event.segmentId,
      text: event.text,
    });
  }
  if (event.type === 'final') {
    session.captions.push({
      type: 'user_final',
      turnId,
      segmentId: event.segmentId,
      text: event.text,
      ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    });
    return event.confidence ?? confidence;
  }
  if (event.type === 'turn_end') {
    session.captions.push({ type: 'user_final', turnId, segmentId: 'turn', text: event.text });
  }
  return confidence;
}

async function finishTurn(active: ActiveTurn | undefined): Promise<undefined> {
  if (!active) return undefined;
  await active.done;
  return undefined;
}

async function nextVoiceEvent(
  heard: AsyncIterator<TranscriptionEvent>,
  failed: Promise<never>
): Promise<TranscriptionEvent | undefined> {
  const step = await Promise.race([heard.next(), failed]);
  if (step.done) return undefined;
  return step.value;
}

function startTurn(
  session: Session,
  setPhase: (phase: VoicePhase) => void,
  turnId: string,
  event: Extract<TranscriptionEvent, { type: 'turn_end' }>,
  meta: VoiceTurnMeta,
  rejectTurn: (error: unknown) => void
): ActiveTurn {
  const linked = linkSignal(session.signal);
  const active: ActiveTurn = {
    controller: linked.controller,
    unlink: linked.unlink,
    turnId,
    utteranceId: `${turnId}:agent`,
    spokenUpTo: 0,
    plays: [],
    done: Promise.resolve(),
  };
  active.done = performTurn(session, setPhase, active, event.text, event.at, meta).finally(() => {
    linked.unlink();
  });
  void active.done.catch((error: unknown) => rejectTurn(error));
  return active;
}

async function performTurn(
  session: Session,
  setPhase: (phase: VoicePhase) => void,
  active: ActiveTurn,
  text: string,
  at: number,
  meta: VoiceTurnMeta
): Promise<void> {
  const signal = active.controller.signal;
  try {
    setPhase({ phase: 'thinking' });
    const message: UserMessage = { role: 'user', content: text, timestamp: at };
    const feed = textFeed(signal);
    const maps: SpokenMap[] = [];
    session.maps = maps;
    const producing = readAgent(session, setPhase, active, message, meta, feed, maps);
    const audio = session.models.speak(
      session.options.mouth,
      { text: feed.iterable, voice: session.options.voice },
      { signal }
    );
    await Promise.all([producing, pipeSpeech(session, setPhase, active, audio, maps)]);
    if (!signal.aborted) setPhase({ phase: 'listening' });
  } catch (error) {
    if (signal.aborted || session.signal.aborted) return;
    throw error;
  }
}

async function readAgent(
  session: Session,
  setPhase: (phase: VoicePhase) => void,
  active: ActiveTurn,
  message: UserMessage,
  meta: VoiceTurnMeta,
  feed: TextFeed,
  maps: SpokenMap[]
): Promise<void> {
  const state = createSpokenState();
  let spokenChars = 0;
  let generated = '';
  try {
    for await (const event of session.conversation.prompt(
      message,
      meta,
      active.controller.signal
    )) {
      if (active.controller.signal.aborted) break;
      notePhase(setPhase, event);
      for (const piece of spokenPieces(event, state, session.options)) {
        spokenChars += piece.text.length;
        generated = rememberPiece(
          session,
          active,
          piece,
          maps,
          spokenChars,
          generated,
          state.entryId
        );
        feed.push(piece.text);
      }
      if (state.entryId) bindEntry(session, active, maps, state.entryId);
    }
  } finally {
    feed.end();
  }
}

function rememberPiece(
  session: Session,
  active: ActiveTurn,
  piece: SpokenPiece,
  maps: SpokenMap[],
  spokenEnd: number,
  generated: string,
  entryId: string | undefined
): string {
  const bound = piece.entryId ?? entryId;
  maps.push({
    spokenStart: spokenEnd - piece.text.length,
    spokenEnd,
    contentIndex: piece.contentIndex,
    start: piece.start,
    end: piece.end,
    kind: piece.kind,
    ...(bound ? { entryId: bound } : {}),
  });
  if (piece.kind === 'announce') {
    session.captions.push({ type: 'announce', turnId: active.turnId, text: piece.text });
    return generated;
  }
  const text = generated + piece.text;
  session.captions.push({
    type: 'agent_generated',
    turnId: active.turnId,
    utteranceId: active.utteranceId,
    text,
  });
  return text;
}

async function pipeSpeech(
  session: Session,
  setPhase: (phase: VoicePhase) => void,
  active: ActiveTurn,
  audio: AsyncIterable<SpeechEvent>,
  maps: SpokenMap[]
): Promise<void> {
  for await (const event of audio) {
    if (active.controller.signal.aborted) return;
    if (event.type === 'error') {
      if (event.reason === 'aborted') return;
      throw new VoiceRequestError(event.reason, event.error);
    }
    if (event.type !== 'audio') continue;
    setPhase({ phase: 'speaking' });
    const span = translateSpan(event.span, maps);
    const tag: AudioTag = { span };
    if (event.alignment) tag.alignment = event.alignment;
    session.clocks.set(tag, clockOf(event));
    session.out.write(event.chunk, tag);
  }
}

function clockOf(event: Extract<SpeechEvent, { type: 'audio' }>): SpokenClock {
  const clock: SpokenClock = {
    start: event.span.start,
    end: event.span.end,
    durationMs: chunkDurationMs(event),
  };
  if (event.alignment) clock.alignment = event.alignment;
  return clock;
}

function chunkDurationMs(event: Extract<SpeechEvent, { type: 'audio' }>): number {
  const measured = Math.round(chunkSeconds(event.chunk) * 1000);
  if (measured > 0) return measured;
  const aligned = alignedDuration(event.alignment);
  if (aligned > 0) return aligned;
  const span = event.span.end - event.span.start;
  if (span > 0) return span;
  return 0;
}

function alignedDuration(alignment: CharAlignment | undefined): number {
  if (!alignment) return 0;
  let ms = 0;
  for (const duration of alignment.durationMs) ms += duration;
  return ms;
}

function notePlayback(session: Session, active: ActiveTurn, tag: AudioTag, offsetMs: number): void {
  rememberPlay(active, tag, offsetMs);
  const playing = session.clocks.get(tag);
  if (playing) revealSpoken(session, active, playing, offsetMs);
  const span = translateSpan(tag.span, session.maps);
  if (!('entryId' in span)) return;
  active.cut = {
    entryId: span.entryId,
    contentIndex: span.contentIndex,
    heardUpTo: playedSource(span, playing, offsetMs),
    heardMs: session.out.playedMs,
  };
}

function rememberPlay(active: ActiveTurn, tag: AudioTag, offsetMs: number) {
  const existing = active.plays.find((play) => play.tag === tag);
  if (existing) {
    existing.offsetMs = offsetMs;
    return;
  }
  active.plays.push({ tag, offsetMs });
}

function revealSpoken(
  session: Session,
  active: ActiveTurn,
  playing: SpokenClock,
  offsetMs: number
) {
  const upTo = utteranceIndex(spokenOffset(playing, offsetMs), session.maps);
  if (upTo <= active.spokenUpTo) return;
  active.spokenUpTo = upTo;
  session.captions.push({
    type: 'agent_spoken',
    turnId: active.turnId,
    utteranceId: active.utteranceId,
    upTo,
  });
}

function playedSource(
  span: { start: number; end: number },
  clock: SpokenClock | undefined,
  offsetMs: number
): number {
  if (!clock) return span.end;
  const length = clock.end - clock.start;
  if (length <= 0) return span.end;
  const local = spokenOffset(clock, offsetMs) - clock.start;
  return span.start + Math.round((local * (span.end - span.start)) / length);
}

function translateSpan(span: TextSpan, maps: SpokenMap[]): TextSpan {
  if ('entryId' in span) return span;
  const map = answerMap(span, maps);
  if (!map?.entryId) return span;
  const spokenLen = map.spokenEnd - map.spokenStart;
  const sourceLen = map.end - map.start;
  const start = map.start + scale(Math.max(0, span.start - map.spokenStart), spokenLen, sourceLen);
  const end =
    map.start + scale(Math.min(spokenLen, span.end - map.spokenStart), spokenLen, sourceLen);
  return { entryId: map.entryId, contentIndex: map.contentIndex, start, end };
}

function answerMap(span: { start: number; end: number }, maps: SpokenMap[]): SpokenMap | undefined {
  for (let index = maps.length - 1; index >= 0; index -= 1) {
    const item = maps[index];
    if (item?.kind !== 'answer' || !item.entryId) continue;
    if (item.spokenStart < span.end && item.spokenEnd > span.start) return item;
  }
  return undefined;
}

function scale(offset: number, spokenLen: number, sourceLen: number): number {
  if (spokenLen <= 0) return 0;
  return Math.round((offset * sourceLen) / spokenLen);
}

function bindEntry(session: Session, active: ActiveTurn, maps: SpokenMap[], entryId: string): void {
  for (const map of maps) {
    if (map.kind === 'answer' && map.entryId === undefined) map.entryId = entryId;
  }
  for (const play of active.plays) notePlayback(session, active, play.tag, play.offsetMs);
}

function notePhase(setPhase: (phase: VoicePhase) => void, event: VoiceAgentEvent): void {
  if (event.type === 'run_start' || event.type === 'turn_start') setPhase({ phase: 'thinking' });
  if (event.type === 'compaction_start') setPhase({ phase: 'compacting' });
  if (event.type === 'auto_retry_start' && event.attempt !== undefined && event.at !== undefined) {
    setPhase({ phase: 'retrying', attempt: event.attempt, at: event.at });
  }
  if (event.type === 'tool_execution_start' && event.toolName && event.toolCallId) {
    setPhase({
      phase: 'tool',
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      args: event.args ?? {},
    });
  }
}

async function interrupt(session: Session, active: ActiveTurn | undefined): Promise<undefined> {
  if (!active) return undefined;
  active.controller.abort();
  session.out.flush();
  await active.done;
  if (active.cut) {
    session.captions.push({
      type: 'agent_cut',
      turnId: active.turnId,
      utteranceId: active.utteranceId,
      heardUpTo: active.cut.heardUpTo,
    });
    await session.conversation.truncate(active.cut);
  }
  return undefined;
}

function bargeMode(options: VoiceTurnOptions): 'interrupt' | 'onWords' | 'ignore' {
  const mode = options.bargeIn ?? 'interrupt';
  if (mode !== 'auto') return mode;
  if (options.echoRecommendation === 'interrupt') return 'interrupt';
  if (options.echoRecommendation === 'headphones') return 'ignore';
  return 'onWords';
}

function shouldBarge(mode: 'interrupt' | 'onWords' | 'ignore', event: TranscriptionEvent): boolean {
  if (mode === 'ignore') return false;
  if (mode === 'interrupt') return event.type === 'speech_start';
  return event.type === 'partial' && event.text.trim().length > 0;
}

function heardMic(options: VoiceTurnOptions, mic: AudioSource): AudioSource {
  const echo = options.echo;
  if (echo === undefined) return mic;
  return openEchoMic(echo, mic);
}

function speechOf(out: AudioSink | AudioOut): AudioSink {
  if (isAudioOut(out)) return out.speech;
  return out;
}

function attachBed(out: AudioSink | AudioOut, soundscape: Soundscape | undefined): BedFollower {
  if (!soundscape) return idleBed();
  if (!isAudioOut(out)) return idleBed();
  return followBed(out.bed, soundscape);
}

function idleBed(): BedFollower {
  return {
    observe() {},
    stop() {},
  };
}

function phaseSetter(phases: Session['phases'], bed: BedFollower): (phase: VoicePhase) => void {
  let previous = '';
  return (phase) => {
    const key = JSON.stringify(phase);
    if (key === previous) return;
    previous = key;
    phases.push(phase);
    bed.observe(phase);
  };
}

function linkSignal(parent: AbortSignal): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', abort);
  return {
    controller,
    unlink: () => parent.removeEventListener('abort', abort),
  };
}

interface TextFeed {
  push(text: string): void;
  end(): void;
  iterable: AsyncIterable<string>;
}

function textFeed(signal: AbortSignal): TextFeed {
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const onAbort = () => notify();
  signal.addEventListener('abort', onAbort);
  return {
    push(text) {
      if (ended || signal.aborted || text.length === 0) return;
      queue.push(text);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        try {
          while (!signal.aborted) {
            const next = queue.shift();
            if (next !== undefined) {
              yield next;
              continue;
            }
            if (ended) return;
            await new Promise<void>((resolve) => {
              if (queue.length > 0 || ended || signal.aborted) resolve();
              else wake = resolve;
            });
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      },
    },
  };
}
