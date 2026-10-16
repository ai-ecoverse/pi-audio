import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mintRealtimeToken, VoiceRequestError } from '@ai-ecoverse/pi-audio';

const tool = {
  name: 'ask_agent',
  description: 'Hand it over',
  parameters: { type: 'object' },
};

const model = (api, transports = ['websocket']) => ({ id: `${api}-id`, api, transports });

const recorded = (payload) => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetch, requests };
};

test('mintRealtimeToken posts vendor fixtures through the public entry', async () => {
  const openai = recorded({ value: 'ek_openai', expires_at: 1_800_000_000 });
  const openaiToken = await mintRealtimeToken(
    model('openai-realtime'),
    { instructions: 'be brief', voice: 'marin', tools: [tool] },
    { apiKey: 'sk', fetch: openai.fetch }
  );
  assert.equal(openaiToken.value, 'ek_openai');
  assert.equal(openaiToken.expiresAt, 1_800_000_000_000);
  assert.equal(openaiToken.model, 'openai-realtime-id');
  assert.equal(openai.requests[0].body.session.instructions, 'be brief');
  assert.equal(openai.requests[0].body.session.audio.output.voice, 'marin');
  assert.equal(openai.requests[0].body.session.tools[0].name, 'ask_agent');

  const xai = recorded({ value: 'ek_xai', expires_at: 1_800_000_000 });
  await mintRealtimeToken(
    model('xai-realtime'),
    { instructions: 'be brief', voice: 'eve' },
    { apiKey: 'sk', fetch: xai.fetch }
  );
  assert.deepEqual(xai.requests[0].body, { expires_after: { seconds: 300 } });

  const gemini = recorded({ name: 'authTokens/abc', expireTime: '2030-01-01T00:00:00.000Z' });
  const geminiToken = await mintRealtimeToken(
    model('gemini-live'),
    { instructions: 'be brief', voice: 'Aoede', tools: [tool], uses: 1 },
    { apiKey: 'gem', fetch: gemini.fetch }
  );
  assert.equal(geminiToken.value, 'authTokens/abc');
  assert.equal(gemini.requests[0].body.liveConnectConstraints.model, 'models/gemini-live-id');
  assert.equal(gemini.requests[0].body.uses, 1);
  assert.equal(
    gemini.requests[0].body.liveConnectConstraints.config.systemInstruction.parts[0].text,
    'be brief'
  );

  const eleven = recorded({ signed_url: 'wss://agents.example/signed' });
  const elevenToken = await mintRealtimeToken(
    model('elevenlabs-agents'),
    { agentId: 'agent-1', instructions: 'be brief' },
    { apiKey: 'xi', fetch: eleven.fetch }
  );
  assert.equal(elevenToken.value, 'wss://agents.example/signed');
  assert.equal(
    eleven.requests[0].url,
    'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent-1'
  );

  const fish = recorded({
    token: 'lk-token',
    livekit_url: 'wss://livekit.example',
    expires_at: '2030-01-01T00:00:00.000Z',
  });
  const fishToken = await mintRealtimeToken(
    model('fish-agents'),
    { agentId: 'agent-1', instructions: 'be brief', voice: 'cedar' },
    { apiKey: 'fish', fetch: fish.fetch }
  );
  assert.equal(fishToken.value, 'lk-token');
  assert.equal(fishToken.url, 'wss://livekit.example');
  assert.deepEqual(fish.requests[0].body, {
    agent_id: 'agent-1',
    overrides: { system_prompt: 'be brief', voice_id: 'cedar' },
  });

  await assert.rejects(
    () => mintRealtimeToken(model('fish-agents'), {}, { apiKey: 'fish', fetch: fish.fetch }),
    (error) => error instanceof VoiceRequestError && /missing agent id/.test(error.message)
  );
});
