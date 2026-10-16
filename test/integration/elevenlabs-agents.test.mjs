import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { connectRealtime, getVoiceModel } from '@ai-ecoverse/pi-audio';
import {
  elevenLabsAgent,
  memoryHostedCache,
  provisionAgent,
  registerElevenLabsAgents,
} from '@ai-ecoverse/pi-audio/elevenlabs-agents';

const readTool = {
  name: 'read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
};

function scripted() {
  const sent = [];
  const queue = [];
  const waiters = [];
  let closed = false;
  let target;
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
    get target() {
      return target;
    },
    factory(next) {
      target = next;
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

test('elevenlabs agents plays a recorded talker round and a silent update', async () => {
  assert.match(
    import.meta.resolve('@ai-ecoverse/pi-audio/elevenlabs-agents'),
    /elevenlabs-agents\/index\.js$/
  );
  const fixture = JSON.parse(
    await readFile(
      new URL('./fixtures/elevenlabs-agents/talker-round.json', import.meta.url),
      'utf8'
    )
  );
  const script = scripted();
  const requests = [];
  const cache = memoryHostedCache();
  const unregister = registerElevenLabsAgents({ wire: script.factory, cache, now: () => 5_000 });
  const fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body });
    if (String(url).includes('get-signed-url')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ signed_url: 'wss://signed.example/talk' }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ agent_id: 'agent_talk' }) };
  };
  try {
    assert.equal(getVoiceModel('realtime', 'elevenlabs', 'elevenlabs-agent').provisioning, 'agent');
    assert.equal(elevenLabsAgent.delivery.silent, 'native');
    const session = await connectRealtime(
      elevenLabsAgent,
      { instructions: 'Be brief.', voice: '21m00Tcm4TlvDq8ikWAM', tools: [readTool] },
      { apiKey: 'xi-test', fetch }
    );
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].url, /\/v1\/convai\/agents\/create$/);
    const created = JSON.parse(requests[0].body);
    assert.equal(created.conversation_config.agent.prompt.tools[0].type, 'client');
    assert.equal(created.conversation_config.agent.prompt.tools[0].name, 'read');
    assert.equal(requests[1].method, 'GET');
    assert.match(requests[1].url, /agent_id=agent_talk/);
    assert.equal(script.target.url, 'wss://signed.example/talk');
    assert.equal(script.sent[0].type, 'conversation_initiation_client_data');
    assert.equal(script.sent[0].conversation_config_override.agent.prompt.prompt, 'Be brief.');
    assert.deepEqual(script.sent[0].dynamic_variables, {});
    assert.deepEqual(script.sent[0].custom_llm_extra_body, {});
    const events = session[Symbol.asyncIterator]();
    for (const event of fixture) script.server(event);
    assert.equal((await events.next()).value.sessionId, 'conv_1');
    assert.equal((await events.next()).value.text, 'What is failing?');
    const call = (await events.next()).value;
    assert.equal(call.type, 'tool_call');
    assert.equal(call.blocking, true);
    assert.equal(call.call.name, 'read');
    session.respond('call_1', {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'read',
      content: [{ type: 'text', text: 'one failure' }],
      isError: false,
      timestamp: 1,
    });
    assert.equal(script.sent.at(-1).type, 'client_tool_result');
    assert.equal(script.sent.at(-1).result, 'one failure');
    session.inject('tests are running', 'silent');
    assert.equal(script.sent.at(-1).type, 'contextual_update');
    assert.equal(script.sent.at(-1).text, 'tests are running');
    assert.equal(script.sent.at(-1).context_id, 'pi-audio');
    const spoken = (await events.next()).value;
    assert.equal(spoken.type, 'output_audio');
    assert.deepEqual(spoken.alignment.durationMs, [20, 20, 20, 20, 20]);
    assert.equal((await events.next()).value.text, 'Tests ');
    assert.equal((await events.next()).value.text, 'Tests are failing.');
    assert.equal((await events.next()).value.type, 'response_done');
    const again = await provisionAgent(
      elevenLabsAgent,
      {
        name: elevenLabsAgent.name,
        instructions: 'Be brief.',
        tools: [readTool],
        voice: '21m00Tcm4TlvDq8ikWAM',
        llm: 'gemini-2.5-flash',
      },
      { apiKey: 'xi-test', fetch, cache }
    );
    assert.equal(again.agentId, 'agent_talk');
    assert.equal(requests.length, 2);
    const sentBeforeInterrupt = script.sent.length;
    session.interrupt({ itemId: 'agent', heardMs: 20 });
    assert.equal(script.sent.length, sentBeforeInterrupt);
    const closed = await session.close();
    assert.equal(closed.usage.audio.inputSeconds, 0);
  } finally {
    unregister();
  }
});
