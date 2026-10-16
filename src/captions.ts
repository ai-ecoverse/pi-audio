import type { CharAlignment } from './audio.ts';
import type { CaptionEvent } from './turns.ts';

export interface SpokenClock {
  start: number;
  end: number;
  durationMs: number;
  alignment?: CharAlignment;
}

export interface UtteranceMap {
  spokenStart: number;
  spokenEnd: number;
  kind: string;
}

export interface CaptionHistoryEntry {
  id: string | number;
  kind: string;
  model?: readonly HistoryMessage[];
  data?: unknown;
}

interface HistoryMessage {
  role?: string;
  content?: string | readonly HistoryBlock[];
}

interface HistoryBlock {
  type?: string;
  text?: string;
}

interface StoredAgent {
  turnId: string;
  utteranceId: string;
  blocks: string[];
}

export function spokenOffset(clock: SpokenClock, offsetMs: number): number {
  const length = clock.end - clock.start;
  if (length <= 0) return clock.start;
  const alignment = clock.alignment;
  if (alignment && alignment.startMs.length === length && alignment.durationMs.length === length) {
    return clock.start + alignedHeard(alignment, offsetMs, length);
  }
  if (clock.durationMs <= 0) {
    if (offsetMs <= 0) return clock.start;
    return clock.end;
  }
  const ratio = offsetMs <= 0 ? 0 : offsetMs / clock.durationMs;
  const fraction = ratio > 1 ? 1 : ratio;
  return clock.start + Math.round(fraction * length);
}

function alignedHeard(alignment: CharAlignment, offsetMs: number, length: number): number {
  const first = alignment.startMs[0];
  let origin = 0;
  if (first !== undefined) origin = first;
  const at = origin + offsetMs;
  let heard = 0;
  for (let index = 0; index < length; index += 1) {
    const start = alignment.startMs[index];
    if (start !== undefined && start <= at) heard = index + 1;
  }
  return heard;
}

export function utteranceIndex(feedPos: number, maps: readonly UtteranceMap[]): number {
  let upTo = 0;
  for (const map of maps) {
    if (map.kind !== 'answer') continue;
    if (feedPos <= map.spokenStart) break;
    const end = feedPos < map.spokenEnd ? feedPos : map.spokenEnd;
    upTo += end - map.spokenStart;
  }
  return upTo;
}

export function captionsFromHistory(entries: readonly CaptionHistoryEntry[]): CaptionEvent[] {
  const captions: CaptionEvent[] = [];
  const agents = new Map<string, StoredAgent>();
  for (const entry of entries) {
    if (entry.kind === 'voice.truncate') {
      noteCut(captions, agents, entry.data);
      continue;
    }
    const message = firstMessage(entry);
    if (!message) continue;
    const voice = voiceMeta(entry.data);
    if (message.role === 'user' && voice) {
      pushUser(captions, entry, message, voice);
      continue;
    }
    if (message.role !== 'assistant') continue;
    const blocks = textBlocks(message.content);
    const turnId = String(entry.id);
    const utteranceId = `${turnId}:agent`;
    agents.set(turnId, { turnId, utteranceId, blocks });
    captions.push({
      type: 'agent_generated',
      turnId,
      utteranceId,
      text: blocks.join(''),
    });
  }
  return captions;
}

function firstMessage(entry: CaptionHistoryEntry): HistoryMessage | undefined {
  const model = entry.model;
  if (!model) return undefined;
  return model[0];
}

function pushUser(
  captions: CaptionEvent[],
  entry: CaptionHistoryEntry,
  message: HistoryMessage,
  voice: { confidence?: number }
): void {
  const turnId = String(entry.id);
  const text = textBlocks(message.content).join('');
  if (voice.confidence === undefined) {
    captions.push({ type: 'user_final', turnId, segmentId: 'turn', text });
    return;
  }
  captions.push({
    type: 'user_final',
    turnId,
    segmentId: 'turn',
    text,
    confidence: voice.confidence,
  });
}

function noteCut(captions: CaptionEvent[], agents: Map<string, StoredAgent>, data: unknown): void {
  const cut = cutData(data);
  if (!cut) return;
  const agent = agents.get(cut.entryId);
  if (!agent) return;
  const heard = heardInBlocks(agent.blocks, cut.contentIndex, cut.heardUpTo);
  captions.push({
    type: 'agent_spoken',
    turnId: agent.turnId,
    utteranceId: agent.utteranceId,
    upTo: heard,
  });
  captions.push({
    type: 'agent_cut',
    turnId: agent.turnId,
    utteranceId: agent.utteranceId,
    heardUpTo: heard,
  });
}

function heardInBlocks(blocks: readonly string[], contentIndex: number, heardUpTo: number): number {
  let prior = 0;
  let index = 0;
  for (const block of blocks) {
    if (index === contentIndex) return prior + clampHeard(block, heardUpTo);
    prior += block.length;
    index += 1;
  }
  return prior;
}

function clampHeard(block: string, heardUpTo: number): number {
  if (heardUpTo <= 0) return 0;
  if (heardUpTo >= block.length) return block.length;
  return heardUpTo;
}

function textBlocks(content: HistoryMessage['content']): string[] {
  if (typeof content === 'string') return [content];
  if (!content) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') blocks.push(block.text);
  }
  return blocks;
}

function voiceMeta(data: unknown): { confidence?: number } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('source' in data) || data.source !== 'voice') return undefined;
  if ('confidence' in data && typeof data.confidence === 'number') {
    return { confidence: data.confidence };
  }
  return {};
}

function cutData(
  data: unknown
): { entryId: string; contentIndex: number; heardUpTo: number } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  if (!('entryId' in data) || typeof data.entryId !== 'string') return undefined;
  if (!('contentIndex' in data) || typeof data.contentIndex !== 'number') return undefined;
  if (!('heardUpTo' in data) || typeof data.heardUpTo !== 'number') return undefined;
  return { entryId: data.entryId, contentIndex: data.contentIndex, heardUpTo: data.heardUpTo };
}
