import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  connectRealtime,
  getVoiceModel,
  listen,
  registerRealtimeApiProvider,
  registerSpeechApiProvider,
  registerTranscriptionApiProvider,
  registerVoiceModel,
  resolveVoiceAuth,
  SpeechEventStream,
  speak,
  TranscriptionEventStream,
  transcribe,
} from '@ai-ecoverse/pi-audio';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai';

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

function idleStream() {
  const stream = createAssistantMessageEventStream();
  stream.end();
  return stream;
}

test('a faux adapter registers and is dispatched by api', async () => {
  const ears = {
    id: 'ears',
    name: 'Ears',
    api: 'integration-transcription',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    type: 'transcription',
    streaming: true,
    turnDetection: 'semantic',
    inputFormats: [format],
    languages: ['en'],
    cost,
  };
  const mouth = {
    id: 'mouth',
    name: 'Mouth',
    api: 'integration-speech',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    type: 'speech',
    textStreaming: true,
    outputFormats: [format],
    voices: [{ id: 'verse', name: 'Verse' }],
    cost,
  };
  const talker = {
    id: 'talker',
    name: 'Talker',
    api: 'integration-realtime',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    type: 'realtime',
    transports: ['websocket'],
    toolCalls: 'async',
    inputFormat: format,
    outputFormat: format,
    resumable: true,
    ephemeralAuth: true,
    voices: [{ id: 'verse', name: 'Verse' }],
    provisioning: 'none',
    delivery: { interrupt: 'native', when_idle: 'approximate', silent: 'unsupported' },
    truncation: 'none',
    liveToolUpdate: false,
    cost,
  };
  registerVoiceModel(ears);
  registerVoiceModel(mouth);
  registerVoiceModel(talker);
  assert.equal(getVoiceModel('transcription', 'openai', 'ears'), ears);

  registerTranscriptionApiProvider({
    api: ears.api,
    async transcribe(_model, input) {
      assert.equal(input.mimeType, 'audio/wav');
      return { text: 'batch', usage: { ...cost, input: 0, output: 0, totalTokens: 0, cost } };
    },
    listen() {
      const stream = new TranscriptionEventStream();
      stream.push({ type: 'speech_start', at: 0 });
      stream.push({ type: 'partial', segmentId: 'a', text: 'hel' });
      stream.push({ type: 'final', segmentId: 'a', text: 'hello', confidence: 0.9 });
      stream.push({ type: 'turn_end', text: 'hello', at: 10 });
      stream.push({
        type: 'done',
        transcript: {
          text: 'hello',
          usage: { ...cost, input: 0, output: 0, totalTokens: 0, cost },
        },
      });
      return stream;
    },
  });
  assert.equal(
    (await transcribe(ears, { data: new Uint8Array([1]), mimeType: 'audio/wav' })).text,
    'batch'
  );
  const heard = [];
  for await (const event of listen(ears, (async function* empty() {})())) heard.push(event.type);
  assert.deepEqual(heard, ['speech_start', 'partial', 'final', 'turn_end', 'done']);

  registerSpeechApiProvider({
    api: mouth.api,
    speak() {
      const stream = new SpeechEventStream();
      stream.push({ type: 'start', format });
      stream.push({
        type: 'audio',
        chunk: { data: new Uint8Array([9]), format, timestamp: 0 },
        span: { itemId: 'mouth', start: 0, end: 2 },
      });
      stream.push({
        type: 'done',
        usage: { ...cost, input: 0, output: 0, totalTokens: 0, cost },
      });
      return stream;
    },
  });
  const spoken = [];
  for await (const event of speak(mouth, { text: 'hi', voice: 'verse' })) spoken.push(event.type);
  assert.deepEqual(spoken, ['start', 'audio', 'done']);

  registerRealtimeApiProvider({
    api: talker.api,
    async connect(model) {
      return {
        model,
        appendAudio() {},
        sendText() {},
        inject() {},
        respond() {},
        interrupt() {},
        update() {},
        async close() {
          return { usage: { ...cost, input: 0, output: 0, totalTokens: 0, cost } };
        },
        async *[Symbol.asyncIterator]() {
          yield { type: 'session_start', sessionId: 's1' };
        },
      };
    },
  });
  const session = await connectRealtime(talker, {
    instructions: 'be brief',
    tools: [],
    voice: 'verse',
  });
  const realtime = [];
  for await (const event of session) realtime.push(event.type);
  assert.deepEqual(realtime, ['session_start']);
  assert.equal((await session.close()).usage.totalTokens, 0);

  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai', async () => ({ type: 'api_key', key: 'sk-shared' }));
  const models = createModels({ credentials });
  models.setProvider(
    createProvider({
      id: 'openai',
      auth: {
        apiKey: {
          name: 'OpenAI',
          resolve: async ({ credential }) =>
            credential?.key ? { auth: { apiKey: credential.key } } : undefined,
        },
      },
      models: [
        {
          id: 'chat',
          name: 'Chat',
          api: 'openai-completions',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          input: ['text'],
          cost,
          reasoning: false,
          contextWindow: 8,
          maxTokens: 8,
        },
      ],
      api: { stream: idleStream, streamSimple: idleStream },
    })
  );
  const auth = await resolveVoiceAuth(models, ears);
  assert.equal(auth.auth.apiKey, 'sk-shared');
  assert.equal(models.getModel('openai', 'ears'), undefined);
});
