import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blankUsage,
  captionsFromHistory,
  convertAudio,
  energyVad,
  followBed,
  listen,
  registerTranscriptionApiProvider,
  TranscriptionEventStream,
  voiceTurns,
} from '@ai-ecoverse/pi-audio';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };
const ears = { id: 'ears' };
const mouth = { id: 'mouth' };

function model(api) {
  return {
    id: 'ears',
    name: 'Ears',
    api,
    provider: 'review',
    baseUrl: 'http://localhost',
    type: 'transcription',
    turnDetection: 'none',
    inputFormats: [format],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    audioCost: {},
  };
}

function pcm(amplitude, samples, timestamp, sampleRate = 16000) {
  const data = new Int16Array(samples);
  data.fill(amplitude);
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    format: { encoding: 'pcm16', sampleRate, channels: 1 },
    timestamp,
  };
}

async function* source(chunks) {
  for (const chunk of chunks) yield chunk;
}

async function eventsOf(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function playback(onWrite) {
  const listeners = new Set();
  return {
    playedMs: 0,
    write(chunk, tag) {
      onWrite(chunk, tag, listeners, this);
    },
    flush() {},
    onPlayback(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function captionsOf(session) {
  const captions = [];
  const reading = (async () => {
    for await (const caption of session.captions) captions.push(caption);
  })();
  const result = session.done.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error })
  );
  await reading;
  return { captions, ...(await result) };
}

test('a slow provider still delivers its transcript after the mic closes', async () => {
  const earsModel = model('review-slow-stt');
  const release = registerTranscriptionApiProvider({
    api: earsModel.api,
    listen(_model, audio) {
      const stream = new TranscriptionEventStream();
      void (async () => {
        for await (const chunk of audio) void chunk;
        for (let step = 0; step < 80; step += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        stream.push({ type: 'final', segmentId: 'a', text: 'hello' });
        stream.push({ type: 'done', transcript: { text: 'hello', usage: blankUsage() } });
      })();
      return stream;
    },
  });
  try {
    const heard = await eventsOf(listen(earsModel, source([pcm(1, 1, 0)])));
    assert.equal(
      heard.some((event) => event.error === 'Transcription ended without a transcript'),
      false
    );
    assert.equal(heard.at(-1).transcript.text, 'hello');
  } finally {
    release();
  }
});

test('a final that lands after local silence stays in the same turn', async () => {
  const earsModel = model('review-late-final');
  const release = registerTranscriptionApiProvider({
    api: earsModel.api,
    listen(_model, audio) {
      const stream = new TranscriptionEventStream();
      void (async () => {
        let count = 0;
        for await (const chunk of audio) {
          count += 1;
          if (count === 1) stream.push({ type: 'partial', segmentId: 'a', text: 'hel' });
          if (count === 2) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            stream.push({ type: 'final', segmentId: 'a', text: 'hello', confidence: 1 });
          }
        }
        stream.push({ type: 'done', transcript: { text: 'hello', usage: blankUsage() } });
      })();
      return stream;
    },
  });
  try {
    const heard = await eventsOf(
      listen(earsModel, source([pcm(1, 1, 0), pcm(1, 1, 30)]), {
        vad: {
          push(chunk) {
            if (chunk.timestamp === 0) return { speechStart: 0 };
            return { turnEnd: 40 };
          },
        },
      })
    );
    assert.deepEqual(
      heard.map((event) => event.type),
      ['speech_start', 'partial', 'final', 'turn_end', 'done']
    );
    assert.equal(heard.find((event) => event.type === 'turn_end').text, 'hello');
  } finally {
    release();
  }
});

test('default energy vad ends a mulaw turn and rejects opus', async () => {
  const law = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
  const vad = energyVad({ silenceMs: 50 });
  const loud = convertAudio(pcm(8000, 80, 0, 8000), law);
  const quiet = convertAudio(pcm(0, 800, 20, 8000), law);
  assert.equal(vad.push(loud).speechStart, 0);
  assert.equal(typeof vad.push(quiet).turnEnd, 'number');
  const earsModel = model('review-opus-vad');
  const release = registerTranscriptionApiProvider({
    api: earsModel.api,
    listen(_model, audio) {
      const stream = new TranscriptionEventStream();
      void (async () => {
        for await (const chunk of audio) void chunk;
        stream.push({ type: 'done', transcript: { text: '', usage: blankUsage() } });
      })();
      return stream;
    },
  });
  try {
    const heard = await eventsOf(
      listen(
        earsModel,
        source([
          {
            data: Uint8Array.of(1),
            format: { encoding: 'opus', sampleRate: 48000, channels: 1 },
            timestamp: 0,
          },
        ])
      )
    );
    assert.match(heard.at(-1).error, /requires PCM audio, received opus/);
  } finally {
    release();
  }
});

test('a prompt failure rejects the voice session without an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const session = voiceTurns(
      {
        async *listen() {
          yield { type: 'turn_end', text: 'hello', at: 1 };
          await new Promise(() => {});
        },
        async *speak() {},
      },
      {
        async *prompt() {
          yield { type: 'run_start' };
          throw new Error('boom');
        },
        async truncate() {},
      },
      (async function* mic() {})(),
      playback(() => {}),
      { ears, mouth, voice: 'faux' },
      new AbortController().signal
    );
    await assert.rejects(session.done, /boom/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('barge-in truncates audio that played before the durable entry id', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const cuts = [];
  const session = voiceTurns(
    {
      async *listen() {
        yield { type: 'turn_end', text: 'hello', at: 1 };
        await gate;
        yield { type: 'speech_start', at: 2 };
      },
      async *speak(_model, input) {
        let cursor = 0;
        for await (const part of input.text) {
          const start = cursor;
          cursor += part.length;
          yield {
            type: 'audio',
            chunk: {
              data: Uint8Array.from(part, (char) => char.charCodeAt(0)),
              format,
              timestamp: 0,
            },
            span: { itemId: 'mouth', start, end: cursor },
          };
        }
      },
    },
    {
      async *prompt(_message, _meta, signal) {
        yield {
          type: 'message_update',
          changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Hello there.' }],
        };
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield {
          type: 'message_end',
          entry: {
            id: 9,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] }],
          },
        };
        release();
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async truncate(cut) {
        cuts.push(cut);
      },
    },
    (async function* mic() {})(),
    playback((_chunk, tag, listeners) => {
      for (const listener of listeners) listener(tag, 0);
    }),
    { ears, mouth, voice: 'faux' },
    new AbortController().signal
  );
  const result = await captionsOf(session);
  assert.equal(result.ok, true, result.error);
  assert.equal(cuts[0].entryId, '9');
});

test('barge-in cuts at the played offset inside a chunk', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const cuts = [];
  const session = voiceTurns(
    {
      async *listen() {
        yield { type: 'turn_end', text: 'hello', at: 1 };
        await gate;
        yield { type: 'speech_start', at: 2 };
      },
      async *speak() {
        yield {
          type: 'audio',
          chunk: { data: new Uint8Array(32000), format, timestamp: 0 },
          span: { itemId: 'mouth', start: 0, end: 10 },
        };
      },
    },
    {
      async *prompt(_message, _meta, signal) {
        yield {
          type: 'message_end',
          entry: {
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: '0123456789' }] }],
          },
        };
        release();
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      async truncate(cut) {
        cuts.push(cut);
      },
    },
    (async function* mic() {})(),
    playback((_chunk, tag, listeners, out) => {
      out.playedMs = 500;
      for (const listener of listeners) listener(tag, 500);
    }),
    { ears, mouth, voice: 'faux' },
    new AbortController().signal
  );
  const result = await captionsOf(session);
  assert.equal(result.ok, true, result.error);
  assert.equal(cuts[0].heardUpTo, 5);
});

test('an earlier queued chunk keeps its own playback clock', async () => {
  const mp3 = { encoding: 'mp3', sampleRate: 16000, channels: 1 };
  const session = voiceTurns(
    {
      async *listen() {
        yield { type: 'turn_end', text: 'hello', at: 1 };
      },
      async *speak() {
        yield {
          type: 'audio',
          chunk: { data: Uint8Array.of(1), format: mp3, timestamp: 0 },
          span: { itemId: 'mouth', start: 0, end: 4 },
        };
        yield {
          type: 'audio',
          chunk: { data: Uint8Array.of(2), format: mp3, timestamp: 4 },
          span: { itemId: 'mouth', start: 4, end: 20 },
        };
      },
    },
    {
      async *prompt() {
        yield {
          type: 'message_end',
          entry: {
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] }],
          },
        };
      },
      async truncate() {},
    },
    (async function* mic() {})(),
    playback((_chunk, tag, listeners) => {
      if (tag.span.start !== 0) return;
      for (const listener of listeners) listener(tag, 1);
    }),
    { ears, mouth, voice: 'faux' },
    new AbortController().signal
  );
  const result = await captionsOf(session);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(
    result.captions
      .filter((caption) => caption.type === 'agent_spoken')
      .map((caption) => caption.upTo),
    [1]
  );
});

test('a compressed chunk reveals text in step with playback', async () => {
  const session = voiceTurns(
    {
      async *listen() {
        yield { type: 'turn_end', text: 'hello', at: 1 };
      },
      async *speak() {
        yield {
          type: 'audio',
          chunk: {
            data: Uint8Array.of(1, 2, 3),
            format: { encoding: 'opus', sampleRate: 48000, channels: 1 },
            timestamp: 0,
          },
          span: { itemId: 'mouth', start: 0, end: 8 },
        };
      },
    },
    {
      async *prompt() {
        yield {
          type: 'message_end',
          entry: {
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: '12345678' }] }],
          },
        };
      },
      async truncate() {},
    },
    (async function* mic() {})(),
    playback((_chunk, tag, listeners) => {
      for (const listener of listeners) listener(tag, 1);
    }),
    { ears, mouth, voice: 'faux' },
    new AbortController().signal
  );
  const result = await captionsOf(session);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.captions.find((caption) => caption.type === 'agent_spoken').upTo, 1);
});

test('a history cut uses the original assistant content index', () => {
  const captions = captionsFromHistory([
    {
      id: 7,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret' },
            { type: 'text', text: 'Hello there.' },
          ],
        },
      ],
    },
    {
      id: 8,
      kind: 'voice.truncate',
      data: { entryId: '7', contentIndex: 1, heardUpTo: 5, heardMs: 40 },
    },
  ]);
  assert.equal(captions.find((caption) => caption.type === 'agent_generated').text, 'Hello there.');
  assert.equal(captions.find((caption) => caption.type === 'agent_spoken').upTo, 5);
});

test('stopping a follower fades out a bed that was kept', () => {
  const events = [];
  const bed = {
    play() {
      events.push('play');
    },
    duck() {},
    stop(fadeMs) {
      events.push(['stop', fadeMs]);
    },
  };
  const follower = followBed(bed, {
    fadeMs: 12,
    cue(next) {
      if (next.phase === 'listening') return { kind: 'loop', source: { url: 'bed' }, gain: 0.2 };
      return { kind: 'keep' };
    },
  });
  follower.observe({ phase: 'listening' });
  follower.observe({ phase: 'speaking' });
  follower.stop();
  assert.deepEqual(
    events.filter((event) => Array.isArray(event)),
    [['stop', 12]]
  );
});

test('two loops with the same shape do not share a bed', () => {
  const played = [];
  const bed = {
    play(cue) {
      played.push(cue.source.buffer ?? cue.source.synth);
    },
    duck() {},
    stop() {},
  };
  const left = { length: 4 };
  const right = { length: 4 };
  const synthA = () => ({});
  const synthB = () => ({});
  const sources = [{ buffer: left }, { buffer: right }, { synth: synthA }, { synth: synthB }];
  let cursor = 0;
  const follower = followBed(bed, {
    cue() {
      const source = sources[cursor];
      cursor += 1;
      return { kind: 'loop', source, gain: 1 };
    },
  });
  follower.observe({ phase: 'listening' });
  follower.observe({ phase: 'thinking' });
  follower.observe({ phase: 'speaking' });
  follower.observe({ phase: 'compacting' });
  assert.deepEqual(played, [left, right, synthA, synthB]);
});
