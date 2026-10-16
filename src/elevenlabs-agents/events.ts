import type { JsonObject, ToolCall } from '@earendil-works/pi-ai';
import type { AudioFormat, CharAlignment } from '../audio.ts';
import { blankUsage } from '../blank-usage.ts';
import { decodeAudioBase64 } from '../convert.ts';
import type { RealtimeEvent } from '../realtime.ts';

export interface TalkTurn {
  vad: boolean;
  dropAudio: boolean;
  lastInterruptId: number;
}

export interface Ingested {
  events: RealtimeEvent[];
  replies: JsonObject[];
}

function none(): Ingested {
  return { events: [], replies: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function transcript(itemId: string, value: string, final: boolean): RealtimeEvent {
  return { type: 'output_transcript', itemId, text: value, final };
}

function done(itemId: string, interrupted: boolean): RealtimeEvent {
  return { type: 'response_done', itemId, interrupted, usage: blankUsage() };
}

function numbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number')) return undefined;
  return value as number[];
}

function alignmentOf(value: unknown): CharAlignment | undefined {
  if (!isRecord(value)) return undefined;
  const startMs = numbers(value.char_start_times_ms);
  const durationMs = numbers(value.char_durations_ms);
  if (startMs === undefined || durationMs === undefined) return undefined;
  return { startMs, durationMs };
}

function pong(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const nested = isRecord(message.ping_event) ? message.ping_event : undefined;
  const raw = nested === undefined ? message.event_id : nested.event_id;
  const eventId = typeof raw === 'number' ? raw : 0;
  return { events: [], replies: [{ type: 'pong', event_id: eventId }] };
}

function metadata(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.conversation_initiation_metadata_event)
    ? message.conversation_initiation_metadata_event
    : undefined;
  const sessionId = text(event?.conversation_id);
  return {
    events: [
      { type: 'session_start', sessionId: sessionId.length > 0 ? sessionId : 'conversation' },
    ],
    replies: [],
  };
}

function userTranscript(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.user_transcription_event)
    ? message.user_transcription_event
    : undefined;
  return {
    events: [
      {
        type: 'input_transcript',
        itemId: 'user',
        text: text(event?.user_transcript),
        final: true,
      },
    ],
    replies: [],
  };
}

function chatPart(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const part = isRecord(message.text_response_part) ? message.text_response_part : undefined;
  if (part === undefined) return none();
  const kind = text(part.type);
  if (kind === 'start' || kind.length === 0) return none();
  const itemId = text(part.response_id);
  return {
    events: [transcript(itemId.length > 0 ? itemId : 'agent', text(part.text), kind === 'stop')],
    replies: [],
  };
}

function agentResponse(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.agent_response_event) ? message.agent_response_event : undefined;
  return { events: [transcript('agent', text(event?.agent_response), true)], replies: [] };
}

function correction(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.agent_response_correction_event)
    ? message.agent_response_correction_event
    : undefined;
  return {
    events: [transcript('agent', text(event?.corrected_agent_response), true)],
    replies: [],
  };
}

function audio(turn: TalkTurn, message: Record<string, unknown>, format: AudioFormat): Ingested {
  const event = isRecord(message.audio_event) ? message.audio_event : undefined;
  const eventId = typeof event?.event_id === 'number' ? event.event_id : 0;
  if (turn.dropAudio || eventId <= turn.lastInterruptId) return none();
  const alignment = alignmentOf(event?.alignment);
  const chars = isRecord(event?.alignment) ? event.alignment.chars : undefined;
  const end = Array.isArray(chars) ? chars.length : 0;
  const itemId = String(eventId);
  const first = alignment?.startMs[0];
  const spoken: RealtimeEvent = {
    type: 'output_audio',
    itemId,
    chunk: {
      data: decodeAudioBase64(text(event?.audio_base_64)),
      format,
      timestamp: typeof first === 'number' ? first : 0,
    },
  };
  if (alignment !== undefined) spoken.alignment = alignment;
  if (end > 0) spoken.span = { itemId, start: 0, end };
  return { events: [spoken], replies: [] };
}

function interruption(turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.interruption_event) ? message.interruption_event : undefined;
  const eventId = typeof event?.event_id === 'number' ? event.event_id : turn.lastInterruptId;
  turn.lastInterruptId = eventId;
  turn.vad = true;
  return { events: [{ type: 'input_speech_start' }, done(String(eventId), true)], replies: [] };
}

function vad(turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.vad_score_event) ? message.vad_score_event : undefined;
  const score = typeof event?.vad_score === 'number' ? event.vad_score : 0;
  const speaking = score > 0.5;
  if (!speaking) {
    turn.vad = false;
    return none();
  }
  if (turn.vad) return none();
  turn.vad = true;
  return { events: [{ type: 'input_speech_start' }], replies: [] };
}

function toolCall(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.client_tool_call) ? message.client_tool_call : undefined;
  const name = text(event?.tool_name);
  const id = text(event?.tool_call_id);
  if (name.length === 0 || id.length === 0) return none();
  const parameters = isRecord(event?.parameters) ? event.parameters : {};
  const call: ToolCall = {
    type: 'toolCall',
    id,
    name,
    arguments: parameters as JsonObject,
  };
  return { events: [{ type: 'tool_call', call, blocking: true }], replies: [] };
}

function complete(turn: TalkTurn, _message: Record<string, unknown>): Ingested {
  turn.dropAudio = false;
  return { events: [done('agent', false)], replies: [] };
}

function clientError(_turn: TalkTurn, message: Record<string, unknown>): Ingested {
  const event = isRecord(message.client_error_event) ? message.client_error_event : undefined;
  const reason = text(event?.message);
  return {
    events: [{ type: 'error', error: reason.length > 0 ? reason : 'client error', fatal: false }],
    replies: [],
  };
}

const handlers: Record<
  string,
  (turn: TalkTurn, message: Record<string, unknown>, format: AudioFormat) => Ingested
> = {
  ping: pong,
  conversation_initiation_metadata: metadata,
  user_transcript: userTranscript,
  agent_chat_response_part: chatPart,
  agent_response: agentResponse,
  agent_response_correction: correction,
  audio,
  interruption,
  vad_score: vad,
  client_tool_call: toolCall,
  agent_response_complete: complete,
  client_error: clientError,
};

export function ingestElevenLabs(
  turn: TalkTurn,
  message: Record<string, unknown>,
  format: AudioFormat
): Ingested {
  const type = message.type;
  if (typeof type !== 'string') return none();
  const handler = handlers[type];
  if (handler === undefined) return none();
  return handler(turn, message, format);
}
