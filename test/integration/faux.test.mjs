import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRealtime, listen, speak } from '@ai-ecoverse/pi-audio';
import {
  registerFauxRealtime,
  registerFauxSpeech,
  registerFauxTranscription,
} from '@ai-ecoverse/pi-audio/faux';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };

test('tests can run on the faux voice providers alone', async () => {
  const ears = registerFauxTranscription({ api: 'integration-faux-stt', id: 'ears' });
  ears.setCues([
    { at: 1, events: [{ type: 'speech_start', at: 2 }] },
    { at: 1, events: [{ type: 'partial', segmentId: 'a', text: 'hel' }] },
    { at: 'end', events: [{ type: 'final', segmentId: 'a', text: 'hello', confidence: 1 }] },
    { at: 'end', events: [{ type: 'turn_end', text: 'hello', at: 8 }] },
  ]);
  const heard = [];
  for await (const event of listen(
    ears.model,
    (async function* mic() {
      yield { data: new TextEncoder().encode('hello'), format, timestamp: 2 };
    })()
  )) {
    heard.push(event.type);
  }
  assert.deepEqual(heard, ['speech_start', 'partial', 'final', 'turn_end', 'done']);

  const mouth = registerFauxSpeech({
    api: 'integration-faux-tts',
    id: 'mouth',
    alignment: true,
    chunkChars: 4,
  });
  const spoken = [];
  for await (const event of speak(mouth.model, { text: 'hello!!', voice: 'faux' }))
    spoken.push(event);
  const audio = spoken.filter((event) => event.type === 'audio');
  assert.equal(audio.length, 2);
  assert.deepEqual(audio[0].span, { itemId: 'mouth', start: 0, end: 4 });
  assert.deepEqual([...audio[0].chunk.data], [...new TextEncoder().encode('hell')]);
  assert.deepEqual(audio[0].alignment.durationMs, [20, 20, 20, 20]);
  assert.equal(spoken.at(-1).type, 'done');
  assert.equal(spoken.at(-1).usage.output, 0);

  const talker = registerFauxRealtime({
    api: 'integration-faux-rt',
    id: 'talker',
    toolCalls: 'blocking',
    delivery: { interrupt: 'native', when_idle: 'approximate', silent: 'unsupported' },
    truncation: 'none',
    events: [{ type: 'session_start', sessionId: 'live' }],
  });
  const session = await connectRealtime(talker.model, {
    instructions: '',
    tools: [],
    voice: 'faux',
  });
  const live = [];
  const reading = (async () => {
    for await (const event of session) live.push(event.type);
  })();
  session.appendAudio({ data: new Uint8Array([1, 2]), format, timestamp: 0 });
  session.inject('status', 'interrupt');
  session.respond('call-1', {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'ask_agent',
    content: [{ type: 'text', text: 'done' }],
    isError: false,
    timestamp: 1,
  });
  session.interrupt({ itemId: 'utterance', heardMs: 15 });
  talker.setFlags({ toolCalls: 'async', truncation: 'server' });
  await session.close();
  await reading;
  assert.deepEqual(live, ['session_start']);
  assert.deepEqual(
    talker.calls.map((call) => call.method),
    ['appendAudio', 'inject', 'respond', 'interrupt', 'close']
  );
  assert.equal(talker.model.toolCalls, 'async');
  assert.equal(talker.model.truncation, 'server');
  assert.equal(talker.model.delivery.silent, 'unsupported');
});
