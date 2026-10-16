import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAgent, bindThinker, connectRealtime } from '@ai-ecoverse/pi-audio';
import { registerFauxRealtime } from '@ai-ecoverse/pi-audio/faux';
import { gemini38Live, registerGeminiLive } from '@ai-ecoverse/pi-audio/gemini-live';
import { gptRealtime2, registerOpenAIRealtime } from '@ai-ecoverse/pi-audio/openai-realtime';
import { grokVoiceLatest, registerXaiRealtime } from '@ai-ecoverse/pi-audio/xai';

const talkerContext = { instructions: '', tools: [askAgent], voice: 'faux' };
const delivery = { interrupt: 'native', when_idle: 'native', silent: 'native' };
const options = {
  progress: 'silent',
  result: 'when_idle',
  ack: 'working on it',
  directTimeoutMs: 1000,
  directMaxChars: 100,
};

function toolCall(id, name, args) {
  return {
    type: 'tool_call',
    blocking: true,
    call: { type: 'toolCall', id, name, arguments: args },
  };
}

function result(id, text, isError = false) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 1,
  };
}

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
  return {
    sent,
    factory() {
      return wire;
    },
    server(event) {
      const raw = JSON.stringify(event);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: raw, done: false });
      else queue.push(raw);
    },
  };
}

test('a blocking thinker failure is injected after the acknowledgement', async () => {
  const faux = registerFauxRealtime({ api: 'review-talker-fail', id: 'fail', delivery });
  try {
    const session = await connectRealtime(faux.model, talkerContext);
    const bound = bindThinker(
      session,
      {
        async *ask() {
          yield { type: 'progress', text: 'started' };
          throw new Error('nope');
        },
      },
      async () => result('x', 'x'),
      options
    );
    const captions = [];
    const reading = (async () => {
      for await (const caption of bound.captions) captions.push(caption);
    })();
    faux.emit(toolCall('c1', 'ask_agent', { request: 'fix it' }));
    await new Promise((resolve) => setImmediate(resolve));
    await session.close();
    await bound.done;
    await reading;
    const ack = faux.calls.find((call) => call.method === 'respond');
    assert.equal(ack.result.content[0].text, 'working on it');
    const injected = faux.calls.find((call) => call.method === 'inject' && call.text === 'nope');
    assert.equal(injected.text, 'nope');
    assert.equal(injected.delivery, 'when_idle');
    const failure = captions.find((caption) => caption.type === 'thinker_result');
    assert.equal(failure.isError, true);
    assert.equal(failure.summary, 'nope');
  } finally {
    faux.unregister();
  }
});

test('closing the session aborts an outstanding thinker', { timeout: 2000 }, async () => {
  const faux = registerFauxRealtime({ api: 'review-talker-close', id: 'close', delivery });
  try {
    const session = await connectRealtime(faux.model, talkerContext);
    let signal;
    const bound = bindThinker(
      session,
      {
        async *ask(_request, _heard, abort) {
          signal = abort;
          await new Promise((resolve) => abort.addEventListener('abort', () => resolve()));
        },
      },
      async () => result('x', 'x'),
      options
    );
    faux.emit({ ...toolCall('c1', 'ask_agent', { request: 'wait' }), blocking: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, false);
    await session.close();
    await bound.done;
    assert.equal(signal.aborted, true);
  } finally {
    faux.unregister();
  }
});

test('ask_agent context is passed to the thinker', async () => {
  const faux = registerFauxRealtime({ api: 'review-talker-context', id: 'context', delivery });
  try {
    const session = await connectRealtime(faux.model, talkerContext);
    let seen;
    const bound = bindThinker(
      session,
      {
        async *ask(_request, _heard, _signal, context) {
          seen = context;
          yield { type: 'result', message: result('c1', 'ok') };
        },
      },
      async () => result('x', 'x'),
      options
    );
    faux.emit(toolCall('c1', 'ask_agent', { request: 'fix it', context: 'src/talker.ts' }));
    await new Promise((resolve) => setImmediate(resolve));
    await session.close();
    await bound.done;
    assert.equal(seen, 'src/talker.ts');
  } finally {
    faux.unregister();
  }
});

test('cancelling a direct tool aborts it without a response', { timeout: 2000 }, async () => {
  const faux = registerFauxRealtime({ api: 'review-talker-direct', id: 'direct', delivery });
  try {
    const session = await connectRealtime(faux.model, talkerContext);
    let signal;
    const bound = bindThinker(
      session,
      { async *ask() {} },
      (_call, abort) =>
        new Promise((resolve) => {
          signal = abort;
          abort.addEventListener('abort', () => resolve(result('read-1', 'late')));
        }),
      options
    );
    faux.emit(toolCall('read-1', 'read', { path: 'src/talker.ts' }));
    await new Promise((resolve) => setImmediate(resolve));
    faux.emit({ type: 'tool_call_cancelled', callId: 'read-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(
      faux.calls.some((call) => call.method === 'respond'),
      false
    );
    await session.close();
    await bound.done;
  } finally {
    faux.unregister();
  }
});

test('the voice socket sends session setup only after it opens', async () => {
  class HoldingSocket {
    constructor() {
      this.sent = [];
      this.listeners = {};
      HoldingSocket.latest = this;
    }
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
  }
  const openai = registerOpenAIRealtime({ socket: HoldingSocket });
  try {
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [] },
      { apiKey: 'sk-test' }
    );
    session.sendText('hello');
    assert.deepEqual(HoldingSocket.latest.sent, []);
    HoldingSocket.latest.listeners.open();
    assert.deepEqual(
      HoldingSocket.latest.sent.map((event) => event.type),
      ['session.update', 'conversation.item.create', 'response.create']
    );
    await session.close();
  } finally {
    openai();
  }
  const gemini = registerGeminiLive({ socket: HoldingSocket });
  try {
    const session = await connectRealtime(
      gemini38Live,
      { instructions: 'Be brief.', voice: 'Aoede', tools: [] },
      { apiKey: 'gemini-key' }
    );
    assert.deepEqual(HoldingSocket.latest.sent, []);
    HoldingSocket.latest.listeners.open();
    assert.equal(HoldingSocket.latest.sent[0].setup.model, 'models/gemini-3.8-live');
    await session.close();
  } finally {
    gemini();
  }
});

test('openai and xai sessions enable input transcription', async () => {
  const openaiScript = scripted();
  const openai = registerOpenAIRealtime({ wire: openaiScript.factory });
  try {
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [] },
      { apiKey: 'sk-test' }
    );
    assert.equal(
      openaiScript.sent[0].session.audio.input.transcription.model,
      'gpt-4o-mini-transcribe'
    );
    await session.close();
  } finally {
    openai();
  }
  const xaiScript = scripted();
  const xai = registerXaiRealtime({ wire: xaiScript.factory });
  try {
    const session = await connectRealtime(
      grokVoiceLatest,
      { instructions: 'Be brief.', voice: 'eve', tools: [] },
      { apiKey: 'xai-key' }
    );
    assert.equal(xaiScript.sent[0].session.audio.input.transcription.model, 'grok-transcribe');
    await session.close();
  } finally {
    xai();
  }
});

test('response.create waits for parallel tools and for the active response', async () => {
  for (const vendor of [
    { register: registerOpenAIRealtime, model: gptRealtime2, key: 'sk-test' },
    { register: registerXaiRealtime, model: grokVoiceLatest, key: 'xai-key' },
  ]) {
    const script = scripted();
    const unregister = vendor.register({ wire: script.factory });
    try {
      const session = await connectRealtime(
        vendor.model,
        { instructions: 'Be brief.', voice: 'marin', tools: [] },
        { apiKey: vendor.key }
      );
      const events = session[Symbol.asyncIterator]();
      script.server({
        type: 'response.function_call_arguments.done',
        call_id: 'a',
        name: 'read',
        arguments: '{}',
      });
      script.server({
        type: 'response.function_call_arguments.done',
        call_id: 'b',
        name: 'read',
        arguments: '{}',
      });
      assert.equal((await events.next()).value.call.id, 'a');
      assert.equal((await events.next()).value.call.id, 'b');
      session.respond('a', result('a', 'one'));
      assert.equal(script.sent.at(-1).item.type, 'function_call_output');
      assert.equal(
        script.sent.some((event) => event.type === 'response.create'),
        false
      );
      session.respond('b', result('b', 'two'));
      assert.equal(script.sent.at(-1).type, 'response.create');
      const created = script.sent.filter((event) => event.type === 'response.create').length;
      session.sendText('again');
      assert.equal(script.sent.filter((event) => event.type === 'response.create').length, created);
      script.server({ type: 'response.done', response: { status: 'completed' } });
      assert.equal((await events.next()).value.type, 'response_done');
      assert.equal(
        script.sent.filter((event) => event.type === 'response.create').length,
        created + 1
      );
      await session.close();
    } finally {
      unregister();
    }
  }
});

test('a done output transcript spans only the unread suffix', async () => {
  const script = scripted();
  const unregister = registerOpenAIRealtime({ wire: script.factory });
  try {
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [] },
      { apiKey: 'sk-test' }
    );
    const events = session[Symbol.asyncIterator]();
    const chunk = 'QQ==';
    script.server({ type: 'response.output_audio.delta', item_id: 'snap', delta: chunk });
    script.server({ type: 'response.output_audio.delta', item_id: 'snap', delta: chunk });
    script.server({
      type: 'response.output_audio_transcript.delta',
      item_id: 'snap',
      delta: 'Hi',
    });
    assert.deepEqual((await events.next()).value.span, { itemId: 'snap', start: 0, end: 1 });
    assert.deepEqual((await events.next()).value.span, { itemId: 'snap', start: 1, end: 2 });
    assert.equal((await events.next()).value.text, 'Hi');
    script.server({ type: 'response.output_audio.delta', item_id: 'snap', delta: chunk });
    script.server({
      type: 'response.output_audio_transcript.done',
      item_id: 'snap',
      transcript: 'Hi there',
    });
    assert.deepEqual((await events.next()).value.span, { itemId: 'snap', start: 2, end: 8 });
    const snapshot = (await events.next()).value;
    assert.equal(snapshot.text, 'Hi there');
    assert.equal(snapshot.final, true);
    await session.close();
  } finally {
    unregister();
  }
});

test('gemini live batches function responses from one tool call', async () => {
  const connections = [];
  const unregister = registerGeminiLive({
    wire() {
      const sent = [];
      const queue = [];
      const waiters = [];
      let closed = false;
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
      return {
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
    },
  });
  try {
    const session = await connectRealtime(
      gemini38Live,
      { instructions: 'Be brief.', voice: 'Aoede', tools: [] },
      { apiKey: 'gemini-key' }
    );
    const wire = connections[0];
    const events = session[Symbol.asyncIterator]();
    wire.server({ setupComplete: { sessionId: 'live' } });
    assert.equal((await events.next()).value.sessionId, 'live');
    wire.server({
      toolCall: {
        functionCalls: [
          { id: 'a', name: 'read', args: { path: 'a' } },
          { id: 'b', name: 'read', args: { path: 'b' } },
        ],
      },
    });
    assert.equal((await events.next()).value.call.id, 'a');
    assert.equal((await events.next()).value.call.id, 'b');
    const before = wire.sent.filter((event) => event.toolResponse).length;
    session.respond('a', result('a', 'one'));
    assert.equal(wire.sent.filter((event) => event.toolResponse).length, before);
    session.respond('b', result('b', 'two'));
    const responses = wire.sent.at(-1).toolResponse.functionResponses;
    assert.equal(responses.length, 2);
    assert.deepEqual(
      responses.map((entry) => entry.id),
      ['a', 'b']
    );
    await session.close();
  } finally {
    unregister();
  }
});
