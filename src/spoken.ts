import type {
  AssistantMessage,
  AssistantMessageEvent,
  JsonObject,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@earendil-works/pi-ai';
import { blankUsage } from './blank-usage.ts';

export interface VoiceMessageChange {
  type: string;
  contentIndex?: number;
  delta?: string;
  block?: TextContent | ThinkingContent | ToolCall;
  message?: AssistantMessage;
}

export interface VoiceEntryRef {
  id: string | number;
  model?: readonly {
    role: string;
    content?: readonly (TextContent | ThinkingContent | ToolCall)[];
  }[];
}

export interface VoiceAgentEvent {
  type: string;
  changes?: readonly VoiceMessageChange[];
  message?: { role: string; content?: unknown };
  entry?: VoiceEntryRef;
  toolName?: string;
  toolCallId?: string;
  args?: JsonObject;
  attempt?: number;
  at?: number;
}

export interface SpokenPiece {
  text: string;
  contentIndex: number;
  start: number;
  end: number;
  kind: 'answer' | 'announce';
  entryId?: string;
}

interface BlockTrack {
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  sent: number;
  signature?: string;
  ended: boolean;
}

export interface SpokenState {
  blocks: Map<number, BlockTrack>;
  entryId?: string;
}

export interface SpokenOptions {
  speakable?(event: AssistantMessageEvent): string | undefined;
  announce?(call: ToolCall): string | undefined;
  model?: string;
}

type Block = TextContent | ThinkingContent | ToolCall;

export function createSpokenState(): SpokenState {
  return { blocks: new Map() };
}

export function isCommentary(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const parsed = JSON.parse(signature) as { phase?: unknown } | null;
    return parsed?.phase === 'commentary';
  } catch {
    return false;
  }
}

export function spokenPieces(
  event: VoiceAgentEvent,
  state: SpokenState,
  options: SpokenOptions = {}
): SpokenPiece[] {
  if (event.type === 'tool_execution_start') return announceOf(event, options);
  if (event.entry?.id !== undefined) state.entryId = String(event.entry.id);
  if (event.type === 'message_end') return messagePieces(event.entry?.model, state, options, true);
  if (event.type === 'message_start')
    return messagePieces(assistantContent(event.message), state, options, true);
  if (event.type === 'message_update') return changePieces(event.changes ?? [], state, options);
  return [];
}

function announceOf(event: VoiceAgentEvent, options: SpokenOptions): SpokenPiece[] {
  if (!options.announce || !event.toolName || !event.toolCallId) return [];
  const text = options.announce({
    type: 'toolCall',
    id: event.toolCallId,
    name: event.toolName,
    arguments: event.args ?? {},
  });
  if (!text) return [];
  return [{ text, contentIndex: -1, start: 0, end: 0, kind: 'announce' }];
}

function assistantContent(message: VoiceAgentEvent['message']): readonly Block[] | undefined {
  if (message?.role !== 'assistant') return undefined;
  return Array.isArray(message.content) ? (message.content as readonly Block[]) : undefined;
}

function messagePieces(
  model: VoiceEntryRef['model'] | readonly Block[] | undefined,
  state: SpokenState,
  options: SpokenOptions,
  close: boolean
): SpokenPiece[] {
  const content = Array.isArray(model) ? blocksOf(model) : undefined;
  if (!content) return [];
  const pieces: SpokenPiece[] = [];
  for (const [contentIndex, block] of content.entries()) {
    const track = applyBlock(state, contentIndex, block);
    const piece = takePiece(track, contentIndex, state, options, close);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

function blocksOf(
  model: readonly Block[] | NonNullable<VoiceEntryRef['model']>
): readonly Block[] | undefined {
  const first = model[0] as { role?: string; content?: unknown } | Block | undefined;
  if (!first) return undefined;
  if ('role' in first) {
    if (first.role !== 'assistant' || !Array.isArray(first.content)) return undefined;
    return first.content as readonly Block[];
  }
  return model as readonly Block[];
}

function changePieces(
  changes: readonly VoiceMessageChange[],
  state: SpokenState,
  options: SpokenOptions
): SpokenPiece[] {
  const pieces: SpokenPiece[] = [];
  for (const change of changes) pieces.push(...applyChange(change, state, options));
  return pieces;
}

function applyChange(
  change: VoiceMessageChange,
  state: SpokenState,
  options: SpokenOptions
): SpokenPiece[] {
  if (change.type === 'message') {
    return messagePieces(change.message ? [change.message] : undefined, state, options, false);
  }
  const contentIndex = change.contentIndex;
  if (contentIndex === undefined) return [];
  if (change.type === 'thinking_start' || change.type === 'thinking_delta') {
    noteThinking(state, contentIndex, change);
    return [];
  }
  if (change.type === 'toolcall_start' || change.type === 'toolcall_delta') {
    state.blocks.set(contentIndex, { kind: 'tool', text: '', sent: 0, ended: true });
    return [];
  }
  const track = textTrack(state, contentIndex);
  if (change.type === 'text_start' || change.type === 'block') noteText(track, change.block);
  if (change.type === 'text_delta' && change.delta) track.text += change.delta;
  const piece =
    change.type === 'text_delta' && options.speakable
      ? customPiece(track, contentIndex, change.delta ?? '', state, options, 'text_delta')
      : takePiece(track, contentIndex, state, options, false);
  return piece ? [piece] : [];
}

function noteThinking(state: SpokenState, contentIndex: number, change: VoiceMessageChange): void {
  const existing = state.blocks.get(contentIndex);
  const text = `${existing?.kind === 'thinking' ? existing.text : ''}${change.delta ?? ''}`;
  const started = change.block?.type === 'thinking' ? change.block.thinking : text;
  state.blocks.set(contentIndex, {
    kind: 'thinking',
    text: change.type === 'thinking_start' ? started : text,
    sent: change.type === 'thinking_start' ? started.length : text.length,
    ended: true,
    ...(change.block?.type === 'thinking' && change.block.thinkingSignature
      ? { signature: change.block.thinkingSignature }
      : {}),
  });
}

function noteText(track: BlockTrack, block: VoiceMessageChange['block']): void {
  if (block?.type !== 'text') return;
  track.kind = 'text';
  track.text = block.text;
  track.signature = block.textSignature;
}

function textTrack(state: SpokenState, contentIndex: number): BlockTrack {
  const existing = state.blocks.get(contentIndex);
  if (existing) return existing;
  const created: BlockTrack = { kind: 'text', text: '', sent: 0, ended: false };
  state.blocks.set(contentIndex, created);
  return created;
}

function applyBlock(state: SpokenState, contentIndex: number, block: Block): BlockTrack {
  if (block.type === 'thinking') {
    const track: BlockTrack = {
      kind: 'thinking',
      text: block.thinking,
      sent: block.thinking.length,
      ended: true,
    };
    state.blocks.set(contentIndex, track);
    return track;
  }
  if (block.type === 'toolCall') {
    const track: BlockTrack = { kind: 'tool', text: '', sent: 0, ended: true };
    state.blocks.set(contentIndex, track);
    return track;
  }
  const existing = state.blocks.get(contentIndex);
  const sent = existing?.kind === 'text' ? existing.sent : 0;
  let ended = false;
  if (existing?.kind === 'text') ended = existing.ended;
  const track: BlockTrack = {
    kind: 'text',
    text: block.text,
    sent,
    ended,
    ...(block.textSignature ? { signature: block.textSignature } : {}),
  };
  state.blocks.set(contentIndex, track);
  return track;
}

function takePiece(
  track: BlockTrack,
  contentIndex: number,
  state: SpokenState,
  options: SpokenOptions,
  close: boolean
): SpokenPiece | undefined {
  if (track.kind !== 'text') return undefined;
  if (options.speakable) {
    if (!close || track.ended) return undefined;
    track.ended = true;
    return customPiece(track, contentIndex, track.text, state, options, 'text_end');
  }
  if (isCommentary(track.signature)) {
    track.sent = track.text.length;
    return undefined;
  }
  if (track.sent >= track.text.length) return undefined;
  const start = track.sent;
  const text = track.text.slice(start);
  track.sent = track.text.length;
  if (!text) return undefined;
  return { text, contentIndex, start, end: track.sent, kind: 'answer', entryId: state.entryId };
}

function customPiece(
  track: BlockTrack,
  contentIndex: number,
  delta: string,
  state: SpokenState,
  options: SpokenOptions,
  type: 'text_delta' | 'text_end'
): SpokenPiece | undefined {
  if (!options.speakable) return undefined;
  const partial = partialFrom(state, options.model ?? 'voice');
  const event: AssistantMessageEvent =
    type === 'text_delta'
      ? { type: 'text_delta', contentIndex, delta, partial }
      : { type: 'text_end', contentIndex, content: track.text, partial };
  const text = options.speakable(event);
  const start = track.sent;
  track.sent = track.text.length;
  track.ended = type === 'text_end';
  if (!text) return undefined;
  return { text, contentIndex, start, end: track.sent, kind: 'answer', entryId: state.entryId };
}

function partialFrom(state: SpokenState, model: string): AssistantMessage {
  const max = Math.max(-1, ...state.blocks.keys());
  const content: Block[] = [];
  for (let index = 0; index <= max; index += 1) content.push(partialBlock(state.blocks.get(index)));
  return {
    role: 'assistant',
    content,
    api: 'pi-audio',
    provider: 'pi-audio',
    model,
    usage: blankUsage(),
    stopReason: 'pending',
    timestamp: 0,
  };
}

function partialBlock(track: BlockTrack | undefined): Block {
  if (!track || track.kind === 'thinking') return { type: 'thinking', thinking: track?.text ?? '' };
  if (track.kind === 'tool')
    return { type: 'toolCall', id: 'pending', name: 'pending', arguments: {} };
  return {
    type: 'text',
    text: track.text,
    ...(track.signature ? { textSignature: track.signature } : {}),
  };
}
