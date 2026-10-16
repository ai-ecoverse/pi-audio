import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerWaveSpeed } from '@ai-ecoverse/pi-audio/wavespeed';

test('wavespeed speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('speech', 'wavespeed', 'minimax/speech-2.6-turbo'), undefined);
  const release = registerWaveSpeed();
  try {
    const voice = getVoiceModel('speech', 'wavespeed', 'minimax/speech-2.6-turbo');
    const whisper = getVoiceModel('transcription', 'wavespeed', 'wavespeed-ai/openai-whisper');
    assert.equal(voice.textStreaming, false);
    assert.equal(voice.outputFormats[0].encoding, 'mp3');
    assert.equal(whisper.streaming, false);
    assert.equal(whisper.turnDetection, 'none');
    const spoken = [];
    let step = 0;
    for await (const event of speak(
      voice,
      { text: 'hi', voice: 'voice-1' },
      {
        apiKey: 'wave',
        fetch: async (url, init) => {
          step += 1;
          if (step === 1) {
            assert.match(String(url), /\/minimax\/speech-2\.6-turbo$/);
            assert.equal(init.headers.Authorization, 'Bearer wave');
            const payload = JSON.parse(init.body);
            assert.equal(payload.text, 'hi');
            assert.equal(payload.voice_id, 'voice-1');
            assert.equal(payload.format, 'mp3');
            return Response.json({ data: { id: 'p1', status: 'processing' } });
          }
          if (step === 2) {
            assert.match(String(url), /\/predictions\/p1\/result$/);
            assert.equal(init.method, 'GET');
            return Response.json({
              data: { status: 'completed', outputs: ['https://example.test/out.mp3'] },
            });
          }
          return new Response(Buffer.from([1, 2]));
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);
    const transcript = await transcribe(
      whisper,
      { url: 'https://example.test/in.wav' },
      {
        apiKey: 'wave',
        fetch: async (url, init) => {
          assert.match(String(url), /\/wavespeed-ai\/openai-whisper$/);
          const payload = JSON.parse(init.body);
          assert.equal(payload.audio, 'https://example.test/in.wav');
          assert.equal(payload.enable_timestamps, false);
          return Response.json({ data: { status: 'completed', outputs: ['hello'] } });
        },
      }
    );
    assert.equal(transcript.text, 'hello');
  } finally {
    release();
  }
});
