import type { BrainOptions } from './options.ts';
import type { Memory } from './parse.ts';
import { parseTurn, turnPlan } from './parse.ts';
import { runTurn } from './turn.ts';

export type { BrainBudget, BrainOptions } from './options.ts';

function jsonError(message: string): Response {
  return Response.json({ error: { message } }, { status: 400 });
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function chatCompletionsBrain(
  options: BrainOptions
): (request: Request) => Promise<Response> {
  const sessions = new Map<string, Memory>();
  return async (request) => {
    const body = await readBody(request);
    if (body === undefined) return jsonError('invalid chat completion');
    const parsed = parseTurn(body);
    if (typeof parsed === 'string') return jsonError(parsed);
    const plan = turnPlan(sessions.get(parsed.sessionKey), parsed);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await runTurn(options, sessions, parsed, plan, request, controller);
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  };
}
