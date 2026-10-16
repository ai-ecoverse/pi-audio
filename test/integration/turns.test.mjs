import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listen, speak, voiceTurns } from '@ai-ecoverse/pi-audio';
import { registerFauxSpeech, registerFauxTranscription } from '@ai-ecoverse/pi-audio/faux';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };
const signature = (phase) => JSON.stringify({ v: 1, id: phase, phase });

function chunk(text, timestamp) {
  return { data: new TextEncoder().encode(text), format, timestamp };
}

function sink() {
  const chunks = [];
  let playedMs = 0;
  let flushed = 0;
  const listeners = new Set();
  return {
    chunks,
    get flushed() {
      return flushed;
    },
    get playedMs() {
      return playedMs;
    },
    write(audio, tag) {
      chunks.push({
        data: [...audio.data].map((byte) => String.fromCharCode(byte)).join(''),
        tag,
      });
      playedMs += 20;
      for (const listener of listeners) listener(tag, 0);
    },
    flush() {
      flushed += 1;
    },
    onPlayback(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function collect(session) {
  const phases = [];
  const captions = [];
  await Promise.all([
    (async () => {
      for await (const phase of session.phases) phases.push(phase);
    })(),
    (async () => {
      for await (const caption of session.captions) captions.push(caption);
    })(),
    session.done,
  ]);
  return { phases, captions };
}

test('a faux voice turn speaks only the final answer', async () => {
  const ears = registerFauxTranscription({
    api: 'integration-turns-ears',
    id: 'ears',
    cues: [
      {
        at: 1,
        events: [
          { type: 'partial', segmentId: 's', text: 'hello' },
          { type: 'final', segmentId: 's', text: 'hello', confidence: 0.9 },
          { type: 'turn_end', text: 'hello', at: 20 },
        ],
      },
    ],
  });
  const mouth = registerFauxSpeech({
    api: 'integration-turns-mouth',
    id: 'mouth',
    textStreaming: false,
    chunkChars: 100,
  });
  const prompts = [];
  const out = sink();
  const session = voiceTurns(
    { listen, speak },
    {
      async *prompt(message, meta) {
        prompts.push({ message, meta });
        yield {
          type: 'message_update',
          changes: [
            { type: 'thinking_delta', contentIndex: 0, delta: 'secret' },
            {
              type: 'text_start',
              contentIndex: 1,
              block: { type: 'text', text: '', textSignature: signature('commentary') },
            },
            { type: 'text_delta', contentIndex: 1, delta: 'Do not say this.' },
          ],
        };
        yield { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'call-1', args: {} };
        yield {
          type: 'message_update',
          changes: [
            { type: 'text_delta', contentIndex: 2, delta: 'Hello there. ' },
            { type: 'text_delta', contentIndex: 2, delta: 'Next sentence!' },
          ],
        };
        yield {
          type: 'message_end',
          entry: {
            id: 8,
            model: [
              {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: 'secret' },
                  {
                    type: 'text',
                    text: 'Do not say this.',
                    textSignature: signature('commentary'),
                  },
                  { type: 'text', text: 'Hello there. Next sentence!' },
                ],
              },
            ],
          },
        };
      },
      async truncate() {},
    },
    (async function* mic() {
      yield chunk('hello', 20);
    })(),
    out,
    {
      ears: ears.model,
      mouth: mouth.model,
      voice: 'faux',
      announce: () => 'Running bash. ',
    },
    new AbortController().signal
  );
  const { phases } = await collect(session);
  assert.deepEqual(prompts[0].message, { role: 'user', content: 'hello', timestamp: 20 });
  assert.deepEqual(prompts[0].meta, {
    source: 'voice',
    transcriptionModel: 'ears',
    confidence: 0.9,
  });
  assert.deepEqual(
    mouth.calls.map((call) => call.text),
    ['Running bash. ', 'Hello there. ', 'Next sentence!']
  );
  assert.equal(
    out.chunks.map((item) => item.data).join(''),
    'Running bash. Hello there. Next sentence!'
  );
  assert.equal(out.chunks.at(-1).tag.span.entryId, '8');
  assert.ok(phases.some((phase) => phase.phase === 'speaking'));
  ears.unregister();
  mouth.unregister();
});

test('barge-in aborts a faux voice turn and its speech', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ears = registerFauxTranscription({
    api: 'integration-turns-barge-ears',
    id: 'barge-ears',
    cues: [
      { at: 1, events: [{ type: 'turn_end', text: 'hello', at: 5 }] },
      { at: 2, events: [{ type: 'speech_start', at: 40 }] },
    ],
  });
  const mouth = registerFauxSpeech({
    api: 'integration-turns-barge-mouth',
    id: 'barge-mouth',
    textStreaming: true,
    chunkChars: 20,
  });
  const cuts = [];
  let aborted = false;
  const out = sink();
  const session = voiceTurns(
    { listen, speak },
    {
      async *prompt(_message, _meta, signal) {
        yield {
          type: 'message_end',
          entry: {
            id: 3,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] }],
          },
        };
        yield {
          type: 'message_update',
          changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Hello there.' }],
        };
        release();
        await new Promise((resolve) => {
          if (signal.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
      async truncate(cut) {
        cuts.push(cut);
      },
    },
    (async function* mic() {
      yield chunk('hello', 5);
      await gate;
      yield chunk('stop', 40);
    })(),
    out,
    { ears: ears.model, mouth: mouth.model, voice: 'faux', bargeIn: 'interrupt' },
    new AbortController().signal
  );
  await collect(session);
  assert.equal(aborted, true);
  assert.equal(out.flushed, 1);
  assert.equal(cuts.length, 0);
  ears.unregister();
  mouth.unregister();
});
