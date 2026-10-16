import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRealtime, getVoiceModel } from '@ai-ecoverse/pi-audio';
import { gemini38Live, registerGeminiLive } from '@ai-ecoverse/pi-audio/gemini-live';

function scripted() {
  const connections = [];
  function make() {
    const sent = [];
    const queue = [];
    const waiters = [];
    let closed = false;
    const wire = {
      send(data) {
        sent.push(JSON.parse(data));
      },
      close() {
        closed = true;
        for (const waiter of waiters) waiter({ value: undefined, done: true });
        waiters.length = 0;
      },
      incoming: {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const queued = queue.shift();
            if (queued !== undefined) {
              yield queued;
              continue;
            }
            if (closed) return;
            const next = await new Promise((resolve) => waiters.push(resolve));
            if (next.done === true || next.value === undefined) return;
            yield next.value;
          }
        },
      },
    };
    const api = {
      sent,
      server(event) {
        const raw = JSON.stringify(event);
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter({ value: raw, done: false });
        else queue.push(raw);
      },
    };
    connections.push(api);
    return wire;
  }
  return {
    connections,
    factory(target) {
      const wire = make();
      connections.at(-1).target = target;
      return wire;
    },
  };
}

const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

test('gemini live delivers an async tool when idle and resumes after goAway', async () => {
  assert.match(import.meta.resolve('@ai-ecoverse/pi-audio/gemini-live'), /gemini-live\/index\.js$/);
  const script = scripted();
  const unregister = registerGeminiLive({ wire: script.factory, vocabulary: ['ORD-8472'] });
  try {
    assert.equal(getVoiceModel('realtime', 'google', 'gemini-3.8-live').toolCalls, 'async');
    assert.equal(
      getVoiceModel('realtime', 'google', 'gemini-3.1-flash-live-preview').toolCalls,
      'blocking'
    );
    const session = await connectRealtime(
      gemini38Live,
      { instructions: 'Be brief.', voice: 'Aoede', tools: [readTool] },
      { apiKey: 'gemini-key' }
    );
    const setup = script.connections[0].sent[0].setup;
    assert.equal(setup.model, 'models/gemini-3.8-live');
    assert.deepEqual(setup.inputAudioTranscription.customVocabulary, ['ORD-8472']);
    assert.equal(setup.tools[0].functionDeclarations[0].behavior, undefined);
    assert.equal(setup.contextWindowCompression.slidingWindow.targetTokens, 80_000);
    assert.equal(script.connections[0].target.url.includes('key=gemini-key'), true);
    const events = session[Symbol.asyncIterator]();
    script.connections[0].server({ setupComplete: { sessionId: 'live-1' } });
    assert.equal((await events.next()).value.sessionId, 'live-1');
    script.connections[0].server({
      sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true },
    });
    assert.deepEqual((await events.next()).value, { type: 'resumption', handle: 'handle-1' });
    script.connections[0].server({
      toolCall: { functionCalls: [{ id: 'call-1', name: 'read', args: { path: 'README.md' } }] },
    });
    const call = (await events.next()).value;
    assert.equal(call.type, 'tool_call');
    assert.equal(call.blocking, false);
    assert.equal(call.call.arguments.path, 'README.md');
    session.respond(
      'call-1',
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'hello' }],
        isError: false,
        timestamp: 1,
      },
      'when_idle'
    );
    const response = script.connections[0].sent.at(-1).toolResponse.functionResponses[0];
    assert.equal(response.scheduling, 'WHEN_IDLE');
    assert.deepEqual(response.response, { status: 'ok', retryable: false, message: 'hello' });
    script.connections[0].server({ goAway: { timeLeft: '10s' } });
    assert.deepEqual((await events.next()).value, { type: 'go_away', timeLeftMs: 10_000 });
    assert.equal(script.connections[1].sent[0].setup.sessionResumption.handle, 'handle-1');
    script.connections[1].server({ setupComplete: {} });
    assert.equal((await events.next()).value.type, 'session_start');
    session.interrupt({ itemId: 'g0', heardMs: 20 });
    assert.equal(
      script.connections[1].sent.some((event) => event.toolResponse || event.clientContent),
      false
    );
    const closed = await session.close();
    assert.equal(closed.usage.input, 0);
    assert.equal(closed.usage.audio.textMessages, 0);
  } finally {
    unregister();
  }
});
