import type { JsonObject, ToolCall } from '@earendil-works/pi-ai';
import type { AudioChunk } from '../audio.ts';
import { blankUsage } from '../blank-usage.ts';
import type { RealtimeEvent } from '../realtime.ts';

export interface FishTurn {
  dropAudio: boolean;
  discardFinals: number;
  speaking: boolean;
  turnOpen: boolean;
}

export interface FishText {
  identity: string;
  text: string;
  attributes: Record<string, string>;
}

function none(): RealtimeEvent[] {
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function done(itemId: string, interrupted: boolean): RealtimeEvent {
  return { type: 'response_done', itemId, interrupted, usage: blankUsage() };
}

export function ingestFishData(message: Record<string, unknown>): RealtimeEvent[] {
  const type = message.type;
  if (typeof type !== 'string') return none();
  if (type === 'client_tool.call') return toolCall(message);
  if (type === 'error')
    return [{ type: 'error', error: text(message.code) || 'error', fatal: false }];
  if (type === 'session.ended') {
    const reason = text(message.reason);
    return [{ type: 'error', error: reason.length > 0 ? reason : 'session ended', fatal: false }];
  }
  if (type === 'tool.started' || type === 'tool.completed' || type === 'tool.failed') return none();
  return none();
}

function toolCall(message: Record<string, unknown>): RealtimeEvent[] {
  const name = text(message.toolName);
  const id = text(message.callId);
  if (name.length === 0 || id.length === 0) return none();
  const params = isRecord(message.params) ? message.params : {};
  const call: ToolCall = { type: 'toolCall', id, name, arguments: params as JsonObject };
  return [{ type: 'tool_call', call, blocking: message.expectsResponse !== false }];
}

export function ingestFishText(
  turn: FishTurn,
  packet: FishText,
  localIdentity: string
): RealtimeEvent[] {
  const itemId = text(packet.attributes['lk.segment_id']);
  const id = itemId.length > 0 ? itemId : 'segment';
  const final = packet.attributes['lk.transcription_final'] === 'true';
  if (packet.identity === localIdentity) {
    return [{ type: 'input_transcript', itemId: id, text: packet.text, final }];
  }
  if (turn.discardFinals > 0) {
    if (final) turn.discardFinals -= 1;
    return none();
  }
  turn.turnOpen = true;
  return [{ type: 'output_transcript', itemId: id, text: packet.text, final }];
}

export function ingestFishAudio(turn: FishTurn, chunk: AudioChunk): RealtimeEvent[] {
  if (turn.dropAudio) return none();
  turn.turnOpen = true;
  return [{ type: 'output_audio', itemId: 'agent', chunk }];
}

export function ingestFishState(turn: FishTurn, value: string): RealtimeEvent[] {
  if (value === 'speaking' || value === 'thinking') {
    turn.turnOpen = true;
    return none();
  }
  if (value !== 'listening') return none();
  turn.dropAudio = false;
  if (!turn.turnOpen) return none();
  turn.turnOpen = false;
  return [done('agent', false)];
}

export function ingestSpeakers(turn: FishTurn, identities: string[]): RealtimeEvent[] {
  const active = identities.length > 0;
  if (!active) {
    turn.speaking = false;
    return none();
  }
  if (turn.speaking) return none();
  turn.speaking = true;
  return [{ type: 'input_speech_start' }];
}

export function userMessage(value: string, speak: boolean): JsonObject {
  const message: JsonObject = { type: 'user.message', text: value };
  if (!speak) message.audio = false;
  return message;
}

export function toolResult(callId: string, result: string, isError: boolean): JsonObject {
  const message: JsonObject = { type: 'client_tool.result', callId, result };
  if (isError) message.isError = true;
  return message;
}
