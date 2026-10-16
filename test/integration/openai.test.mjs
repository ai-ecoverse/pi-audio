import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, listen, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerOpenAI } from '@ai-ecoverse/pi-audio/openai';

const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

class FakeSocket {
  static latest;
  constructor(url, protocols) {
    this.url = String(url);
    this.protocols = protocols;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.latest = this;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data) {
    this.sent.push(String(data));
  }
  close() {
    this.emit('close', {});
  }
  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

test('openai and openrouter speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('transcription', 'openai', 'whisper-1'), undefined);
  const release = registerOpenAI();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const heard = await transcribe(
      getVoiceModel('transcription', 'openai', 'whisper-1'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.match(String(init.headers['Content-Type']), /multipart/);
          return Response.json({ text: 'hello', usage: { seconds: 1 } });
        },
      }
    );
    assert.equal(heard.text, 'hello');

    const routed = await transcribe(
      getVoiceModel('transcription', 'openrouter', 'openai/whisper-1'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.equal(JSON.parse(init.body).input_audio.format, 'wav');
          return Response.json({ text: 'routed' });
        },
      }
    );
    assert.equal(routed.text, 'routed');

    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'openai', 'tts-1'),
      { text: 'hi', voice: 'alloy' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.equal(JSON.parse(init.body).response_format, 'pcm');
          return new Response(Uint8Array.from([1, 0]));
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);

    const model = getVoiceModel('transcription', 'openai', 'gpt-live-transcribe');
    const pending = (async () => {
      const events = [];
      for await (const event of listen(model, emptyAudio(), { apiKey: 'sk' })) events.push(event);
      return events;
    })();
    const socket = await waitSocket();
    socket.emit('open', {});
    await waitFor(() => socket.sent.some((message) => message.includes('commit')));
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'live',
      }),
    });
    const events = await pending;
    assert.equal(events.at(-1).transcript.text, 'live');
  } finally {
    globalThis.WebSocket = previous;
    release();
  }
});

async function* emptyAudio() {}

function waitSocket() {
  return waitFor(() => FakeSocket.latest);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out');
}

function gatedAudio() {
  const gate = Promise.withResolvers();
  async function* audio() {
    yield { data: new Uint8Array(4800), format: pcm, timestamp: 0 };
    await gate.promise;
  }
  return { audio: audio(), end: gate.resolve };
}

async function vadSession(options) {
  const release = registerOpenAI();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  FakeSocket.latest = undefined;
  const model = getVoiceModel('transcription', 'openai', 'gpt-realtime-whisper');
  const { audio, end } = gatedAudio();
  const events = [];
  const pending = (async () => {
    for await (const event of listen(model, audio, { apiKey: 'sk', ...options })) {
      events.push(event);
    }
    return events;
  })();
  const socket = await waitSocket();
  socket.emit('open', {});
  await waitFor(() => socket.sent.some((message) => message.includes('append')));
  const say = (event) => socket.emit('message', { data: JSON.stringify(event) });
  const restore = () => {
    globalThis.WebSocket = previous;
    release();
  };
  return { socket, say, end, pending, events, restore };
}

const commits = (socket) => socket.sent.filter((message) => message.includes('commit')).length;

test('listen waits for an utterance still in progress when the audio ends', async () => {
  const session = await vadSession();
  try {
    const { socket, say } = session;
    say({ type: 'input_audio_buffer.speech_started', item_id: 'a', audio_start_ms: 0 });
    say({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' });
    say({ type: 'input_audio_buffer.committed', item_id: 'a' });
    say({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'one',
    });
    say({ type: 'input_audio_buffer.speech_started', item_id: 'b', audio_start_ms: 900 });
    say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'tw' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.end();
    await waitFor(() => commits(socket) === 1);
    assert.equal(
      session.events.some((event) => event.type === 'done'),
      false
    );
    say({ type: 'input_audio_buffer.committed', item_id: 'b' });
    say({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'b',
      transcript: 'two',
    });
    const events = await session.pending;
    const tail = events.slice(-3).map((event) => [event.type, event.text]);
    assert.deepEqual(tail, [
      ['final', 'two'],
      ['turn_end', 'two'],
      ['done', undefined],
    ]);
    assert.equal(events.at(-1).transcript.text, 'one two');
  } finally {
    session.restore();
  }
});

test('listen waits for a committed turn and tolerates an empty final commit', async () => {
  const session = await vadSession();
  try {
    const { socket, say } = session;
    say({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
    session.end();
    await waitFor(() => commits(socket) === 1);
    say({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' });
    say({ type: 'input_audio_buffer.committed', item_id: 'a' });
    say({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'empty' } });
    say({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'late',
    });
    const events = await session.pending;
    assert.equal(
      events.some((event) => event.type === 'error'),
      false
    );
    assert.equal(events.at(-1).transcript.text, 'late');
  } finally {
    session.restore();
  }
});

test('listen ends at once when no turn is in flight', async () => {
  const session = await vadSession();
  try {
    const { socket, say } = session;
    say({ type: 'input_audio_buffer.committed', item_id: 'a' });
    say({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'a' });
    say({ type: 'input_audio_buffer.committed', item_id: 'b' });
    say({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'b',
      transcript: 'only',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.end();
    const events = await session.pending;
    assert.equal(commits(socket), 0);
    assert.equal(events.at(-1).transcript.text, 'only');
  } finally {
    session.restore();
  }
});

test('listen commits speech that starts after the audio ends', async () => {
  const session = await vadSession({ drainTimeoutMs: 1000 });
  try {
    const { socket, say } = session;
    session.end();
    await new Promise((resolve) => setTimeout(resolve, 5));
    say({ type: 'input_audio_buffer.speech_started', item_id: 'a' });
    await waitFor(() => commits(socket) === 1);
    say({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'tail' });
    const events = await session.pending;
    assert.equal(events.at(-1).transcript.text, 'tail');
  } finally {
    session.restore();
  }
});

test('listen emits what it heard when the drain times out', async () => {
  const session = await vadSession({ drainTimeoutMs: 20 });
  try {
    const { say } = session;
    say({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'first' });
    say({ type: 'input_audio_buffer.speech_started', item_id: 'b' });
    say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'half' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.end();
    const events = await session.pending;
    const tail = events.slice(-3).map((event) => [event.type, event.text]);
    assert.deepEqual(tail, [
      ['final', 'half'],
      ['turn_end', 'half'],
      ['done', undefined],
    ]);
    assert.equal(events.at(-1).transcript.text, 'first half');
  } finally {
    session.restore();
  }
});
