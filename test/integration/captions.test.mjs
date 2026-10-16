import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captionsFromHistory, listen, speak, voiceTurns } from '@ai-ecoverse/pi-audio';
import { registerFauxSpeech, registerFauxTranscription } from '@ai-ecoverse/pi-audio/faux';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };
const spoken = 'Hello there.';

function chunk(text, timestamp) {
  return { data: new TextEncoder().encode(text), format, timestamp };
}

function sink(playLimit) {
  const listeners = new Set();
  let writes = 0;
  const out = {
    playedMs: 0,
    write(_audio, tag) {
      writes += 1;
      out.playedMs += 20;
      if (writes > playLimit) return;
      for (const listener of listeners) listener(tag, 1);
    },
    flush() {},
    onPlayback(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return out;
}

function scripted(id, cues) {
  const ears = registerFauxTranscription({
    api: `${id}-ears`,
    id: `${id}-ears`,
    cues,
  });
  const mouth = registerFauxSpeech({
    api: `${id}-mouth`,
    id: `${id}-mouth`,
    textStreaming: true,
    chunkChars: 4,
  });
  return { ears, mouth };
}

function reply() {
  return {
    async *prompt() {
      yield {
        type: 'message_end',
        entry: {
          id: 9,
          model: [{ role: 'assistant', content: [{ type: 'text', text: spoken }] }],
        },
      };
    },
  };
}

async function captionsOf(session) {
  const captions = [];
  const reading = (async () => {
    for await (const caption of session.captions) captions.push(caption);
  })();
  await session.done;
  await reading;
  return captions;
}

test('faux captions reveal with playback and a cut leaves the rest unheard', async () => {
  const revealed = scripted('captions-reveal', [
    { at: 1, events: [{ type: 'turn_end', text: 'hello', at: 5 }] },
  ]);
  const revealSession = voiceTurns(
    { listen, speak },
    { ...reply(), async truncate() {} },
    (async function* mic() {
      yield chunk('hello', 5);
    })(),
    sink(10),
    { ears: revealed.ears.model, mouth: revealed.mouth.model, voice: 'faux' },
    new AbortController().signal
  );
  const revealedCaptions = await captionsOf(revealSession);
  assert.deepEqual(
    revealedCaptions
      .filter((caption) => caption.type === 'agent_spoken')
      .map((caption) => caption.upTo),
    [4, 8, spoken.length]
  );
  assert.equal(revealedCaptions.find((caption) => caption.type === 'agent_generated').text, spoken);
  revealed.ears.unregister();
  revealed.mouth.unregister();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const cut = scripted('captions-cut', [
    { at: 1, events: [{ type: 'turn_end', text: 'hello', at: 5 }] },
    { at: 2, events: [{ type: 'speech_start', at: 40 }] },
  ]);
  const cuts = [];
  const cutOut = sink(1);
  const play = cutOut.write;
  cutOut.write = (audio, tag) => {
    play(audio, tag);
    release();
  };
  const cutSession = voiceTurns(
    { listen, speak },
    {
      ...reply(),
      async truncate(value) {
        cuts.push(value);
      },
    },
    (async function* mic() {
      yield chunk('hello', 5);
      await gate;
      yield chunk('stop', 40);
    })(),
    cutOut,
    { ears: cut.ears.model, mouth: cut.mouth.model, voice: 'faux', bargeIn: 'interrupt' },
    new AbortController().signal
  );
  const cutCaptions = await captionsOf(cutSession);
  const heard = cutCaptions.filter((caption) => caption.type === 'agent_spoken').at(-1);
  const marked = cutCaptions.find((caption) => caption.type === 'agent_cut');
  assert.ok(heard.upTo < spoken.length);
  assert.equal(marked.heardUpTo, heard.upTo);
  assert.equal(cutCaptions.find((caption) => caption.type === 'agent_generated').text, spoken);
  assert.equal(cuts.length, 1);
  cut.ears.unregister();
  cut.mouth.unregister();

  const rebuilt = captionsFromHistory([
    {
      id: 5,
      kind: 'pi.user',
      model: [{ role: 'user', content: 'hello' }],
      data: { source: 'voice', transcriptionModel: 'ears', confidence: 0.9 },
    },
    {
      id: 9,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: spoken }] }],
    },
    {
      id: 10,
      kind: 'voice.truncate',
      data: { entryId: '9', contentIndex: 0, heardUpTo: heard.upTo, heardMs: 20 },
    },
  ]);
  assert.equal(rebuilt.find((caption) => caption.type === 'agent_cut').heardUpTo, heard.upTo);
  assert.equal(rebuilt.find((caption) => caption.type === 'agent_generated').text, spoken);
});
