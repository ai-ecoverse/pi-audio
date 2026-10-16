import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRealtime, getVoiceModel } from '@ai-ecoverse/pi-audio';
import { gptRealtime2, registerOpenAIRealtime } from '@ai-ecoverse/pi-audio/openai-realtime';
import { grokVoiceLatest, registerXaiRealtime } from '@ai-ecoverse/pi-audio/xai';

function scripted() {
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
    target: undefined,
    factory(target) {
      api.target = target;
      return wire;
    },
    server(event) {
      const raw = JSON.stringify(event);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: raw, done: false });
      else queue.push(raw);
    },
  };
  return api;
}

const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

test('openai realtime replays a tool round and truncates on barge-in', async () => {
  assert.match(
    import.meta.resolve('@ai-ecoverse/pi-audio/openai-realtime'),
    /openai-realtime\/index\.js$/
  );
  const script = scripted();
  const unregister = registerOpenAIRealtime({ wire: script.factory });
  try {
    assert.equal(getVoiceModel('realtime', 'openai', 'gpt-realtime-2').id, 'gpt-realtime-2');
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [readTool] },
      { apiKey: 'sk-test' }
    );
    const events = session[Symbol.asyncIterator]();
    script.server({ type: 'session.created', session: { id: 'sess' } });
    assert.equal((await events.next()).value.sessionId, 'sess');
    script.server({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'read',
      arguments: '{"path":"README.md"}',
    });
    const call = (await events.next()).value;
    assert.equal(call.type, 'tool_call');
    assert.equal(call.call.name, 'read');
    session.respond('call-1', {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
      timestamp: 1,
    });
    assert.equal(script.sent.at(-2).item.type, 'function_call_output');
    assert.equal(script.sent.at(-2).item.output, 'hello');
    assert.equal(script.sent.at(-1).type, 'response.create');
    script.server({ type: 'response.output_audio.delta', item_id: 'msg', delta: 'QQ==' });
    script.server({ type: 'response.output_audio.delta', item_id: 'msg', delta: 'Qg==' });
    script.server({ type: 'response.output_audio_transcript.delta', item_id: 'msg', delta: 'Hi' });
    const first = (await events.next()).value;
    const second = (await events.next()).value;
    assert.equal(first.type, 'output_audio');
    assert.deepEqual(first.span, { itemId: 'msg', start: 0, end: 1 });
    assert.deepEqual(second.span, { itemId: 'msg', start: 1, end: 2 });
    assert.equal((await events.next()).value.text, 'Hi');
    session.interrupt({ itemId: 'msg', heardMs: 20 });
    assert.equal(script.sent.at(-2).type, 'response.cancel');
    assert.deepEqual(script.sent.at(-1), {
      type: 'conversation.item.truncate',
      item_id: 'msg',
      content_index: 0,
      audio_end_ms: 20,
    });
    script.server({
      type: 'response.done',
      response: { id: 'resp', status: 'cancelled', output: [{ id: 'msg' }] },
    });
    const done = (await events.next()).value;
    assert.equal(done.interrupted, true);
    const closed = await session.close();
    assert.equal(typeof closed.usage.audio.inputSeconds, 'number');
  } finally {
    unregister();
  }
});

test('xai realtime speaks force_message and resumes across a conversation id', async () => {
  assert.match(import.meta.resolve('@ai-ecoverse/pi-audio/xai'), /xai\/index\.js$/);
  const script = scripted();
  const unregister = registerXaiRealtime({ wire: script.factory, replace: { Acme: 'Ackme' } });
  try {
    assert.equal(getVoiceModel('realtime', 'xai', 'grok-voice-latest').resumable, true);
    const session = await connectRealtime(
      grokVoiceLatest,
      { instructions: 'Be brief.', voice: 'eve', tools: [readTool] },
      {
        token: { value: 'xai-eph', expiresAt: 9, model: 'grok-voice-latest' },
        resumeHandle: 'conv-1',
      }
    );
    assert.equal(
      script.target.url,
      'wss://api.x.ai/v1/realtime?model=grok-voice-latest&conversation_id=conv-1'
    );
    assert.deepEqual(script.target.protocols, ['xai-client-secret.xai-eph']);
    assert.equal(script.sent[0].session.replace.Acme, 'Ackme');
    assert.equal(script.sent[0].session.resumption.enabled, true);
    const events = session[Symbol.asyncIterator]();
    script.server({ type: 'conversation.created', conversation: { id: 'conv-1' } });
    assert.deepEqual((await events.next()).value, { type: 'resumption', handle: 'conv-1' });
    script.server({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'u',
      transcript: 'Hello?',
    });
    script.server({
      type: 'conversation.item.input_audio_transcription.updated',
      item_id: 'u',
      transcript: 'Hello there',
    });
    assert.equal((await events.next()).value.text, 'Hello?');
    assert.equal((await events.next()).value.final, false);
    session.inject('working on it', 'when_idle');
    assert.equal(script.sent.at(-1).item.type, 'force_message');
    assert.equal(script.sent.at(-1).item.content[0].text, 'working on it');
    assert.equal(
      script.sent.some((event) => event.type === 'response.create' && script.sent.at(-1).item),
      false
    );
    script.server({
      type: 'response.function_call_arguments.done',
      call_id: 'call-9',
      name: 'read',
      arguments: '{"path":"src"}',
    });
    assert.equal((await events.next()).value.call.id, 'call-9');
    session.respond(
      'call-9',
      {
        role: 'toolResult',
        toolCallId: 'call-9',
        toolName: 'read',
        content: [{ type: 'text', text: 'src' }],
        isError: false,
        timestamp: 2,
      },
      'when_idle'
    );
    assert.equal(script.sent.at(-2).item.call_id, 'call-9');
    session.interrupt({ itemId: 'msg', heardMs: 8 });
    assert.equal(script.sent.at(-1).audio_end_ms, 8);
    await session.close();
  } finally {
    unregister();
  }
});
