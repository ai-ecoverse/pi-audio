import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerCloudflare } from '@ai-ecoverse/pi-audio/cloudflare';

test('cloudflare speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('speech', 'cloudflare', '@cf/deepgram/aura-1'), undefined);
  const release = registerCloudflare();
  try {
    const aura = getVoiceModel('speech', 'cloudflare', '@cf/deepgram/aura-1');
    const nova = getVoiceModel('transcription', 'cloudflare', '@cf/deepgram/nova-3');
    const flux = getVoiceModel('transcription', 'cloudflare', '@cf/deepgram/flux');
    const whisper = getVoiceModel(
      'transcription',
      'cloudflare',
      '@cf/openai/whisper-large-v3-turbo'
    );
    const melo = getVoiceModel('speech', 'cloudflare', '@cf/myshell-ai/melotts');
    assert.equal(aura.textStreaming, true);
    assert.equal(aura.outputFormats[0].encoding, 'mp3');
    assert.equal(nova.streaming, true);
    assert.equal(nova.turnDetection, 'vad');
    assert.equal(flux.streaming, true);
    assert.equal(flux.turnDetection, 'semantic');
    assert.equal(whisper.streaming, false);
    assert.equal(whisper.turnDetection, 'none');
    assert.equal(melo.textStreaming, false);
    const spoken = [];
    for await (const event of speak(
      aura,
      { text: 'hi', voice: 'angus' },
      {
        apiKey: 'cf',
        headers: { 'cf-account-id': 'acct' },
        fetch: async (url, init) => {
          assert.equal(
            String(url),
            'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/deepgram/aura-1'
          );
          assert.equal(init.headers.Authorization, 'Bearer cf');
          const payload = JSON.parse(init.body);
          assert.equal(payload.text, 'hi');
          assert.equal(payload.speaker, 'angus');
          assert.equal(payload.encoding, 'mp3');
          return new Response(Buffer.from([1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);
    const transcript = await transcribe(
      whisper,
      { data: Uint8Array.from([1]), mimeType: 'audio/wav' },
      {
        apiKey: 'cf',
        headers: { 'cf-account-id': 'acct' },
        fetch: async (url, init) => {
          assert.match(String(url), /whisper-large-v3-turbo$/);
          const payload = JSON.parse(init.body);
          assert.equal(typeof payload.audio, 'string');
          return Response.json({ success: true, result: { text: 'hello' } });
        },
      }
    );
    assert.equal(transcript.text, 'hello');
  } finally {
    release();
  }
});
