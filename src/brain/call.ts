import type { VoiceAgentEvent } from '../spoken.ts';

export interface VendorCall {
  id: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(event: VoiceAgentEvent): readonly unknown[] {
  const direct = event.message?.content;
  if (Array.isArray(direct)) return direct;
  const model = event.entry?.model;
  if (!Array.isArray(model) || model.length === 0) return [];
  const first = model[0];
  if (!isRecord(first) || !Array.isArray(first.content)) return [];
  return first.content;
}

function callId(id: unknown, name: string): string {
  if (typeof id === 'string' && id.length > 0) return id;
  return name;
}

export function vendorCall(event: VoiceAgentEvent, tools: Set<string>): VendorCall | undefined {
  if (event.type === 'tool_execution_start' && event.toolName && tools.has(event.toolName)) {
    return {
      id: callId(event.toolCallId, event.toolName),
      name: event.toolName,
      arguments: JSON.stringify(event.args ?? {}),
    };
  }
  for (const block of contentBlocks(event)) {
    if (!isRecord(block) || block.type !== 'toolCall' || typeof block.name !== 'string') continue;
    if (!tools.has(block.name)) continue;
    const args = isRecord(block.arguments) ? block.arguments : {};
    return { id: callId(block.id, block.name), name: block.name, arguments: JSON.stringify(args) };
  }
  return undefined;
}
