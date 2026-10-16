import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connectRealtime, getVoiceModel } from '@ai-ecoverse/pi-audio';
import {
  fishAgent,
  memoryHostedCache,
  provisionAgent,
  registerFishAgents,
} from '@ai-ecoverse/pi-audio/fish-agents';

const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } } },
};

function scriptedRoom() {
  const sent = [];
  let handlers;
  const room = {
    identity: 'user-1',
    async connect(url, token) {
      this.url = url;
      this.token = token;
    },
    async publishMic() {},
    async publishData(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {
      this.closed = true;
    },
  };
  return {
    sent,
    room,
    factory(next) {
      handlers = next;
      return room;
    },
    get handlers() {
      return handlers;
    },
  };
}

test('fish agents joins a minted livekit room and publishes a client tool', async () => {
  assert.match(import.meta.resolve('@ai-ecoverse/pi-audio/fish-agents'), /fish-agents\/index\.js$/);
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/fish-agents/talker-round.json', import.meta.url), 'utf8')
  );
  const script = scriptedRoom();
  const cache = memoryHostedCache();
  const unregister = registerFishAgents({
    room: script.factory,
    cache,
    now: () => 5_000,
    agentId: 'public',
  });
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body });
    if (String(url).endsWith('/sessions')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          transport: 'livekit',
          livekit_url: 'wss://livekit.example/room',
          token: 'participant',
          session_id: 'sess-recorded',
        }),
      };
    }
    if (String(url).endsWith('/tools'))
      return { ok: true, status: 200, json: async () => ({ tool_id: 'tool-1' }) };
    if (String(url).endsWith('/publish')) return { ok: true, status: 204, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ agent_id: 'agent-recorded' }) };
  };
  try {
    assert.equal(getVoiceModel('realtime', 'fish', 'fish-agent').transports[0], 'webrtc');
    assert.equal(fishAgent.delivery.silent, 'approximate');
    const minted = await connectRealtime(
      fishAgent,
      { instructions: 'Be brief.', voice: fishAgent.voices[0].id, tools: [readTool] },
      {
        token: {
          value: 'participant',
          url: 'wss://livekit.example/room',
          expiresAt: 1,
          model: fishAgent.id,
        },
        fetch: async () => {
          throw new Error('minted connect must not open a session');
        },
      }
    );
    const mintedEvents = minted[Symbol.asyncIterator]();
    assert.equal((await mintedEvents.next()).value.sessionId, 'session');
    assert.equal(script.room.url, 'wss://livekit.example/room');
    minted.inject('quiet', 'silent');
    assert.equal(script.sent[0].audio, false);
    script.handlers.text('agent', 'hidden', { 'lk.transcription_final': 'true' });
    script.handlers.data('agent-event', fixture.tool, 'agent');
    const tool = (await mintedEvents.next()).value;
    assert.equal(tool.type, 'tool_call');
    assert.equal(tool.call.name, 'read');
    assert.equal(tool.blocking, true);
    script.handlers.data('agent-event', fixture.ended, 'agent');
    assert.equal((await mintedEvents.next()).value.error, 'idle');
    await minted.close();

    const created = await connectRealtime(
      fishAgent,
      { instructions: 'Be brief.', voice: fishAgent.voices[0].id, tools: [readTool] },
      { apiKey: 'fish-test', fetch }
    );
    assert.equal(script.room.token, 'participant');
    assert.equal(
      requests.some((request) => request.url.endsWith('/sessions')),
      true
    );
    assert.equal(
      requests.some((request) => request.url.endsWith('/publish')),
      true
    );
    const createdEvents = created[Symbol.asyncIterator]();
    assert.equal((await createdEvents.next()).value.sessionId, 'sess-recorded');
    await created.close();

    const rejected = await connectRealtime(
      fishAgent,
      { instructions: '', voice: '', tools: [] },
      {
        fetch: async () => ({
          ok: true,
          status: 201,
          json: async () => ({ transport: 'websocket', livekit_url: 'wss://x', token: 't' }),
        }),
        agentId: 'public',
      }
    ).then(
      () => undefined,
      (error) => error
    );
    assert.match(rejected.message, /unsupported transport/);
    const cached = await provisionAgent(
      fishAgent,
      {
        name: 'Fish Agent',
        instructions: 'Be brief.',
        tools: [readTool],
        voice: fishAgent.voices[0].id,
        llm: 'fish',
      },
      { apiKey: 'fish-test', fetch, cache }
    );
    assert.equal(cached.agentId, 'agent-recorded');
  } finally {
    unregister();
  }
});
