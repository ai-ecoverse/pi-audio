export function sseChunk(
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finish: string | null
): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-brain',
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

export function sseError(message: string): string {
  return `data: ${JSON.stringify({ error: { message } })}\n\n`;
}
