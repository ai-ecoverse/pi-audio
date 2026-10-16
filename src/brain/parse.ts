import { replyHash } from './hash.ts';

export interface Memory {
  hash: string;
  text: string;
  user: string;
}

export interface ParsedTurn {
  model: string;
  sessionKey: string;
  tools: Set<string>;
  prior?: string;
  priorTools: boolean;
  user: string;
}

export type TurnPlan = { replay: true; text: string } | { replay: false; content: string };

const extraNames = [
  'fishaudio_extra_body',
  'llm_extra_body',
  'elevenlabs_extra_body',
  'custom_llm_extra_body',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (isRecord(part) && typeof part.text === 'string') text += part.text;
  }
  return text;
}

function namedSession(extra: unknown): string | undefined {
  if (typeof extra === 'string') return extra.length > 0 ? extra : undefined;
  if (!isRecord(extra)) return undefined;
  const id = extra.session_id;
  if (typeof id === 'string' && id.length > 0) return id;
  return undefined;
}

function sessionOf(body: Record<string, unknown>): string | undefined {
  if (typeof body.session_id === 'string' && body.session_id.length > 0) return body.session_id;
  for (const name of extraNames) {
    const key = namedSession(body[name]);
    if (key !== undefined) return key;
  }
  return undefined;
}

function toolNames(body: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(body.tools)) return names;
  for (const tool of body.tools) {
    if (!isRecord(tool)) continue;
    const fn = tool.function;
    if (!isRecord(fn)) continue;
    if (typeof fn.name !== 'string' || fn.name.length === 0) continue;
    names.add(fn.name);
  }
  return names;
}

function lastTurn(
  messages: unknown
): { prior?: string; priorTools: boolean; user?: string } | undefined {
  if (!Array.isArray(messages)) return undefined;
  let prior: string | undefined;
  let priorTools = false;
  let user: string | undefined;
  for (const message of messages) {
    if (!isRecord(message) || message.role === 'system') continue;
    if (message.role === 'assistant') {
      prior = textOf(message.content);
      priorTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      user = undefined;
      continue;
    }
    if (message.role === 'user' || message.role === 'tool') user = textOf(message.content);
  }
  return { prior, priorTools, user };
}

export function parseTurn(body: unknown): ParsedTurn | string {
  if (!isRecord(body)) return 'invalid chat completion';
  if (body.stream !== true) return 'stream is required';
  const sessionKey = sessionOf(body);
  if (sessionKey === undefined) return 'missing session id';
  const turn = lastTurn(body.messages);
  if (turn?.user === undefined) return 'missing user turn';
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'brain';
  return {
    model,
    sessionKey,
    tools: toolNames(body),
    prior: turn.prior,
    priorTools: turn.priorTools,
    user: turn.user,
  };
}

function sameReply(memory: Memory, prior: string | undefined): boolean {
  if (prior === undefined) return false;
  return replyHash(prior) === memory.hash;
}

export function turnPlan(memory: Memory | undefined, turn: ParsedTurn): TurnPlan {
  if (memory === undefined) return { replay: false, content: turn.user };
  const matches = sameReply(memory, turn.prior);
  if (turn.user === memory.user && !matches && !turn.priorTools) {
    return { replay: true, text: memory.text };
  }
  if (!matches && turn.prior !== undefined && !turn.priorTools) {
    return { replay: false, content: `The caller heard: ${turn.prior}\n\n${turn.user}` };
  }
  return { replay: false, content: turn.user };
}
